"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
} from "../../lib/mobile/types";
import {
  cacheBundle,
  loadCachedBundles,
  getPendingSubmissions,
  type PendingSubmission,
} from "../../lib/mobile/idb";
import { useMobileAuth } from "../../components/mobile/MobileAuthProvider";

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_MOBILE_TASKS === "true";

export default function MobileHomePage() {
  const [bundles, setBundles] = useState<MobileBundleResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [pendingSubmissions, setPendingSubmissions] = useState<
    PendingSubmission[]
  >([]);
  const [showQueue, setShowQueue] = useState(false);
  const { fetchWithAuth, session, status, mode } = useMobileAuth();

  useEffect(() => {
    if (!ENABLED) return;
    loadCachedBundles().then(setBundles).catch(() => {});
  }, []);

  useEffect(() => {
    if (!ENABLED) return;
    let mounted = true;
    const readQueue = async () => {
      try {
        const queue = await getPendingSubmissions();
        if (mounted) setPendingSubmissions(queue);
      } catch {
        /* ignore */
      }
    };
    readQueue();
    const interval = setInterval(readQueue, 15_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setOnline(navigator.onLine);
    window.addEventListener("online", handler);
    window.addEventListener("offline", handler);
    return () => {
      window.removeEventListener("online", handler);
      window.removeEventListener("offline", handler);
    };
  }, []);

  if (!ENABLED) {
    return (
      <main className="p-6 text-center">
        <p className="text-gray-600">
          Mobile tasks are disabled in this environment.
        </p>
      </main>
    );
  }

  if (mode === "otp") {
    if (status === "loading") {
      return (
        <main className="p-6 text-center space-y-3">
          <p className="text-sm text-slate-500">Checking session…</p>
        </main>
      );
    }

    if (!session) {
      return (
        <main className="max-w-md mx-auto p-6 space-y-4 text-center">
          <h1 className="text-2xl font-semibold">Sign in to continue</h1>
          <p className="text-sm text-slate-500">
            Use the one-time passcode login to fetch and submit mobile tasks.
          </p>
          <Link
            href="/mobile/login"
            className="inline-flex w-full justify-center rounded-lg bg-blue-600 py-3 font-semibold text-white"
          >
            Launch OTP Login
          </Link>
        </main>
      );
    }
  }

  const flatTasks = bundles.flatMap((bundle) =>
    bundle.tasks.map((task) => ({ bundle_id: bundle.bundle_id, task }))
  );
  const cachedCount = flatTasks.length;
  const queuedCount = pendingSubmissions.length;

  const fetchBundle = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth("/api/mobile/bundle?count=3");
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Failed to fetch bundle");
      }
      const data: MobileBundleResponse = await response.json();
      setBundles((prev) => [data, ...prev]);
      await cacheBundle(data);
    } catch (err: any) {
      setError(err.message || "Failed to fetch bundle");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative mx-auto max-w-md space-y-4 p-4 pb-10">
      <header className="text-center space-y-1">
        <p className="text-sm text-slate-500">Dialect Data</p>
        <h1 className="text-2xl font-semibold">Work on Tasks</h1>
        <p className={`text-xs ${online ? "text-green-600" : "text-amber-600"}`}>
          {online ? "Online" : "Offline mode"}
        </p>
      </header>

      {(cachedCount > 0 || queuedCount > 0) && (
        <button
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 text-left"
          onClick={() => setShowQueue(true)}
        >
          {cachedCount} tasks cached • {queuedCount} submissions queued
        </button>
      )}

      <button
        onClick={fetchBundle}
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white disabled:opacity-60"
      >
        {loading ? "Loading…" : "Get Tasks"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <section className="space-y-3 pb-4">
        {flatTasks.length === 0 ? (
          <p className="text-center text-sm text-slate-500">
            No cached tasks yet. Tap “Get Tasks” to start.
          </p>
        ) : (
          flatTasks.map(({ bundle_id, task }) => (
            <TaskCard key={`${bundle_id}:${task.assignment_id}`} task={task} />
          ))
        )}
      </section>

      {showQueue ? (
        <OfflineQueueModal
          cachedCount={cachedCount}
          pending={pendingSubmissions}
          onClose={() => setShowQueue(false)}
        />
      ) : null}
    </main>
  );
}

function TaskCard({ task }: { task: MobileClaimResponse }) {
  const durationLabel = useMemo(
    () => formatDuration(task.clip.end_ms - task.clip.start_ms),
    [task.clip.end_ms, task.clip.start_ms]
  );
  const { label: leaseLabel } = useLeaseCountdown(task.lease_expires_at);
  const href = `/mobile/tasks/${task.task_id}?assignment=${task.assignment_id}`;
  const hasHint = Boolean(task.ai_suggestion);

  return (
    <a
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow"
      href={href}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {task.task_type.replace("_", " ")}
          </p>
          <p className="text-xl font-semibold">{durationLabel}</p>
          <p className="text-xs text-slate-500">
            {`$${(task.price_cents / 100).toFixed(2)}`} • Lease {leaseLabel}
          </p>
        </div>
        {hasHint ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-blue-700">
            AI hint
          </span>
        ) : null}
      </div>
    </a>
  );
}

function OfflineQueueModal({
  cachedCount,
  pending,
  onClose,
}: {
  cachedCount: number;
  pending: PendingSubmission[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Offline queue
            </p>
            <h2 className="text-lg font-semibold">
              {cachedCount} cached • {pending.length} queued
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-sm font-semibold text-blue-600"
          >
            Close
          </button>
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">
            No submissions waiting for sync.
          </p>
        ) : (
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {pending.map((entry) => (
              <li
                key={entry.idempotencyKey}
                className="rounded-lg border border-slate-200 p-2 text-sm"
              >
                <p className="font-semibold">{entry.task_id}</p>
                <p className="text-xs text-slate-500">
                  Assignment {entry.assignment_id}
                </p>
                <p className="text-xs text-slate-500">
                  Queued {new Date(entry.created_at).toLocaleTimeString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function useLeaseCountdown(expiresAt: string) {
  const compute = () => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) {
      return { label: "Expired", expired: true };
    }
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return {
      label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
      )}`,
      expired: false,
    };
  };
  const [value, setValue] = useState(compute);
  useEffect(() => {
    const id = setInterval(() => setValue(compute()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return value;
}
