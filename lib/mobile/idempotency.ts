import { getServiceSupabase } from "../supabaseServer";
import { MobileApiError } from "./errors";

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function assertIdempotencyKey(
  contributorId: string,
  key: string | null | undefined
) {
  if (!key) {
    throw new MobileApiError("IDEMPOTENCY_REQUIRED", 400, "Missing Idempotency-Key header");
  }

  const supabase = getServiceSupabase();

  await supabase
    .from("idempotency_keys")
    .delete()
    .lt("created_at", new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString());

  const { data: existing } = await supabase
    .from("idempotency_keys")
    .select("key")
    .eq("contributor_id", contributorId)
    .eq("key", key)
    .maybeSingle();

  if (existing) {
    throw new MobileApiError("IDEMPOTENCY_REPLAY", 409, "Duplicate submission");
  }

  await supabase.from("idempotency_keys").insert({
    contributor_id: contributorId,
    key,
  });
}

