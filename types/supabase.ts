export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      contributors: {
        Row: {
          id: string;
          handle: string | null;
          email: string | null;
          tier: "bronze" | "silver" | "gold";
          locale: string | null;
          geo_country: string | null;
          capabilities: Json;
          feature_flags: Json;
          role: "contributor" | "qa" | "admin";
          created_at: string;
          updated_at: string;
        };
      };
      media_assets: {
        Row: {
          id: string;
          kind: "video" | "audio";
          uri: string;
          duration_ms: number;
          meta: Json;
          created_at: string;
        };
      };
      clips: {
        Row: {
          id: string;
          asset_id: string;
          start_ms: number;
          end_ms: number;
          overlap_ms: number;
          speakers: Json;
          context_prev_clip: string | null;
          context_next_clip: string | null;
          meta: Json;
          created_at: string;
        };
      };
      tasks: {
        Row: {
          id: string;
          clip_id: string;
          task_type: string;
          status: string;
          target_votes: number;
          min_green_for_skip_qa: number;
          min_green_for_review: number;
          price_cents: number;
          ai_suggestion: Json;
          meta: Json;
          is_golden: boolean;
          golden_answer: Json | null;
          created_at: string;
          updated_at: string;
        };
      };
      task_bundles: {
        Row: {
          id: string;
          contributor_id: string;
          created_at: string;
          ttl_minutes: number;
          state: "active" | "expired" | "closed";
        };
      };
      task_assignments: {
        Row: {
          id: string;
          task_id: string;
          contributor_id: string;
          bundle_id: string | null;
          state: "leased" | "submitted" | "expired" | "released";
          leased_at: string;
          lease_expires_at: string;
          last_heartbeat_at: string | null;
          playback_ratio: number | null;
          watched_ms: number | null;
        };
      };
      task_responses: {
        Row: {
          id: string;
          task_id: string;
          contributor_id: string;
          payload: Json;
          duration_ms: number | null;
          playback_ratio: number | null;
          created_at: string;
        };
      };
      task_consensus: {
        Row: {
          task_id: string;
          consensus: Json;
          votes: Json;
          green_count: number;
          agreement_score: number;
          decided_at: string;
          final_status: string;
        };
      };
      contributor_stats: {
        Row: {
          contributor_id: string;
          ewma_agreement: number;
          tasks_total: number;
          tasks_agreed: number;
          flags: number;
          last_active: string | null;
          golden_correct: number;
          golden_total: number;
        };
      };
      task_prices: {
        Row: {
          task_type: string;
          base_cents: number;
          surge_multiplier: number;
          updated_at: string;
        };
      };
      payouts: {
        Row: {
          id: string;
          contributor_id: string;
          period_start: string;
          period_end: string;
          amount_cents: number;
          export_uri: string | null;
          created_at: string;
        };
      };
      events_mobile: {
        Row: {
          id: number;
          contributor_id: string | null;
          name: string;
          props: Json;
          ts: string;
        };
      };
      idempotency_keys: {
        Row: {
          contributor_id: string;
          key: string;
          created_at: string;
        };
      };
    };
  };
}
