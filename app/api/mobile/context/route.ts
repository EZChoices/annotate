import { NextRequest } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { getClipContext } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";
import {
  getMockContext,
  isMobileMockMode,
} from "../../../../lib/mobile/mockData";
import { jsonWithLog, logMobileApi } from "../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const clipId = req.nextUrl.searchParams.get("clip_id");
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    assertMobileFeatureEnabled();
    if (!clipId) {
      throw new MobileApiError(
        "VALIDATION_FAILED",
        400,
        "clip_id query parameter required"
      );
    }

    if (isMobileMockMode()) {
      return jsonWithLog(
        "GET /api/mobile/context",
        userId,
        startedAt,
        getMockContext(clipId),
        { headers: { "x-mobile-mock-data": "true" } }
      );
    }

    const { contributor, supabase } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    userId = contributor.id;
    const context = await getClipContext(supabase, clipId);
    return jsonWithLog(
      "GET /api/mobile/context",
      userId,
      startedAt,
      { ...context }
    );
  } catch (error) {
    if (error instanceof MobileApiError) {
      const response = errorResponse(error);
      logMobileApi("GET /api/mobile/context", userId, response.status, startedAt);
      return response;
    }
    console.error("[mobile/context] unexpected error", error);
    return jsonWithLog(
      "GET /api/mobile/context",
      userId,
      startedAt,
      { error: "SERVER_ERROR", message: "Context lookup failed" },
      { status: 500 }
    );
  }
}
