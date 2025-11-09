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

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const countParam = Number(req.nextUrl.searchParams.get("count"));
  const requestedCount =
    Number.isFinite(countParam) && countParam > 0
      ? Math.min(Math.trunc(countParam), 10)
      : MOBILE_DEFAULT_BUNDLE_SIZE;
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    if (
      !consumeRateLimit(contributor.id, "bundle/hour", 10, 60 * 60 * 1000)
    ) {
      return NextResponse.json(
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const mockBundle = mockClaimBundle(contributor.id, requestedCount);
      return NextResponse.json(mockBundle, {
        headers: { "x-mobile-mock-data": "true" },
      });
    }

    const bundle = await claimBundle(contributor, supabase, requestedCount);
    return NextResponse.json(bundle);
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      return errorResponse(error);
    }
    console.warn("[mobile/bundle] falling back to mock data", error);
    return NextResponse.json(mockClaimBundle("fallback", requestedCount), {
      headers: { "x-mobile-mock-data": "true" },
    });
  }
}
