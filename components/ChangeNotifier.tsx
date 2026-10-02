"use client";

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

type Level = "normal" | "important" | "critical";

type ChangeEvent = {
  id: string;
  title: string;
  body: string;
  kind: string;
  level: Level;
  at: string;
};

type Feed = { events: ChangeEvent[]; cursor: string; serverTime: string };

const POLL_MS = 10_000;
const CURSOR_KEY = "sps-changes-cursor";
const SEEN_KEY = "sps-changes-seen";

/**
 * Android notification channels, one per urgency so the user can fine-tune them.
 * `importance` already drives the vibration pattern on Android, so each channel
 * only needs the boolean `vibration` flag.
 */
const CHANNELS = [
  { id: "sps-critical", name: "حذف وإجراءات حرجة", importance: 5, description: "عمليات الحذف وإغلاق الشهر" },
  { id: "sps-important", name: "تحديثات الأهداف", importance: 4, description: "الأهداف و BOXI والوكالة" },
  { id: "sps-updates", name: "تحديثات المبيعات", importance: 3, description: "الفواتير والمروج و Stuff" },
] as const;

const channelFor = (level: Level) =>
  level === "critical" ? "sps-critical" : level === "important" ? "sps-important" : "sps-updates";

const isNative = () => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

function hash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return h;
}

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>) {
  try {
    // Keep only the most recent ids so the list never grows unbounded.
    localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(seen).slice(-200)));
  } catch {
    /* storage full or unavailable */
  }
}
/**
 * Asks for the Android 13+ POST_NOTIFICATIONS permission and creates every
 * channel up-front, so the very first notification already lands in the right
 * place with the right urgency.
 */
async function prepareNotifications() {
  if (!isNative()) return false;
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display !== "granted") {
      const asked = await LocalNotifications.requestPermissions();
      if (asked.display !== "granted") return false;
    }
  } catch {
    /* older Android grants the permission implicitly */
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
  return true;
}

/** Clears the launcher badge so stale counts never stick around. */
async function clearBadge() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    // `clearAppBadge` works on Chromium but is missing from the DOM lib types.
    const withBadge = reg as unknown as { clearAppBadge?: () => Promise<void> };
    await withBadge?.clearAppBadge?.();
  } catch {
    /* badge unsupported */
  }
}

async function showOnDevice(event: ChangeEvent) {
  const allowed = await prepareNotifications();
  if (!allowed) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          // A stable per-event id stops Android from collapsing distinct updates.
          id: Math.abs(hash(event.id)) % 2_000_000_000,
          title: event.title,
          body: event.body,
          channelId: channelFor(event.level),
          smallIcon: "ic_stat_icon",
          sound: "default",
          ongoing: false,
          autoCancel: true,
          extra: { url: "/" },
        },
      ],
    });
  } catch {
    /* display failed */
  }
}

async function showInBrowser(event: ChangeEvent) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(event.title, {
        body: event.body,
        tag: `sps-${event.kind}-${event.id}`,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        requireInteraction: event.level === "critical",
        vibrate: event.level === "critical" ? [400, 120, 400, 120, 400] : [180, 60, 180],
        data: { url: "/" },
        actions: [{ action: "open", title: "فتح" }],
      } as NotificationOptions);
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(event.title, {
        body: event.body,
        icon: "/icons/icon-192.png",
        tag: `sps-${event.kind}-${event.id}`,
      });
    }
  } catch {
    /* notification display failed */
  }
}
/**
 * Zero-configuration, always-on change notifications.
 *
 * Every mutation the server performs is already recorded in `AuditLog`, so this
 * polls a tiny cursor-based feed and raises a real system notification for each
 * new event — no Firebase project required. It also re-checks as soon as the app
 * returns to the foreground, so nothing is missed while it was backgrounded.
 */
export default function ChangeNotifier() {
  useEffect(() => {
    let stopped = false;

    // Restored from storage so a restart does not re-alert on old events.
    const seen = readSeen();
    let cursor: string | null = null;
    try {
      cursor = localStorage.getItem(CURSOR_KEY);
    } catch {
      cursor = null;
    }

    void prepareNotifications();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped) return;
      try {
        const query = cursor ? `?since=${encodeURIComponent(cursor)}` : "";
        const response = await fetch(`/api/changes${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const feed = (await response.json()) as Feed;
          const fresh = feed.events.filter((e) => !seen.has(e.id));

          // A brand-new install must not replay history as a flood of alerts:
          // mark those events as seen instead of alerting on them.
          if (cursor === null) {
            fresh.forEach((e) => seen.add(e.id));
          } else {
            for (const event of fresh) {
              seen.add(event.id);
              if (isNative()) await showOnDevice(event);
              else await showInBrowser(event);
            }
            if (fresh.length) {
              writeSeen(seen);
              await clearBadge();
            }
          }

          cursor = feed.cursor;
          try {
            localStorage.setItem(CURSOR_KEY, feed.cursor);
          } catch {
            /* storage unavailable */
          }
        }
      } catch {
        /* offline, aborted, or a server hiccup — retried on the next tick */
      } finally {
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }
    }

    void poll();

    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
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