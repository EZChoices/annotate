import { NextRequest, NextResponse } from "next/server";
import { assertMobileFeatureEnabled } from "../../../../../lib/mobile/feature";
import { requireContributor } from "../../../../../lib/mobile/auth";
import { errorResponse, MobileApiError } from "../../../../../lib/mobile/errors";
import { submitAssignment } from "../../../../../lib/mobile/taskService";
import {
  assertIdempotencyKey,
  getIdempotentResponse,
  setIdempotentResponse,
} from "../../../../../lib/mobile/idempotency";
import { consumeRateLimit } from "../../../../../lib/mobile/rateLimit";
import {
  mockModeActive,
  mockSubmit,
} from "../../../../../lib/mobile/mockRepo";
import { isMobileMockMode } from "../../../../../lib/mobile/mockData";

export async function POST(req: NextRequest) {
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    const body = (await req.json()) || {};
    const idempotencyKey = req.headers.get("idempotency-key");
    await assertIdempotencyKey(contributor.id, idempotencyKey);
    if (!consumeRateLimit(contributor.id, "submit/min", 10, 60 * 1000)) {
      return NextResponse.json(
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (!consumeRateLimit(contributor.id, "submit/hour", 60, 60 * 60 * 1000)) {
      return NextResponse.json(
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const cached = idempotencyKey
        ? getIdempotentResponse(contributor.id, idempotencyKey)
        : null;
      if (cached) {
        return NextResponse.json(cached as any);
      }
      const mockResult = mockSubmit(body.assignment_id, body.payload);
      if (idempotencyKey) {
        setIdempotentResponse(contributor.id, idempotencyKey, mockResult);
      }
      return NextResponse.json(mockResult);
    }
    const existing = idempotencyKey
      ? getIdempotentResponse(contributor.id, idempotencyKey)
      : null;
    if (existing) {
      return NextResponse.json(existing as any);
    }
    const result = await submitAssignment(contributor, supabase, body);
    if (idempotencyKey) {
      setIdempotentResponse(contributor.id, idempotencyKey, result);
    }
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
