import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";

const body = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  departmentId: z.string(),
  amount: z.number().nonnegative(),
  // Kept optional for backwards compatibility with older clients; sales targets are always automatic.
  employeeTargets: z.array(z.object({ employeeId: z.string(), amount: z.number().nonnegative() })).optional(),
});

export async function GET(req: Request) {
  const u = new URL(req.url);
  const year = Number(u.searchParams.get("year"));
  const month = Number(u.searchParams.get("month"));
  if (!year || !month) return NextResponse.json({ error: "year and month required" }, { status: 400 });

  const rows = await prisma.monthlyTarget.findMany({
    where: { year, month },
    include: { department: true, employeeTargets: { include: { employee: true } } },
  });
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  try { await requireManager(); }
  catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }

  try {
    const data = body.parse(await req.json());

    const result = await prisma.$transaction(async (tx) => {
      const active = await tx.employee.findMany({
        where: { departmentId: data.departmentId, status: "ACTIVE" },
        orderBy: { id: "asc" },
      });

      const target = await tx.monthlyTarget.upsert({
        where: { year_month_departmentId: { year: data.year, month: data.month, departmentId: data.departmentId } },
        create: { year: data.year, month: data.month, departmentId: data.departmentId, amount: data.amount },
        update: { amount: data.amount },
      });

      // Sales targets are always distributed equally across every ACTIVE promoter.
      // Remove ALL previous allocations for these promoters in this month first.
      // This is important when an old allocation was linked to an older MonthlyTarget row.
      if (active.length) {
        await tx.employeeTarget.deleteMany({
          where: {
            year: data.year,
            month: data.month,
            employeeId: { in: active.map((employee) => employee.id) },
          },
        });
      }

      const each = active.length ? data.amount / active.length : 0;
      if (active.length) {
        await tx.employeeTarget.createMany({
          data: active.map((employee) => ({
            year: data.year,
            month: data.month,
            employeeId: employee.id,
            monthlyTargetId: target.id,
            mode: "AUTO" as const,
            amount: each,
          })),
        });
      }

      await tx.auditLog.create({
        data: {
          action: "UPDATE",
          entity: "MonthlyTarget",
          entityId: target.id,
          details: {
            year: data.year,
            month: data.month,
            departmentId: data.departmentId,
            amount: data.amount,
            distribution: "EQUAL_ACTIVE_PROMOTERS",
            promoterCount: active.length,
            perPromoter: each,
          },
        },
      });

      return tx.monthlyTarget.findUnique({
        where: { id: target.id },
        include: { department: true, employeeTargets: { include: { employee: true } } },
      });
    });

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    console.error("TARGET_SAVE_ERROR", e);
    return NextResponse.json({ error: message || "Unable to save target" }, { status: 400 });
  }
}
