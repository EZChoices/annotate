import { getServiceSupabase } from "../supabaseServer";
import { MobileApiError } from "./errors";
import { isMobileMockMode } from "./mockData";

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const memoryStore = new Map<
  string,
  { timestamp: number; response?: unknown }
>();
const MEMORY_LIMIT = 5000;

export async function assertIdempotencyKey(
  contributorId: string,
  key: string | null | undefined
) {
  if (!key) {
    throw new MobileApiError("IDEMPOTENCY_REQUIRED", 400, "Missing Idempotency-Key header");
  }

  if (isMobileMockMode()) {
    pruneMemory();
    const record = memoryStore.get(hashKey(contributorId, key));
    if (record) {
      throw new MobileApiError("IDEMPOTENCY_REPLAY", 409, "Duplicate submission");
    }
    memoryStore.set(hashKey(contributorId, key), {
      timestamp: Date.now(),
    });
    enforceMemoryLimit();
    return;
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

export function getIdempotentResponse(
  contributorId: string,
  key: string
): unknown | null {
  if (!isMobileMockMode()) return null;
  const record = memoryStore.get(hashKey(contributorId, key));
  return record?.response ?? null;
}

export function setIdempotentResponse(
  contributorId: string,
  key: string,
  response: unknown
) {
  if (!isMobileMockMode()) return;
  memoryStore.set(hashKey(contributorId, key), {
    timestamp: Date.now(),
    response,
  });
  enforceMemoryLimit();
}

function pruneMemory() {
  const limit = Date.now() - IDEMPOTENCY_WINDOW_MS;
  for (const [storeKey, record] of memoryStore.entries()) {
    if (record.timestamp < limit) {
      memoryStore.delete(storeKey);
    }
  }
}

function enforceMemoryLimit() {
  if (memoryStore.size <= MEMORY_LIMIT) return;
  const entries = Array.from(memoryStore.entries()).sort(
    (a, b) => a[1].timestamp - b[1].timestamp
  );
  const excess = memoryStore.size - MEMORY_LIMIT;
  for (let i = 0; i < excess; i += 1) {
    memoryStore.delete(entries[i][0]);
  }
}

function hashKey(contributorId: string, key: string) {
  return `${contributorId}:${key}`;
}
