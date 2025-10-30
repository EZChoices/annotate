import { differenceInDays, differenceInMinutes, formatISO, isValid, parseISO, startOfDay, subDays } from "date-fns";
import { supabase } from "../utils/supabaseClient";
import {
  CANONICAL_STATUS,
  CanonicalStatus,
  isBacklog,
  isInAnnotation,
  isStuck as clipIsStuck,
  toCanonical,
  toFunnelStage,
} from "./statusMap";

const DEFAULT_WINDOW_DAYS = 30;
const HOUR_SECONDS = 3600;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AdminFilterStage = CanonicalStatus | CanonicalStatus[];

export interface AdminFilters {
  from?: Date;
  to?: Date;
  stage?: AdminFilterStage;
  priority?: string;
  dialect?: string;
  country?: string;
  annotatorId?: string;
}

export interface MetricValue {
  value: number | null;
  delta: number | null;
}

export interface PrefillCoverage {
  transcript: number | null;
  translation: number | null;
  diarization: number | null;
}

export interface AnnotatorLeaderboardRow {
  annotator: string;
  clipsDone: number;
  hoursDone: number;
  qaPassRate: number;
  avgTurnaroundMin: number | null;
}

export interface AdminStats {
  generatedAt: string;
  timeWindow: { from: string; to: string };
  environment: {
    supabaseStatus: "online" | "degraded" | "offline";
    message?: string;
    lastSync: string;
  };
  kpis: {
    totalClips: MetricValue;
    totalDurationHours: MetricValue;
    pctCompleteCount: MetricValue;
    pctCompleteDuration: MetricValue;
    awaitingAnnotation: MetricValue;
    inAnnotation: MetricValue;
    qaPending: MetricValue;
    qaFailRate: MetricValue;
    activeAnnotators24h: MetricValue;
    throughput7d: MetricValue;
    avgTurnaroundMinutes: MetricValue;
    stuckOver24h: MetricValue;
  };
  analytics: {
    funnel: Array<{ stage: string; count: number }>;
    throughput30d: Array<{ date: string; completedCount: number }>;
    annotatorLeaderboard: AnnotatorLeaderboardRow[];
    prefillCoverage: PrefillCoverage;
    dialectDistribution: Array<{ dialect: string; count: number; hours: number }>;
    countryDistribution: Array<{ country: string; count: number; hours: number }>;
  };
  tables: {
    stuck: Array<{
      clipId: string;
      stage: CanonicalStatus;
      priority: number | null;
      assignedTo: string | null;
      lastActionAt: string | null;
      ageDays: number | null;
    }>;
    recentFlags: Array<{
      clipId: string;
      type: string;
      note: string | null;
      createdAt: string | null;
      stage: CanonicalStatus | null;
    }>;
  };
  filters: {
    availableAnnotators: string[];
  };
}

type ClipRow = Record<string, any>;
type AnnotationRow = Record<string, any>;
type QAReviewRow = Record<string, any>;
type FlagRow = Record<string, any>;
type AnnotatorRow = Record<string, any>;

function ensureDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isValid(value) ? value : null;
  const parsed = parseISO(String(value));
  return isValid(parsed) ? parsed : null;
}

function determineWindow(filters?: AdminFilters) {
  const to = ensureDate(filters?.to) || new Date();
  const from =
    ensureDate(filters?.from) ||
    subDays(startOfDay(to), DEFAULT_WINDOW_DAYS - 1);
  return { from, to };
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 10) / 10;
}

function matchesValue(value: unknown, filterValue?: string): boolean {
  if (!filterValue) return true;
  if (value == null) return false;
  return String(value).toLowerCase() === filterValue.toLowerCase();
}

function clipMatchesFilters(
  clip: ClipRow,
  filters: AdminFilters,
  options: { ignoreDates?: boolean } = {}
): boolean {
  if (!clip) return false;

  if (filters.priority && !matchesValue(clip.priority, filters.priority)) {
    return false;
  }

  const dialectCandidate =
    clip.dialect ??
    clip.dialect_family ??
    clip.dialectFamily ??
    clip.dialect_family_code;
  if (filters.dialect && !matchesValue(dialectCandidate, filters.dialect)) {
    return false;
  }

  const countryCandidate = clip.country ?? clip.region ?? clip.locale;
  if (filters.country && !matchesValue(countryCandidate, filters.country)) {
    return false;
  }

  const assigned = clip.assigned_to ?? clip.assignedTo ?? clip.owner_id;
  if (filters.annotatorId && !matchesValue(assigned, filters.annotatorId)) {
    return false;
  }

  const canonical = toCanonical(clip);
  if (filters.stage) {
    if (Array.isArray(filters.stage)) {
      if (!filters.stage.includes(canonical)) return false;
    } else if (canonical !== filters.stage) {
      return false;
    }
  }

  if (!options.ignoreDates) {
    const timestamp = clipTimestamp(clip);
    if (filters.from && timestamp && timestamp < filters.from) return false;
    if (filters.to && timestamp && timestamp > filters.to) return false;
  }

  return true;
}

function clipTimestamp(clip: ClipRow): Date | null {
  const raw =
    clip.completed_at ??
    clip.completedAt ??
    clip.last_action_at ??
    clip.lastActionAt ??
    clip.updated_at ??
    clip.updatedAt ??
    clip.created_at ??
    clip.createdAt;
  return ensureDate(raw);
}

function sumDurationSeconds(clips: ClipRow[]): number {
  return clips.reduce((acc, clip) => {
    const duration =
      Number(clip.duration_sec ?? clip.durationSec ?? clip.clip_duration_sec) ||
      0;
    return acc + duration;
  }, 0);
}

function buildFunnelCounts(clips: Array<ClipRow & { canonicalStatus: CanonicalStatus }>) {
  const counts = new Map<string, number>();
  clips.forEach((clip) => {
    const funnel = toFunnelStage(clip.canonicalStatus);
    counts.set(funnel, (counts.get(funnel) ?? 0) + 1);
  });
  return Array.from(counts.entries()).map(([stage, count]) => ({ stage, count }));
}

function buildThroughputSeries(
  clips: Array<ClipRow & { canonicalStatus: CanonicalStatus; timestamp: Date | null }>,
  windowFrom: Date,
  windowTo: Date
) {
  const totals = new Map<string, number>();
  const cursor = new Date(startOfDay(windowFrom));
  while (cursor <= windowTo) {
    const key = formatISO(cursor, { representation: "date" });
    totals.set(key, 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  clips.forEach((clip) => {
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return;
    if (!clip.timestamp) return;
    if (clip.timestamp < windowFrom || clip.timestamp > windowTo) return;
    const key = formatISO(startOfDay(clip.timestamp), { representation: "date" });
    if (!totals.has(key)) return;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  });

  return Array.from(totals.entries()).map(([date, completedCount]) => ({
    date,
    completedCount,
  }));
}

function buildBreakdown(
  clips: Array<ClipRow & { canonicalStatus: CanonicalStatus }>,
  key: "dialect" | "country"
) {
  const valueKeyMap: Record<typeof key, string[]> = {
    dialect: ["dialect", "dialect_family", "dialectFamily", "dialect_family_code"],
    country: ["country", "region", "locale"],
  };
  const buckets = new Map<
    string,
    { value: string; count: number; seconds: number }
  >();
  clips.forEach((clip) => {
    const candidateKeys = valueKeyMap[key];
    const value =
      candidateKeys
        .map((field) => clip[field])
        .find((val) => val != null && `${val}`.trim().length > 0) ?? null;
    if (!value) return;
    const duration =
      Number(clip.duration_sec ?? clip.durationSec ?? clip.clip_duration_sec) ||
      0;
    const bucket = buckets.get(String(value)) ?? {
      value: String(value),
      count: 0,
      seconds: 0,
    };
    bucket.count += 1;
    bucket.seconds += duration;
    buckets.set(bucket.value, bucket);
  });
  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      [key]: entry.value,
      count: entry.count,
      hours: Math.round((entry.seconds / HOUR_SECONDS) * 100) / 100,
    }));
}

function hasPrefillTranscript(clip: ClipRow): boolean {
  const candidates = [
    clip.prefill_transcript_vtt_url,
    clip.prefill_transcript_url,
    clip.transcript_vtt_url,
    clip.transcript_url,
    clip.prefill?.transcript_vtt_url,
  ];
  return candidates.some((value) => Boolean(value));
}

function hasPrefillTranslation(clip: ClipRow): boolean {
  const candidates = [
    clip.prefill_translation_vtt_url,
    clip.translation_vtt_url,
    clip.translation_url,
    clip.prefill?.translation_vtt_url,
  ];
  return candidates.some((value) => Boolean(value));
}

function hasPrefillDiarization(clip: ClipRow): boolean {
  const candidates = [
    clip.prefill_diarization_rttm_url,
    clip.diarization_rttm_url,
    clip.diarization_url,
    clip.prefill?.diarization_rttm_url,
  ];
  return candidates.some((value) => Boolean(value));
}

function calcTurnaroundMinutes(annotation: AnnotationRow): number | null {
  const start = ensureDate(annotation.started_at ?? annotation.startedAt);
  const submitted = ensureDate(annotation.submitted_at ?? annotation.submittedAt);
  if (!start || !submitted) return null;
  const minutes = differenceInMinutes(submitted, start);
  return minutes >= 0 ? minutes : null;
}

function buildLeaderboard(
  annotations: AnnotationRow[],
  qaReviews: QAReviewRow[],
  clipsById: Map<string, ClipRow & { canonicalStatus: CanonicalStatus; timestamp: Date | null }>,
  windowFrom: Date,
  windowTo: Date
): AnnotatorLeaderboardRow[] {
  const qaByClip = qaReviews.reduce((map, review) => {
    const clipId = review.clip_id ?? review.clipId;
    if (!clipId) return map;
    const bucket = map.get(clipId) ?? { pass: 0, fail: 0 };
    const status = String(review.status ?? "").toLowerCase();
    if (status === "pass") bucket.pass += 1;
    else if (status === "fail") bucket.fail += 1;
    map.set(clipId, bucket);
    return map;
  }, new Map<string, { pass: number; fail: number }>());

  const perAnnotator = new Map<
    string,
    {
      annotator: string;
      clipsDone: number;
      secondsDone: number;
      qaPass: number;
      qaTotal: number;
      turnaround: number[];
    }
  >();

  annotations.forEach((annotation) => {
    const clipId = annotation.clip_id ?? annotation.clipId;
    if (!clipId) return;
    const clip = clipsById.get(String(clipId));
    if (!clip) return;
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return;

    const submitted = ensureDate(annotation.submitted_at ?? annotation.submittedAt);
    if (!submitted || submitted < windowFrom || submitted > windowTo) return;

    const annotatorId = annotation.annotator_id ?? annotation.annotatorId;
    if (!annotatorId) return;

    const entry =
      perAnnotator.get(annotatorId) ??
      {
        annotator: annotatorId,
        clipsDone: 0,
        secondsDone: 0,
        qaPass: 0,
        qaTotal: 0,
        turnaround: [] as number[],
      };
    entry.clipsDone += 1;

    const duration =
      Number(clip.duration_sec ?? clip.durationSec ?? clip.clip_duration_sec) ||
      Number(annotation.duration_worked_sec ?? annotation.durationWorkedSec) ||
      0;
    entry.secondsDone += duration;

    const qaBucket = qaByClip.get(String(clipId));
    if (qaBucket) {
      entry.qaPass += qaBucket.pass;
      entry.qaTotal += qaBucket.pass + qaBucket.fail;
    }

    const turnaround = calcTurnaroundMinutes(annotation);
    if (turnaround != null) entry.turnaround.push(turnaround);

    perAnnotator.set(annotatorId, entry);
  });

  return Array.from(perAnnotator.values())
    .map((entry) => ({
      annotator: entry.annotator,
      clipsDone: entry.clipsDone,
      hoursDone: Math.round((entry.secondsDone / HOUR_SECONDS) * 100) / 100,
      qaPassRate:
        entry.qaTotal > 0
          ? entry.qaPass / entry.qaTotal
          : entry.qaPass > 0
          ? 1
          : 0,
      avgTurnaroundMin:
        entry.turnaround.length > 0
          ? Math.round(
              entry.turnaround.reduce((sum, value) => sum + value, 0) /
                entry.turnaround.length
            )
          : null,
    }))
    .sort((a, b) => b.clipsDone - a.clipsDone)
    .slice(0, 50);
}

function collectStuck(
  clips: Array<ClipRow & { canonicalStatus: CanonicalStatus; timestamp: Date | null }>,
  filters: AdminFilters,
  now: Date
) {
  return clips
    .filter((clip) => clipMatchesFilters(clip, filters, { ignoreDates: true }))
    .filter((clip) => clipIsStuck(clip, now))
    .map((clip) => {
      const lastAction =
        (clip.last_action_at as string | undefined) ??
        (clip.lastActionAt as string | undefined) ??
        (clip.updated_at as string | undefined) ??
        (clip.updatedAt as string | undefined) ??
        (clip.created_at as string | undefined) ??
        (clip.createdAt as string | undefined) ??
        null;
      const ageDays =
        lastAction != null
          ? differenceInDays(now, ensureDate(lastAction) ?? now)
          : null;
      return {
        clipId: String(clip.id ?? clip.clip_id ?? clip.clipId ?? ""),
        stage: clip.canonicalStatus,
        priority:
          clip.priority != null && !Number.isNaN(Number(clip.priority))
            ? Number(clip.priority)
            : null,
        assignedTo:
          (clip.assigned_to as string | undefined) ??
          (clip.assignedTo as string | undefined) ??
          null,
        lastActionAt: lastAction,
        ageDays,
      };
    })
    .filter((row) => row.clipId);
}

function collectFlags(
  flags: FlagRow[],
  clipMap: Map<string, ClipRow & { canonicalStatus: CanonicalStatus }>
) {
  return flags
    .map((flag) => {
      const clipId = flag.clip_id ?? flag.clipId;
      if (!clipId) return null;
      const clip = clipMap.get(String(clipId));
      return {
        clipId: String(clipId),
        type: flag.type ?? flag.flag_type ?? "unknown",
        note: flag.note ?? flag.notes ?? null,
        createdAt: flag.created_at ?? flag.createdAt ?? null,
        stage: clip ? clip.canonicalStatus : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => {
      const tsA = ensureDate(a.createdAt)?.getTime() ?? 0;
      const tsB = ensureDate(b.createdAt)?.getTime() ?? 0;
      return tsB - tsA;
    })
    .slice(0, 100);
}

function calculatePrefillCoverage(clips: ClipRow[]): PrefillCoverage {
  if (!clips.length) {
    return { transcript: null, translation: null, diarization: null };
  }
  const total = clips.length;
  const transcript = clips.filter(hasPrefillTranscript).length;
  const translation = clips.filter(hasPrefillTranslation).length;
  const diarization = clips.filter(hasPrefillDiarization).length;
  return {
    transcript: clampPercent((transcript / total) * 100),
    translation: clampPercent((translation / total) * 100),
    diarization: clampPercent((diarization / total) * 100),
  };
}

export async function getAdminStats(filters: AdminFilters = {}): Promise<AdminStats> {
  const window = determineWindow(filters);
  const now = new Date();

  const clipFields = [
    "id",
    "status",
    "stage",
    "stage_status",
    "duration_sec",
    "country",
    "dialect",
    "dialect_family",
    "priority",
    "assigned_to",
    "duplicate_group_id",
    "rights_consent_status",
    "last_action_at",
    "updated_at",
    "created_at",
    "transcript_vtt_url",
    "translation_vtt_url",
    "diarization_rttm_url",
    "prefill_transcript_vtt_url",
    "prefill_translation_vtt_url",
    "prefill_diarization_rttm_url",
  ].join(",");

  const annotationFields = [
    "id",
    "clip_id",
    "annotator_id",
    "started_at",
    "submitted_at",
    "duration_worked_sec",
  ].join(",");

  const qaFields = ["id", "clip_id", "reviewer_id", "status", "created_at"].join(
    ","
  );

  const flagFields = ["id", "clip_id", "type", "note", "created_at"].join(",");
  const annotatorFields = ["id", "display_name", "email", "active"].join(",");

  const clipQuery = supabase.from("clips").select(clipFields).limit(10000);
  const annotationQuery = supabase
    .from("annotations")
    .select(annotationFields)
    .limit(20000);
  const qaQuery = supabase.from("qa_reviews").select(qaFields).limit(20000);
  const flagQuery = supabase
    .from("flags")
    .select(flagFields)
    .order("created_at", { ascending: false })
    .limit(200);
  const annotatorQuery = supabase.from("annotators").select(annotatorFields).limit(2000);

  const [
    { data: clips, error: clipsError },
    { data: annotations, error: annotationsError },
    { data: qaReviews, error: qaError },
    { data: flags, error: flagsError },
    { data: annotators, error: annotatorsError },
  ] = await Promise.all([
    clipQuery,
    annotationQuery,
    qaQuery,
    flagQuery,
    annotatorQuery,
  ]);

  const errors = [
    clipsError,
    annotationsError,
    qaError,
    flagsError,
    annotatorsError,
  ].filter(Boolean);

  const supabaseStatus: AdminStats["environment"]["supabaseStatus"] =
    errors.length === 0 ? "online" : clipsError ? "degraded" : "degraded";

  type AugmentedClip = ClipRow & {
    canonicalStatus: CanonicalStatus;
    timestamp: Date | null;
  };

  const augmentedClips: AugmentedClip[] = ((clips ?? []) as ClipRow[]).map((clip) => {
    const canonicalStatus = toCanonical(clip);
    const timestamp = clipTimestamp(clip);
    return {
      ...clip,
      canonicalStatus,
      timestamp,
    };
  });

  const filteredClips = augmentedClips.filter((clip) =>
    clipMatchesFilters(
      clip,
      { ...filters, from: window.from, to: window.to },
      { ignoreDates: false }
    )
  );

  const clipMap = new Map(
    augmentedClips.map((clip) => [
      String(clip.id ?? clip.clip_id ?? clip.clipId ?? ""),
      clip,
    ])
  );

  const totalClips = filteredClips.length;
  const totalDurationHours = sumDurationSeconds(filteredClips) / HOUR_SECONDS;

  const statusCounts = filteredClips.reduce<Record<string, number>>((acc, clip) => {
    acc[clip.canonicalStatus] = (acc[clip.canonicalStatus] ?? 0) + 1;
    return acc;
  }, {});

  const backlogCount = filteredClips.filter((clip) =>
    isBacklog(clip.canonicalStatus)
  ).length;
  const inAnnotationCount = filteredClips.filter((clip) =>
    isInAnnotation(clip.canonicalStatus)
  ).length;
  const qaPendingCount = statusCounts[CANONICAL_STATUS.QA_PENDING] ?? 0;
  const qaFailCount = statusCounts[CANONICAL_STATUS.QA_FAIL] ?? 0;
  const completedCount = statusCounts[CANONICAL_STATUS.DONE] ?? 0;

  const durationDone =
    sumDurationSeconds(
      filteredClips.filter(
        (clip) => clip.canonicalStatus === CANONICAL_STATUS.DONE
      )
    ) / HOUR_SECONDS;

  const pctCompleteByCount =
    totalClips > 0 ? clampPercent((completedCount / totalClips) * 100) : 0;
  const pctCompleteByDuration =
    totalDurationHours > 0
      ? clampPercent((durationDone / totalDurationHours) * 100)
      : 0;

  const throughput7dCutoff = new Date(window.to.getTime() - 7 * DAY_MS);
  const throughput7d = filteredClips.filter((clip) => {
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return false;
    if (!clip.timestamp) return false;
    return clip.timestamp >= throughput7dCutoff && clip.timestamp <= window.to;
  }).length;

  const prevThroughputRangeEnd = new Date(throughput7dCutoff.getTime());
  const prevThroughputRangeStart = new Date(
    throughput7dCutoff.getTime() - 7 * DAY_MS
  );
  const throughputPrev7d = augmentedClips.filter((clip) => {
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return false;
    if (!clip.timestamp) return false;
    if (!clipMatchesFilters(clip, filters, { ignoreDates: true })) return false;
    return (
      clip.timestamp >= prevThroughputRangeStart &&
      clip.timestamp < prevThroughputRangeEnd
    );
  }).length;

  const annotationsList = (annotations ?? []) as AnnotationRow[];
  const qaList = (qaReviews ?? []) as QAReviewRow[];

  const activeAnnotators24h = (() => {
    const cutoff = new Date(window.to.getTime() - DAY_MS);
    const active = new Set<string>();
    annotationsList.forEach((annotation) => {
      const submitted = ensureDate(annotation.submitted_at ?? annotation.submittedAt);
      if (!submitted || submitted < cutoff || submitted > window.to) return;
      const annotatorId = annotation.annotator_id ?? annotation.annotatorId;
      if (annotatorId) active.add(String(annotatorId));
    });
    qaList.forEach((review) => {
      const created = ensureDate(review.created_at ?? review.createdAt);
      if (!created || created < cutoff || created > window.to) return;
      const reviewer = review.reviewer_id ?? review.reviewerId;
      if (reviewer) active.add(String(reviewer));
    });
    return active.size;
  })();

  const stuckRows = collectStuck(augmentedClips, filters, now);
  const stuckOver24h = stuckRows.length;

  const qaStats = qaList.reduce(
    (acc, review) => {
      const status = String(review.status ?? "").toLowerCase();
      if (status === "pass") acc.pass += 1;
      else if (status === "fail") acc.fail += 1;
      return acc;
    },
    { pass: 0, fail: 0 }
  );
  const qaFailRate =
    qaStats.pass + qaStats.fail > 0
      ? clampPercent((qaStats.fail / (qaStats.pass + qaStats.fail)) * 100)
      : 0;

  const qaRecentWindowStart = new Date(window.to.getTime() - 7 * DAY_MS);
  const qaRecent = qaList.filter((review) => {
    const created = ensureDate(review.created_at ?? review.createdAt);
    return created && created >= qaRecentWindowStart && created <= window.to;
  });
  const qaPrev = qaList.filter((review) => {
    const created = ensureDate(review.created_at ?? review.createdAt);
    return (
      created &&
      created >= prevThroughputRangeStart &&
      created < qaRecentWindowStart
    );
  });
  const qaRecentTotals = qaRecent.reduce(
    (acc, review) => {
      const status = String(review.status ?? "").toLowerCase();
      if (status === "fail") acc.fail += 1;
      else if (status === "pass") acc.pass += 1;
      return acc;
    },
    { pass: 0, fail: 0 }
  );
  const qaPrevTotals = qaPrev.reduce(
    (acc, review) => {
      const status = String(review.status ?? "").toLowerCase();
      if (status === "fail") acc.fail += 1;
      else if (status === "pass") acc.pass += 1;
      return acc;
    },
    { pass: 0, fail: 0 }
  );

  const qaFailRateRecent =
    qaRecentTotals.pass + qaRecentTotals.fail > 0
      ? qaRecentTotals.fail / (qaRecentTotals.pass + qaRecentTotals.fail)
      : null;
  const qaFailRatePrev =
    qaPrevTotals.pass + qaPrevTotals.fail > 0
      ? qaPrevTotals.fail / (qaPrevTotals.pass + qaPrevTotals.fail)
      : null;

  const turnaroundMinutes = annotationsList
    .map(calcTurnaroundMinutes)
    .filter((value): value is number => value != null && !Number.isNaN(value));
  const avgTurnaroundMinutes =
    turnaroundMinutes.length > 0
      ? Math.round(
          turnaroundMinutes.reduce((sum, value) => sum + value, 0) /
            turnaroundMinutes.length
        )
      : null;

  const leaderboard = buildLeaderboard(
    annotationsList,
    qaList,
    clipMap,
    window.from,
    window.to
  );

  const stuckTable = stuckRows
    .sort((a, b) => {
      const priorityA = a.priority ?? 999;
      const priorityB = b.priority ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;
      const tsA = ensureDate(a.lastActionAt)?.getTime() ?? 0;
      const tsB = ensureDate(b.lastActionAt)?.getTime() ?? 0;
      return tsA - tsB;
    })
    .slice(0, 200);

  const recentFlags = collectFlags((flags ?? []) as FlagRow[], clipMap);

  const coverage = calculatePrefillCoverage(filteredClips);

  const throughput30d = buildThroughputSeries(filteredClips, window.from, window.to);
  const funnel = buildFunnelCounts(filteredClips);
  const dialectDistribution = buildBreakdown(filteredClips, "dialect") as Array<{
    dialect: string;
    count: number;
    hours: number;
  }>;
  const countryDistribution = buildBreakdown(filteredClips, "country") as Array<{
    country: string;
    count: number;
    hours: number;
  }>;

  const availableAnnotators = ((annotators ?? []) as AnnotatorRow[])
    .map((row) => String(row.display_name ?? row.email ?? row.id ?? ""))
    .filter((value) => value.length > 0);

  return {
    generatedAt: new Date().toISOString(),
    timeWindow: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    environment: {
      supabaseStatus,
      message:
        errors.length > 0
          ? errors.map((err) => err?.message ?? "").filter(Boolean).join("; ")
          : undefined,
      lastSync: new Date().toISOString(),
    },
    kpis: {
      totalClips: { value: totalClips, delta: null },
      totalDurationHours: {
        value: Math.round(totalDurationHours * 100) / 100,
        delta: null,
      },
      pctCompleteCount: { value: pctCompleteByCount, delta: null },
      pctCompleteDuration: { value: pctCompleteByDuration, delta: null },
      awaitingAnnotation: { value: backlogCount, delta: null },
      inAnnotation: { value: inAnnotationCount, delta: null },
      qaPending: { value: qaPendingCount, delta: null },
      qaFailRate: {
        value: qaFailRate,
        delta:
          qaFailRateRecent != null && qaFailRatePrev != null
            ? Math.round((qaFailRateRecent - qaFailRatePrev) * 1000) / 10
            : null,
      },
      activeAnnotators24h: { value: activeAnnotators24h, delta: null },
      throughput7d: {
        value: throughput7d,
        delta: throughput7d - throughputPrev7d,
      },
      avgTurnaroundMinutes: { value: avgTurnaroundMinutes, delta: null },
      stuckOver24h: { value: stuckOver24h, delta: null },
    },
    analytics: {
      funnel,
      throughput30d,
      annotatorLeaderboard: leaderboard,
      prefillCoverage: coverage,
      dialectDistribution,
      countryDistribution,
    },
    tables: {
      stuck: stuckTable,
      recentFlags,
    },
    filters: {
      availableAnnotators,
    },
  };
}
