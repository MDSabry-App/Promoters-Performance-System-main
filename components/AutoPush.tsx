"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

const PUSH_KEY = "sps-push-enabled";
const POLL_MS = 45_000;
const SNAPSHOT_KEY = "sps-change-snapshot";
const CHANNEL_ID = "sps-updates";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Subscribes the device to server push without any user-facing control. */
async function autoSubscribe() {
  if (Capacitor.isNativePlatform()) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (permission !== "granted") return;
  if (localStorage.getItem(PUSH_KEY) === "off") return;

  try {
    const { publicKey } = await fetch("/api/push", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => ({ publicKey: null }));
    if (!publicKey) return;

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }),
      }).catch(() => {});
    }
    localStorage.setItem(PUSH_KEY, "on");
  } catch {
    /* push unavailable on this platform */
  }
}

/** Compact fingerprint of the month so any change produces a different string. */
function fingerprint(data: {
  byEmployee: Array<{ employeeId: string; target: number; actual: number; warrantyActual: number; agencyActual: number }>;
  totalActual: number;
  invoiceCount: number;
}) {
  return JSON.stringify([
    data.invoiceCount,
    data.totalActual,
    data.byEmployee.map((r) => [r.employeeId, r.target, r.actual, r.warrantyActual, r.agencyActual]),
  ]);
}

/** Asks for the Android 13+ runtime permission and creates the notification channel. */
async function ensureChannel() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display !== "granted") await LocalNotifications.requestPermissions();
  } catch {
    /* older Android grants the permission implicitly */
  }
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: "تحديثات المبيعات",
      description: "إشعارات الفواتير والأهداف والتعديلات",
      importance: 5,
      visibility: 1,
      sound: "default",
      vibration: true,
    });
  } catch {
    /* channel already exists or unsupported */
  }
}

async function showLocal(title: string, body: string) {
  if (Capacitor.isNativePlatform()) {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: Math.floor(Date.now() % 2_000_000_000),
            title,
            body,
            channelId: CHANNEL_ID,
            smallIcon: "ic_stat_icon",
            sound: "default",
            ongoing: false,
          },
        ],
      });
      return;
    } catch {
      return;
    }
  }
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(title, {
        body,
        tag: "sps-change",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        vibrate: [90, 40, 90],
        data: { url: "/" },
      } as NotificationOptions);
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/icons/icon-192.png", tag: "sps-change" });
    }
  } catch {
    /* notification display failed */
  }
}

/**
 * Zero-configuration notifications.
 *
 * Every mutation already calls notifyAll() on the server, so registered devices get a
 * real push. This component also polls the month report so a change made anywhere still
 * raises a local notification (fallback when FCM is not configured yet).
 */
export default function AutoPush() {
  useEffect(() => {
    ensureChannel();
    autoSubscribe();

    const controller = new AbortController();
    let stopped = false;
    let baseline: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (stopped) return;
      try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const response = await fetch(`/api/reports?year=${year}&month=${month}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        const next = fingerprint(data);
        if (baseline !== null && next !== baseline) {
          const count = Number(data.invoiceCount) || 0;
          await showLocal(
            "تحديث بيانات المبيعات",
            count === 1 ? "تم تسجيل فاتورة جديدة." : `تم تسجيل ${count} فاتورة هذا الشهر.`,
          );
        }
        baseline = next;
        try {
          localStorage.setItem(SNAPSHOT_KEY, next);
        } catch {
          /* storage full or unavailable */
        }
      } catch {
        /* offline or aborted */
      } finally {
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    }

    tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
