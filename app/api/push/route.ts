import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { pushReady, notifyAll } from "@/lib/push";
import { requireManager } from "@/lib/auth";

const sendSchema = z.object({
  title: z.string(),
  body: z.string(),
  tag: z.string().optional(),
  url: z.string().optional(),
  level: z.enum(["normal", "important", "critical"]).optional(),
});

/** Web Push uses a real HTTPS endpoint; native APK uses `fcm:<deviceToken>`. */
const schema = z
  .object({
    endpoint: z.string().min(1),
    keys: z
      .object({
        p256dh: z.string(),
        auth: z.string(),
      })
      .optional(),
    token: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const isFcm = Boolean(data.token) || data.endpoint.startsWith("fcm:");
    if (isFcm) {
      if (!data.token && data.endpoint.length < 5) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "FCM token required", path: ["token"] });
      }
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(data.endpoint);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid web-push endpoint URL", path: ["endpoint"] });
    }
    if (!data.keys?.p256dh || !data.keys?.auth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Web Push keys required", path: ["keys"] });
    }
  });

export async function GET(req: Request) {
  const u = new URL(req.url);

  // Diagnostics: which notification paths are live right now, and what is missing.
  if (u.searchParams.get("status") === "1") {
    try {
      const [web, native, recent] = await Promise.all([
        prisma.pushSubscription.count({ where: { token: null, NOT: { endpoint: { startsWith: "fcm:" } } } }),
        prisma.pushSubscription.count({ where: { NOT: { token: null } } }),
        prisma.auditLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
      ]);
      const fcmConfigured = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
      return NextResponse.json({
        webPush: { configured: pushReady(), devices: web, label: "Web Push (VAPID) — يعمل على المتصفح والـ PWA" },
        fcm: {
          configured: fcmConfigured,
          devices: native,
          label: "FCM — يوصل للتطبيق المقفول (يحتاج FIREBASE_SERVICE_ACCOUNT)",
          missing: fcmConfigured ? null : "أضف FIREBASE_SERVICE_ACCOUNT في إعدادات Vercel",
        },
        changeFeed: {
          active: true,
          eventsLast24h: recent,
          label: "Change feed — يعمل بدون أي إعداد (يعتمد على AuditLog)",
        },
      });
    } catch (e) {
      console.error("PUSH_STATUS_ERROR", e);
      return NextResponse.json({ error: "Unable to read push status" }, { status: 503 });
    }
  }

  if (u.searchParams.get("send") === "1") {
    return NextResponse.json({
      ready: pushReady(),
      ...(await notifyAll({ title: "إشعار تجريبي", body: "إشعارات SPS F1 تعمل بنجاح.", level: "important" })),
    });
  }
  return NextResponse.json({ ready: pushReady(), publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null });
}

export async function POST(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("send") === "1") {
    try {
      await requireManager();
    } catch {
      return NextResponse.json({ error: "Manager authentication required" }, { status: 401 });
    }
    const data = sendSchema.parse(await req.json());
    return NextResponse.json(await notifyAll({ title: data.title, body: data.body, tag: data.tag, url: data.url, level: data.level }));
  }

  const data = schema.parse(await req.json());
  const isFcm = Boolean(data.token) || data.endpoint.startsWith("fcm:");
  const token = isFcm ? data.token || data.endpoint.replace(/^fcm:/, "") : null;
  const endpoint = isFcm ? `fcm:${token}` : data.endpoint;

  const row = await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      endpoint,
      p256dh: data.keys?.p256dh || "",
      auth: data.keys?.auth || "",
      token,
      userAgent: req.headers.get("user-agent"),
    },
    update: {
      p256dh: data.keys?.p256dh || "",
      auth: data.keys?.auth || "",
      token,
      userAgent: req.headers.get("user-agent"),
    },
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
