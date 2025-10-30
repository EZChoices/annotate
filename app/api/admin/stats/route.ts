import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { CANONICAL_STATUS, CanonicalStatus } from "../../../../lib/statusMap";
import { getAdminStats } from "../../../../lib/adminQueries";

const querySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    stage: z.string().optional(),
    priority: z.string().optional(),
    dialect: z.string().optional(),
    country: z.string().optional(),
    annotatorId: z.string().optional(),
  })
  .strict();

const canonicalStages = new Set<CanonicalStatus>(
  Object.values(CANONICAL_STATUS)
);

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function parseStage(value: string | undefined): CanonicalStatus | CanonicalStatus[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as CanonicalStatus[];
  const filtered = entries.filter((entry) =>
    canonicalStages.has(entry as CanonicalStatus)
  );
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  return Array.from(new Set(filtered));
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const raw = Object.fromEntries(params.entries());
  const parsed = querySchema.safeParse(raw);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const filters = {
      from: parseDate(parsed.data.from),
      to: parseDate(parsed.data.to),
      stage: parseStage(parsed.data.stage),
      priority: parsed.data.priority,
      dialect: parsed.data.dialect,
      country: parsed.data.country,
      annotatorId: parsed.data.annotatorId,
    };

    const stats = await getAdminStats(filters);
    return NextResponse.json(stats, {
      headers: {
        "Cache-Control": "s-maxage=60, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    console.error("[admin/stats] error", error);
    return NextResponse.json(
      {
        error: "Failed to load admin stats",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}

