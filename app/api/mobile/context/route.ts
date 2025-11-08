import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { getClipContext } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";
import {
  getMockContext,
  isMobileMockMode,
} from "../../../../lib/mobile/mockData";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const clipId = req.nextUrl.searchParams.get("clip_id");
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
      return NextResponse.json(getMockContext(clipId), {
        headers: { "x-mobile-mock-data": "true" },
      });
    }

    const { contributor, supabase } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    const context = await getClipContext(supabase, clipId);
    return NextResponse.json({ ...context });
  } catch (error) {
    if (error instanceof MobileApiError && error.code === "VALIDATION_FAILED") {
      return errorResponse(error);
    }
    console.warn("[mobile/context] falling back to mock data", error);
    return NextResponse.json(getMockContext(clipId || "mock-clip-1"), {
      headers: { "x-mobile-mock-data": "true" },
    });
  }
}
