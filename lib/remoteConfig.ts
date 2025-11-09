type ConfigEntry = {
  value: unknown;
  expiresAt: number;
};

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, ConfigEntry>();

export function setRemoteConfigValue(key: string, value: unknown) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function getRemoteConfigValue<T>(
  key: string,
  fallback: T
): T {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value as T;
  }
  const envKey = `REMOTE_${key.toUpperCase()}`;
  if (process.env[envKey] != null) {
    const raw = process.env[envKey] as string;
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    cache.set(key, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
    return parsed as T;
  }
  cache.set(key, { value: fallback, expiresAt: Date.now() + CACHE_TTL_MS });
  return fallback;
}

export function getRemoteConfigSnapshot() {
  const snapshot: Record<string, unknown> = {};
  cache.forEach((entry, key) => {
    snapshot[key] = entry.value;
  });
  return snapshot;
}
