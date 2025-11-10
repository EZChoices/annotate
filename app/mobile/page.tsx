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
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-slate-50 to-slate-200 px-4 py-6 text-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-50">
      <main className="mx-auto flex w-full max-w-sm flex-col gap-5 pb-16">
        <section className="rounded-3xl bg-white/95 p-5 shadow-2xl ring-1 ring-blue-50 dark:bg-slate-900/90 dark:ring-blue-900/40">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">
                {t("brand")}
              </p>
              <h1 className="text-3xl font-bold leading-tight text-slate-900 dark:text-white">
                {t("workOnTasks")}
              </h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Clip bundles refresh throughout the day. Stay in flow.
              </p>
            </div>
            <LocaleToggle />
          </div>
          <div className="mt-4 flex items-center justify-between text-xs font-semibold">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 ${
                online
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
              }`}
            >
              <span className="text-base leading-none">•</span>
              {online ? t("statusOnline") : t("statusOffline")}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              {cachedCount} cached • {queuedCount} queued
            </span>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              onClick={fetchBundle}
              disabled={loading}
              className="flex-1 rounded-2xl bg-blue-600 py-3 text-center text-base font-semibold text-white shadow-lg transition hover:bg-blue-500 disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
            >
              {loading ? t("loading") : t("getTasks")}
            </button>
            {(cachedCount > 0 || queuedCount > 0) && (
              <button
                type="button"
                onClick={() => setShowQueue(true)}
                className="rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:bg-slate-800"
              >
                <span className="flex items-center justify-center gap-2">
                  {t("offlineQueueTitle")}
                  {queuedCount > 0 ? (
                    <span className="inline-flex min-w-[2rem] justify-center rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">
                      {queuedCount}
                    </span>
                  ) : null}
                </span>
              </button>
            )}
          </div>
        </section>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
            {error}
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Today&apos;s bundle
            </p>
            <span className="text-xs text-slate-400">
              {flatTasks.length} clips ready
            </span>
          </div>
          {flatTasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
              {t("noCached")}
            </div>
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

  return (
    <a
      className="block rounded-3xl border border-slate-100 bg-white/95 p-4 shadow-lg transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-xl dark:border-slate-800 dark:bg-slate-900/80 dark:hover:border-blue-400/60"
      href={href}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {friendlyName}
            </p>
            <h3 className="text-2xl font-semibold text-slate-900 dark:text-white">
              {durationLabel}
            </h3>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800/80">
                {clipDuration}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800/80">
                {payout}
              </span>
            </div>
          </div>
          {hasHint ? (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-blue-600 dark:bg-blue-500/20 dark:text-blue-200">
              {t("aiHint")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center justify-between text-sm font-semibold">
          <span
            className={
              warning
                ? "text-amber-600 dark:text-amber-400"
                : "text-slate-500 dark:text-slate-400"
            }
          >
            {t("leaseLabel", { time: leaseLabel })}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400">
            Start
            <span aria-hidden="true">→</span>
          </span>
        </div>
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
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900 dark:text-slate-100">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
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
            className="text-sm font-semibold text-blue-600"
          >
            {t("close")}
          </button>
        </div>
        {!anyPending ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("offlineQueueEmpty")}
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t("offlineQueueBulkHint")}
            </p>
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              <button
                type="button"
                onClick={onRetryAll}
                disabled={bulkDisabled}
                className="rounded border border-blue-300 px-2 py-1 font-semibold text-blue-700 transition hover:bg-blue-50 disabled:opacity-60 dark:border-blue-500/40 dark:text-blue-200 dark:hover:bg-blue-500/10"
              >
                {bulkAction === "retryAll"
                  ? t("retryingState")
                  : t("retryAllAction")}
              </button>
              <button
                type="button"
                onClick={onClearAll}
                disabled={bulkDisabled}
                className="rounded border border-rose-200 px-2 py-1 font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-60 dark:border-rose-400/60 dark:text-rose-200 dark:hover:bg-rose-500/10"
              >
                {bulkAction === "clearAll"
                  ? t("removingState")
                  : t("clearAllAction")}
              </button>
            </div>
            <ul className="max-h-64 overflow-y-auto space-y-2">
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
                  className="rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700"
                >
                  <p className="font-semibold">{entry.task_id}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t("queueAssignmentLabel", { id: entry.assignment_id })}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t("queueQueuedAt", {
                      time: new Date(entry.created_at).toLocaleTimeString(),
                    })}
                  </p>
                  <div className="mt-2 flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => onRetry(entry)}
                      disabled={anotherActionInFlight || isRemoving || isRetrying}
                      className="rounded border border-blue-200 px-2 py-1 font-semibold text-blue-600 transition hover:bg-blue-50 disabled:opacity-60 dark:border-blue-500/40 dark:hover:bg-blue-500/10"
                    >
                      {isRetrying ? t("retryingState") : t("retryAction")}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(entry)}
                      disabled={anotherActionInFlight || isRetrying || isRemoving}
                      className="rounded border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
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












