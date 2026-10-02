"use client";

import { useEffect } from "react";

/**
 * The Android build ships a static bundle, so relative /api/* calls are rewritten to
 * the deployed backend (NEXT_PUBLIC_API_BASE). On the normal web deploy the base is
 * empty and every request stays relative.
 */
function useApiBase() {
  useEffect(() => {
    const base = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
    if (!base) return;

    const original = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (raw.startsWith("/api/")) {
        const target = base + raw;
        if (typeof input === "string" || input instanceof URL) return original(target, init);
        return original(new Request(target, input as Request), init);
      }
      return original(input as RequestInfo, init);
    }) as typeof window.fetch;
  }, []);
}

export default function ServiceWorker() {
  useApiBase();

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}