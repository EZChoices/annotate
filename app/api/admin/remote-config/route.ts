import { NextRequest, NextResponse } from "next/server";
import {
  getRemoteConfigSnapshot,
  getRemoteConfigValue,
  setRemoteConfigValue,
} from "../../../../lib/remoteConfig";

export async function GET(req: NextRequest) {
  const keys = req.nextUrl.searchParams.getAll("key");
  if (keys.length === 0) {
    return NextResponse.json({ values: getRemoteConfigSnapshot() });
  }
  const entries = keys.reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = getRemoteConfigValue(key, null);
    return acc;
  }, {});
  return NextResponse.json({ values: entries });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.key !== "string") {
    return NextResponse.json(
      { error: "INVALID_BODY", message: "Key is required" },
      { status: 400 }
    );
  }
  setRemoteConfigValue(body.key, body.value ?? null);
  return NextResponse.json({ ok: true });
}
