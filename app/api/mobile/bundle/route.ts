import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { claimBundle } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";
import { MOBILE_DEFAULT_BUNDLE_SIZE } from "../../../../lib/mobile/constants";

export async function GET(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const countParam = Number(req.nextUrl.searchParams.get("count"));
    const count = Number.isFinite(countParam) && countParam > 0
      ? Math.min(Math.trunc(countParam), 10)
      : MOBILE_DEFAULT_BUNDLE_SIZE;

    const { contributor, supabase } = await requireContributor(req);
    const bundle = await claimBundle(contributor, supabase, count);
    return NextResponse.json(bundle);
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[mobile/bundle]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}

