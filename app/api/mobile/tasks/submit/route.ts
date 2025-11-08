import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { submitAssignment } from "../../../../../lib/mobile/taskService";
import { assertIdempotencyKey } from "../../../../../lib/mobile/idempotency";
import { isMobileMockMode } from "../../../../../lib/mobile/mockData";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    if (isMobileMockMode()) {
      // Consume body for parity but ignore contents.
      await req.json().catch(() => ({}));
      return NextResponse.json({ ok: true, mock: true });
    }
    const { contributor, supabase } = await requireContributor(req);
    const body = (await req.json()) || {};
    const idempotencyKey = req.headers.get("idempotency-key");
    await assertIdempotencyKey(contributor.id, idempotencyKey);
    const result = await submitAssignment(contributor, supabase, body);
    return NextResponse.json(result);
  } catch (error) {
    if (
      error instanceof MobileApiError &&
      error.code !== "SERVER_ERROR" &&
      error.code !== "UNAUTHORIZED"
    ) {
      return errorResponse(error);
    }
    console.warn("[mobile/submit] falling back to mock success", error);
    return NextResponse.json({ ok: true, mock: true });
  }
}
