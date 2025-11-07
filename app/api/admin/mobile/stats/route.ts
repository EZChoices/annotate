import { NextResponse } from "next/server";
import { fetchMobileAdminStats } from "../../../../../lib/mobile/adminStats";

export const revalidate = 0;

export async function GET() {
  try {
    const stats = await fetchMobileAdminStats();
    return NextResponse.json(stats);
  } catch (error: any) {
    console.error("[admin/mobile/stats]", error);
    return NextResponse.json(
      { error: "Failed to load mobile stats" },
      { status: 500 }
    );
  }
}

