type BucketKey = string;

interface BucketEntry {
  count: number;
  expiresAt: number;
}

const store = new Map<BucketKey, BucketEntry>();

function key(userId: string, bucket: string) {
  return `${userId}:${bucket}`;
}

export function resetRateLimitBuckets() {
  store.clear();
}

export function consumeRateLimit(
  userId: string,
  bucket: string,
  limit: number,
  windowMs: number
): boolean {
  const bucketKey = key(userId, bucket);
  const now = Date.now();
  const existing = store.get(bucketKey);
  if (!existing || existing.expiresAt < now) {
    store.set(bucketKey, { count: 1, expiresAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  return true;
}

export function getRemaining(
  userId: string,
  bucket: string,
  limit: number,
  windowMs: number
) {
  const bucketKey = key(userId, bucket);
  const now = Date.now();
  const existing = store.get(bucketKey);
  if (!existing || existing.expiresAt < now) {
    return limit;
  }
  return Math.max(0, limit - existing.count);
}
