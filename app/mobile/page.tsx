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
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || "Failed to fetch bundle");
      }
      const hasTasks =
        payload && typeof payload === "object" && Array.isArray((payload as any).tasks);
      if (!hasTasks) {
        const message = "No tasks available";
        setError(message);
        pushToast(message, "error");
        return;
      }
      const data = payload as MobileBundleResponse;
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
    <div className="mobile-shell">
      <main className="mobile-main">
        <section className="hero">
          <div className="hero-glow hero-glow-a" />
          <div className="hero-glow hero-glow-b" />
          <div className="hero-top">
            <div>
              <p className="eyebrow">{t("brand")}</p>
              <h1 className="hero-title">{t("workOnTasks")}</h1>
              <p className="hero-subtitle">
                Clip bundles refresh throughout the day. Stay in flow.
              </p>
            </div>
            <LocaleToggle />
          </div>
          <div className="stat-grid">
            <StatusPill
              label={online ? t("statusOnline") : t("statusOffline")}
              tone={online ? "emerald" : "amber"}
              helper={online ? "Live sync" : "Offline cache"}
            />
            <StatCard label="Cached" value={cachedCount} helper="ready clips" />
            <StatCard label="Queued" value={queuedCount} helper="pending sends" />
          </div>
          <div className="cta-row">
            <button
              onClick={fetchBundle}
              disabled={loading}
              className="cta-primary"
            >
              {loading ? t("loading") : t("getTasks")}
              <span className="chevron">{">"}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowQueue(true)}
              className="cta-secondary"
            >
              Offline queue
              {queuedCount > 0 ? (
                <span className="badge">{queuedCount}</span>
              ) : null}
            </button>
          </div>
        </section>

        {error ? <div className="alert">{error}</div> : null}

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow muted">Today&apos;s bundle</p>
              <p className="muted tiny">{flatTasks.length} clips ready</p>
            </div>
            <div className="sync-pill">
              <span className="dot" />
              {online ? "Auto-sync on" : "Will sync when online"}
            </div>
          </div>
          <div className="panel-body">
            {flatTasks.length === 0 ? (
              <div className="empty">
                {t("noCached")}
                <div className="tiny muted">Fetch a bundle to start a new run.</div>
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
      <style jsx>{`
        .mobile-shell {
          min-height: 100vh;
          background: radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.12), transparent 32%),
            radial-gradient(circle at 80% 0%, rgba(14, 165, 233, 0.1), transparent 28%),
            radial-gradient(circle at 50% 80%, rgba(79, 70, 229, 0.08), transparent 36%),
            #0b1220;
          color: #f8fafc;
        }
        .mobile-main {
          max-width: 420px;
          margin: 0 auto;
          padding: 24px 16px 80px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .hero {
          position: relative;
          overflow: hidden;
          border-radius: 22px;
          padding: 20px;
          background: linear-gradient(145deg, #2563eb, #4f46e5 55%, #0f172a);
          box-shadow: 0 20px 50px rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .hero-glow {
          position: absolute;
          border-radius: 999px;
          filter: blur(38px);
          opacity: 0.4;
        }
        .hero-glow-a {
          width: 140px;
          height: 140px;
          background: rgba(255, 255, 255, 0.24);
          top: 12px;
          left: -30px;
        }
        .hero-glow-b {
          width: 110px;
          height: 110px;
          background: rgba(52, 211, 153, 0.28);
          bottom: 12px;
          right: 4px;
        }
        .hero-top {
          position: relative;
          display: flex;
          justify-content: space-between;
          gap: 12px;
        }
        .hero-title {
          margin: 4px 0;
          font-size: 28px;
          font-weight: 700;
          line-height: 1.1;
        }
        .hero-subtitle {
          margin: 0;
          font-size: 14px;
          color: rgba(255, 255, 255, 0.82);
        }
        .eyebrow {
          margin: 0;
          font-size: 11px;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          font-weight: 600;
          color: rgba(255, 255, 255, 0.7);
        }
        .eyebrow.muted {
          color: #94a3b8;
          letter-spacing: 0.18em;
        }
        .stat-grid {
          position: relative;
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }
        .cta-row {
          position: relative;
          margin-top: 16px;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .cta-primary,
        .cta-secondary {
          border: none;
          border-radius: 14px;
          padding: 12px 14px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
        }
        .cta-primary {
          background: #ffffff;
          color: #0f172a;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .cta-primary:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
        .cta-primary:not(:disabled):hover {
          transform: translateY(-1px);
        }
        .cta-secondary {
          background: rgba(255, 255, 255, 0.14);
          color: #ffffff;
          border: 1px solid rgba(255, 255, 255, 0.2);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .cta-secondary:hover {
          transform: translateY(-1px);
        }
        .badge {
          min-width: 26px;
          text-align: center;
          padding: 4px 6px;
          border-radius: 999px;
          background: #ffffff;
          color: #0f172a;
          font-size: 12px;
          font-weight: 800;
        }
        .chevron {
          font-size: 16px;
          line-height: 1;
        }
        .alert {
          background: #fef2f2;
          color: #991b1b;
          border: 1px solid #fecdd3;
          border-radius: 14px;
          padding: 12px 14px;
          font-size: 14px;
          box-shadow: 0 8px 18px rgba(248, 113, 113, 0.15);
        }
        .panel {
          background: rgba(255, 255, 255, 0.96);
          color: #0f172a;
          border-radius: 18px;
          padding: 14px 14px 16px;
          box-shadow: 0 16px 38px rgba(15, 23, 42, 0.22);
          border: 1px solid rgba(148, 163, 184, 0.2);
        }
        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .panel-body {
          margin-top: 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .status-pill {
          display: flex;
          flex-direction: column;
          gap: 4px;
          border-radius: 14px;
          padding: 10px;
          box-shadow: 0 12px 22px rgba(0, 0, 0, 0.16);
        }
        .stat-card {
          border-radius: 14px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.12);
          border: 1px solid rgba(255, 255, 255, 0.14);
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
        }
        .pill-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .pill-helper {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.82);
        }
        .stat-value {
          font-size: 22px;
          font-weight: 800;
          color: #ffffff;
          margin: 4px 0;
        }
        .sync-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: #e2e8f0;
          color: #0f172a;
          font-size: 11px;
          font-weight: 700;
        }
        .sync-pill .dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #22c55e;
        }
        .empty {
          border: 1px dashed #cbd5e1;
          border-radius: 14px;
          padding: 18px;
          text-align: center;
          background: #f8fafc;
          color: #475569;
          font-size: 14px;
        }
        .muted {
          color: #94a3b8;
        }
        .tiny {
          font-size: 12px;
        }
        .task-card {
          display: block;
          border-radius: 16px;
          padding: 14px;
          background: linear-gradient(135deg, #ffffff, #f8fafc);
          border: 1px solid rgba(148, 163, 184, 0.35);
          box-shadow: 0 12px 26px rgba(15, 23, 42, 0.15);
          color: #0f172a;
          text-decoration: none;
          transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .task-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 16px 32px rgba(59, 130, 246, 0.15);
        }
        .task-top {
          display: flex;
          justify-content: space-between;
          gap: 12px;
        }
        .task-chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          background: #e2e8f0;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          color: #1e293b;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .task-hint {
          background: #2563eb;
          color: #ffffff;
          border-radius: 999px;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 800;
        }
        .task-title {
          margin: 6px 0 4px;
          font-size: 22px;
          font-weight: 800;
          color: #0f172a;
        }
        .task-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          font-size: 12px;
          font-weight: 700;
          color: #475569;
        }
        .task-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: #f1f5f9;
          color: #1e293b;
          font-weight: 700;
        }
        .task-pill.payout {
          background: #dcfce7;
          color: #166534;
        }
        .task-side {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 8px;
          text-align: right;
        }
        .lease {
          font-size: 12px;
          font-weight: 700;
          color: #475569;
        }
        .lease-warn {
          color: #d97706;
        }
        .task-start {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          background: linear-gradient(135deg, #2563eb, #4f46e5);
          color: #ffffff;
          font-size: 12px;
          font-weight: 800;
          box-shadow: 0 10px 22px rgba(37, 99, 235, 0.28);
        }
        .task-footer {
          margin-top: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          color: #475569;
          font-size: 12px;
        }
        .lease-bar {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .lease-bar .lease-fill {
          display: block;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(90deg, #22c55e, #2563eb);
          width: 80%;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.65);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: flex-end;
          justify-content: center;
          padding: 16px;
          z-index: 40;
        }
        @media (min-width: 540px) {
          .modal-backdrop {
            align-items: center;
          }
        }
        .modal {
          width: 100%;
          max-width: 420px;
          background: #0b1220;
          color: #e2e8f0;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 22px 48px rgba(0, 0, 0, 0.45);
          padding: 14px;
        }
        .modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .modal-title {
          margin: 4px 0;
          font-size: 18px;
          font-weight: 700;
        }
        .modal-close {
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.08);
          color: #ffffff;
          border-radius: 999px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .modal-actions {
          display: flex;
          gap: 8px;
          margin: 10px 0;
          flex-wrap: wrap;
        }
        .btn-solid,
        .btn-ghost {
          border: none;
          border-radius: 12px;
          padding: 10px 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .btn-solid {
          background: linear-gradient(135deg, #2563eb, #4f46e5);
          color: #ffffff;
          box-shadow: 0 10px 24px rgba(37, 99, 235, 0.25);
        }
        .btn-solid:disabled,
        .btn-ghost:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .btn-ghost {
          background: rgba(255, 255, 255, 0.08);
          color: #e2e8f0;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .btn-ghost.danger {
          border-color: rgba(248, 113, 113, 0.5);
          color: #fecdd3;
        }
        .modal-list {
          list-style: none;
          padding: 0;
          margin: 0;
          max-height: 290px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .modal-item {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          padding: 10px;
          background: rgba(255, 255, 255, 0.04);
        }
        .modal-item-title {
          margin: 0 0 4px;
          font-weight: 700;
          color: #ffffff;
        }
        .modal-buttons {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        @media (max-width: 480px) {
          .mobile-main {
            padding: 20px 12px 72px;
          }
          .stat-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
          .cta-row {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>
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
  const styles =
    tone === "emerald"
      ? { background: "rgba(34,197,94,0.18)", border: "1px solid rgba(74,222,128,0.4)" }
      : { background: "rgba(251,191,36,0.2)", border: "1px solid rgba(252,211,77,0.35)" };
  return (
    <div className="status-pill" style={styles}>
      <span className="pill-title">{label}</span>
      <span className="pill-helper">{helper}</span>
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
    <div className="stat-card">
      <p className="pill-title muted">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="pill-helper muted">{helper}</p>
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
    <a className="task-card" href={href}>
      <div className="task-top">
        <div>
          <div className="task-chip">
            {friendlyName}
            {hasHint ? <span className="task-hint">{t("aiHint")}</span> : null}
          </div>
          <h3 className="task-title">{durationLabel}</h3>
          <div className="task-meta">
            <span className="task-pill">{clipDuration}</span>
            <span className="task-pill payout">{payout}</span>
          </div>
        </div>
        <div className="task-side">
          <span className={`lease ${isShortLease ? "lease-warn" : ""}`}>
            {t("leaseLabel", { time: leaseLabel })}
          </span>
          <span className="task-start">
            Start
            <span aria-hidden="true">{">"}</span>
          </span>
        </div>
      </div>
      <div className="task-footer">
        <span className="task-pill">Assignment {task.assignment_id.slice(0, 6)}</span>
        <span className="lease-bar">
          <span
            className="lease-fill"
            style={{ width: isShortLease ? "60%" : "90%" }}
          />
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
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-header">
          <div>
            <p className="eyebrow muted">{t("offlineQueueTitle")}</p>
            <h2 className="modal-title">
              {t("offlineQueueHeading", { cached: cachedCount, queued: pending.length })}
            </h2>
          </div>
          <button onClick={onClose} className="modal-close">
            {t("close")}
          </button>
        </div>
        <p className="muted tiny">{t("offlineQueueBulkHint")}</p>
        {!anyPending ? (
          <p className="muted" style={{ marginTop: 8 }}>
            {t("offlineQueueEmpty")}
          </p>
        ) : (
          <>
            <div className="modal-actions">
              <button
                type="button"
                onClick={onRetryAll}
                disabled={bulkDisabled}
                className="btn-solid"
              >
                {bulkAction === "retryAll" ? t("retryingState") : t("retryAllAction")}
              </button>
              <button
                type="button"
                onClick={onClearAll}
                disabled={bulkDisabled}
                className="btn-ghost danger"
              >
                {bulkAction === "clearAll" ? t("removingState") : t("clearAllAction")}
              </button>
            </div>
            <ul className="modal-list">
              {pending.map((entry) => {
                const isRetrying =
                  queueAction?.type === "retry" && queueAction?.id === entry.idempotencyKey;
                const isRemoving =
                  queueAction?.type === "remove" && queueAction?.id === entry.idempotencyKey;
                const anotherActionInFlight =
                  queueAction !== null && queueAction?.id !== entry.idempotencyKey;
                return (
                  <li key={entry.idempotencyKey} className="modal-item">
                    <p className="modal-item-title">
                      {entry.task_id} - {entry.assignment_id}
                    </p>
                    <p className="tiny muted">
                      {t("queueQueuedAt", {
                        time: new Date(entry.created_at).toLocaleTimeString(),
                      })}
                    </p>
                    <div className="modal-buttons">
                      <button
                        type="button"
                        onClick={() => onRetry(entry)}
                        disabled={anotherActionInFlight || isRemoving || isRetrying}
                        className="btn-solid"
                      >
                        {isRetrying ? t("retryingState") : t("retryAction")}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(entry)}
                        disabled={anotherActionInFlight || isRetrying || isRemoving}
                        className="btn-ghost"
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












