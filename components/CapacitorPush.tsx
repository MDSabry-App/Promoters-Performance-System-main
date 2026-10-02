"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";

type Handle = { remove: () => void } | undefined;

// Must stay in sync with the channels created in components/ChangeNotifier.tsx.
const CHANNELS = [
  { id: "sps-critical", name: "حذف وإجراءات حرجة", description: "عمليات الحذف وإغلاق الشهر", importance: 5 },
  { id: "sps-important", name: "تحديثات الأهداف", description: "الأهداف و BOXI والوكالة", importance: 4 },
  { id: "sps-updates", name: "تحديثات المبيعات", description: "الفواتير والمروج و Stuff", importance: 3 },
] as const;

const channelFor = (level?: string) =>
  level === "critical" ? "sps-critical" : level === "important" ? "sps-important" : "sps-updates";

async function ensureNotificationChannels() {
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display !== "granted") await LocalNotifications.requestPermissions();
  } catch {
    /* older Android grants implicitly */
  }
  for (const channel of CHANNELS) {
    try {
      await LocalNotifications.createChannel({
        id: channel.id,
        name: channel.name,
        description: channel.description,
        importance: channel.importance,
        visibility: 1,
        sound: "default",
        vibration: true,
        lights: true,
        lightColor: channel.importance === 5 ? "#e5484d" : "#173b73",
      });
    } catch {
      /* channel already exists */
    }
  }
}

async function showForeground(title: string, body: string, level?: string) {
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Date.now() % 2_000_000_000),
          title,
          body,
          channelId: channelFor(level),
          smallIcon: "ic_stat_icon",
          sound: "default",
          autoCancel: true,
        },
      ],
    });
  } catch {
    /* display failed */
  }
}

/**
 * Registers for push notifications inside the Android APK (FCM).
 *
 * Requires google-services.json inside android/app/. Without it the plugin throws
 * at runtime, which is caught so the app keeps working with local AutoPush alerts.
 */
export default function CapacitorPush() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || typeof PushNotifications === "undefined") return;

    const handles: Handle[] = [];

    (async () => {
      try {
        await ensureNotificationChannels();

        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== "granted") return;

        await PushNotifications.register();

        handles.push(
          await PushNotifications.addListener("registration", (token: { value: string }) => {
            if (!token.value) return;
            // Re-registering the same endpoint refreshes the stored token, so a
            // rotated FCM registration never leaves a dead device behind.
            fetch("/api/push", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                endpoint: `fcm:${token.value}`,
                token: token.value,
              }),
            }).catch(() => {});
          }),
        );

        handles.push(
          await PushNotifications.addListener("registrationError", (e: { error: string }) => {
            console.warn("CAPACITOR_PUSH_ERROR", e?.error);
          }),
        );

        // When the app is open, FCM delivers silently — surface it as a real
        // system notification so it behaves exactly like a background one.
        handles.push(
          await PushNotifications.addListener(
            "pushNotificationReceived",
            (notification: { title?: string; body?: string; data?: Record<string, string> }) => {
              const title = notification.title || "SPS F1";
              const body = notification.body || "هناك تحديث جديد";
              void showForeground(title, body, notification.data?.level);
            },
          ),
        );

        handles.push(
          await PushNotifications.addListener("pushNotificationActionPerformed", () => {
            /* singleTask MainActivity already brings the dashboard to front */
          }),
        );
      } catch (e) {
        console.warn("CAPACITOR_PUSH_INIT", e);
      }
    })();

    return () => {
      for (const h of handles) h?.remove();
    };
  }, []);

  return null;
}
