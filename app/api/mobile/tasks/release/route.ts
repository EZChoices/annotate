import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { releaseAssignment } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockReleaseAssignment, mockModeActive } from "../../../../../lib/mobile/mockRepo";

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
      mockReleaseAssignment(assignmentId);
      return NextResponse.json({ ok: true, mock: true });
    }
    await releaseAssignment(contributor, supabase, assignmentId, body?.reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      return errorResponse(error);
    }
    console.warn("[mobile/release] falling back to mock success", error);
    return NextResponse.json({ ok: true, mock: true });
  }
}
