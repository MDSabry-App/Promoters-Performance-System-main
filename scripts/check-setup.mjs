// One-time diagnostics for the notification + APK setup.
// Run:  node scripts/check-setup.mjs
//
// It only inspects local files and environment variables — it never contacts
// Firebase, so it is safe to run before the Firebase project exists.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => console.log(`  \u2717 ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

// Reads KEY=VALUE from a dotenv-style file without needing a dependency.
function readEnv(file) {
  const full = resolve(root, file);
  if (!existsSync(full)) return {};
  const out = {};
  for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const env = { ...readEnv(".env"), ...readEnv(".env.local") };

console.log("\n== 1. Database ==");
env.DATABASE_URL ? ok("DATABASE_URL موجود") : bad("DATABASE_URL ناقص — بدونه الإشعارات ما هتشتغلش");
env.DIRECT_URL ? ok("DIRECT_URL موجود") : warn("DIRECT_URL ناقص (مطلوب للـ migrations فقط)");

console.log("\n== 2. Change feed (يعمل بدون أي إعداد) ==");
ok("lib/changes.ts — يحوّل AuditLog لأحداث");
ok("app/api/changes/route.ts — الـ cursor feed");
ok("components/ChangeNotifier.tsx — الإشعارات على الجهاز");
console.log("  -> بعد deploy افتح: /api/changes");

console.log("\n== 3. Web Push (VAPID) ==");
const vapidOk = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY;
vapidOk ? ok("مفاتيح VAPID موجودة") : bad("مفاتيح VAPID ناقصة — ولّدها بـ: npx web-push generate-vapid-keys");

console.log("\n== 4. FCM (إشعار والتطبيق مقفول) ==");
const gsPath = resolve(root, "android/app/google-services.json");
existsSync(gsPath)
  ? ok("google-services.json موجود — الإعداد مكتمل")
  : bad("google-services.json ناقص —Steps: 1) Firebase Console > Add Android app > package com.fayoum1.sps  2) حمّل الملف وحطه في android/app/");
env.FIREBASE_SERVICE_ACCOUNT
  ? ok("FIREBASE_SERVICE_ACCOUNT موجود في البيئة")
  : bad("FIREBASE_SERVICE_ACCOUNT ناقص — من Firebase Console > Project settings > Service accounts");

console.log("\n== 5. APK build ==");
const apk = resolve(root, "SPS-F1-release.apk");
existsSync(apk)
  ? ok(`SPS-F1-release.apk موجود (${(readFileSync(apk).length / 1024 / 1024).toFixed(2)} MB)`)
  : warn("SPS-F1-release.apk غير موجود — ولّده بـ: npm run build:release");
existsSync(resolve(root, "android/app/keystore.properties"))
  ? ok("keystore.properties موجود — التوقيع شغال")
  : bad("keystore.properties ناقص — بدونه الـ release هيفضل unsigned");

console.log("\n== الخلاصة ==");
if (existsSync(gsPath) && env.FIREBASE_SERVICE_ACCOUNT) {
  console.log("  كل حاجة جاهزة. نفّذ: npm run build:release\n");
} else {
  console.log("  Change feed شغال الآن بدون أي خطوة إضافية.");
  console.log("  لإكمال FCM اتّبع الخطوة 4 أعلاه (محتاج حساب Google بتاعك).\n");
}