import { NextRequest } from "next/server";
import { MobileApiError, errorResponse } from "../../../../../lib/mobile/errors";
import { getMockContext } from "../../../../../lib/mobile/mockData";
import { jsonWithLog } from "../../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const clipId = req.nextUrl.searchParams.get("clip_id");
  const startedAt = Date.now();
  if (!clipId) {
    const error = new MobileApiError(
      "VALIDATION_FAILED",
      400,
      "clip_id query parameter required"
    );
    return errorResponse(error);
  }
  return jsonWithLog(
    "GET /api/mobile/mock/context",
    "mock-demo",
    startedAt,
    getMockContext(clipId),
    { headers: { "x-mobile-mock-data": "true" } }
  );
}
