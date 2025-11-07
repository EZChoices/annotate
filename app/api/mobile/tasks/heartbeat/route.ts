import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { refreshLease } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const body = await req.json();
    const assignmentId = body?.assignment_id;
    if (!assignmentId) {
      throw new MobileApiError(
        "VALIDATION_FAILED",
        400,
        "assignment_id is required"
      );
    }
    const { contributor, supabase } = await requireContributor(req);
    const lease = await refreshLease(
      contributor,
      supabase,
      assignmentId,
      body?.playback_ratio,
      body?.watched_ms
    );
    return NextResponse.json({ ok: true, lease_expires_at: lease });
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[mobile/heartbeat]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}

