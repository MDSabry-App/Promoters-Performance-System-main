import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { pushReady } from "@/lib/push";
import { requireManager } from "@/lib/auth";
import { notifyAll } from "@/lib/push";

const sendSchema = z.object({ title: z.string(), body: z.string(), tag: z.string().optional(), url: z.string().optional() });
const schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).optional(),
  token: z.string().optional(),
});

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("send") === "1") {
    return NextResponse.json({ ready: pushReady(), ...(await notifyAll({ title: "Test notification", body: "SPS F1 push works." })) });
  }
  return NextResponse.json({ ready: pushReady(), publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null });
}

export async function POST(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("send") === "1") {
    try { await requireManager(); } catch { return NextResponse.json({ error: "Manager authentication required" }, { status: 401 }); }
    const data = sendSchema.parse(await req.json());
    return NextResponse.json(await notifyAll({ title: data.title, body: data.body, tag: data.tag, url: data.url }));
  }

  const data = schema.parse(await req.json());
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: data.endpoint },
    create: { endpoint: data.endpoint, p256dh: data.keys?.p256dh || "", auth: data.keys?.auth || "", token: data.token || null, userAgent: req.headers.get("user-agent") },
    update: { p256dh: data.keys?.p256dh || "", auth: data.keys?.auth || "", token: data.token || null, userAgent: req.headers.get("user-agent") },
  });
  return NextResponse.json({ ok: true, id: row.id });
}

export async function DELETE(req: Request) {
  try {
    const u = new URL(req.url);
    const endpoint = u.searchParams.get("endpoint");
    if (!endpoint) return NextResponse.json({ error: "endpoint required" }, { status: 400 });
    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    return NextResponse.json({ error: message || "Unable to unsubscribe" }, { status: 400 });
  }
}