import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { mockPeek } from "../../../../lib/mobile/mockRepo";
import { MobileApiError } from "../../../../lib/mobile/errors";
import { getRemoteConfigValue } from "../../../../lib/remoteConfig";
import { jsonWithLog } from "../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    assertMobileFeatureEnabled();
    const { contributor } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    userId = contributor.id;
    const capability = req.nextUrl.searchParams.get("cap") || undefined;
    const payload = mockPeek(capability || undefined);
    const estSeconds = getRemoteConfigValue<number>(
      "est_wait_seconds",
      payload.est_wait_seconds
    );
    return jsonWithLog(
      "GET /api/mobile/peek",
      userId,
      startedAt,
      payload,
      {
        headers: {
          "x-mobile-mock-data": "true",
          "x-user": contributor.id,
          "x-est-wait": estSeconds.toString(),
        },
      }
    );
  } catch (error) {
    if (error instanceof MobileApiError) {
      return jsonWithLog(
        "GET /api/mobile/peek",
        userId,
        startedAt,
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("[mobile/peek]", error);
    return jsonWithLog(
      "GET /api/mobile/peek",
      userId,
      startedAt,
      { error: "SERVER_ERROR", message: "unexpected" },
      { status: 500 }
    );
  }
}
