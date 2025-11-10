import { NextRequest } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { claimSingleTask } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockClaimSingle, mockModeActive } from "../../../../../lib/mobile/mockRepo";
import { consumeRateLimit } from "../../../../../lib/mobile/rateLimit";
import { jsonWithLog, logMobileApi } from "../../../../../lib/mobile/logging";

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    userId = contributor.id;
    if (
      !consumeRateLimit(contributor.id, "tasks/hour", 60, 60 * 60 * 1000)
    ) {
      return jsonWithLog(
        "POST /api/mobile/tasks/next",
        userId,
        startedAt,
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const mockTask = mockClaimSingle(contributor.id);
      return jsonWithLog(
        "POST /api/mobile/tasks/next",
        userId,
        startedAt,
        mockTask,
        { headers: { "x-mobile-mock-data": "true" } }
      );
    }
    const claimed = await claimSingleTask(contributor, supabase);
    if (!claimed) {
      throw new MobileApiError("NO_TASKS", 404, "No tasks available");
    }
    return jsonWithLog(
      "POST /api/mobile/tasks/next",
      userId,
      startedAt,
      claimed
    );
  } catch (error) {
    if (error instanceof MobileApiError && error.code !== "SERVER_ERROR") {
      const response = errorResponse(error);
      logMobileApi(
        "POST /api/mobile/tasks/next",
        userId,
        response.status,
        startedAt
      );
      return response;
    }
    console.warn("[mobile/next] falling back to mock task", error);
    return jsonWithLog(
      "POST /api/mobile/tasks/next",
      userId,
      startedAt,
      mockClaimSingle("fallback"),
      { headers: { "x-mobile-mock-data": "true" } }
    );
  }
}
