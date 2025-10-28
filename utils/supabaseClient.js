import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

if (!url || !key) {
  console.error("[supabaseClient] Missing Supabase credentials at runtime", {
    SUPABASE_URL: Boolean(url),
    SUPABASE_KEY: Boolean(key),
  });
}

const fallbackUrl = url || "https://missing-url";
const fallbackKey = key || "missing-key";

export const supabase = createClient(fallbackUrl, fallbackKey, {
  auth: { persistSession: false },
});
