import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { claimSingleTask } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { mockClaimSingle, mockModeActive } from "../../../../../lib/mobile/mockRepo";
import { consumeRateLimit } from "../../../../../lib/mobile/rateLimit";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    if (
      !consumeRateLimit(contributor.id, "tasks/hour", 60, 60 * 60 * 1000)
    ) {
      return NextResponse.json(
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const mockTask = mockClaimSingle(contributor.id);
      return NextResponse.json(mockTask, {
        headers: { "x-mobile-mock-data": "true" },
      });
    }
    const claimed = await claimSingleTask(contributor, supabase);
    if (!claimed) {
      throw new MobileApiError("NO_TASKS", 404, "No tasks available");
    }
    return NextResponse.json(claimed);
  } catch (error) {
    if (error instanceof MobileApiError && error.code !== "SERVER_ERROR") {
      return errorResponse(error);
    }
    console.warn("[mobile/next] falling back to mock task", error);
    return NextResponse.json(mockClaimSingle("fallback"), {
      headers: { "x-mobile-mock-data": "true" },
    });
  }
}
