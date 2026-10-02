import crypto from "node:crypto";
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
  /** Drives the Android channel + FCM priority. Defaults to "normal". */
  level?: "normal" | "important" | "critical";
};

/** FCM channel per urgency — must match the channels created in ChangeNotifier. */
function fcmChannel(level: PushPayload["level"]) {
  if (level === "critical") return { id: "sps-critical", priority: "high" as const };
  if (level === "important") return { id: "sps-important", priority: "high" as const };
  return { id: "sps-updates", priority: "normal" as const };
}

// ------------------------------------------------------------------ FCM (native APK)

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key };
  } catch {
    return null;
  }
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Builds a signed RS256 JWT and exchanges it for an OAuth access token. */
async function fcmAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(account.private_key.replace(/\\n/g, "\n"));
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!response.ok) throw new Error(`FCM_AUTH_${response.status}`);
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("FCM_AUTH_NO_TOKEN");
  return data.access_token;
}

async function sendFcm(token: string, payload: PushPayload, accessToken: string) {
  const channel = fcmChannel(payload.level);
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount()!.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: payload.title, body: payload.body },
        data: {
          tag: payload.tag || "sps",
          url: payload.url || "/",
          level: payload.level || "normal",
        },
        android: {
          priority: channel.priority,
          notification: {
            channel_id: channel.id,
            tag: payload.tag || "sps",
            // Critical updates (deletions) keep the notification on screen.
            default_vibrate_timings: false,
            notification_priority: payload.level === "critical" ? "PRIORITY_MAX" : "PRIORITY_DEFAULT",
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`FCM_SEND_${response.status}`);
}

/**
 * Sends a push notification to every registered device.
 * Never throws: a notification failure must not break the action that triggered it.
 */
export async function notifyAll(payload: PushPayload) {
  let sent = 0;
  let skipped = false;

  try {
    const subs = await prisma.pushSubscription.findMany();

    // Native devices registered through Capacitor carry an FCM token, not a web-push key.
    const native = subs.filter((s) => s.token || s.endpoint.startsWith("fcm:"));
    const web = subs.filter((s) => !s.token && !s.endpoint.startsWith("fcm:"));

    if (web.length) {
      if (!pushReady()) {
        skipped = true;
      } else {
        const body = JSON.stringify(payload);
        const results = await Promise.allSettled(
          web.map((sub) =>
            webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body),
          ),
        );

        // Drop only web subscriptions the browser has invalidated (404/410).
        const dead = results
          .map((r, i) => ({ r, s: web[i] }))
          .filter(({ r }) => r.status === "rejected" && [404, 410].includes((r.reason as { statusCode?: number })?.statusCode || 0))
          .map(({ s }) => s.endpoint);

        if (dead.length) {
          await prisma.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } }).catch(() => {});
        }
        sent += results.filter((r) => r.status === "fulfilled").length;
      }
    }

    if (native.length) {
      const account = serviceAccount();
      if (account) {
        try {
          const accessToken = await fcmAccessToken(account);
          const tokens = native.map((s) => s.token || s.endpoint.replace(/^fcm:/, ""));
          const results = await Promise.allSettled(tokens.map((t) => sendFcm(t, payload, accessToken)));

          // UNREGISTERED / INVALID_ARGUMENT mean the token is gone for good.
          const deadIndexes = results
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => r.status === "rejected" && /FCM_SEND_(400|404)/.test((r.reason as Error)?.message || ""))
            .map(({ i }) => tokens[i]);

          if (deadIndexes.length) {
            await prisma.pushSubscription.deleteMany({ where: { token: { in: deadIndexes } } }).catch(() => {});
          }
          sent += results.filter((r) => r.status === "fulfilled").length;
        } catch (e) {
          console.error("PUSH_FCM_ERROR", e);
        }
      } else {
        skipped = true;
      }
    }

    if (!subs.length) return { sent: 0, skipped: false };
    return { sent, skipped };
  } catch (e) {
    console.error("PUSH_SEND_ERROR", e);
    return { sent: 0, skipped: true };
  }
}