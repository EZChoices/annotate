import { NextRequest, NextResponse } from "next/server";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { getServiceSupabase } from "../../../../../lib/supabaseServer";
import { randomUUID } from "crypto";

type GoldenRecord = {
  asset_id?: string;
  asset_uri?: string;
  clip?: {
    id?: string;
    start_ms: number;
    end_ms: number;
    overlap_ms?: number;
    speakers?: string[];
  };
  task_type: string;
  price_cents?: number;
  golden_answer: Record<string, any>;
  meta?: Record<string, any>;
};

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor } = await requireContributor(req);
    if (contributor.role !== "admin") {
      throw new MobileApiError("FORBIDDEN", 403, "Admin access required");
    }
    const payload = await req.text();
    if (!payload?.trim()) {
      throw new MobileApiError("VALIDATION_FAILED", 400, "Body cannot be empty");
    }

    const supabase = getServiceSupabase();
    const lines = payload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let inserted = 0;
    for (const line of lines) {
      const record = JSON.parse(line) as GoldenRecord;
      if (!record.task_type || !record.clip) {
        continue;
      }
      const assetId = record.asset_id || randomUUID();
      await supabase
        .from("media_assets")
        .upsert({
          id: assetId,
          kind: "video",
          uri: record.asset_uri || "",
          duration_ms: Math.max(
            0,
            (record.clip.end_ms ?? 0) - (record.clip.start_ms ?? 0)
          ),
          meta: {},
        });

      const clipId = record.clip.id || randomUUID();
      await supabase
        .from("clips")
        .upsert({
          id: clipId,
          asset_id: assetId,
          start_ms: record.clip.start_ms,
          end_ms: record.clip.end_ms,
          overlap_ms: record.clip.overlap_ms ?? 2000,
          speakers: record.clip.speakers ?? [],
        });

      await supabase.from("tasks").insert({
        id: randomUUID(),
        clip_id: clipId,
        task_type: record.task_type,
        status: "pending",
        target_votes: 5,
        min_green_for_skip_qa: 4,
        min_green_for_review: 3,
        price_cents: record.price_cents ?? 0,
        ai_suggestion: {},
        meta: record.meta ?? {},
        is_golden: true,
        golden_answer: record.golden_answer,
      });

      inserted += 1;
    }

    return NextResponse.json({ ok: true, inserted });
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[admin/goldens]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}
