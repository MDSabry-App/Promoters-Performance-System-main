import { prisma } from "@/lib/prisma";

export async function isMonthLocked(year: number, month: number) {
  const row = await prisma.monthLock.findUnique({
    where: { year_month: { year, month } },
  });
  return !!row?.locked;
}

export async function assertMonthOpen(year: number, month: number) {
  if (await isMonthLocked(year, month)) {
    throw new Error("MONTH_LOCKED");
  }
}
