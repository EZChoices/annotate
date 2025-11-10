import { NextRequest } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { releaseAssignment } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockReleaseAssignment, mockModeActive } from "../../../../../lib/mobile/mockRepo";
import { jsonWithLog, logMobileApi } from "../../../../../lib/mobile/logging";

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
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
    userId = contributor.id;
    if (mockModeActive()) {
      mockReleaseAssignment(assignmentId);
      return jsonWithLog(
        "POST /api/mobile/tasks/release",
        userId,
        startedAt,
        { ok: true },
        { headers: { "x-mobile-mock-data": "true" } }
      );
    }
    await releaseAssignment(contributor, supabase, assignmentId, body?.reason);
    return jsonWithLog(
      "POST /api/mobile/tasks/release",
      userId,
      startedAt,
      { ok: true }
    );
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      const response = errorResponse(error);
      logMobileApi(
        "POST /api/mobile/tasks/release",
        userId,
        response.status,
        startedAt
      );
      return response;
    }
    console.warn("[mobile/release] falling back to mock success", error);
    return jsonWithLog(
      "POST /api/mobile/tasks/release",
      userId,
      startedAt,
      { ok: true },
      { headers: { "x-mobile-mock-data": "true" } }
    );
  }
}
