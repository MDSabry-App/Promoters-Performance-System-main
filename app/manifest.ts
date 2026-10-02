import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Promoters Performance System — F1",
    short_name: "SPS F1",
    description: "Fayoum1 Branch sales performance, targets and invoices.",
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#f4f7fb",
    theme_color: "#173b73",
    categories: ["business", "productivity", "finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Add Invoice", short_name: "Invoice", url: "/?action=invoice" },
      { name: "Promoter Performance", short_name: "Performance", url: "/?action=performance" },
    ],
  };
}