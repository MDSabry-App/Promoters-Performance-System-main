# SPS F1 — Promoters Performance System

Sales / target / invoice dashboard for the **Fayoum1 Branch** (TV-AC · MDA · SDA · MOBILE).

This is an installable Android app built with **Capacitor 7** + a server-side **Web Push** backend.
The APK lives at the project root: `SPS-F1.apk` (debug build).

---

## Quick start (local dev)

```bash
npm install
cp .env.example .env.local        # edit the values to match your Neon DB / ADMIN_PASSWORD
npx prisma generate
npm run dev                       # http://localhost:3000
```

---

## Project layout

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Dashboard UI: cards, accordions, target modal, Stuff, invoice list, toast notifications, Push button, Install button |
| `app/layout.tsx` | Root layout: PWA metadata, viewport, service-worker + capacitor-push registration |
| `app/manifest.ts` | Web App Manifest (`display: standalone`, icons, shortcuts, theme colors) |
| `app/api/*` | REST routes: month, reports, invoices, targets, special-targets, stuff, push, auth, employees |
| `app/api/stuff/route.ts` | New "Stuff" CRUD (company is always `Stuff B.TECH`) |
| `app/api/push/route.ts` | Web-push subscription management + test send |
| `app/api/targets/route.ts` | Department targets, manual per-promoter overrides, excludes placeholders |
| `lib/push.ts` | web-push helper (`notifyAll`) wired into every server action |
| `components/ServiceWorker.tsx` | Registers `/sw.js` + rewrites `/api/*` to `NEXT_PUBLIC_API_BASE` when set |
| `components/usePushNotifications.ts` | Browser/PWA subscribe / unsubscribe hook |
| `components/CapacitorPush.tsx` | FCM registration inside the APK (needs google-services.json) |
| `public/sw.js` | Offline cache (app shell) + push / notificationclick handlers |
| `public/icons/*` `public/logos/stuff-b-tech.png` | App icons and the Stuff B.TECH logo |
| `capacitor.config.ts` | Android shell config (`com.fayoum1.sps` → `https://…` live site) |
| `android/` | Generated Capacitor Android project |
| `prisma/schema.prisma` | Postgres schema (adds `Stuff` + `PushSubscription`) |

---

## Notable behavior changes

### Promoter Performance cards
- Company **name** is no longer rendered in the card; only the logo + promoter name + department.
- The logo column uses a light tinted background (matches the chosen color theme) with a white logo and a transparent logo frame.

### Top Sales / Low Sales
- Rendered as **accordions** (collapsed by default). Click the header to expand.
- The two panels sit side-by-side in a matching grid (`grid-template-columns: 1fr 1fr`); on mobile they stack.
- `Top Sales` → green header; `Low Sales` → red header.

### Department targets (`Sales Target` modal)
- You may leave any promoter blank (they share the remaining target equally) or enter a **manual target** for one or more promoters.
- Placeholder employees (`Other` / company `Stuff B.TECH`) are **never** included in the distribution and are not shown in the list.

### Stuff (`Add Stuff`)
- Company is always `Stuff B.TECH`; the form only collects **Item Name** and **Department**.
- Listed in a dedicated **Stuff** section under Promoter Performance, filtered by the selected department tab.

### Gap color
- Negative gap → red ; positive gap → green (live in Promoter Performance).

---

## Push notifications

There are two paths, and you get the one that matches where the user is:

### 1. Web Push (PWA / mobile browser)  ✅ works now
- The deployed HTTPS site registers a service worker + VAPID subscription.
- Every server action (new invoice, target update, Stuff add/delete, etc.) calls `notifyAll` and pushes a notification to every subscribed browser device — including mobile **when the site is added to the Home Screen**.
- An **Alerts** button appears in the header when supported: tap it to subscribe / unsubscribe.
- Requires VAPID env vars (already generated): `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

### 2. Push inside the APK (FCM)  🔧 setup required
The Capacitor `@capacitor/push-notifications` plugin is installed and wired
(`components/CapacitorPush.tsx`), but the APK can only receive push from **Firebase Cloud Messaging**, not from the Web Push API that the system WebView lacks. To enable it:

1. Create a **Firebase project** and register the Android app:
   - package name: `com.fayoum1.sps`
   - download `google-services.json` → drop it at `android/app/google-services.json`
2. Add Firebase Admin to the server (`npm i firebase-admin`) and, in `lib/push.ts`,
   forward FCM `token` subscriptions through the FCM HTTP v1 API using your service-account key.
3. Rebuild the APK: `npm run build:mobile` (see below).

Until step 1 the APK still runs fine — it just won't show remote push; local in-app toasts still fire for every action.

---

## Building the Android APK

```bash
npm install
npx cap sync android          # copies the latest web assets into the Android project
cd android && .\gradlew.bat assembleDebug   # produces app/build/outputs/apk/debug/app-debug.apk
```

Or from the repo root:
```bash
npm run build:mobile          # runs `next build` then `cap sync android`, then `./gradlew assembleDebug`
```

Install on a phone (developer options / USB debugging):
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

A prebuilt debug APK is shipped at the repo root as **`SPS-F1.apk`**.

### Build notes
- The APK loads the **live** site configured in `capacitor.config.ts` (`server.url`).
  Update that URL with `CAPACITOR_SERVER_URL=…` before rebuilding if your domain changes.
- `compileSdkVersion = 35`, requires the `android-35` SDK platform.

---

## Env reference (`.env.example`)

```
DATABASE_URL=              # Neon PostgreSQL connection string
DIRECT_URL=                # Neon direct (pool-less) URL
ADMIN_PASSWORD=            # used by the manager login form
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
NEXT_PUBLIC_API_BASE=      # only set for a static-export build that calls a remote API
```

---

## Verification

- `npx tsc --noEmit` — type-checks.
- `npm run build` — production web build.
- `npm run build:mobile` — full Android APK (debug).
