import type { Database } from "../../types/supabase";
import { MOBILE_ALLOWED_TASK_TYPES } from "./constants";

export type ContributorRow = Database["public"]["Tables"]["contributors"]["Row"];
export type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];
export type TaskAssignmentRow =
  Database["public"]["Tables"]["task_assignments"]["Row"];
export type TaskResponseRow =
  Database["public"]["Tables"]["task_responses"]["Row"];
export type TaskBundleRow =
  Database["public"]["Tables"]["task_bundles"]["Row"];

export type TaskType = (typeof MOBILE_ALLOWED_TASK_TYPES)[number];

export type MobileTaskPayload =
  | TranslationCheckPayload
  | AccentTagPayload
  | EmotionTagPayload
  | GestureTagPayload
  | SafetyFlagPayload
  | SpeakerContinuityPayload;

export interface TranslationCheckPayload {
  approved: boolean;
  edit?: string;
  notes?: string;
}

export interface AccentTagPayload {
  speaker: string;
  region: string;
  country?: string;
  confidence?: number;
}

export interface EmotionTagPayload {
  speaker: string;
  emotion_primary: string;
  secondary?: string[];
  confidence?: number;
}

export interface GestureTagEvent {
  t: number;
  label: string;
}

export interface GestureTagPayload {
  events: GestureTagEvent[];
}

export interface SafetyFlagPayload {
  flag: string;
  notes?: string;
}

export interface SpeakerContinuityPayload {
  speaker: string;
  same_as_clip?: string;
  confidence?: number;
  notes?: string;
}

export interface MobileTaskResponseBody {
  task_id: string;
  assignment_id: string;
  payload: MobileTaskPayload;
  duration_ms: number;
  playback_ratio: number;
  client_ts?: string;
  seeking_events?: number;
  watched_ms?: number;
}

export interface MobileTaskReleaseBody {
  assignment_id: string;
  reason:
    | "not_confident"
    | "low_audio"
    | "wrong_lang"
    | "other"
    | string;
}

export interface MobileTaskHeartbeatBody {
  assignment_id: string;
  playback_ratio?: number;
  watched_ms?: number;
}

export interface MobileClaimResponse {
  task_id: string;
  assignment_id: string;
  lease_expires_at: string;
  clip: MobileClipPayload;
  task_type: TaskType;
  ai_suggestion?: Record<string, any>;
  price_cents: number;
  bundle_id?: string;
}

export interface MobileBundleResponse {
  bundle_id: string;
  tasks: MobileClaimResponse[];
}

export interface MobileClipPayload {
  id: string;
  asset_id: string;
  start_ms: number;
  end_ms: number;
  overlap_ms: number;
  speakers: string[];
  audio_url: string;
  video_url?: string | null;
  captions_vtt_url?: string | null;
  captions_auto_enabled?: boolean;
  context_prev_clip?: string | null;
  context_next_clip?: string | null;
}
