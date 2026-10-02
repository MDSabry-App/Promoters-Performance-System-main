import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";

const STUFF_COMPANY = "Stuff B.TECH";

const createSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  name: z.string().trim().min(2),
  departmentCode: z.string().min(1),
  notes: z.string().trim().optional(),
});

export async function GET(req: Request) {
  const u = new URL(req.url);
  const year = Number(u.searchParams.get("year"));
  const month = Number(u.searchParams.get("month"));
  if (!year || month < 1 || month > 12) return NextResponse.json({ error: "year and month required" }, { status: 400 });

  const rows = await prisma.stuff.findMany({
    where: { year, month },
    include: { department: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      year: r.year,
      month: r.month,
      name: r.name,
      company: r.company,
      department: r.department.code,
      amount: Number(r.amount),
      notes: r.notes,
      createdAt: r.createdAt,
    })),
  );
}

export async function POST(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }

  try {
    const data = createSchema.parse(await req.json());
    const department = await prisma.department.findUnique({ where: { code: data.departmentCode } });
    if (!department) return NextResponse.json({ error: "Department not found" }, { status: 404 });

    const created = await prisma.stuff.create({
      data: {
        year: data.year,
        month: data.month,
        name: data.name,
        company: STUFF_COMPANY,
        departmentId: department.id,
        amount: 0,
        notes: data.notes || null,
      },
      include: { department: true },
    });

    await prisma.auditLog.create({
      data: {
        action: "CREATE",
        entity: "Stuff",
        entityId: created.id,
        details: { year: data.year, month: data.month, name: data.name, company: STUFF_COMPANY, departmentId: department.id },
      },
    });

    await notifyAll({ title: "تمت إضافة Stuff", body: `${data.name} · ${department.code}`, tag: "stuff", level: "important" });

    return NextResponse.json({ ...created, department: created.department.code, amount: Number(created.amount) }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    return NextResponse.json({ error: message || "Unable to create stuff" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }

  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const existing = await prisma.stuff.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Stuff not found" }, { status: 404 });

    await prisma.stuff.delete({ where: { id } });
    await prisma.auditLog.create({
      data: { action: "DELETE", entity: "Stuff", entityId: id, details: { name: existing.name, departmentId: existing.departmentId, amount: Number(existing.amount) } },
    });

    await notifyAll({ title: "تم حذف Stuff", body: existing.name, tag: "stuff", level: "critical" });

    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    return NextResponse.json({ error: message || "Unable to delete stuff" }, { status: 400 });
  }
}