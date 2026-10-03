import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";
import { recordChange } from "@/lib/changes";

const schema = z.object({
  name: z.string().trim().min(2),
  company: z.string().trim().min(1),
  departmentCode: z.string().min(1),
});

export async function GET() {
  return NextResponse.json(
    await prisma.employee.findMany({
      where: { status: "ACTIVE" },
      include: { department: true, company: true },
      orderBy: { name: "asc" },
    }),
  );
}

export async function POST(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
  try {
    const d = schema.parse(await req.json());
    const dep = await prisma.department.findUnique({ where: { code: d.departmentCode } });
    if (!dep) return NextResponse.json({ error: "Department not found" }, { status: 404 });
    const company = await prisma.company.upsert({ where: { name: d.company }, create: { name: d.company }, update: {} });
    const employee = await prisma.employee.create({
      data: { name: d.name, companyId: company.id, departmentId: dep.id, employeeCode: "EMP-" + crypto.randomUUID().slice(0, 8).toUpperCase() },
    });
    await recordChange("CREATE", "Employee", employee.id, { name: d.name, company: d.company, departmentCode: d.departmentCode });
    await notifyAll({ title: "تمت إضافة مروج", body: `${d.name} · ${d.company} · ${d.departmentCode}`, tag: "employee", level: "important" });
    return NextResponse.json(employee, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Unable to create employee" }, { status: 400 });
  }
}

/** Rename a promoter, or move them to another company / department. */
export async function PUT(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
  try {
    const d = schema.extend({ id: z.string().min(1) }).parse(await req.json());
    const existing = await prisma.employee.findUnique({ where: { id: d.id }, include: { company: true, department: true } });
    if (!existing) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    const dep = await prisma.department.findUnique({ where: { code: d.departmentCode } });
    if (!dep) return NextResponse.json({ error: "Department not found" }, { status: 404 });
    const company = await prisma.company.upsert({ where: { name: d.company }, create: { name: d.company }, update: {} });

    const employee = await prisma.employee.update({
      where: { id: d.id },
      data: { name: d.name, companyId: company.id, departmentId: dep.id },
      include: { company: true, department: true },
    });

    await recordChange("UPDATE", "Employee", employee.id, {
      name: d.name, company: d.company, departmentCode: d.departmentCode,
      before: { name: existing.name, company: existing.company.name, departmentCode: existing.department.code },
    });
    await notifyAll({ title: "تم تعديل مروج", body: `${d.name} · ${d.company} · ${d.departmentCode}`, tag: "employee", level: "important" });
    return NextResponse.json(employee);
  } catch {
    return NextResponse.json({ error: "Unable to update employee" }, { status: 400 });
  }
}

/**
 * Remove a promoter by marking them INACTIVE rather than deleting the row.
 *
 * Invoices and target allocations reference the employee, so a hard delete would fail
 * on the foreign key and would throw away the sales history. Deactivating hides them
 * from the dashboard while keeping every invoice intact and restorable.
 */
export async function DELETE(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const existing = await prisma.employee.findUnique({ where: { id }, include: { company: true, department: true } });
    if (!existing) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    if (existing.status === "INACTIVE") return NextResponse.json({ error: "Employee is already removed" }, { status: 409 });

    await prisma.employee.update({ where: { id }, data: { status: "INACTIVE" } });
    await recordChange("DELETE", "Employee", id, {
      name: existing.name, company: existing.company.name, departmentCode: existing.department.code,
    });
    await notifyAll({ title: "تم حذف مروج", body: `${existing.name} · ${existing.department.code}`, tag: "employee", level: "critical" });
    return NextResponse.json({ ok: true, id });
  } catch {
    return NextResponse.json({ error: "Unable to remove employee" }, { status: 400 });
  }
}

/** Bring a removed promoter back. */
export async function PATCH(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const existing = await prisma.employee.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Employee not found" }, { status: 404 });
    const employee = await prisma.employee.update({ where: { id }, data: { status: "ACTIVE" } });
    await recordChange("RESTORE", "Employee", id, { name: existing.name });
    await notifyAll({ title: "تم استرجاع مروج", body: existing.name, tag: "employee", level: "important" });
    return NextResponse.json(employee);
  } catch {
    return NextResponse.json({ error: "Unable to restore employee" }, { status: 400 });
  }
}