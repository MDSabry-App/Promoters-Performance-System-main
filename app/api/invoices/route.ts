import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";

const schema = z.object({
  date: z.string(),
  employeeId: z.string(),
  amount: z.number().nonnegative(),
  warranty: z.number().nonnegative().default(0),
  agency: z.number().nonnegative().default(0),
  notes: z.string().optional(),
});

/**
 * Plain snapshot of an invoice, safe to store as JSON.
 *
 * The audit trail used to record only the invoice number, which meant an edit or a
 * delete threw the amount and the promoter away for good. Every write path now
 * stores this snapshot in `AuditLog.before` / `AuditLog.after`, so any invoice can
 * be reconstructed from the log alone.
 *
 * Decimals are stringified because Prisma returns Decimal objects that do not
 * survive JSON.stringify.
 */
type InvoiceSnapshot = {
  invoiceNumber: string;
  date: string;
  employeeId: string;
  amount: string;
  warranty: string;
  agency: string;
  notes: string | null;
};

function snapshot(inv: {
  invoiceNumber: string;
  date: Date;
  employeeId: string;
  amount: unknown;
  warranty: unknown;
  agency: unknown;
  notes: string | null;
}): InvoiceSnapshot {
  return {
    invoiceNumber: inv.invoiceNumber,
    date: inv.date.toISOString(),
    employeeId: inv.employeeId,
    amount: String(inv.amount),
    warranty: String(inv.warranty),
    agency: String(inv.agency),
    notes: inv.notes,
  };
}

/** One-line summary of a snapshot, used in push notification bodies. */
function describe(s: InvoiceSnapshot | null | undefined) {
  if (!s) return "فاتورة";
  return `${s.invoiceNumber} · ${Number(s.amount).toLocaleString("en-US")}`;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const year = Number(u.searchParams.get("year"));
  const month = Number(u.searchParams.get("month"));
  if (!year || month < 1 || month > 12) return NextResponse.json({ error: "Invalid year/month" }, { status: 400 });
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const rows = await prisma.invoice.findMany({
    // Soft-deleted invoices stay in the table but must never reach the dashboard.
    where: { date: { gte: from, lt: to }, deletedAt: null },
    include: { employee: { include: { department: true, company: true } } },
    orderBy: { date: "desc" },
  });
  return NextResponse.json(rows);
}

async function manager() {
  try { await requireManager(); return null; }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
}

export async function POST(req: Request) {
  const denied = await manager(); if (denied) return denied;
  try {
    const d = schema.parse(await req.json());
    const date = new Date(d.date);
    if (Number.isNaN(date.getTime())) return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    const employee = await prisma.employee.findUnique({ where: { id: d.employeeId } });
    if (!employee) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    const row = await prisma.$transaction(async tx => {
      const invoiceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const invoice = await tx.invoice.create({
        data: { invoiceNumber, date, employeeId:d.employeeId, amount:d.amount, warranty:d.warranty, agency:d.agency, notes:d.notes },
        include: { employee: true },
      });
      await tx.auditLog.create({ data:{ action:"CREATE", entity:"Invoice", entityId:invoice.id, details:{invoiceNumber:invoice.invoiceNumber}, after:snapshot(invoice) as unknown as object }});
      return invoice;
    });
    await notifyAll({ title: "فاتورة جديدة", body: `${row.invoiceNumber} · ${employee.name} · ${d.amount}`, tag: "invoice" });
    return NextResponse.json(row,{status:201});
  } catch { return NextResponse.json({ error:"Unable to save invoice" },{status:400}); }
}

export async function PUT(req: Request) {
  const denied = await manager(); if (denied) return denied;
  try {
    const body = schema.extend({ id:z.string().min(1) }).parse(await req.json());
    const date = new Date(body.date);
    if (Number.isNaN(date.getTime())) return NextResponse.json({error:"Invalid date"},{status:400});
    const existing = await prisma.invoice.findUnique({where:{id:body.id}});
    if (!existing) return NextResponse.json({error:"Invoice not found"},{status:404});
    if (existing.deletedAt) return NextResponse.json({error:"This invoice was deleted. Restore it before editing."},{status:409});
    const employee = await prisma.employee.findUnique({where:{id:body.employeeId}});
    if (!employee) return NextResponse.json({error:"Employee not found"},{status:404});
    const row=await prisma.$transaction(async tx=>{
      const invoice=await tx.invoice.update({where:{id:body.id},data:{date,employeeId:body.employeeId,amount:body.amount,warranty:body.warranty,agency:body.agency,notes:body.notes},include:{employee:true}});
      // `before` is the whole point: it preserves the values this edit replaced.
      await tx.auditLog.create({data:{action:"UPDATE",entity:"Invoice",entityId:invoice.id,details:{invoiceNumber:invoice.invoiceNumber},before:snapshot(existing) as unknown as object,after:snapshot(invoice) as unknown as object}});
      return invoice;
    });
    await notifyAll({ title: "تم تحديث فاتورة", body: `${row.invoiceNumber} · ${employee.name} · ${body.amount}`, tag: "invoice", level: "important" });
    return NextResponse.json(row);
  } catch { return NextResponse.json({error:"Unable to update invoice. Invoice number may already exist."},{status:400}); }
}

/**
 * Soft delete.
 *
 * The row is kept and stamped rather than removed, so the manager can bring it back
 * from the recycle bin. The full snapshot also goes into the audit log, which means
 * the invoice can still be rebuilt even if the row itself is ever lost.
 */
export async function DELETE(req: Request) {
  const denied = await manager(); if (denied) return denied;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({error:"Invoice id required"},{status:400});
    const existing=await prisma.invoice.findUnique({where:{id}});
    if(!existing) return NextResponse.json({error:"Invoice not found"},{status:404});
    if(existing.deletedAt) return NextResponse.json({error:"Invoice is already deleted"},{status:409});
    const snap = snapshot(existing);
    await prisma.$transaction(async tx=>{
      await tx.invoice.update({where:{id},data:{deletedAt:new Date()}});
      await tx.auditLog.create({data:{action:"DELETE",entity:"Invoice",entityId:id,details:{invoiceNumber:existing.invoiceNumber},before:snap as unknown as object}});
    });
    await notifyAll({ title: "تم حذف فاتورة", body: `${describe(snap)} · يمكن استرجاعها`, tag: "invoice", level: "critical" });
    return NextResponse.json({ok:true});
  } catch { return NextResponse.json({error:"Unable to delete invoice"},{status:400}); }
}

/**
 * Restore a soft-deleted invoice: clears the stamps so it counts in the reports again.
 */
export async function PATCH(req: Request) {
  const denied = await manager(); if (denied) return denied;
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({error:"Invoice id required"},{status:400});
    const existing = await prisma.invoice.findUnique({where:{id}});
    if (!existing) return NextResponse.json({error:"Invoice not found"},{status:404});
    if (!existing.deletedAt) return NextResponse.json({error:"Invoice is not deleted"},{status:409});
    const invoice = await prisma.$transaction(async tx => {
      const restored = await tx.invoice.update({where:{id},data:{deletedAt:null,deletedBy:null},include:{employee:true}});
      await tx.auditLog.create({data:{action:"RESTORE",entity:"Invoice",entityId:id,details:{invoiceNumber:restored.invoiceNumber},after:snapshot(restored) as unknown as object}});
      return restored;
    });
    await notifyAll({ title: "تم استرجاع فاتورة", body: describe(snapshot(invoice)), tag: "invoice", level: "important" });
    return NextResponse.json(invoice);
  } catch { return NextResponse.json({error:"Unable to restore invoice"},{status:400}); }
}
