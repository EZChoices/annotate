import { NextResponse } from "next/server";
import { readMobileHealth } from "../../../../lib/mobile/health";
import { logMobileApi } from "../../../../lib/mobile/logging";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  const health = readMobileHealth();
  const status = health.supabaseConfigured ? 200 : 503;
  const response = NextResponse.json(health, { status });
  logMobileApi("GET /api/mobile/health", null, status, startedAt);
  return response;
}
