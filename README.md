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
| `components/ChangeNotifier.tsx` | Change-feed notifier: polls `/api/changes`, raises real system notifications (APK + browser) |
| `components/usePushNotifications.ts` | Browser/PWA subscribe / unsubscribe hook |
| `components/CapacitorPush.tsx` | FCM registration inside the APK (needs google-services.json) |
| `lib/changes.ts` | Maps an `AuditLog` row to a display-ready change event (Arabic copy + urgency) |
| `app/api/changes/route.ts` | Cursor-based change feed (`?since=`) feeding the notifier |
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

## Protecting your data

The dashboard lives in a single Neon database with no history of its own, and on
2026-10-01 four invoices were deleted by mistake. The audit log only held their
invoice numbers, so the amounts could never be recovered. Three safeguards now stop
that from happening again.

### 1. Backups (`npm run db:backup`)

Dumps every table to `backups/latest.json` plus a dated copy. A GitHub Actions
workflow (`.github/workflows/db-backup.yml`) runs it every day at 02:00 UTC and
commits the result, so **every day is a restore point in the repository history**.

```bash
npm run db:backup                 # take a snapshot now
```

Requires the repository secrets `DATABASE_URL` and `DIRECT_URL` in
**Settings → Secrets and variables → Actions**.

### 2. Restoring (`npm run db:restore`)

Dry run by default — it prints what would change and writes nothing:

```bash
npm run db:restore                              # scan backups/latest.json
npm run db:restore -- backups/2026-10-03.json   # scan a specific day
npm run db:restore -- backups/latest.json --yes # actually apply
```

Only `--yes` writes. Applying upserts the dump back and removes rows that are not in
it, so pause the app while it runs.

### 3. Soft delete + recycle bin

Deleting an invoice no longer removes the row. It is stamped with `deletedAt` and
kept out of every report (`deletedAt: null` is filtered on all read paths).

- `GET /api/invoices/deleted?year=&month=` — the recycle bin (manager only)
- `PATCH /api/invoices?id=` — restore an invoice

The dashboard shows the bin under the invoice list, with a **Restore** button per
row. Rows are dimmed and struck through so they are clearly out of the totals.

### 4. Full audit trail

`AuditLog` now stores `before` and `after` JSON snapshots, so an edit no longer
destroys the values it replaced — you can always see the old amount and promoter.
The change feed renders these too (`12,000 ← 15,000`), and invoice deletions are
reported with the amount that was removed.

---

## Push notifications

There are **two independent layers**. Together they give you a notification for
**every change made from the website or the app**:

### 1. Change feed notifier ✅ works now, no setup
Every write already lands in the `AuditLog` table, so the system is fully
automatic — nothing to configure.

| Piece | Role |
|-------|------|
| `lib/changes.ts` | Turns an `AuditLog` row into a ready-to-display event (Arabic title/body, kind, urgency level) |
| `app/api/changes/route.ts` | Cursor-based feed: `GET /api/changes?since=<iso>` returns only what is new |
| `components/ChangeNotifier.tsx` | Polls every 10 s, raises a real system notification per new event, clears the app badge |

Notifications are raised the right way on each platform:
- **APK (Android)** — `@capacitor/local-notifications`, with three channels so the
  user can tune them: `sps-critical` (deletes / month close), `sps-important`
  (targets), `sps-updates` (invoices, promoters, Stuff).
- **Browser / PWA** — Service Worker notification with icon, badge, vibration and
  a “فتح” action.

It also re-checks the moment the app returns to the foreground, and on a fresh
install the recent history is marked as seen instead of replayed as a flood.

> Works while the app is open or backgrounded. For a push that arrives even when
> the app is fully closed, enable FCM below.

### 2. Web Push (VAPID) ✅ works now
- The deployed HTTPS site registers a service worker + VAPID subscription.
- Every server action calls `notifyAll`, pushing to every subscribed browser device.
- Requires `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

### 3. FCM inside the APK — delivers with the app fully closed 🔧 one-time setup
An Android WebView has no Web Push API, so true background delivery needs
**Firebase Cloud Messaging**. The client (`components/CapacitorPush.tsx`), the
server sender (`lib/push.ts`) and the Gradle wiring are all ready — only two
secrets are missing:

1. **Firebase project**
   - Add an Android app with package name `com.fayoum1.sps`
   - Download `google-services.json` → place it at `android/app/google-services.json`
     (a template lives at `android/app/google-services.json.example`)
2. **Server key**
   - Firebase Console → Project settings → Service accounts → Generate new private key
   - Paste the whole JSON into `FIREBASE_SERVICE_ACCOUNT` (see `.env.example`)

3. Rebuild: `npm run build:release`

Once both are in place the FCM branch of `notifyAll` switches on by itself, using
the same channels and urgency levels as the change feed.

---

## Building the Android APK

```bash
npm install
npx cap sync android                      # copies the latest web assets into the Android project
cd android && .\gradlew.bat assembleDebug # debug APK
```

Or from the repo root:
```bash
npm run build:apk          # debug APK
npm run build:release      # signed release APK → ./SPS-F1-release.apk
```

Install on a phone (developer options / USB debugging):
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

A **signed release** APK is shipped at the repo root as **`SPS-F1-release.apk`**
(cert `CN=SPS F1, O=Fayoum1`). Release signing reads `android/app/keystore.properties`.

### Build notes
- The APK loads the **live** site configured in `capacitor.config.ts` (`server.url`).
  Update that URL with `CAPACITOR_SERVER_URL=…` before rebuilding if your domain changes.
- `compileSdkVersion = 35`, `minSdkVersion = 23`, `targetSdkVersion = 34`.
- `POST_NOTIFICATIONS` is declared, so Android 13+ prompts the user on first launch.
- Notification channels (`sps-critical`, `sps-important`, `sps-updates`) are created at runtime.
- The web layer must be **deployed** for the APK to work — the shell only points at the live URL.

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
- `npm run build:release` — signed release APK → `SPS-F1-release.apk`.
- `npm run check:setup` — reports which notification paths are live and what is missing.

### Live diagnostics after deploy
- `GET /api/push?status=1` — per-path status (Web Push / FCM / change feed) with device counts.
- `GET /api/changes?since=<iso>` — the change feed the notifier consumes.
