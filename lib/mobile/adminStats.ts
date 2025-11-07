import { getServiceSupabase } from "../supabaseServer";
import type { Database } from "../../types/supabase";

export interface MobileAdminStats {
  generatedAt: string;
  kpis: {
    contributorsTotal: number;
    contributorsActive24h: number;
    tasksPending: number;
    tasksInProgress: number;
    tasksNeedsReview: number;
    tasksAutoApproved: number;
    assignmentsActive: number;
    bundlesActive: number;
    avgEwma: number;
    goldenAccuracy: number | null;
  };
  charts: {
    dailyCompletions: Array<{
      date: string;
      autoApproved: number;
      needsReview: number;
    }>;
  };
  tables: {
    topContributors: Array<{
      contributor_id: string;
      handle: string | null;
      tier: string | null;
      tasks_total: number;
      tasks_agreed: number;
      ewma_agreement: number;
      golden_accuracy: number | null;
    }>;
    recentEvents: Array<{
      id: number;
      contributor_id: string | null;
      name: string;
      ts: string;
      props: Record<string, any>;
    }>;
  };
}

type ContributorStatsRow =
  Database["public"]["Tables"]["contributor_stats"]["Row"];

const STATUS_PENDING = "pending";
const STATUS_IN_PROGRESS = "in_progress";
const STATUS_NEEDS_REVIEW = "needs_review";
const STATUS_AUTO_APPROVED = "auto_approved";

export async function fetchMobileAdminStats(): Promise<MobileAdminStats> {
  const now = new Date();
  let supabase;
  try {
    supabase = getServiceSupabase();
  } catch (error) {
    console.warn("[mobile] admin stats skipped:", error);
    return emptyStats(now);
  }
  const last24hIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const last30dIso = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const [
    tasksPending,
    tasksInProgress,
    tasksNeedsReview,
    tasksAutoApproved,
    assignmentsActive,
    contributorsTotal,
    contributorsActive24h,
    bundlesActive,
    avgEwma,
    goldenAccuracy,
    dailyCompletions,
    topContributors,
    recentEvents,
  ] = await Promise.all([
    countTasksByStatus(supabase, STATUS_PENDING),
    countTasksByStatus(supabase, STATUS_IN_PROGRESS),
    countTasksByStatus(supabase, STATUS_NEEDS_REVIEW),
    countTasksByStatus(supabase, STATUS_AUTO_APPROVED),
    countActiveAssignments(supabase, now.toISOString()),
    countContributors(supabase),
    countActiveContributors(supabase, last24hIso),
    countActiveBundles(supabase, now),
    averageEwma(supabase),
    computeGoldenAccuracy(supabase),
    loadDailyCompletions(supabase, last30dIso),
    loadTopContributors(supabase),
    loadRecentEvents(supabase),
  ]);

  return {
    generatedAt: now.toISOString(),
    kpis: {
      contributorsTotal,
      contributorsActive24h,
      tasksPending,
      tasksInProgress,
      tasksNeedsReview,
      tasksAutoApproved,
      assignmentsActive,
      bundlesActive,
      avgEwma,
      goldenAccuracy,
    },
    charts: { dailyCompletions },
    tables: { topContributors, recentEvents },
  };
}

function emptyStats(now: Date): MobileAdminStats {
  return {
    generatedAt: now.toISOString(),
    kpis: {
      contributorsTotal: 0,
      contributorsActive24h: 0,
      tasksPending: 0,
      tasksInProgress: 0,
      tasksNeedsReview: 0,
      tasksAutoApproved: 0,
      assignmentsActive: 0,
      bundlesActive: 0,
      avgEwma: 0,
      goldenAccuracy: null,
    },
    charts: { dailyCompletions: [] },
    tables: { topContributors: [], recentEvents: [] },
  };
}

async function countTasksByStatus(supabase: ReturnType<typeof getServiceSupabase>, status: string) {
  const { count, error } = await supabase
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("status", status);
  if (error) throw error;
  return count ?? 0;
}

async function countActiveAssignments(
  supabase: ReturnType<typeof getServiceSupabase>,
  nowIso: string
) {
  const { count, error } = await supabase
    .from("task_assignments")
    .select("*", { count: "exact", head: true })
    .eq("state", "leased")
    .gt("lease_expires_at", nowIso);
  if (error) throw error;
  return count ?? 0;
}

async function countContributors(supabase: ReturnType<typeof getServiceSupabase>) {
  const { count, error } = await supabase
    .from("contributors")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function countActiveContributors(
  supabase: ReturnType<typeof getServiceSupabase>,
  sinceIso: string
) {
  const { count, error } = await supabase
    .from("contributor_stats")
    .select("*", { count: "exact", head: true })
    .gt("last_active", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

async function countActiveBundles(
  supabase: ReturnType<typeof getServiceSupabase>,
  now: Date
) {
  const { data, error } = await supabase
    .from("task_bundles")
    .select("created_at, ttl_minutes")
    .eq("state", "active");
  if (error) throw error;
  if (!data) return 0;
  return data.filter((bundle) => {
    const expires = new Date(bundle.created_at);
    expires.setMinutes(expires.getMinutes() + (bundle.ttl_minutes ?? 45));
    return expires > now;
  }).length;
}

async function averageEwma(
  supabase: ReturnType<typeof getServiceSupabase>
) {
  const { data, error } = await supabase
    .from("contributor_stats")
    .select("ewma_agreement");
  if (error) throw error;
  if (!data || data.length === 0) return 0;
  const sum = data.reduce(
    (acc, row) => acc + (row.ewma_agreement ?? 0),
    0
  );
  return sum / data.length;
}

async function computeGoldenAccuracy(
  supabase: ReturnType<typeof getServiceSupabase>
) {
  const { data, error } = await supabase
    .from("contributor_stats")
    .select("golden_correct, golden_total");
  if (error) throw error;
  let sumCorrect = 0;
  let sumTotal = 0;
  for (const row of data || []) {
    sumCorrect += row.golden_correct ?? 0;
    sumTotal += row.golden_total ?? 0;
  }
  if (!sumTotal) return null;
  return sumCorrect / sumTotal;
}

async function loadDailyCompletions(
  supabase: ReturnType<typeof getServiceSupabase>,
  sinceIso: string
) {
  const { data, error } = await supabase
    .from("task_consensus")
    .select("decided_at, final_status")
    .gte("decided_at", sinceIso)
    .order("decided_at", { ascending: true })
    .limit(5000);
  if (error) throw error;
  const bucket = new Map<
    string,
    { autoApproved: number; needsReview: number }
  >();
  (data || []).forEach((row) => {
    const date = row.decided_at?.slice(0, 10);
    if (!date) return;
    if (!bucket.has(date)) {
      bucket.set(date, { autoApproved: 0, needsReview: 0 });
    }
    const target = bucket.get(date)!;
    if (row.final_status === "auto_approved") target.autoApproved += 1;
    if (row.final_status === "needs_review") target.needsReview += 1;
  });
  return Array.from(bucket.entries())
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([date, counts]) => ({ date, ...counts }));
}

async function loadTopContributors(
  supabase: ReturnType<typeof getServiceSupabase>
) {
  const { data, error } = await supabase
    .from("contributor_stats")
    .select(
      "contributor_id, ewma_agreement, tasks_total, tasks_agreed, golden_correct, golden_total"
    )
    .order("tasks_total", { ascending: false })
    .limit(10);
  if (error) throw error;
  const statsRows = (data || []) as ContributorStatsRow[];
  const contributorIds = statsRows.map((row) => row.contributor_id);
  const contributorMap = await loadContributorsMeta(supabase, contributorIds);
  return statsRows.map((stats) => {
    const contributorData = contributorMap.get(stats.contributor_id) ?? null;
    const goldenAccuracy =
      stats.golden_total && stats.golden_total > 0
        ? stats.golden_correct / stats.golden_total
        : null;
    return {
      contributor_id: stats.contributor_id,
      handle: contributorData?.handle ?? null,
      tier: contributorData?.tier ?? null,
      tasks_total: stats.tasks_total ?? 0,
      tasks_agreed: stats.tasks_agreed ?? 0,
      ewma_agreement: stats.ewma_agreement ?? 0,
      golden_accuracy: goldenAccuracy,
    };
  });
}

async function loadContributorsMeta(
  supabase: ReturnType<typeof getServiceSupabase>,
  contributorIds: string[]
) {
  const map = new Map<string, { handle: string | null; tier: string | null }>();
  const uniqueIds = Array.from(new Set(contributorIds)).filter(Boolean);
  if (uniqueIds.length === 0) return map;
  const { data, error } = await supabase
    .from("contributors")
    .select("id, handle, tier")
    .in("id", uniqueIds);
  if (error) throw error;
  for (const row of data || []) {
    map.set(row.id, { handle: row.handle ?? null, tier: row.tier ?? null });
  }
  return map;
}

async function loadRecentEvents(
  supabase: ReturnType<typeof getServiceSupabase>
) {
  const { data, error } = await supabase
    .from("events_mobile")
    .select("id, contributor_id, name, props, ts")
    .order("ts", { ascending: false })
    .limit(25);
  if (error) throw error;
  return (data || []).map((event) => ({
    id: event.id!,
    contributor_id: event.contributor_id,
    name: event.name,
    ts: event.ts,
    props: event.props as Record<string, any>,
  }));
}
