"use client";

const SW_PATH = "/mobile/sw.js";

export function registerMobileServiceWorker() {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    process.env.NEXT_PUBLIC_ENABLE_MOBILE_TASKS !== "true"
  ) {
    return;
  }
  navigator.serviceWorker
    .register(SW_PATH)
    .catch((err) => console.warn("[mobile] sw registration failed", err));
}

