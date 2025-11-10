import { NextRequest } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { refreshLease } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockHeartbeat, mockModeActive } from "../../../../../lib/mobile/mockRepo";
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
      const lease = mockHeartbeat(assignmentId);
      return jsonWithLog(
        "POST /api/mobile/tasks/heartbeat",
        userId,
        startedAt,
        {
          ok: true,
          lease_expires_at:
            lease ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        },
        { headers: { "x-mobile-mock-data": "true" } }
      );
    }
    const lease = await refreshLease(
      contributor,
      supabase,
      assignmentId,
      body?.playback_ratio,
      body?.watched_ms
    );
    return jsonWithLog(
      "POST /api/mobile/tasks/heartbeat",
      userId,
      startedAt,
      { ok: true, lease_expires_at: lease }
    );
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      const response = errorResponse(error);
      logMobileApi(
        "POST /api/mobile/tasks/heartbeat",
        userId,
        response.status,
        startedAt
      );
      return response;
    }
    console.warn("[mobile/heartbeat] falling back to mock success", error);
    return jsonWithLog(
      "POST /api/mobile/tasks/heartbeat",
      userId,
      startedAt,
      {
        ok: true,
        lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
      { headers: { "x-mobile-mock-data": "true" } }
    );
  }
}
