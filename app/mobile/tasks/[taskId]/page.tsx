"use client";

import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MobileClaimResponse,
  TranslationCheckPayload,
  AccentTagPayload,
  EmotionTagPayload,
  SpeakerContinuityPayload,
  GestureTagPayload,
  GestureTagEvent,
} from "../../../../lib/mobile/types";
import {
  loadCachedBundles,
  queueSubmission,
  PendingSubmission,
} from "../../../../lib/mobile/idb";
import { useMobileAuth } from "../../../../components/mobile/MobileAuthProvider";
import { useTranslations } from "../../../../components/mobile/useTranslations";
import { LocaleToggle } from "../../../../components/mobile/LocaleToggle";
import { useRemoteConfigValue } from "../../../../components/mobile/useRemoteConfig";

const STRUCTURED_TASK_TYPES = new Set([
  "translation_check",
  "accent_tag",
  "emotion_tag",
  "speaker_continuity",
  "gesture_tag",
]);

const CONTEXT_WINDOW_LIMIT_SECONDS = 24;
const CAPTIONS_STORAGE_KEY = "dd-mobile-captions";
const INPUT_BASE_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
const TEXTAREA_BASE_CLASS = `${INPUT_BASE_CLASS} min-h-[120px]`;
const OPTION_BASE_CLASS =
  "relative flex flex-col gap-1 rounded-2xl border-2 px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:ring-offset-slate-950";
const OPTION_ACTIVE_CLASS =
  "border-blue-600 bg-blue-50 text-blue-700 shadow-[0_15px_45px_rgba(37,99,235,0.15)] dark:border-blue-400 dark:bg-blue-500/20 dark:text-blue-100";
const OPTION_INACTIVE_CLASS =
  "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500";

function clampContextPayload(payload: any) {
  if (!payload || typeof payload !== "object") return null;
  const clone = JSON.parse(JSON.stringify(payload));
  if (typeof clone.window_seconds === "number") {
    clone.window_seconds = Math.min(
      clone.window_seconds,
      CONTEXT_WINDOW_LIMIT_SECONDS
    );
  }
  const windowLabel = `+/- ${
    clone.window_seconds ?? CONTEXT_WINDOW_LIMIT_SECONDS
  }s`;
  clone.window = windowLabel;
  clone.window_label = windowLabel;
  if ("mock" in clone) {
    delete (clone as Record<string, unknown>).mock;
  }
  return clone;
}

export default function MobileTaskPage() {
  const router = useRouter();
  const params = useParams<{ taskId: string }>();
  const taskId = params?.taskId ?? "";
  const search = useSearchParams();
  const assignmentId = search?.get("assignment") || "";

  const [task, setTask] = useState<MobileClaimResponse | null>(null);
  const [payloadObj, setPayloadObj] = useState<any | null>(null);
  const [payloadText, setPayloadText] = useState<string>("{}");
  const [clipProgress, setClipProgress] = useState<{ current: number; total: number }>({
    current: 0,
    total: 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<any | null>(null);
  const [contextView, setContextView] = useState<"tree" | "json">("tree");
  const [hintOpen, setHintOpen] = useState(false);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [watchedSec, setWatchedSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const { fetchWithAuth, session, status, mode } = useMobileAuth();
  const t = useTranslations();
  const captionsDefault = useRemoteConfigValue<boolean>(
    "captions_default",
    true
  );
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [contextCopied, setContextCopied] = useState(false);

  useEffect(() => {
    loadCachedBundles().then((bundles) => {
      const flattened = bundles.flatMap((bundle) => bundle.tasks);
      const foundIndex = flattened.findIndex((t) => t.task_id === taskId);
      if (foundIndex === -1) {
        return;
      }
      const found = flattened[foundIndex];
      setClipProgress({
        current: foundIndex + 1,
        total: flattened.length,
      });
      setTask(found);
      const initialPayload = defaultPayload(found.task_type);
      setPayloadObj(initialPayload);
      setPayloadText(JSON.stringify(initialPayload, null, 2));
      setDurationSec(
        Math.max(
          1,
          Math.round((found.clip.end_ms - found.clip.start_ms) / 1000)
        )
      );
    });
  }, [taskId]);

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

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(CAPTIONS_STORAGE_KEY);
    const hasCaptions = Boolean(task?.clip.captions_vtt_url);
    if (stored === "on" || stored === "off") {
      setCaptionsEnabled(stored === "on" && hasCaptions);
      return;
    }
    const autoEnabled =
      hasCaptions &&
      task?.clip.captions_auto_enabled !== false &&
      captionsDefault !== false;
    setCaptionsEnabled(autoEnabled);
  }, [task?.clip.captions_vtt_url, task?.clip.captions_auto_enabled, captionsDefault]);

  useEffect(() => {
    if (context?.clip_id) {
      setContextView("tree");
    }
  }, [context?.clip_id]);

  const nextPath =
    `/mobile/tasks/${taskId}` + (assignmentId ? `?assignment=${assignmentId}` : "");
  const loginHref = `/mobile/login?next=${encodeURIComponent(nextPath)}`;

  if (mode === "otp") {
    if (status === "loading") {
      return (
        <main className="p-6 text-center space-y-3">
          <p className="text-sm text-slate-500">{t("checkingSession")}</p>
        </main>
      );
    }

    if (!session) {
      return (
        <main className="max-w-md mx-auto p-6 space-y-4 text-center">
          <h1 className="text-2xl font-semibold">{t("sessionExpiredTitle")}</h1>
          <p className="text-sm text-slate-500">
            {t("sessionExpiredDescription")}
          </p>
          <Link
            href={loginHref}
            className="inline-flex w-full justify-center rounded-lg bg-blue-600 py-3 font-semibold text-white"
          >
            {t("goToOtp")}
          </Link>
        </main>
      );
    }
  }
  const isStructured = task ? STRUCTURED_TASK_TYPES.has(task.task_type) : false;

  useEffect(() => {
    if (isStructured && payloadObj) {
      setPayloadText(JSON.stringify(payloadObj, null, 2));
    }
  }, [isStructured, payloadObj]);

  const playbackRatio = useMemo(() => {
    if (!durationSec) return 0;
    return Math.min(1, watchedSec / durationSec);
  }, [watchedSec, durationSec]);
  const clipProgressDots = useMemo(() => {
    if (!clipProgress.total) return [];
    const dots = Math.min(8, clipProgress.total);
    if (!dots) return [];
    const active = Math.max(
      1,
      Math.round((clipProgress.current / clipProgress.total) * dots)
    );
    return Array.from({ length: dots }, (_, index) => index < active);
  }, [clipProgress]);
  const clipProgressPercent = useMemo(() => {
    if (!clipProgress.total) return 0;
    return Math.min(
      100,
      Math.max(0, Math.round((clipProgress.current / clipProgress.total) * 100))
    );
  }, [clipProgress]);

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setWatchedSec((prev) => Math.max(prev, audio.currentTime || 0));
    if (audio.duration) {
      setDurationSec(Math.round(audio.duration));
    }
  };

  const enforcePlaybackBounds = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const maxAllowed = Math.max(durationSec, 0);
    if (audio.currentTime < 0) {
      audio.currentTime = 0;
    } else if (maxAllowed && audio.currentTime > maxAllowed) {
      audio.currentTime = maxAllowed;
    }
  };

  const toggleCaptions = () => {
    if (!task?.clip.captions_vtt_url) return;
    setCaptionsEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(CAPTIONS_STORAGE_KEY, next ? "on" : "off");
      }
      return next;
    });
  };
  const goHomeWithToast = useCallback(() => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }
    setSuccessMessage(t("submitSuccessToast"));
    successTimeoutRef.current = setTimeout(() => {
      setSuccessMessage(null);
      router.push("/mobile");
    }, 700);
  }, [router, t]);

  const loadContext = async () => {
    if (!task) return;
    const response = await fetchWithAuth(
      `/api/mobile/context?clip_id=${task.clip.id}`
    );
    if (response.ok) {
      const raw = await response.json();
      setContext(clampContextPayload(raw));
    }
  };

  const copyContext = async () => {
    if (!context) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
        setContextCopied(true);
        setTimeout(() => setContextCopied(false), 1500);
      }
    } catch {
      setContextCopied(false);
    }
  };

  const submitTask = async () => {
    if (!task || !assignmentId) return;
    setSubmitting(true);
    setError(null);
    let payloadData: any = null;
    try {
      payloadData = isStructured
        ? payloadObj
        : payloadText
        ? JSON.parse(payloadText)
        : {};
    } catch {
      setError(t("payloadInvalidJson"));
      setSubmitting(false);
      return;
    }
    if (!payloadData || Object.keys(payloadData).length === 0) {
      setError(t("payloadRequired"));
      setSubmitting(false);
      return;
    }
    const body = {
      task_id: task.task_id,
      assignment_id: assignmentId,
      payload: payloadData,
      duration_ms: durationSec * 1000,
      playback_ratio: playbackRatio,
    };
    const idempotencyKey =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    try {
      const response = await fetchWithAuth("/api/mobile/tasks/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || t("submitFailed"));
      }
      goHomeWithToast();
      return;
    } catch (err: any) {
      setError(err.message || t("submitQueuedOffline"));
      await queueSubmission({
        task_id: task.task_id,
        assignment_id: assignmentId,
        payload: payloadData,
        duration_ms: body.duration_ms,
        playback_ratio: body.playback_ratio,
        created_at: Date.now(),
        endpoint: "/api/mobile/tasks/submit",
        idempotencyKey,
      } satisfies PendingSubmission);
      const registration = await navigator.serviceWorker?.ready;
      await (registration as any)?.sync?.register("dd-submit").catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };

  const skipTask = async () => {
    if (!assignmentId) return;
    setReleasing(true);
    try {
      await fetchWithAuth("/api/mobile/tasks/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          task_id: task?.task_id,
          reason: "not_confident",
        }),
      });
      router.push("/mobile");
    } catch (err: any) {
      setError(err.message || t("skipFailed"));
    } finally {
      setReleasing(false);
    }
  };

  if (!task) {
    return (
      <main className="p-4 text-center text-sm text-slate-500">
        {t("loadingTask")}
      </main>
    );
  }

  const captionsUrl = task.clip.captions_vtt_url || null;
  const captionsAvailable = Boolean(captionsUrl);
  const captionsLabel = !captionsAvailable
    ? t("captionsUnavailable")
    : captionsEnabled
    ? t("captionsOn")
    : t("captionsOff");
  const clipDurationLabel = formatDuration(
    task.clip.end_ms - task.clip.start_ms
  );
  const leaseTimeLabel = new Date(task.lease_expires_at).toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
    }
  );
  const hasProgress = clipProgress.total > 0;
  const clipProgressLabelText = hasProgress
    ? t("clipProgressLabel", {
        current: clipProgress.current,
        total: clipProgress.total,
      })
    : "";

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-white via-slate-50 to-slate-200 px-4 py-4 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {successMessage ? (
        <div className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-600/95 px-4 py-2 text-sm font-semibold text-white shadow-xl dark:bg-emerald-500/90">
            <span aria-hidden="true">✓</span>
            {successMessage}
          </div>
        </div>
      ) : null}
      <main className="mx-auto flex w-full max-w-sm flex-col gap-5 pb-32">
        <header className="flex items-center justify-between">
          <button
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 transition hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
            onClick={() => router.push("/mobile")}
          >
            <span aria-hidden="true">←</span>
            {t("backToTasks")}
          </button>
          <LocaleToggle />
        </header>

        {hasProgress ? (
          <section className="rounded-3xl bg-white/90 p-4 text-xs font-semibold text-slate-500 shadow ring-1 ring-slate-100 dark:bg-slate-900/80 dark:text-slate-300 dark:ring-slate-800">
            <div className="flex items-center justify-between">
              <span>{clipProgressLabelText}</span>
              <span>{clipProgressPercent}%</span>
            </div>
            <div className="mt-3 flex gap-1" aria-hidden="true">
              {clipProgressDots.map((active, index) => (
                <span
                  key={`progress-dot-${index}`}
                  className={`h-1.5 flex-1 rounded-full ${
                    active
                      ? "bg-blue-600 dark:bg-blue-400"
                      : "bg-slate-200 dark:bg-slate-700"
                  }`}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-4 rounded-3xl bg-white/95 p-4 shadow-xl ring-1 ring-slate-100 dark:bg-slate-900/90 dark:ring-slate-800">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
              {getFriendlyTitle(task.task_type)}
            </p>
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
              {t("clipPreview")}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {clipDurationLabel} • {t("leaseLabel", { time: leaseTimeLabel })}
            </p>
          </div>

          <div className="relative overflow-hidden rounded-2xl bg-slate-900 text-white shadow-lg">
            <div className="aspect-video bg-black/40">
              {task.clip.video_url ? (
                <video
                  controls
                  className="h-full w-full object-cover"
                  src={task.clip.video_url ?? task.clip.audio_url ?? ""}
                  onSeeking={enforcePlaybackBounds}
                  onLoadedMetadata={onTimeUpdate}
                />
              ) : (
                <audio
                  ref={audioRef}
                  controls
                  className="w-full bg-slate-900 p-4"
                  src={task.clip.audio_url}
                  onTimeUpdate={onTimeUpdate}
                  onLoadedMetadata={onTimeUpdate}
                  onSeeking={enforcePlaybackBounds}
                />
              )}
            </div>
            <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold">
              <span>00:{Math.max(0, Math.round(watchedSec)).toString().padStart(2, "0")}</span>
              <span className="opacity-60">/</span>
              <span>{durationSec.toString().padStart(2, "0")}s</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span
              className={`rounded-full px-3 py-1 ${
                online
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200"
              }`}
            >
              {online ? t("statusOnline") : t("statusOffline")}
            </span>
            <button
              type="button"
              onClick={toggleCaptions}
              disabled={!captionsAvailable}
              className={`rounded-full px-3 py-1 ${
                captionsEnabled && captionsAvailable
                  ? "bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-200"
                  : "bg-slate-200 text-slate-500 dark:bg-slate-800/70 dark:text-slate-400"
              }`}
            >
              {captionsLabel}
            </button>
            <button
              onClick={loadContext}
              className="rounded-full border border-slate-200 px-3 py-1 text-slate-600 transition hover:border-slate-300 hover:text-slate-900 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500 dark:hover:text-white"
            >
              {t("loadContext")}
            </button>
          </div>

          {context ? (
            <div className="space-y-3 rounded-2xl bg-slate-100/80 p-3 dark:bg-slate-800/40">
              <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-300">
                <span>{t("contextTreeTitle")}</span>
                <button
                  type="button"
                  className="text-blue-600 transition hover:text-blue-500 dark:text-blue-300 dark:hover:text-blue-200"
                  onClick={() =>
                    setContextView((prev) => (prev === "tree" ? "json" : "tree"))
                  }
                >
                  {contextView === "tree"
                    ? t("contextViewRaw")
                    : t("contextViewStructured")}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <span>
                  {t("contextWindowLabel", {
                    window: context.window ?? t("defaultContextWindow"),
                  })}
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                  {t("contextWatermark")}
                </span>
                <button
                  type="button"
                  onClick={copyContext}
                  className="rounded-full border border-slate-300 px-2 py-0.5 text-blue-600 transition hover:bg-blue-50 dark:border-slate-600 dark:text-blue-200 dark:hover:bg-slate-900"
                >
                  {contextCopied ? t("contextCopied") : t("contextCopy")}
                </button>
              </div>
              {contextView === "tree" ? (
                <ContextTree data={context} />
              ) : (
                <pre className="max-h-48 overflow-auto rounded-xl bg-slate-900/80 p-2 text-[11px] text-slate-50 dark:bg-slate-950">
                  {JSON.stringify(context, null, 2)}
                </pre>
              )}
            </div>
          ) : null}

          {task.ai_suggestion ? (
            <div className="rounded-2xl border border-blue-100 bg-blue-50/80 p-3 dark:border-blue-400/40 dark:bg-blue-500/10">
              <button
                className="text-sm font-semibold text-blue-700 dark:text-blue-300"
                onClick={() => setHintOpen((prev) => !prev)}
              >
                {hintOpen ? t("hideAiHint") : t("showAiHint")}
              </button>
              {hintOpen ? (
                <pre className="mt-2 text-xs text-blue-900 dark:text-blue-100">
                  {JSON.stringify(task.ai_suggestion, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="space-y-4 rounded-3xl bg-white/95 p-4 shadow-xl ring-1 ring-slate-100 dark:bg-slate-900/80 dark:ring-slate-800">
        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("answerLabel")}
        </p>
        {isStructured && payloadObj ? (
          <StructuredForm
            taskType={task.task_type}
            payload={payloadObj}
            onChange={(updated) => setPayloadObj(updated)}
          />
        ) : (
          <textarea
            className="w-full min-h-[200px] rounded-2xl border border-slate-200 bg-slate-50/80 p-3 font-mono text-sm text-slate-900 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-500 dark:focus:ring-blue-500/30"
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
          />
        )}
        {error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : null}
      </section>

        {!isStructured && (
          <section className="rounded-3xl bg-white/95 p-4 shadow ring-1 ring-slate-100 dark:bg-slate-900/80 dark:ring-slate-800">
            <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {t("payloadPreviewLabel")}
            </p>
            <pre className="mt-2 max-h-56 overflow-x-auto rounded-2xl bg-slate-900/80 p-3 text-[11px] text-slate-50 dark:bg-slate-950">
              {payloadText}
            </pre>
          </section>
        )}
      </main>
      <TaskActionBar
        onSkip={skipTask}
        onSubmit={submitTask}
        releasing={releasing}
        submitting={submitting}
      />
    </div>
  );
}

function StructuredForm({
  taskType,
  payload,
  onChange,
}: {
  taskType: string;
  payload: any;
  onChange: (value: any) => void;
}) {
  const t = useTranslations();
  const [newGesture, setNewGesture] = useState<{
    label: string;
    t: string;
  }>({ label: "", t: "" });

  if (taskType === "translation_check") {
    const value = payload as TranslationCheckPayload;
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("translationQuestion")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {["yes", "no"].map((option) => {
            const approved = option === "yes";
            const active = value.approved === approved;
            return (
              <OptionButton
                key={option}
                label={approved ? t("optionYes") : t("optionNo")}
                active={active}
                onClick={() => onChange({ ...value, approved })}
              />
            );
          })}
        </div>
        {!value.approved ? (
          <textarea
            className={TEXTAREA_BASE_CLASS}
            placeholder={t("correctedTranslationPlaceholder")}
            value={value.edit ?? ""}
            onChange={(event) =>
              onChange({ ...value, edit: event.target.value })
            }
          />
        ) : null}
        <textarea
          className={TEXTAREA_BASE_CLASS}
          placeholder={t("notesOptionalPlaceholder")}
          value={value.notes ?? ""}
          onChange={(event) =>
            onChange({ ...value, notes: event.target.value })
          }
        />
      </div>
    );
  }

  if (taskType === "accent_tag") {
    const value = payload as AccentTagPayload;
    const options = ["American", "British", "Australian", "Indian", "Other"];
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("selectAccent")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => (
            <OptionButton
              key={option}
              label={option}
              active={value.region === option}
              onClick={() => onChange({ ...value, region: option })}
            />
          ))}
        </div>
        {value.region === "Other" ? (
          <input
            className={INPUT_BASE_CLASS}
            placeholder={t("describeAccentPlaceholder")}
            value={value.country ?? ""}
            onChange={(event) =>
              onChange({ ...value, country: event.target.value })
            }
          />
        ) : null}
        <ConfidenceSlider
          label={t("confidenceLabel")}
          value={value.confidence ?? 0.5}
          onChange={(next) => onChange({ ...value, confidence: next })}
        />
      </div>
    );
  }

  if (taskType === "emotion_tag") {
    const value = payload as EmotionTagPayload;
    const options = ["Happy", "Neutral", "Angry", "Sad", "Surprised", "Other"];
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("selectEmotion")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {options.map((option) => (
            <OptionButton
              key={option}
              label={option}
              active={value.emotion_primary === option}
              onClick={() =>
                onChange({
                  ...value,
                  emotion_primary: option,
                })
              }
            />
          ))}
        </div>
        {value.emotion_primary === "Other" ? (
          <input
            className={INPUT_BASE_CLASS}
            placeholder={t("describeEmotionPlaceholder")}
            value={value.secondary?.[0] ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                secondary: [event.target.value],
              })
            }
          />
        ) : null}
        <ConfidenceSlider
          label={t("confidenceLabel")}
          value={value.confidence ?? 0.5}
          onChange={(next) => onChange({ ...value, confidence: next })}
        />
      </div>
    );
  }

  if (taskType === "speaker_continuity") {
    const value = payload as SpeakerContinuityPayload;
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t("speakerLabelPlaceholder")}
          </p>
          <input
            className={INPUT_BASE_CLASS}
            value={value.speaker ?? ""}
            onChange={(event) =>
              onChange({ ...value, speaker: event.target.value })
            }
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t("sameAsClipPlaceholder")}
          </p>
          <input
            className={INPUT_BASE_CLASS}
            value={value.same_as_clip ?? ""}
            onChange={(event) =>
              onChange({ ...value, same_as_clip: event.target.value })
            }
          />
        </div>
        <ConfidenceSlider
          label={t("confidenceLabel")}
          value={value.confidence ?? 0.5}
          onChange={(next) => onChange({ ...value, confidence: next })}
        />
        <textarea
          className={TEXTAREA_BASE_CLASS}
          placeholder={t("notesOptionalPlaceholder")}
          value={value.notes ?? ""}
          onChange={(event) =>
            onChange({ ...value, notes: event.target.value })
          }
        />
      </div>
    );
  }

  if (taskType === "gesture_tag") {
    const value = payload as GestureTagPayload;
    const events = value.events ?? [];
    const updateEvents = (next: GestureTagEvent[]) =>
      onChange({ ...value, events: next });
    return (
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("gesturesLabel")}
        </p>
        {events.length ? (
          <ul className="space-y-2">
            {events.map((event, index) => (
              <li
                key={`${event.label}-${event.t}-${index}`}
                className="rounded-2xl border-2 border-slate-200 px-3 py-2 dark:border-slate-700"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {event.label}
                    </p>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {event.t}ms
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-xs font-semibold text-rose-600 transition hover:text-rose-700 dark:text-rose-300 dark:hover:text-rose-200"
                    onClick={() =>
                      updateEvents(events.filter((_, idx) => idx !== index))
                    }
                  >
                    {t("removeAction")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("gesturesEmpty")}
          </p>
        )}
        <div className="space-y-2 rounded-2xl border border-dashed border-slate-300 p-3 dark:border-slate-700">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t("addGestureLabel")}
          </p>
          <input
            className={INPUT_BASE_CLASS}
            placeholder={t("gestureLabelPlaceholder")}
            value={newGesture.label}
            onChange={(event) =>
              setNewGesture((prev) => ({ ...prev, label: event.target.value }))
            }
          />
          <input
            className={INPUT_BASE_CLASS}
            placeholder={t("timestampPlaceholder")}
            value={newGesture.t}
            onChange={(event) =>
              setNewGesture((prev) => ({ ...prev, t: event.target.value }))
            }
          />
          <button
            type="button"
            className="w-full rounded-xl bg-slate-900 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            disabled={!newGesture.label}
            onClick={() => {
              const timestamp = Number.parseInt(newGesture.t || "0", 10) || 0;
              updateEvents([
                ...events,
                { label: newGesture.label.trim(), t: timestamp },
              ]);
              setNewGesture({ label: "", t: "" });
            }}
          >
            {t("addAction")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <textarea
      className={`${TEXTAREA_BASE_CLASS} font-mono`}
      value={JSON.stringify(payload, null, 2)}
      readOnly
    />
  );
}

function OptionButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${OPTION_BASE_CLASS} ${
        active ? OPTION_ACTIVE_CLASS : OPTION_INACTIVE_CLASS
      }`}
    >
      <span className="text-sm font-semibold">{label}</span>
      {description ? (
        <span
          className={`text-xs ${
            active
              ? "text-blue-800 dark:text-blue-100"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          {description}
        </span>
      ) : null}
    </button>
  );
}

function ConfidenceSlider({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  label: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <div className="flex items-center gap-3">
        <input
          className="w-full accent-blue-600 dark:accent-blue-400"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(event) =>
            onChange(Number.parseFloat(event.target.value) || 0)
          }
        />
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-300">
          {Math.round(value * 100)}%
        </span>
      </div>
    </div>
  );
}
function defaultPayload(taskType: string) {
  switch (taskType) {
    case "translation_check":
      return { approved: true, edit: "", notes: "" } as TranslationCheckPayload;
    case "accent_tag":
      return {
        speaker: "A",
        region: "American",
        country: "",
        confidence: 0.5,
      } as AccentTagPayload;
    case "emotion_tag":
      return {
        speaker: "A",
        emotion_primary: "Neutral",
        confidence: 0.5,
      } as EmotionTagPayload;
    case "speaker_continuity":
      return {
        speaker: "A",
        same_as_clip: "",
        confidence: 0.5,
        notes: "",
      } as SpeakerContinuityPayload;
    case "gesture_tag":
      return { events: [] } as GestureTagPayload;
    default:
      return {};
  }
}
function TaskActionBar({
  onSkip,
  onSubmit,
  releasing,
  submitting,
}: {
  onSkip: () => void;
  onSubmit: () => void;
  releasing: boolean;
  submitting: boolean;
}) {
  const t = useTranslations();
  const triggerHaptic = useCallback(() => {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(20);
    }
  }, []);

  const handleSkip = () => {
    triggerHaptic();
    onSkip();
  };

  const handleSubmit = () => {
    triggerHaptic();
    onSubmit();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-white/95 px-4 py-3 pb-5 shadow-[0_-4px_24px_rgba(15,23,42,0.18)] dark:bg-slate-950/95">
      <div className="mx-auto flex max-w-md gap-3">
        <button
          onClick={handleSkip}
          disabled={releasing || submitting}
          className="flex-1 rounded-lg bg-slate-200 py-3 font-semibold text-slate-800 transition hover:bg-slate-300 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
        >
          {releasing ? t("skippingState") : t("skipAction")}
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex-1 rounded-lg bg-blue-600 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
        >
          {submitting ? t("submittingState") : t("submitAction")}
        </button>
      </div>
    </div>
  );
}

function isRenderable(value: any) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function ContextTree({ data }: { data: any }) {
  if (!isRenderable(data)) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">-</p>;
  }
  if (typeof data !== "object") {
    return (
      <p className="break-words text-sm text-slate-700 dark:text-slate-200">
        {String(data)}
      </p>
    );
  }
  const entries = Array.isArray(data)
    ? data
        .map((value, index) => ({ key: `[${index}]`, value }))
        .filter((entry) => isRenderable(entry.value))
    : Object.entries(data)
        .map(([childKey, child]) => ({ key: childKey, value: child }))
        .filter((entry) => isRenderable(entry.value));

  if (!entries.length) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">-</p>;
  }

  return (
    <ul className="space-y-2 border-l border-slate-200 pl-3 text-sm dark:border-slate-700">
      {entries.map(({ key, value }) => (
        <ContextTreeNode
          key={`${key}`}
          label={String(key)}
          value={value}
          depth={0}
        />
      ))}
    </ul>
  );
}

function ContextTreeNode({
  label,
  value,
  depth,
}: {
  label: string;
  value: any;
  depth: number;
}) {
  if (!isRenderable(value)) {
    return null;
  }
  const isLeaf = value === null || typeof value !== "object";
  const [open, setOpen] = useState(depth < 1);
  if (isLeaf) {
    return (
      <li className="space-y-0.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </p>
        <p className="break-words text-sm text-slate-700 dark:text-slate-200">
          {String(value)}
        </p>
      </li>
    );
  }

  const entries = (Array.isArray(value)
    ? value.map((child, index) => ({
        key: `[${index}]`,
        child,
      }))
    : Object.entries(value).map(([childKey, child]) => ({
        key: childKey,
        child,
      }))).filter(({ child }) => isRenderable(child));

  if (!entries.length) return null;

  return (
    <li className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-md bg-white px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600 shadow-sm transition hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
      >
        <span>{label}</span>
        <span className="text-xs font-bold">{open ? "-" : "+"}</span>
      </button>
      {open ? (
        <ul className="space-y-1 border-l border-dashed border-slate-200 pl-3 dark:border-slate-700">
          {entries.map(({ key, child }) => (
            <ContextTreeNode
              key={`${label}-${key}-${depth}`}
              label={String(key)}
              value={child}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}































