import { NextRequest } from "next/server";
import {
  mockClaimBundle,
  mockModeActive,
} from "../../../../../lib/mobile/mockRepo";
import { jsonWithLog } from "../../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const countParam = Number(req.nextUrl.searchParams.get("count"));
  const requestedCount = Number.isFinite(countParam) && countParam > 0
    ? Math.min(Math.trunc(countParam), 10)
    : 3;
  const contributorId = req.headers.get("x-demo-user") || "demo";
  const startedAt = Date.now();
  try {
    const bundle = mockClaimBundle(contributorId, requestedCount);
    return jsonWithLog(
      "GET /api/mobile/mock/bundle",
      mockModeActive() ? contributorId : "mock-demo",
      startedAt,
      bundle,
      { headers: { "x-mobile-mock-data": "true" } }
    );
  } catch (error: any) {
    if (error?.message === "BUNDLE_ACTIVE") {
      return jsonWithLog(
        "GET /api/mobile/mock/bundle",
        contributorId,
        startedAt,
        { error: "BUNDLE_ACTIVE" },
        { status: 409 }
      );
    }
    return jsonWithLog(
      "GET /api/mobile/mock/bundle",
      contributorId,
      startedAt,
      { error: "SERVER_ERROR", message: "Mock bundle failed" },
      { status: 500 }
    );
  }
}
