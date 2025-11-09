export interface Vote {
  contributor_id: string;
  payload: unknown;
  key: string;
  weight: number;
}

export interface ConsensusResult {
  label: string;
  green_count: number;
  agreement_score: number;
}

export function computeConsensus(
  votes: Vote[],
  preferredKey?: string
): ConsensusResult {
  if (votes.length === 0) {
    return { label: "unknown", green_count: 0, agreement_score: 0 };
  }
  const tally = new Map<string, { weight: number; vote: Vote }>();
  for (const vote of votes) {
    const existing = tally.get(vote.key);
    if (existing) {
      existing.weight += vote.weight;
    } else {
      tally.set(vote.key, { weight: vote.weight, vote });
    }
  }
  const sorted = Array.from(tally.entries()).sort((a, b) => {
    if (a[0] === preferredKey) return -1;
    if (b[0] === preferredKey) return 1;
    return b[1].weight - a[1].weight;
  });
  const winner = sorted[0];
  const totalWeight = votes.reduce((sum, vote) => sum + vote.weight, 0);
  const agreement = winner[1].weight / Math.max(totalWeight, 1);
  return {
    label: winner[0],
    green_count: Math.round(winner[1].weight),
    agreement_score: Number(agreement.toFixed(3)),
  };
}

export function updateReputation(prev: number | null | undefined, aligned: boolean) {
  const current = typeof prev === "number" ? prev : 0.8;
  const next = aligned ? 1 : 0;
  const ewma = 0.6 * current + 0.4 * next;
  return Math.min(1.5, Math.max(0.5, ewma));
}
