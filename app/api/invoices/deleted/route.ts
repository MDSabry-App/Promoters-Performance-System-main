import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireManager } from "@/lib/auth";

/**
 * Recycle bin: the soft-deleted invoices of one month, for the manager only.
 *
 * It uses the same month range as the main invoice list so the dashboard can offer a
 * one-click restore for anything that was removed by mistake. Rows stay in the table
 * with a `deletedAt` stamp, so this is the only place that can see them.
 */
export async function GET(req: Request) {
  try {
    await requireManager();
  } catch {
    return NextResponse.json({ error: "Manager authentication required" }, { status: 401 });
  }
  try {
    const u = new URL(req.url);
    const year = Number(u.searchParams.get("year"));
    const month = Number(u.searchParams.get("month"));
    if (!year || month < 1 || month > 12) return NextResponse.json({ error: "Invalid year/month" }, { status: 400 });
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    const rows = await prisma.invoice.findMany({
      where: { date: { gte: from, lt: to }, deletedAt: { not: null } },
      include: { employee: { include: { department: true, company: true } } },
      orderBy: { deletedAt: "desc" },
    });
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json({ error: "Unable to load deleted invoices" }, { status: 500 });
  }
}