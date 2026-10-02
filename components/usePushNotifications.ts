"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "sps-push-enabled";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export type PushState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  publicKey: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

export function usePushNotifications(): PushState {
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [subscribed, setSubscribed] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    const ok = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(ok);
    setPermission(ok ? Notification.permission : "unsupported");
    if (!ok) return;

    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});

    fetch("/api/push")
      .then((r) => r.json())
      .then((d) => setPublicKey(d.publicKey || null))
      .catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    if (!supported || !publicKey) return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result !== "granted") return;

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
    setSubscribed(true);
    localStorage.setItem(KEY, "1");
  }, [publicKey, supported]);

  const disable = useCallback(async () => {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch(`/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" }).catch(() => {});
      await subscription.unsubscribe().catch(() => {});
    }
    setSubscribed(false);
    localStorage.removeItem(KEY);
  }, []);

  return { supported, permission, subscribed, publicKey, enable, disable };
}