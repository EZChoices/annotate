"use client";

import { ReactNode, useEffect } from "react";
import {
  getPendingSubmissions,
  clearPendingSubmission,
} from "../../lib/mobile/idb";
import { registerMobileServiceWorker } from "../../lib/mobile/sw-register";

export function MobileSyncProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    registerMobileServiceWorker();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = async () => {
      const queue = await getPendingSubmissions();
      for (const submission of queue) {
        try {
          const response = await fetch(submission.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": submission.idempotencyKey,
            },
            body: JSON.stringify({
              assignment_id: submission.assignment_id,
              task_id: submission.task_id,
              payload: submission.payload,
              duration_ms: submission.duration_ms,
              playback_ratio: submission.playback_ratio,
            }),
          });
          if (response.ok) {
            await clearPendingSubmission(submission.idempotencyKey);
          }
        } catch (error) {
          console.warn("[mobile] failed to flush submission", error);
          const registration = await navigator.serviceWorker?.ready;
          await (registration as any)?.sync?.register("dd-submit").catch(() => {});
          break;
        }
      }
    };
    flush();
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "dd-sync") {
        flush();
      }
    };
    navigator.serviceWorker?.addEventListener("message", handler);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handler);
    };
  }, []);

  return <>{children}</>;
}
