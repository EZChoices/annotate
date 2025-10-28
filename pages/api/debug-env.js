import { createClient } from "@supabase/supabase-js";

function maskKey(value) {
  if (!value) return null;
  const tail = value.slice(-6);
  return `***${tail}`;
}

function booleanFlags(value) {
  return value ? "present" : "missing";
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  const vars = {
    SUPABASE_URL: process.env.SUPABASE_URL || null,
    SUPABASE_KEY: maskKey(process.env.SUPABASE_KEY),
    BUNNY_KEEP_URL: process.env.BUNNY_KEEP_URL || null,
    BUNNY_PULL_BASE: process.env.BUNNY_PULL_BASE || null,
    NODE_ENV: process.env.NODE_ENV || null,
    VERCEL_ENV: process.env.VERCEL_ENV || "unknown",
  };

  const report = {
    ok: true,
    timestamp,
    vars,
    supabasePing: null,
  };

  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
      throw new Error(
        `Missing Supabase credentials: url=${booleanFlags(url)} key=${booleanFlags(
          key
        )}`
      );
    }

    const supabase = createClient(url, key, { auth: { persistSession: false } });

    const { data, error } = await supabase.from("manifest").select("id").limit(1);
    if (error) {
      report.supabasePing = { ok: false, message: error.message };
      report.ok = false;
    } else {
      report.supabasePing = {
        ok: true,
        rows: Array.isArray(data) ? data.length : 0,
      };
    }
  } catch (error) {
    report.ok = false;
    report.error = error.message;
  }

  res.setHeader("x-debug-ts", timestamp);
  res.status(200).json(report);
}
