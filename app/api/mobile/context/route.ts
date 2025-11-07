import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { getClipContext } from "../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../lib/mobile/errors";

export async function GET(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const clipId = req.nextUrl.searchParams.get("clip_id");
    if (!clipId) {
      throw new MobileApiError(
        "VALIDATION_FAILED",
        400,
        "clip_id query parameter required"
      );
    }
    const { contributor, supabase } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    const context = await getClipContext(supabase, clipId);
    return NextResponse.json({ ...context });
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[mobile/context]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}

