import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../lib/mobile/feature";
import { requireContributor } from "../../../../lib/mobile/auth";
import { mockPeek } from "../../../../lib/mobile/mockRepo";
import { MobileApiError } from "../../../../lib/mobile/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor } = await requireContributor(req, {
      requireMobileFlag: false,
    });
    const capability = req.nextUrl.searchParams.get("cap") || undefined;
    const payload = mockPeek(capability || undefined);
    return NextResponse.json(payload, {
      headers: { "x-mobile-mock-data": "true", "x-user": contributor.id },
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
