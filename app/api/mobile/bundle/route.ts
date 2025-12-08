import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import {
  claimBundle,
  summarizeCandidateTasks,
} from "../../../../lib/mobile/taskService";
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
  let contributorContext: Awaited<ReturnType<typeof requireContributor>> | null =
    null;
  try {
    assertMobileFeatureEnabled();
    contributorContext = await requireContributor(req);
    const { contributor, supabase } = contributorContext;
    userId = contributor.id;
    if (
      !consumeRateLimit(contributor.id, "bundle/hour", 100, 60 * 60 * 1000)
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
    if (error instanceof MobileApiError) {
      if (error.code === "NO_TASKS") {
        const skipReasons =
          (error as MobileApiError & { skipReasons?: unknown }).skipReasons ??
          null;
        const candidateStats =
          contributorContext?.supabase && !mockModeActive()
            ? await summarizeCandidateTasks(contributorContext.supabase)
            : null;

        console.warn("[mobile bundle] NO_TASKS", {
          contributorId: contributorContext?.contributor.id,
          locale: contributorContext?.contributor.locale,
          featureFlags: contributorContext?.contributor.feature_flags,
          skipReasons,
          filters: {
            status: ["pending", "in_progress"],
            requiredLocale: contributorContext?.contributor.locale ?? null,
            requiredGeo: contributorContext?.contributor.geo_country ?? null,
            tier: contributorContext?.contributor.tier ?? null,
          },
          queryStats: {
            totalCandidates: candidateStats?.totalCandidates ?? -1,
            finalPicked: 0,
          },
        });

        const response = NextResponse.json(
          {
            status: "NO_TASKS",
            debug: {
              contributorId: contributorContext?.contributor.id ?? null,
              locale: contributorContext?.contributor.locale ?? null,
              featureFlags: contributorContext?.contributor.feature_flags ?? null,
              skipReasons,
            },
          },
          { status: 200 }
        );

        logMobileApi(
          "GET /api/mobile/bundle",
          userId,
          response.status,
          startedAt
        );
        return response;
      }
      const response = errorResponse(error);
      logMobileApi("GET /api/mobile/bundle", userId, response.status, startedAt);
      return response;
    }
    console.error("[mobile/bundle] unexpected error", error);
    return jsonWithLog(
      "GET /api/mobile/bundle",
      userId,
      startedAt,
      {
        error: "SERVER_ERROR",
        message: "Bundle fetch failed. Check Supabase/Bunny configuration.",
      },
      { status: 500 }
    );
  }
}
