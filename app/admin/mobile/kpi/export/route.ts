import { NextResponse } from "next/server";
import { getMockKpiCsv } from "../../../../../lib/mobile/mockAnalytics";

export const dynamic = "force-dynamic";

export async function GET() {
  const csv = getMockKpiCsv();
  const bom = "\uFEFF";
  return new NextResponse(bom + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="dialect-data-mobile-kpi.csv"`,
    },
  });
}
