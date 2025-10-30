import { z } from "zod";
import { getAdminStats } from "../../../lib/adminQueries";

const querySchema = z
  .object({
    from: z.string().optional(),
    to: z.string().optional(),
    stage: z.union([z.string(), z.array(z.string())]).optional(),
    priority: z.string().optional(),
    dialect: z.string().optional(),
    country: z.string().optional(),
    annotatorId: z.string().optional(),
  })
  .strict(false);

function normalizeStage(stageValue) {
  if (!stageValue) return undefined;
  const list = (Array.isArray(stageValue) ? stageValue : String(stageValue).split(","))
    .map((val) => val.trim())
    .filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return Array.from(new Set(list));
}

function parseDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function normalizeFilters(parsed) {
  const stage = normalizeStage(parsed.stage);
  const from = parseDate(parsed.from);
  const to = parseDate(parsed.to);

  const result = {
    stage,
    priority: parsed.priority ? String(parsed.priority).trim() : undefined,
    dialect: parsed.dialect ? String(parsed.dialect).trim() : undefined,
    country: parsed.country ? String(parsed.country).trim() : undefined,
    annotatorId: parsed.annotatorId
      ? String(parsed.annotatorId).trim()
      : undefined,
  };

  if (from) result.from = from;
  if (to) result.to = to;

  return result;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.flatten(),
    });
  }

  try {
    const filters = normalizeFilters(parsed.data);
    const stats = await getAdminStats(filters);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    return res.status(200).json(stats);
  } catch (error) {
    console.error("[admin/stats] error", error);
    return res.status(500).json({ error: "Failed to load admin stats" });
  }
}

