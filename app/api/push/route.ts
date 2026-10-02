import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { pushReady } from "@/lib/push";

const schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export async function GET() {
  return NextResponse.json({ ready: pushReady(), publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null });
}

export async function POST(req: Request) {
  try {
    const data = schema.parse(await req.json());
    const row = await prisma.pushSubscription.upsert({
      where: { endpoint: data.endpoint },
      create: { endpoint: data.endpoint, p256dh: data.keys.p256dh, auth: data.keys.auth, userAgent: req.headers.get("user-agent") },
      update: { p256dh: data.keys.p256dh, auth: data.keys.auth, userAgent: req.headers.get("user-agent") },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown database error";
    return NextResponse.json({ error: message || "Unable to subscribe" }, { status: 400 });
  }
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