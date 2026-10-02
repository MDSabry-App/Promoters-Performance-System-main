import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toChangeEvent } from "@/lib/changes";

/**
 * Lightweight change feed used by the device notifier.
 *
 * The client passes the timestamp of the newest event it already saw (`since`)
 * and receives only what happened afterwards, so polling stays cheap and every
 * edit — made from the website or the app — produces a real notification.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const sinceParam = u.searchParams.get("since");

  // Default window: last 5 minutes so a freshly opened app shows recent activity
  // instead of silently dropping it, while still avoiding a flood on first run.
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 5 * 60 * 1000);
  if (Number.isNaN(since.getTime())) {
    return NextResponse.json({ error: "Invalid since timestamp" }, { status: 400 });
  }

  try {
    const rows = await prisma.auditLog.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    const events = rows.map(toChangeEvent);
    const cursor = rows.length ? rows[rows.length - 1].createdAt.toISOString() : since.toISOString();

    return NextResponse.json(
      { events, cursor, serverTime: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    console.error("CHANGES_FETCH_ERROR", e);
    return NextResponse.json({ error: "Unable to load changes" }, { status: 503 });
  }
}