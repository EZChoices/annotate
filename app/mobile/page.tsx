"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
} from "../../lib/mobile/types";
import { cacheBundle, loadCachedBundles } from "../../lib/mobile/idb";
import { useMobileAuth } from "../../components/mobile/MobileAuthProvider";

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_MOBILE_TASKS === "true";

export default function MobileHomePage() {
  const [bundles, setBundles] = useState<MobileBundleResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const { fetchWithAuth, session, status, mode } = useMobileAuth();

  useEffect(() => {
    if (!ENABLED) return;
    loadCachedBundles().then(setBundles).catch(() => {});
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
    <main className="max-w-md mx-auto p-4 space-y-4">
      <header className="text-center">
        <p className="text-sm text-slate-500">Dialect Data</p>
        <h1 className="text-2xl font-semibold">Work on Tasks</h1>
        <p className={`text-xs ${online ? "text-green-600" : "text-amber-600"}`}>
          {online ? "Online" : "Offline mode"}
        </p>
      </header>
      <button
        onClick={fetchBundle}
        disabled={loading}
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-semibold disabled:opacity-60"
      >
        {loading ? "Loading…" : "Get Tasks"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <section className="space-y-3">
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
    </main>
  );
}

function TaskCard({ task }: { task: MobileClaimResponse }) {
  const durationSec = Math.round(
    (task.clip.end_ms - task.clip.start_ms) / 1000
  );
  const href = `/mobile/tasks/${task.task_id}?assignment=${task.assignment_id}`;
  return (
    <a
      className="block rounded-xl bg-white p-4 shadow border border-slate-200"
      href={href}
    >
      <div className="flex justify-between items-center">
        <div>
          <p className="font-semibold capitalize">
            {task.task_type.replace("_", " ")}
          </p>
          <p className="text-xs text-slate-500">{durationSec}s clip</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-green-600">
            ${(task.price_cents / 100).toFixed(2)}
          </p>
          <p className="text-[11px] text-slate-500">
            Lease until {new Date(task.lease_expires_at).toLocaleTimeString()}
          </p>
        </div>
      </div>
    </a>
  );
}
