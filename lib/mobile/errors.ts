import { NextResponse } from "next/server";

export type MobileErrorCode =
  | "FEATURE_DISABLED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "LEASE_CONFLICT"
  | "LEASE_EXPIRED"
  | "CAPABILITY_MISMATCH"
  | "BUNDLE_ACTIVE"
  | "NO_TASKS"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_REPLAY"
  | "PLAYBACK_TOO_SHORT"
  | "VALIDATION_FAILED"
  | "SERVER_ERROR";

export class MobileApiError extends Error {
  constructor(
    public code: MobileErrorCode,
    public status: number,
    message?: string
  ) {
    super(message || code);
  }
}

export function errorResponse(error: MobileApiError) {
  return NextResponse.json(
    {
      error: error.code,
      message: error.message,
    },
    { status: error.status }
  );
}

export function assert(
  condition: any,
  code: MobileErrorCode,
  status = 400,
  message?: string
) {
  if (!condition) {
    throw new MobileApiError(code, status, message);
  }
}

