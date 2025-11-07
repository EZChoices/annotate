import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { claimSingleTask } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    const claimed = await claimSingleTask(contributor, supabase);
    if (!claimed) {
      throw new MobileApiError("NO_TASKS", 404, "No tasks available");
    }
    return NextResponse.json(claimed);
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[mobile/next]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}

