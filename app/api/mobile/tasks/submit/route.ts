import { NextRequest } from "next/server";
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
import { jsonWithLog, logMobileApi } from "../../../../../lib/mobile/logging";

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let userId: string | null = null;
  try {
    assertMobileFeatureEnabled();
    const { contributor, supabase } = await requireContributor(req);
    userId = contributor.id;
    const body = (await req.json()) || {};
    const idempotencyKey = req.headers.get("idempotency-key");
    await assertIdempotencyKey(contributor.id, idempotencyKey);
    if (!consumeRateLimit(contributor.id, "submit/min", 10, 60 * 1000)) {
      return jsonWithLog(
        "POST /api/mobile/tasks/submit",
        userId,
        startedAt,
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (!consumeRateLimit(contributor.id, "submit/hour", 60, 60 * 60 * 1000)) {
      return jsonWithLog(
        "POST /api/mobile/tasks/submit",
        userId,
        startedAt,
        { error: "RATE_LIMIT" },
        { status: 429 }
      );
    }
    if (mockModeActive()) {
      const cached = idempotencyKey
        ? getIdempotentResponse(contributor.id, idempotencyKey)
        : null;
      if (cached) {
        return jsonWithLog(
          "POST /api/mobile/tasks/submit",
          userId,
          startedAt,
          cached,
          { headers: { "x-mobile-mock-data": "true", "x-idempotent-hit": "true" } }
        );
      }
      const mockResult = mockSubmit(body.assignment_id, body.payload);
      if (idempotencyKey) {
        setIdempotentResponse(contributor.id, idempotencyKey, mockResult);
      }
      return jsonWithLog(
        "POST /api/mobile/tasks/submit",
        userId,
        startedAt,
        mockResult,
        { headers: { "x-mobile-mock-data": "true" } }
      );
    }
    const existing = idempotencyKey
      ? getIdempotentResponse(contributor.id, idempotencyKey)
      : null;
    if (existing) {
      return jsonWithLog(
        "POST /api/mobile/tasks/submit",
        userId,
        startedAt,
        existing,
        { headers: { "x-idempotent-hit": "true" } }
      );
    }
    const result = await submitAssignment(contributor, supabase, body);
    if (idempotencyKey) {
      setIdempotentResponse(contributor.id, idempotencyKey, result);
    }
    return jsonWithLog(
      "POST /api/mobile/tasks/submit",
      userId,
      startedAt,
      result
    );
  } catch (error) {
    if (error instanceof MobileApiError) {
      const response = errorResponse(error);
      logMobileApi(
        "POST /api/mobile/tasks/submit",
        userId,
        response.status,
        startedAt
      );
      return response;
    }
    console.error("[mobile/submit] unexpected error", error);
    return jsonWithLog(
      "POST /api/mobile/tasks/submit",
      userId,
      startedAt,
      { error: "SERVER_ERROR", message: "Submit failed" },
      { status: 500 }
    );
  }
}
