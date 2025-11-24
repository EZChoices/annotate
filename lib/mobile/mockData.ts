import { randomUUID } from "crypto";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
  MobileClipPayload,
  TaskType,
} from "./types";
import { isMockModeEnabled } from "./health";

const TWELVE_SECONDS = 12_000;

const MOCK_CLIPS: Array<{
  clip: MobileClipPayload;
  task_type: TaskType;
  price_cents: number;
  ai_suggestion?: Record<string, any>;
  context: Record<string, any>;
}> = [
  {
    clip: {
      id: "mock-clip-1",
      asset_id: "mock-asset-1",
      start_ms: 0,
      end_ms: TWELVE_SECONDS,
      overlap_ms: 2000,
      speakers: ["A"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      video_url:
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      captions_vtt_url:
        "https://gist.githubusercontent.com/raw/cc0-example/flower-en.vtt",
      captions_auto_enabled: true,
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "translation_check",
    price_cents: 8,
    ai_suggestion: {
      translation: "Hello! Thanks for taking the survey today.",
    },
    context: {
      transcript:
        "مرحبا! شكرا للمشاركة. نحتاج فقط إلى بعض المعلومات الإضافية منك.",
      translation:
        "Hello! Thanks for taking part. We just need a little more information from you.",
      window: "+/- 24s",
    },
  },
  {
    clip: {
      id: "mock-clip-2",
      asset_id: "mock-asset-2",
      start_ms: 0,
      end_ms: TWELVE_SECONDS,
      overlap_ms: 2000,
      speakers: ["A"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
      video_url:
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm",
      captions_vtt_url:
        "https://gist.githubusercontent.com/raw/cc0-example/flower-ar.vtt",
      captions_auto_enabled: true,
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "emotion_tag",
    price_cents: 7,
    ai_suggestion: {
      emotion_primary: "Happy",
      confidence: 0.74,
    },
    context: {
      summary:
        "Speaker reminisces about a family celebration and sounds upbeat.",
      window: "+/- 24s",
    },
  },
  {
    clip: {
      id: "mock-clip-3",
      asset_id: "mock-asset-3",
      start_ms: 0,
      end_ms: TWELVE_SECONDS,
      overlap_ms: 2000,
      speakers: ["A", "B"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
      video_url: null,
      captions_vtt_url:
        "https://gist.githubusercontent.com/raw/cc0-example/flower-cc.vtt",
      captions_auto_enabled: true,
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "speaker_continuity",
    price_cents: 7,
    ai_suggestion: {
      same_as_clip: "previous_segment_12",
      confidence: 0.65,
    },
    context: {
      diarization: [
        { speaker: "A", from: 0, to: 6000 },
        { speaker: "B", from: 6000, to: 12000 },
      ],
      window: "+/- 24s",
    },
  },
];

export function isMobileMockMode(): boolean {
  return isMockModeEnabled();
}

export function generateMockBundle(
  count = 3,
  bundleId = `mock-bundle-${Date.now()}`
): MobileBundleResponse {
  const tasks: MobileClaimResponse[] = [];
  for (let i = 0; i < count; i += 1) {
    const template = MOCK_CLIPS[i % MOCK_CLIPS.length];
    tasks.push({
      task_id: `mock-task-${template.clip.id}-${Date.now()}-${i}`,
      assignment_id: `mock-assign-${randomUUID()}`,
      lease_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      clip: { ...template.clip },
      task_type: template.task_type,
      ai_suggestion: template.ai_suggestion,
      price_cents: template.price_cents,
      bundle_id: bundleId,
    });
  }
  return {
    bundle_id: bundleId,
    tasks,
  };
}

export function generateMockTask(): MobileClaimResponse {
  return generateMockBundle(1).tasks[0];
}

export function getMockContext(clipId: string) {
  const template =
    MOCK_CLIPS.find((entry) => entry.clip.id === clipId) || MOCK_CLIPS[0];
  const { clip, context } = template;
  const prev = {
    start_ms: Math.max(clip.start_ms - TWELVE_SECONDS, 0),
    end_ms: clip.start_ms,
    audio_url: clip.audio_url,
  };
  const next = {
    start_ms: clip.end_ms,
    end_ms: clip.end_ms + TWELVE_SECONDS,
    audio_url: clip.audio_url,
  };
  const rawDiarization = Array.isArray(context.diarization)
    ? context.diarization
    : null;
  const diarization = rawDiarization
    ? rawDiarization.map(
        (segment: { speaker: string; from: number; to: number }) =>
          `${segment.speaker}: ${segment.from}-${segment.to}ms`
      )
    : clip.speakers ?? [];
  return {
    clip_id: clip.id,
    prev,
    next,
    transcript_snippet: context.transcript ?? context.summary ?? null,
    translation_snippet: context.translation ?? null,
    diarization,
    window_seconds: 24,
    ...context,
    mock: true,
  };
}
