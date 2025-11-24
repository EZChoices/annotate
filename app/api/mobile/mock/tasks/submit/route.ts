import { NextRequest } from "next/server";
import { MobileApiError, errorResponse } from "../../../../../../lib/mobile/errors";
import { mockSubmit } from "../../../../../../lib/mobile/mockRepo";
import { jsonWithLog } from "../../../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = (await req.json()) || {};
    if (!body.assignment_id) {
      throw new MobileApiError(
        "VALIDATION_FAILED",
        400,
        "assignment_id is required"
      );
    }
    const result = mockSubmit(body.assignment_id, body.payload);
    return jsonWithLog(
      "POST /api/mobile/mock/tasks/submit",
      "mock-demo",
      startedAt,
      result,
      { headers: { "x-mobile-mock-data": "true" } }
    );
  } catch (error) {
    if (error instanceof MobileApiError) {
      return errorResponse(error);
    }
    if (error instanceof Error && error.message === "LEASE_CONFLICT") {
      return jsonWithLog(
        "POST /api/mobile/mock/tasks/submit",
        "mock-demo",
        startedAt,
        { error: "LEASE_CONFLICT" },
        { status: 409 }
      );
    }
    return jsonWithLog(
      "POST /api/mobile/mock/tasks/submit",
      "mock-demo",
      startedAt,
      { error: "SERVER_ERROR", message: "Mock submit failed" },
      { status: 500 }
    );
  }
}
