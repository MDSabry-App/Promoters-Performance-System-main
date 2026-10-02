import type { CapacitorConfig } from "@capacitor/cli";

// The APK is a native shell around the deployed dashboard: the Android WebView loads
// the live site, so invoices/targets/stuff keep using the same API and database.
// Update server.url whenever the production domain changes.
const liveUrl = process.env.CAPACITOR_SERVER_URL || "https://promoters-performance-system-eta.vercel.app/";

const config: CapacitorConfig = {
  appId: "com.fayoum1.sps",
  appName: "SPS F1",
  // The dashboard needs a live server (API routes + database), so a static export is not
  // possible. `offline/` only holds the page shown when server.url cannot be reached.
  webDir: "offline",
  server: {
    url: liveUrl,
    cleartext: false,
    androidScheme: "https",
    // Shown instead of a blank WebView when the site is unreachable.
    errorPath: "index.html",
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon",
      iconColor: "#173b73",
    },
  },
};

export default config;