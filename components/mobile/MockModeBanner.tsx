"use client";

import { useMobileAuth } from "./MobileAuthProvider";

export function MockModeBanner() {
  const { mockActive } = useMobileAuth();

  if (!mockActive) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-4">
      <div className="pointer-events-auto rounded-full bg-amber-100 px-4 py-2 text-xs font-semibold text-amber-800 shadow-lg ring-1 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-300/40">
        Mock data active — Supabase/Bunny unreachable or mock mode enabled
      </div>
    </div>
  );
}
