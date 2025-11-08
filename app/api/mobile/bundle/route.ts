import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { claimBundle } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";
import { MOBILE_DEFAULT_BUNDLE_SIZE } from "../../../../lib/mobile/constants";
import {
  generateMockBundle,
  isMobileMockMode,
} from "../../../../lib/mobile/mockData";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const countParam = Number(req.nextUrl.searchParams.get("count"));
  const requestedCount =
    Number.isFinite(countParam) && countParam > 0
      ? Math.min(Math.trunc(countParam), 10)
      : MOBILE_DEFAULT_BUNDLE_SIZE;
  try {
    assertMobileFeatureEnabled();
    if (isMobileMockMode()) {
      return NextResponse.json(generateMockBundle(requestedCount), {
        headers: { "x-mobile-mock-data": "true" },
      });
    }

    const { contributor, supabase } = await requireContributor(req);
    const bundle = await claimBundle(contributor, supabase, requestedCount);
    return NextResponse.json(bundle);
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      return errorResponse(error);
    }
    console.warn("[mobile/bundle] falling back to mock data", error);
    return NextResponse.json(generateMockBundle(requestedCount), {
      headers: { "x-mobile-mock-data": "true" },
    });
  }
}
