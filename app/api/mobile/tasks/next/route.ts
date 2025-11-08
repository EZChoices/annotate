import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { claimSingleTask } from "../../../../../lib/mobile/taskService";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import {
  generateMockTask,
  isMobileMockMode,
} from "../../../../../lib/mobile/mockData";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    if (isMobileMockMode()) {
      return NextResponse.json(generateMockTask(), {
        headers: { "x-mobile-mock-data": "true" },
      });
    }
    const { contributor, supabase } = await requireContributor(req);
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
    return NextResponse.json(generateMockTask(), {
      headers: { "x-mobile-mock-data": "true" },
    });
  }
}
