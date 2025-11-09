import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { mockPeek } from "../../../../lib/mobile/mockRepo";
import { MobileApiError } from "../../../../lib/mobile/errors";
import { getRemoteConfigValue } from "../../../../lib/remoteConfig";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    const capability = req.nextUrl.searchParams.get("cap") || undefined;
    const payload = mockPeek(capability || undefined);
    const estSeconds = getRemoteConfigValue<number>(
      "est_wait_seconds",
      payload.est_wait_seconds
    );
    return NextResponse.json(payload, {
      headers: {
        "x-mobile-mock-data": "true",
        "x-user": contributor.id,
        "x-est-wait": estSeconds.toString(),
      },
    });
  } catch (error) {
    if (error instanceof MobileApiError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("[mobile/peek]", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "unexpected" },
      { status: 500 }
    );
  }
}
