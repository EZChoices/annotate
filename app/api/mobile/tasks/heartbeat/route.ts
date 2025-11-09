import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { refreshLease } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockHeartbeat, mockModeActive } from "../../../../../lib/mobile/mockRepo";

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
    if (mockModeActive()) {
      const lease = mockHeartbeat(assignmentId);
      return NextResponse.json({
        ok: true,
        lease_expires_at:
          lease ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        mock: true,
      });
    }
    const lease = await refreshLease(
      contributor,
      supabase,
      assignmentId,
      body?.playback_ratio,
      body?.watched_ms
    );
    return NextResponse.json({ ok: true, lease_expires_at: lease });
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      return errorResponse(error);
    }
    console.warn("[mobile/heartbeat] falling back to mock success", error);
    return NextResponse.json({
      ok: true,
      lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      mock: true,
    });
  }
}
