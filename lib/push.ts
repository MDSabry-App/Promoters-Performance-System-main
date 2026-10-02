import webpush from "web-push";
import { prisma } from "@/lib/prisma";

let configured = false;

/** Configures web-push from VAPID_* env vars. Returns false when keys are missing. */
export function pushReady() {
  if (configured) return true;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  tag?: string;
  url?: string;
};

/**
 * Sends a push notification to every registered device.
 * Never throws: a notification failure must not break the action that triggered it.
 */
export async function notifyAll(payload: PushPayload) {
  if (!pushReady()) return { sent: 0, skipped: true };
  try {
    const subs = await prisma.pushSubscription.findMany();
    if (!subs.length) return { sent: 0, skipped: false };

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        ),
      ),
    );

    // Drop subscriptions the browser has invalidated (404/410).
    const dead = results
      .map((r, i) => ({ r, s: subs[i] }))
      .filter(({ r }) => r.status === "rejected" && [404, 410].includes((r.reason as { statusCode?: number })?.statusCode || 0))
      .map(({ s }) => s.endpoint);

    if (dead.length) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } }).catch(() => {});
    }

    return { sent: results.filter((r) => r.status === "fulfilled").length, skipped: false };
  } catch (e) {
    console.error("PUSH_SEND_ERROR", e);
    return { sent: 0, skipped: true };
  }
}