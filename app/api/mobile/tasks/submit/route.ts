import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { submitAssignment } from "../../../../../lib/mobile/taskService";
import { assertIdempotencyKey } from "../../../../../lib/mobile/idempotency";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    const body = (await req.json()) || {};
    const idempotencyKey = req.headers.get("idempotency-key");
    await assertIdempotencyKey(contributor.id, idempotencyKey);
    const result = await submitAssignment(contributor, supabase, body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    console.error("[mobile/submit]", error);
    return errorResponse(
      new MobileApiError("SERVER_ERROR", 500, "Unexpected server error")
    );
  }
}

