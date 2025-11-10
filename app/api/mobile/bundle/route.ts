import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { claimBundle } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";
import { MOBILE_DEFAULT_BUNDLE_SIZE } from "../../../../lib/mobile/constants";
import {
  mockClaimBundle,
  mockModeActive,
} from "../../../../lib/mobile/mockRepo";
import { consumeRateLimit } from "../../../../lib/mobile/rateLimit";
import { jsonWithLog, logMobileApi } from "../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const countParam = Number(req.nextUrl.searchParams.get("count"));
  const requestedCount =
    Number.isFinite(countParam) && countParam > 0
      ? Math.min(Math.trunc(countParam), 10)
      : MOBILE_DEFAULT_BUNDLE_SIZE;
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    userId = contributor.id;
    if (
      !consumeRateLimit(contributor.id, "bundle/hour", 10, 60 * 60 * 1000)
    ) {
      return jsonWithLog(
        "GET /api/mobile/bundle",
        userId,
        startedAt,
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const mockBundle = mockClaimBundle(contributor.id, requestedCount);
      return jsonWithLog(
        "GET /api/mobile/bundle",
        userId,
        startedAt,
        mockBundle,
        {
          headers: { "x-mobile-mock-data": "true" },
        }
      );
    }

    const bundle = await claimBundle(contributor, supabase, requestedCount);
    return jsonWithLog(
      "GET /api/mobile/bundle",
      userId,
      startedAt,
      bundle
    );
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      const response = errorResponse(error);
      logMobileApi("GET /api/mobile/bundle", userId, response.status, startedAt);
      return response;
    }
    console.warn("[mobile/bundle] falling back to mock data", error);
    return jsonWithLog(
      "GET /api/mobile/bundle",
      userId,
      startedAt,
      mockClaimBundle("fallback", requestedCount),
      {
        headers: { "x-mobile-mock-data": "true" },
      }
    );
  }
}
