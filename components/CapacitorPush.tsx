"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

type Handle = { remove: () => void } | undefined;

/**
 * Registers for push notifications inside the Android APK (FCM).
 *
 * Browser/PWA push is handled by usePushNotifications in app/page.tsx.
 *
 * Requires a google-services.json inside android/app/. Without it the plugin throws
 * at runtime, which is caught and ignored (registration simply never resolves).
 */
export default function CapacitorPush() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || typeof PushNotifications === "undefined") return;

    let reg: Handle;
    let err: Handle;

    (async () => {
      try {
        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== "granted") return;

        await PushNotifications.register();

        reg = await PushNotifications.addListener("registration", (token: { value: string }) => {
          if (!token.value) return;
          fetch("/api/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: `fcm:${token.value}`, token: token.value, keys: { p256dh: "", auth: "" } }),
          }).catch(() => {});
        });

        err = await PushNotifications.addListener("registrationError", (e: { error: string }) => {
          console.warn("CAPACITOR_PUSH_ERROR", e?.error);
        });
      } catch (e) {
        console.warn("CAPACITOR_PUSH_INIT", e);
      }
    })();

    return () => {
      reg?.remove();
      err?.remove();
    };
  }, []);

  return null;
}
