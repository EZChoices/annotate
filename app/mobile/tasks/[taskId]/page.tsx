"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MobileClaimResponse,
  TranslationCheckPayload,
  AccentTagPayload,
  EmotionTagPayload,
} from "../../../../lib/mobile/types";
import {
  loadCachedBundles,
  queueSubmission,
  PendingSubmission,
} from "../../../../lib/mobile/idb";

export default function MobileTaskPage() {
  const paramValues = useParams<{ taskId: string }>();
  const taskId = paramValues?.taskId ?? "";
  const search = useSearchParams();
  const router = useRouter();
  const assignmentId = search?.get("assignment") || "";
  const [task, setTask] = useState<MobileClaimResponse | null>(null);
  const [payloadObj, setPayloadObj] = useState<any | null>(null);
  const [payloadText, setPayloadText] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoVisible, setVideoVisible] = useState(false);
  const [context, setContext] = useState<any>(null);
  const [hintOpen, setHintOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [watchedSec, setWatchedSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    loadCachedBundles().then((bundles) => {
      const found = bundles
        .flatMap((bundle) => bundle.tasks)
        .find((t) => t.task_id === taskId);
      if (found) {
        setTask(found);
        const initial = defaultPayload(found.task_type);
        setPayloadObj(initial);
        setPayloadText(JSON.stringify(initial, null, 2));
        setDurationSec(
          Math.max(
            1,
            Math.round((found.clip.end_ms - found.clip.start_ms) / 1000)
          )
        );
      }
    });
  }, [taskId]);

  const playbackRatio = useMemo(() => {
    if (!durationSec) return 0;
    return Math.min(1, watchedSec / durationSec);
  }, [watchedSec, durationSec]);

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setWatchedSec((prev) => Math.max(prev, audio.currentTime || 0));
    if (audio.duration) {
      setDurationSec(Math.round(audio.duration));
    }
  };

  const structuredTaskTypes = new Set([
    "translation_check",
    "accent_tag",
    "emotion_tag",
  ]);
  const isStructured = task ? structuredTaskTypes.has(task.task_type) : false;

  const submit = async () => {
    if (!task || !assignmentId) return;
    setSubmitting(true);
    setError(null);
    let payloadData: any = null;
    try {
      if (isStructured) {
        payloadData = payloadObj ?? {};
      } else {
        payloadData = payloadText ? JSON.parse(payloadText) : {};
      }
    } catch {
      setError("Payload must be valid JSON");
      setSubmitting(false);
      return;
    }
    if (!payloadData || Object.keys(payloadData).length === 0) {
      setError("Payload is required");
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
      const response = await fetch("/api/mobile/tasks/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Submit failed");
      }
      router.push("/mobile");
    } catch (err: any) {
      setError(err.message || "Submit failed. Queued offline.");
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

  const loadContext = async () => {
    if (!task) return;
    const response = await fetch(`/api/mobile/context?clip_id=${task.clip.id}`);
    if (response.ok) {
      setContext(await response.json());
    }
  };

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

  const skipTask = async () => {
    if (!assignmentId) return;
    setReleasing(true);
    try {
      await fetch("/api/mobile/tasks/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId,
          reason: "not_confident",
        }),
      });
      router.push("/mobile");
    } catch (err: any) {
      setError(err.message || "Skip failed");
    } finally {
      setReleasing(false);
    }
  };

  if (!task) {
    return (
      <main className="p-4 text-center text-sm text-slate-500">
        Loading task…
      </main>
    );
  }

  return (
    <main className="p-4 space-y-4">
      <button
        className="text-sm text-blue-600"
        onClick={() => router.push("/mobile")}
      >
        ← Back to tasks
      </button>
      <section className="bg-white p-4 rounded-2xl shadow space-y-3">
        <p className="text-xs text-slate-500 uppercase">{task.task_type}</p>
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold">Clip preview</p>
          <span className={`text-xs ${online ? "text-green-600" : "text-amber-600"}`}>
            {online ? "Online" : "Offline"}
          </span>
        </div>
        {task.clip.audio_url ? (
          <audio
            ref={audioRef}
            controls
            className="w-full"
            src={task.clip.audio_url}
            onTimeUpdate={onTimeUpdate}
          />
        ) : (
          <p className="text-sm text-slate-500">Audio unavailable</p>
        )}
        <button
          onClick={() => setVideoVisible((prev) => !prev)}
          className="text-sm text-blue-600"
        >
          {videoVisible ? "Hide Video" : "Show Video"}
        </button>
        {videoVisible && task.clip.video_url ? (
          <video
            controls
            className="w-full rounded-lg"
            src={task.clip.video_url}
          />
        ) : null}
        <p className="text-xs text-slate-500">
          Watched {(watchedSec || 0).toFixed(1)}s · Playback ratio{" "}
          {(playbackRatio * 100).toFixed(0)}%
        </p>
        <button
          className="text-sm text-blue-600"
          onClick={loadContext}
        >
          Load extended context
        </button>
        {context ? (
          <pre className="text-[11px] bg-slate-100 p-2 rounded">
            {JSON.stringify(context, null, 2)}
          </pre>
        ) : null}
        {task.ai_suggestion ? (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <button
              className="text-sm font-semibold text-blue-700"
              onClick={() => setHintOpen((prev) => !prev)}
            >
              {hintOpen ? "Hide AI hint" : "Show AI hint"}
            </button>
            {hintOpen ? (
              <pre className="text-xs text-slate-700 mt-2 whitespace-pre-wrap">
                {JSON.stringify(task.ai_suggestion, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="bg-white p-4 rounded-2xl shadow space-y-3">
        <p className="font-semibold">Answer</p>
        {isStructured && payloadObj ? (
          <StructuredForm
            task={task}
            payload={payloadObj}
            onChange={setPayloadObj}
          />
        ) : (
          <textarea
            className="w-full min-h-[200px] border rounded-lg p-2 font-mono text-sm"
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
          />
        )}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="flex gap-3">
          <button
            onClick={skipTask}
            disabled={releasing || submitting}
            className="flex-1 bg-slate-200 text-slate-800 rounded-lg py-3 font-semibold disabled:opacity-60"
          >
            {releasing ? "Skipping..." : "Skip"}
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="flex-1 bg-blue-600 text-white rounded-lg py-3 font-semibold disabled:opacity-60"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </div>
      </section>
    </main>
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
    case "gesture_tag":
      return { events: [] };
    default:
      return {};
  }
}

function StructuredForm({
  task,
  payload,
  onChange,
}: {
  task: MobileClaimResponse;
  payload: any;
  onChange: (value: any) => void;
}) {
  if (task.task_type === "translation_check") {
    const value = payload as TranslationCheckPayload;
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Is the translation correct?</p>
        <div className="flex gap-3">
          {["yes", "no"].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() =>
                onChange({ ...value, approved: option === "yes" })
              }
              className={`flex-1 border rounded-lg py-2 font-semibold ${
                value.approved === (option === "yes")
                  ? "border-blue-500 text-blue-600"
                  : "border-slate-300"
              }`}
            >
              {option === "yes" ? "Yes" : "No"}
            </button>
          ))}
        </div>
        {!value.approved ? (
          <textarea
            className="w-full border rounded-lg p-2 text-sm"
            placeholder="Provide the corrected translation"
            value={value.edit ?? ""}
            onChange={(event) =>
              onChange({ ...value, edit: event.target.value })
            }
          />
        ) : null}
        <textarea
          className="w-full border rounded-lg p-2 text-sm"
          placeholder="Notes (optional)"
          value={value.notes ?? ""}
          onChange={(event) =>
            onChange({ ...value, notes: event.target.value })
          }
        />
      </div>
    );
  }

  if (task.task_type === "accent_tag") {
    const value = payload as AccentTagPayload;
    const options = ["American", "British", "Australian", "Indian", "Other"];
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Select the accent</p>
        <div className="flex flex-col gap-2">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={value.region === option}
                onChange={() => onChange({ ...value, region: option })}
              />
              {option}
            </label>
          ))}
        </div>
        {value.region === "Other" ? (
          <input
            className="w-full border rounded-lg p-2 text-sm"
            placeholder="Describe the accent"
            value={value.country ?? ""}
            onChange={(event) =>
              onChange({ ...value, country: event.target.value })
            }
          />
        ) : null}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Confidence</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={value.confidence ?? 0.5}
            onChange={(event) =>
              onChange({
                ...value,
                confidence: Number.parseFloat(event.target.value),
              })
            }
          />
        </div>
      </div>
    );
  }

  if (task.task_type === "emotion_tag") {
    const value = payload as EmotionTagPayload;
    const options = ["Happy", "Neutral", "Angry", "Sad", "Surprised", "Other"];
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Select the emotion</p>
        <div className="flex flex-col gap-2">
          {options.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={value.emotion_primary === option}
                onChange={() =>
                  onChange({
                    ...value,
                    emotion_primary: option,
                  })
                }
              />
              {option}
            </label>
          ))}
        </div>
        {value.emotion_primary === "Other" ? (
          <input
            className="w-full border rounded-lg p-2 text-sm"
            placeholder="Describe the emotion"
            value={value.secondary?.[0] ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                secondary: [event.target.value],
              })
            }
          />
        ) : null}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium">Confidence</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={value.confidence ?? 0.5}
            onChange={(event) =>
              onChange({
                ...value,
                confidence: Number.parseFloat(event.target.value),
              })
            }
          />
        </div>
      </div>
    );
  }

  return (
    <textarea
      className="w-full min-h-[200px] border rounded-lg p-2 font-mono text-sm"
      defaultValue={JSON.stringify(payload, null, 2)}
      readOnly
    />
  );
}
