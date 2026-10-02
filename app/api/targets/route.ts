import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";

const body = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  departmentId: z.string(),
  amount: z.number().nonnegative(),
  // Manual overrides: these promoters keep exactly the amount sent here (mode MANUAL).
  // Everything not listed is split equally from the remaining target (mode AUTO).
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
      // Placeholder promoters ("Other" / Stuff B.TECH) never receive a sales target.
      const active = await tx.employee.findMany({
        where: { departmentId: data.departmentId, status: "ACTIVE", NOT: { OR: [{ name: "Other" }, { company: { name: { in: ["Stuff B.TECH", "Stuff Btech"] } } }] } },
        orderBy: { id: "asc" },
      });

      // Keep only manual overrides that target an ACTIVE promoter of this department.
      const activeIds = new Set(active.map((employee) => employee.id));
      const manualMap = new Map(
        (data.employeeTargets || [])
          .filter((item) => item.amount > 0 && activeIds.has(item.employeeId))
          .map((item) => [item.employeeId, item.amount]),
      );
      const manualTotal = [...manualMap.values()].reduce((sum, value) => sum + value, 0);
      if (manualTotal > data.amount) throw new Error("Manual promoter targets exceed the department target.");

      const autoEmployees = active.filter((employee) => !manualMap.has(employee.id));
      const remaining = data.amount - manualTotal;
      const each = autoEmployees.length ? remaining / autoEmployees.length : remaining;

      const target = await tx.monthlyTarget.upsert({
        where: { year_month_departmentId: { year: data.year, month: data.month, departmentId: data.departmentId } },
        create: { year: data.year, month: data.month, departmentId: data.departmentId, amount: data.amount },
        update: { amount: data.amount },
      });

      // Rebuild the allocation from scratch so manual and automatic shares always add up to the total.
      // Deletes every allocation in this department (including placeholders that no longer qualify)
      // because an old allocation can be linked to an older MonthlyTarget row.
      await tx.employeeTarget.deleteMany({
        where: {
          year: data.year,
          month: data.month,
          employee: { departmentId: data.departmentId },
        },
      });

      if (active.length) {
        await tx.employeeTarget.createMany({
          data: active.map((employee) => {
            const manual = manualMap.get(employee.id);
            const isManual = manual !== undefined;
            return {
              year: data.year,
              month: data.month,
              employeeId: employee.id,
              monthlyTargetId: target.id,
              mode: (isManual ? "MANUAL" : "AUTO") as "MANUAL" | "AUTO",
              amount: isManual ? manual : each,
            };
          }),
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
            distribution: manualMap.size ? "MANUAL_WITH_EQUAL_REMAINDER" : "EQUAL_ACTIVE_PROMOTERS",
            promoterCount: active.length,
            manualCount: manualMap.size,
            manualTotal,
            autoCount: autoEmployees.length,
            remaining,
            perPromoter: each,
          },
        },
      });

      return tx.monthlyTarget.findUnique({
        where: { id: target.id },
        include: { department: true, employeeTargets: { include: { employee: true } } },
      });
    });

    const manualCount = (data.employeeTargets || []).filter((item) => item.amount > 0).length;
    await notifyAll({
      title: "Target updated",
      body: `${result?.department?.code || ""} · ${data.amount}${manualCount ? ` · ${manualCount} manual` : " · split equally"}`,
      tag: "target",
    });

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    console.error("TARGET_SAVE_ERROR", e);
    return NextResponse.json({ error: message || "Unable to save target" }, { status: 400 });
  }
}
