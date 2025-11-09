"use client";

import { useEffect, useState } from "react";

/**
 * Lightweight client-side remote config reader.
 * Hits the admin remote-config endpoint (still mock-only) and caches
 * the value in component state so downstream consumers can stay reactive.
 */
export function useRemoteConfigValue<T>(key: string, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    let active = true;

    const fetchValue = async () => {
      try {
        const params = new URLSearchParams({ key });
        const response = await fetch(`/api/admin/remote-config?${params}`);
        if (!response.ok) return;
        const payload = await response.json();
        const raw = payload?.values?.[key];
        if (!active || raw === undefined || raw === null) return;
        setValue(raw as T);
      } catch {
        // ignore network failures; stick to fallback
      }
    };

    fetchValue();
    const interval = window.setInterval(fetchValue, 60_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [key]);

  return value;
}
