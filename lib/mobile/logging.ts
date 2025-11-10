import { NextResponse } from "next/server";

export function logMobileApi(
  route: string,
  userId: string | null,
  status: number,
  startedAt: number
) {
  const duration = Date.now() - startedAt;
  console.info(
    `[mobile] ${route} user=${userId ?? "unknown"} status=${status} duration=${duration}ms`
  );
}

export function jsonWithLog(
  route: string,
  userId: string | null,
  startedAt: number,
  body: unknown,
  init?: ResponseInit
) {
  const response = NextResponse.json(body, init);
  logMobileApi(route, userId, response.status, startedAt);
  return response;
}
