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
  clearPendingSubmission,
  type PendingSubmission,
  clearAllPendingSubmissions,
} from "../../lib/mobile/idb";
import { useMobileAuth } from "../../components/mobile/MobileAuthProvider";
import { useTranslations } from "../../components/mobile/useTranslations";
import { LocaleToggle } from "../../components/mobile/LocaleToggle";
import { useMobileToast } from "../../components/mobile/MobileToastProvider";

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_MOBILE_TASKS !== "false";
const TASK_LABELS: Record<string, string> = {
  translation_check: "Check Translation",
  accent_tag: "Tag Accent",
  emotion_tag: "Classify Emotion",
  speaker_continuity: "Approve Clip",
  gesture_tag: "Tag Gestures",
  safety_flag: "Flag Quality",
};

function getTaskLabel(type: string) {
  return TASK_LABELS[type] || type.replace(/_/g, " ");
}
type QueueActionState = { type: "retry" | "remove"; id: string } | null;
type BulkActionState = "retryAll" | "clearAll" | null;

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
  const [queueAction, setQueueAction] = useState<QueueActionState>(null);
  const [bulkAction, setBulkAction] = useState<BulkActionState>(null);
  const { fetchWithAuth, session, status, mode } = useMobileAuth();
  const t = useTranslations();
  const { pushToast } = useMobileToast();

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
        <p className="text-gray-600">{t("mobileDisabled")}</p>
      </main>
    );
  }

  if (mode === "otp") {
    if (status === "loading") {
      return (
        <main className="p-6 text-center space-y-3">
          <p className="text-sm text-slate-500">Checking session...</p>
        </main>
      );
    }

    if (!session) {
      return (
        <main className="max-w-md mx-auto p-6 space-y-4 text-center">
          <h1 className="text-2xl font-semibold">{t("signInTitle")}</h1>
          <p className="text-sm text-slate-500">
            Use the one-time passcode login to fetch and submit mobile tasks.
          </p>
          <Link
            href="/mobile/login"
            className="inline-flex w-full justify-center rounded-lg bg-blue-600 py-3 font-semibold text-white"
          >
            {t("launchOtp")}
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
      const message = err?.message || "Failed to fetch bundle";
      setError(message);
      pushToast(message, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveSubmission = async (submission: PendingSubmission) => {
    setQueueAction({ type: "remove", id: submission.idempotencyKey });
    try {
      await clearPendingSubmission(submission.idempotencyKey);
      setPendingSubmissions((prev) =>
        prev.filter((item) => item.idempotencyKey !== submission.idempotencyKey)
      );
    } catch (err: any) {
      const message = err?.message || t("retryFailed");
      setError(message);
      pushToast(message, "error");
    } finally {
      setQueueAction(null);
    }
  };

  const handleRetrySubmission = async (submission: PendingSubmission) => {
    setQueueAction({ type: "retry", id: submission.idempotencyKey });
    try {
      const response = await fetchWithAuth(submission.endpoint, {
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
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || t("retryFailed"));
      }
      await clearPendingSubmission(submission.idempotencyKey);
      setPendingSubmissions((prev) =>
        prev.filter((item) => item.idempotencyKey !== submission.idempotencyKey)
      );
    } catch (err: any) {
      const message = err?.message || t("retryFailed");
      setError(message);
      pushToast(message, "error");
      if (typeof navigator !== "undefined") {
        const registration = await navigator.serviceWorker?.ready;
        await (registration as any)?.sync?.register("dd-submit").catch(() => {});
      }
    } finally {
      setQueueAction(null);
    }
  };

  const handleRetryAllPending = async () => {
    if (!pendingSubmissions.length) return;
    setBulkAction("retryAll");
    try {
      const queueSnapshot = [...pendingSubmissions];
      for (const submission of queueSnapshot) {
        // eslint-disable-next-line no-await-in-loop
        await handleRetrySubmission(submission);
      }
      pushToast(t("retryAllQueuedSuccess"), "success");
    } finally {
      setBulkAction(null);
    }
  };

  const handleClearQueue = async () => {
    if (!pendingSubmissions.length) return;
    setBulkAction("clearAll");
    try {
      await clearAllPendingSubmissions();
      setPendingSubmissions([]);
      pushToast(t("clearQueueSuccess"), "success");
    } catch (err: any) {
      const message = err?.message || t("queueClearFailed");
      setError(message);
      pushToast(message, "error");
    } finally {
      setBulkAction(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-24 pt-6">
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 via-indigo-500 to-slate-900 p-5 shadow-2xl ring-1 ring-white/10">
          <div className="absolute inset-0 opacity-30 mix-blend-overlay">
            <div className="absolute -left-10 top-6 h-28 w-28 rounded-full bg-white/20 blur-3xl" />
            <div className="absolute right-2 bottom-6 h-24 w-24 rounded-full bg-emerald-300/20 blur-3xl" />
          </div>
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-white/70">
                {t("brand")}
              </p>
              <h1 className="mt-1 text-3xl font-bold leading-tight text-white">
                {t("workOnTasks")}
              </h1>
              <p className="mt-1 text-sm text-white/80">
                Clip bundles refresh throughout the day. Stay in flow.
              </p>
            </div>
            <LocaleToggle />
          </div>
          <div className="relative mt-4 grid grid-cols-3 gap-3 text-sm font-semibold text-white/90">
            <StatusPill
              label={online ? t("statusOnline") : t("statusOffline")}
              tone={online ? "emerald" : "amber"}
              helper={online ? "Live sync" : "Offline cache"}
            />
            <StatCard label="Cached" value={cachedCount} helper="ready clips" />
            <StatCard label="Queued" value={queuedCount} helper="pending sends" />
          </div>
          <div className="relative mt-5 grid grid-cols-2 gap-3">
            <button
              onClick={fetchBundle}
              disabled={loading}
              className="flex items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3 text-base font-semibold text-slate-900 shadow-lg shadow-blue-900/30 transition hover:-translate-y-0.5 hover:shadow-xl disabled:opacity-60"
            >
              {loading ? t("loading") : t("getTasks")}
              <span className="text-lg">{">"}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowQueue(true)}
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/30 bg-white/10 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/15"
            >
              Offline queue
              {queuedCount > 0 ? (
                <span className="inline-flex min-w-[2rem] justify-center rounded-full bg-white/80 px-2 py-0.5 text-xs font-bold text-slate-900">
                  {queuedCount}
                </span>
              ) : null}
            </button>
          </div>
        </section>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-lg shadow-rose-200/40 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-100">
            {error}
          </div>
        ) : null}

        <section className="rounded-3xl bg-white/95 px-4 py-5 shadow-xl ring-1 ring-slate-100/60 dark:bg-slate-900/90 dark:ring-slate-800/60">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Today&apos;s bundle
              </p>
              <p className="text-xs text-slate-400">{flatTasks.length} clips ready</p>
            </div>
            <div className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-100">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {online ? "Auto-sync on" : "Will sync when online"}
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {flatTasks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                {t("noCached")}
                <div className="mt-2 text-xs text-slate-400">
                  Fetch a bundle to start a new run.
                </div>
              </div>
            ) : (
              flatTasks.map(({ bundle_id, task }) => (
                <TaskCard key={`${bundle_id}:${task.assignment_id}`} task={task} />
              ))
            )}
          </div>
        </section>

        {showQueue ? (
          <OfflineQueueModal
            cachedCount={cachedCount}
            pending={pendingSubmissions}
            onClose={() => setShowQueue(false)}
            onRetry={handleRetrySubmission}
            onRemove={handleRemoveSubmission}
            queueAction={queueAction}
            onRetryAll={handleRetryAllPending}
            onClearAll={handleClearQueue}
            bulkAction={bulkAction}
          />
        ) : null}
      </main>
    </div>
  );
}

function StatusPill({
  label,
  helper,
  tone = "emerald",
}: {
  label: string;
  helper: string;
  tone?: "emerald" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/20 text-white border border-emerald-200/40"
      : "bg-amber-400/25 text-white border border-amber-100/30";
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-2xl px-3 py-2 shadow-lg shadow-black/10 ${toneClass}`}
    >
      <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      <span className="text-[11px] text-white/80">{helper}</span>
    </div>
  );
}

function StatCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: number;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 shadow-inner">
      <p className="text-[11px] uppercase tracking-wide text-white/70">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-[11px] text-white/70">{helper}</p>
    </div>
  );
}

function TaskCard({ task }: { task: MobileClaimResponse }) {
  const durationLabel = useMemo(
    () => formatDuration(task.clip.end_ms - task.clip.start_ms),
    [task.clip.end_ms, task.clip.start_ms]
  );
  const { label: leaseLabel, warning } = useLeaseCountdown(
    task.lease_expires_at
  );
  const href = `/mobile/tasks/${task.task_id}?assignment=${task.assignment_id}`;
  const hasHint = Boolean(task.ai_suggestion);
  const t = useTranslations();
  const friendlyName = getTaskLabel(task.task_type);
  const payout = `$${(task.price_cents / 100).toFixed(2)}`;
  const clipDuration = `${Math.max(
    1,
    Math.round((task.clip.end_ms - task.clip.start_ms) / 1000)
  )}s clip`;
  const isShortLease = warning || leaseLabel === "Expired";

  return (
    <a
      className="block overflow-hidden rounded-2xl border border-slate-200/70 bg-white/95 p-4 shadow-lg shadow-slate-900/5 transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-xl dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-blue-500/40"
      href={href}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800/70 dark:text-slate-200">
            {friendlyName}
            {hasHint ? (
              <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
                {t("aiHint")}
              </span>
            ) : null}
          </div>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
            {durationLabel}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-slate-600 dark:text-slate-300">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800/70">
              {clipDuration}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200">
              {payout}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 text-right">
          <span
            className={`text-xs font-semibold ${
              isShortLease ? "text-amber-500" : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {t("leaseLabel", { time: leaseLabel })}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400">
            Start
            <span aria-hidden="true">{">"}</span>
          </span>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 dark:bg-slate-800/70">
          Assignment {task.assignment_id.slice(0, 6)}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <span
              className="block h-full rounded-full bg-blue-500 transition-all"
              style={{ width: isShortLease ? "60%" : "90%" }}
            />
          </span>
          {warning ? "Soon" : "Fresh"}
        </span>
      </div>
    </a>
  );
}

function OfflineQueueModal({
  cachedCount,
  pending,
  onClose,
  onRetry,
  onRemove,
  queueAction,
  onRetryAll,
  onClearAll,
  bulkAction,
}: {
  cachedCount: number;
  pending: PendingSubmission[];
  onClose: () => void;
  onRetry: (submission: PendingSubmission) => void;
  onRemove: (submission: PendingSubmission) => void;
  queueAction: QueueActionState;
  onRetryAll: () => void;
  onClearAll: () => void;
  bulkAction: BulkActionState;
}) {
  const t = useTranslations();
  const anyPending = pending.length > 0;
  const bulkDisabled = bulkAction !== null || queueAction !== null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 backdrop-blur-md sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-slate-950 text-slate-50 shadow-2xl ring-1 ring-white/10">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-white/60">
                {t("offlineQueueTitle")}
              </p>
              <h2 className="text-lg font-semibold">
                {t("offlineQueueHeading", {
                  cached: cachedCount,
                  queued: pending.length,
                })}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white hover:bg-white/20"
            >
              {t("close")}
            </button>
          </div>
          <p className="mt-1 text-xs text-white/60">{t("offlineQueueBulkHint")}</p>
        </div>
        <div className="px-4 py-3">
          {!anyPending ? (
            <p className="text-sm text-white/70">{t("offlineQueueEmpty")}</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  onClick={onRetryAll}
                  disabled={bulkDisabled}
                  className="rounded-lg bg-blue-500 px-3 py-2 font-semibold text-white shadow hover:bg-blue-400 disabled:opacity-60"
                >
                  {bulkAction === "retryAll" ? t("retryingState") : t("retryAllAction")}
                </button>
                <button
                  type="button"
                  onClick={onClearAll}
                  disabled={bulkDisabled}
                  className="rounded-lg bg-rose-500/80 px-3 py-2 font-semibold text-white shadow hover:bg-rose-400 disabled:opacity-60"
                >
                  {bulkAction === "clearAll" ? t("removingState") : t("clearAllAction")}
                </button>
              </div>
              <ul className="max-h-72 space-y-3 overflow-y-auto pr-1">
                {pending.map((entry) => {
                  const isRetrying =
                    queueAction?.type === "retry" &&
                    queueAction?.id === entry.idempotencyKey;
                  const isRemoving =
                    queueAction?.type === "remove" &&
                    queueAction?.id === entry.idempotencyKey;
                  const anotherActionInFlight =
                    queueAction !== null && queueAction?.id !== entry.idempotencyKey;
                  return (
                    <li
                      key={entry.idempotencyKey}
                      className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm shadow-sm"
                    >
                      <p className="font-semibold text-white">
                        {entry.task_id} - {entry.assignment_id}
                      </p>
                      <p className="text-xs text-white/60">
                        {t("queueQueuedAt", {
                          time: new Date(entry.created_at).toLocaleTimeString(),
                        })}
                      </p>
                      <div className="mt-2 flex gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => onRetry(entry)}
                          disabled={anotherActionInFlight || isRemoving || isRetrying}
                          className="flex-1 rounded-lg bg-blue-500 px-3 py-2 font-semibold text-white transition hover:bg-blue-400 disabled:opacity-60"
                        >
                          {isRetrying ? t("retryingState") : t("retryAction")}
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemove(entry)}
                          disabled={anotherActionInFlight || isRetrying || isRemoving}
                          className="flex-1 rounded-lg bg-slate-800 px-3 py-2 font-semibold text-white transition hover:bg-slate-700 disabled:opacity-60"
                        >
                          {isRemoving ? t("removingState") : t("removeQueueAction")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
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
      return { label: "Expired", expired: true, warning: false };
    }
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return {
      label: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
        2,
        "0"
      )}`,
      expired: false,
      warning: diff <= 2 * 60 * 1000,
    };
  };
  const [value, setValue] = useState(compute);
  useEffect(() => {
    const id = setInterval(() => setValue(compute()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return value;
}












