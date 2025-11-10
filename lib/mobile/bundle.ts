export type BundleState = "active" | "expired" | "closed";

export interface BundleRecord {
  id: string;
  contributorId: string;
  state: BundleState;
  createdAt: number;
  ttlMs: number;
  assignmentIds: string[];
}

export const DEFAULT_BUNDLE_TTL_MS = 45 * 60 * 1000;

export function createBundleRecord(
  bundleId: string,
  contributorId: string,
  ttlMs = DEFAULT_BUNDLE_TTL_MS
): BundleRecord {
  return {
    id: bundleId,
    contributorId,
    state: "active",
    createdAt: Date.now(),
    ttlMs,
    assignmentIds: [],
  };
}

export function isBundleExpired(bundle: BundleRecord, now = Date.now()) {
  return bundle.createdAt + bundle.ttlMs < now;
}

export function ensureSingleActiveBundle(
  bundles: Iterable<BundleRecord>,
  contributorId: string,
  now = Date.now()
) {
  for (const bundle of bundles) {
    if (
      bundle.contributorId === contributorId &&
      bundle.state === "active" &&
      !isBundleExpired(bundle, now)
    ) {
      return bundle;
    }
  }
  return null;
}

export function expireBundlesInPlace(
  bundles: Map<string, BundleRecord>,
  onExpire?: (bundle: BundleRecord) => void,
  now = Date.now()
) {
  bundles.forEach((bundle) => {
    if (bundle.state !== "active") return;
    if (isBundleExpired(bundle, now)) {
      bundle.state = "expired";
      onExpire?.(bundle);
    }
  });
}
