import { randomUUID } from "crypto";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
  MobileClipPayload,
  TaskType,
} from "./types";

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
      end_ms: 45000,
      overlap_ms: 2000,
      speakers: ["A"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      video_url:
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "translation_check",
    price_cents: 75,
    ai_suggestion: {
      translation: "Hello! Thanks for taking the survey today.",
    },
    context: {
      transcript:
        "مرحبا! شكرا للمشاركة. نحتاج فقط إلى بعض المعلومات الإضافية منك.",
      translation:
        "Hello! Thanks for taking part. We just need a little more information from you.",
    },
  },
  {
    clip: {
      id: "mock-clip-2",
      asset_id: "mock-asset-2",
      start_ms: 0,
      end_ms: 30000,
      overlap_ms: 2000,
      speakers: ["A"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
      video_url:
        "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm",
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "emotion_tag",
    price_cents: 60,
    ai_suggestion: {
      emotion_primary: "Happy",
      confidence: 0.74,
    },
    context: {
      summary:
        "Speaker reminisces about a family celebration and sounds upbeat.",
    },
  },
  {
    clip: {
      id: "mock-clip-3",
      asset_id: "mock-asset-3",
      start_ms: 1000,
      end_ms: 55000,
      overlap_ms: 2000,
      speakers: ["A", "B"],
      audio_url:
        "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
      video_url: null,
      context_prev_clip: null,
      context_next_clip: null,
    },
    task_type: "speaker_continuity",
    price_cents: 70,
    ai_suggestion: {
      same_as_clip: "previous_segment_12",
      confidence: 0.65,
    },
    context: {
      diarization: [
        { speaker: "A", from: 0, to: 22 },
        { speaker: "B", from: 22, to: 46 },
      ],
    },
  },
];

export function isMobileMockMode(): boolean {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_KEY ||
    "";
  return (
    process.env.NEXT_PUBLIC_ENABLE_MOBILE_MOCK === "true" ||
    !serviceKey ||
    serviceKey === "mock" ||
    (!!anonKey && serviceKey === anonKey)
  );
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
  return {
    clip_id: template.clip.id,
    ...template.context,
    mock: true,
  };
}
