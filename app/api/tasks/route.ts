import { NextRequest, NextResponse } from "next/server";
import { supabase } from "../../../utils/supabaseClient";

const KEEP_TABLE =
  process.env.SUPABASE_KEEP_TABLE ||
  process.env.KEEP_TABLE ||
  "keep";
const FILE_COL =
  process.env.SUPABASE_FILE_COL ||
  process.env.FILE_COL ||
  "file_name";
const DECISION_COL =
  process.env.SUPABASE_DECISION_COL ||
  process.env.DECISION_COL ||
  "decision";
const KEEP_VALUE =
  process.env.SUPABASE_KEEP_VALUE ||
  process.env.KEEP_VALUE ||
  "keep";
const PREFILL_TR_VTT =
  process.env.SUPABASE_KEEP_TR_VTT_COL ||
  process.env.PREFILL_TR_VTT ||
  "transcript_vtt_url";
const PREFILL_TL_VTT =
  process.env.SUPABASE_KEEP_TL_VTT_COL ||
  process.env.PREFILL_TL_VTT ||
  "translation_vtt_url";
const PREFILL_CS_VTT =
  process.env.SUPABASE_KEEP_CS_VTT_COL ||
  process.env.PREFILL_CS_VTT ||
  "code_switch_vtt_url";
const PREFILL_DIA =
  process.env.SUPABASE_KEEP_DIA_RTTM_COL ||
  process.env.PREFILL_DIA ||
  "diarization_rttm_url";

const EXPECTED_COLUMNS = [
  FILE_COL,
  DECISION_COL,
  PREFILL_TR_VTT,
  PREFILL_TL_VTT,
  PREFILL_CS_VTT,
  PREFILL_DIA,
];

type Meta = {
  contacted_supabase: boolean;
  table: string | null;
  error_type: "missing_table" | "missing_columns" | "query_error" | null;
  keep_rows: number;
  skipped_missing_transcript: number;
};

function buildMeta(overrides?: Partial<Meta>): Meta {
  return {
    contacted_supabase: false,
    table: KEEP_TABLE || null,
    error_type: null,
    keep_rows: 0,
    skipped_missing_transcript: 0,
    ...overrides,
  };
}

function missingColumnsFromMessage(message: string): string[] {
  const lower = message.toLowerCase();
  const missing: string[] = [];
  for (const column of EXPECTED_COLUMNS) {
    if (lower.includes(`"${column.toLowerCase()}" does not exist`)) {
      missing.push(column);
    } else if (lower.includes(`column ${column.toLowerCase()} does not exist`)) {
      missing.push(column);
    }
  }
  return missing;
}

export async function GET(request: NextRequest) {
  const meta = buildMeta();
  const diag: Record<string, any> = {};

  if (!KEEP_TABLE) {
    meta.error_type = "missing_table";
    diag.error = "SUPABASE_KEEP_TABLE (KEEP_TABLE) env var is not configured.";
    warnOnce(diag.error);
    return NextResponse.json({
      data: [],
      __diag: diag,
      __meta: meta,
    });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = Number.isFinite(Number(limitParam))
    ? Math.max(parseInt(limitParam ?? "100", 10), 1)
    : 100;

  try {
    const headResponse = await supabase
      .from(KEEP_TABLE)
      .select("*", { head: true, count: "exact" });

    meta.contacted_supabase = true;

    if (headResponse.error) {
      const errorMessage = headResponse.error.message || "Unknown Supabase error";
      if (errorMessage.toLowerCase().includes("does not exist")) {
        meta.error_type = "missing_table";
        diag.error = `Supabase table "${KEEP_TABLE}" does not exist`;
        warnOnce(diag.error);
      } else {
        meta.error_type = "query_error";
        diag.error = errorMessage;
        warnOnce(`Supabase head query failed: ${errorMessage}`);
      }
      return NextResponse.json({
        data: [],
        __diag: diag,
        __meta: meta,
      });
    }

    meta.keep_rows = headResponse.count ?? 0;

    const selectColumns = Array.from(new Set(EXPECTED_COLUMNS)).join(",");

    const { data: rows, error: selectError } = await supabase
      .from(KEEP_TABLE)
      .select(selectColumns)
      .eq(DECISION_COL, KEEP_VALUE)
      .limit(limit);

    if (selectError) {
      const errorMessage = selectError.message || "Unknown select error";
      const missingColumns = missingColumnsFromMessage(errorMessage);
      if (missingColumns.length > 0) {
        meta.error_type = "missing_columns";
        diag.error = `Missing columns: ${missingColumns.join(", ")}`;
        diag.missing_columns = missingColumns;
        warnOnce(`Supabase column mismatch on ${KEEP_TABLE}: ${missingColumns.join(", ")}`);
      } else {
        meta.error_type = "query_error";
        diag.error = errorMessage;
        warnOnce(`Supabase select failed for ${KEEP_TABLE}: ${errorMessage}`);
      }
      return NextResponse.json({
        data: [],
        __diag: diag,
        __meta: meta,
      });
    }

    const safeRows = Array.isArray(rows) ? rows : [];
    const results: any[] = [];
    let skipped = 0;

    for (const row of safeRows) {
      const hasTranscript =
        Boolean(row?.[PREFILL_TR_VTT]) || Boolean(row?.[PREFILL_TL_VTT]);
      if (!hasTranscript) {
        skipped += 1;
        continue;
      }

      results.push({
        asset_id: row?.[FILE_COL] ?? null,
        decision: row?.[DECISION_COL] ?? null,
        prefill: {
          transcript_vtt_url: row?.[PREFILL_TR_VTT] ?? null,
          translation_vtt_url: row?.[PREFILL_TL_VTT] ?? null,
          code_switch_vtt_url: row?.[PREFILL_CS_VTT] ?? null,
          diarization_rttm_url: row?.[PREFILL_DIA] ?? null,
        },
        raw: row,
      });
    }

    meta.skipped_missing_transcript = skipped;

    return NextResponse.json({
      data: results,
      __diag: Object.keys(diag).length ? diag : null,
      __meta: meta,
    });
  } catch (error) {
    meta.error_type = "query_error";
    const message =
      error instanceof Error ? error.message : "Unexpected error querying Supabase";
    diag.error = message;
    warnOnce(`Unexpected /api/tasks error: ${message}`);
    return NextResponse.json({
      data: [],
      __diag: diag,
      __meta: meta,
    });
  }
}

let warnedMessages = new Set<string>();

function warnOnce(message: string) {
  if (process.env.NODE_ENV !== "production" && !warnedMessages.has(message)) {
    warnedMessages.add(message);
    console.warn(`[tasks] ${message}`);
  }
}

