type ConfigEntry = {
  value: unknown;
  expiresAt: number;
};

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, ConfigEntry>();

export interface RemoteConfigAdapter {
  get(key: string): Promise<unknown | undefined>;
  set?(key: string, value: unknown): Promise<void>;
  list?(): Promise<Record<string, unknown>>;
}

class MemoryRemoteConfigAdapter implements RemoteConfigAdapter {
  async get(key: string) {
    return cache.get(key)?.value;
  }
  async set(key: string, value: unknown) {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  async list() {
    const snapshot: Record<string, unknown> = {};
    cache.forEach((entry, key) => {
      snapshot[key] = entry.value;
    });
    return snapshot;
  }
}

export class SupabaseRemoteConfigAdapter implements RemoteConfigAdapter {
  // Placeholder for future Supabase-backed implementation.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly supabase?: unknown) {}
  async get() {
    return undefined;
  }
  async set() {
    // no-op until Supabase credentials are wired.
  }
  async list() {
    return {};
  }
}

const memoryAdapter = new MemoryRemoteConfigAdapter();
let adapter: RemoteConfigAdapter = memoryAdapter;

export function useRemoteConfigAdapter(next: RemoteConfigAdapter | null) {
  adapter = next ?? memoryAdapter;
  cache.clear();
}

function readFromCache<T>(key: string, fallback: T): T {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return (entry.value ?? fallback) as T;
  }
  return fallback;
}

export function setRemoteConfigValue(key: string, value: unknown) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  adapter
    ?.set?.(key, value)
    ?.catch((error) =>
      console.warn("[remote-config] adapter set failed", key, error)
    );
}

export function getRemoteConfigValue<T>(key: string, fallback: T): T {
  const cached = readFromCache<T>(key, fallback);
  if (cache.has(key)) return cached;
  adapter
    ?.get(key)
    ?.then((value) => {
      if (value === undefined) return;
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    })
    .catch((error) =>
      console.warn("[remote-config] adapter get failed", key, error)
    );
  return cached;
}

export function getRemoteConfigSnapshot() {
  const snapshot: Record<string, unknown> = {};
  cache.forEach((entry, key) => {
    snapshot[key] = entry.value;
  });
  return snapshot;
}

export async function refreshRemoteConfigFromAdapter(keys?: string[]) {
  if (!adapter || adapter === memoryAdapter) return;
  if (adapter.list && (!keys || keys.length === 0)) {
    try {
      const entries = await adapter.list();
      Object.entries(entries).forEach(([key, value]) => {
        cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      });
      return;
    } catch (error) {
      console.warn("[remote-config] list failed", error);
    }
  }
  if (!keys) return;
  await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await adapter.get(key);
        if (value !== undefined) {
          cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
        }
      } catch (error) {
        console.warn("[remote-config] get failed", key, error);
      }
    })
  );
}
