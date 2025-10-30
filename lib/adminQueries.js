import { parseISO, isValid, subDays, startOfDay, formatISO } from "date-fns";
import { supabase } from "../utils/supabaseClient";
import {
  CANONICAL_STATUS,
  toCanonical,
  toFunnelStage,
  isStuck as clipIsStuck,
  isBacklog,
  isInAnnotation,
} from "./statusMap";

const DEFAULT_WINDOW_DAYS = 30;
const HOUR_SECONDS = 3600;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isValid(value) ? value : null;
  const parsed = parseISO(String(value));
  return isValid(parsed) ? parsed : null;
}

function clampPercent(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function sumDurationSeconds(clips) {
  return clips.reduce(
    (acc, clip) => acc + (Number(clip.duration_sec || clip.durationSec) || 0),
    0
  );
}

function clipTimestamp(clip) {
  const raw =
    clip.completed_at ||
    clip.completedAt ||
    clip.last_action_at ||
    clip.lastActionAt ||
    clip.updated_at ||
    clip.updatedAt ||
    clip.created_at ||
    clip.createdAt;
  return ensureDate(raw);
}

function determineWindow(filters) {
  const to = ensureDate(filters?.to) || new Date();
  const from =
    ensureDate(filters?.from) || subDays(startOfDay(to), DEFAULT_WINDOW_DAYS - 1);
  return { from, to };
}

function matchesValue(value, filterValue) {
  if (!filterValue) return true;
  if (value == null) return false;
  return String(value).toLowerCase() === String(filterValue).toLowerCase();
}

function clipMatchesFilters(clip, filters, { ignoreDates = false } = {}) {
  if (!clip) return false;

  if (filters.priority && !matchesValue(clip.priority, filters.priority)) {
    return false;
  }

  const dialectCandidate =
    clip.dialect ||
    clip.dialect_family ||
    clip.dialectFamily ||
    clip.dialect_family_code;
  if (filters.dialect && !matchesValue(dialectCandidate, filters.dialect)) {
    return false;
  }

  const countryCandidate = clip.country || clip.region || clip.locale;
  if (filters.country && !matchesValue(countryCandidate, filters.country)) {
    return false;
  }

  const assigned = clip.assigned_to || clip.assignedTo || clip.owner_id;
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

  if (!ignoreDates) {
    const timestamp = clipTimestamp(clip);
    if (filters.from && timestamp && timestamp < filters.from) return false;
    if (filters.to && timestamp && timestamp > filters.to) return false;
  }

  return true;
}

function buildFunnelCounts(clips) {
  const counts = {};
  clips.forEach((clip) => {
    const canonical = clip.canonicalStatus;
    const funnel = toFunnelStage(canonical);
    counts[funnel] = (counts[funnel] || 0) + 1;
  });
  return Object.entries(counts).map(([stage, count]) => ({ stage, count }));
}

function buildSeriesThroughput(clips, windowFrom, windowTo) {
  const totals = new Map();
  const cursor = new Date(startOfDay(windowFrom));
  while (cursor <= windowTo) {
    const key = formatISO(cursor, { representation: "date" });
    totals.set(key, 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  clips.forEach((clip) => {
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return;
    const ts = clipTimestamp(clip);
    if (!ts) return;
    if (ts < windowFrom || ts > windowTo) return;
    const key = formatISO(startOfDay(ts), { representation: "date" });
    if (!totals.has(key)) return;
    totals.set(key, totals.get(key) + 1);
  });

  return Array.from(totals.entries()).map(([date, completedCount]) => ({
    date,
    completedCount,
  }));
}

function buildBreakdown(clips, key) {
  const map = new Map();
  clips.forEach((clip) => {
    const value = clip[key] || clip[key.replace(/([A-Z])/g, "_$1").toLowerCase()];
    if (!value) return;
    const durationSec = Number(
      clip.duration_sec || clip.durationSec || clip.clip_duration_sec
    );
    const entry = map.get(value) || { value, count: 0, seconds: 0 };
    entry.count += 1;
    if (!Number.isNaN(durationSec)) entry.seconds += durationSec;
    map.set(value, entry);
  });

  return Array.from(map.values())
    .sort((a, b) => b.count - a.count)
    .map(({ value, count, seconds }) => ({
      [key]: value,
      count,
      hours: Math.round((seconds / HOUR_SECONDS) * 100) / 100,
    }));
}

function collectStuck(clips, filters, now) {
  return clips
    .filter((clip) => clipMatchesFilters(clip, filters, { ignoreDates: true }))
    .filter((clip) => clipIsStuck(clip, now))
    .map((clip) => ({
      clipId: clip.id || clip.clip_id || clip.clipId,
      status: clip.canonicalStatus,
      priority: clip.priority ?? null,
      assignedTo: clip.assigned_to || clip.assignedTo || null,
      lastActionAt:
        clip.last_action_at ||
        clip.lastActionAt ||
        clip.updated_at ||
        clip.updatedAt,
    }));
}

function collectRecentFlags(flags, clipMap, limit = 50) {
  return flags
    .map((flag) => {
      const clipId = flag.clip_id || flag.clipId;
      if (!clipId) return null;
      const clip = clipMap.get(clipId);
      if (!clip) return null;
      return {
        clipId,
        type: flag.type || flag.flag_type || "unknown",
        note: flag.note || flag.notes || null,
        createdAt: flag.created_at || flag.createdAt || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const tsA = ensureDate(a.createdAt)?.getTime() || 0;
      const tsB = ensureDate(b.createdAt)?.getTime() || 0;
      return tsB - tsA;
    })
    .slice(0, limit)
    .map(({ canonicalStatus, priority, ...row }) => row);
}

function calcTurnaroundMinutes(annotation) {
  const start = ensureDate(annotation?.started_at || annotation?.startedAt);
  const submitted = ensureDate(
    annotation?.submitted_at || annotation?.submittedAt
  );
  if (!start || !submitted) return null;
  return Math.max(0, Math.round((submitted.getTime() - start.getTime()) / MINUTE_MS));
}

function buildLeaderboard(
  annotations,
  qaReviews,
  clippedById,
  windowFrom,
  windowTo
) {
  const qaByClip = qaReviews.reduce((map, review) => {
    const clipId = review.clip_id || review.clipId;
    if (!clipId) return map;
    const entry = map.get(clipId) || { pass: 0, fail: 0 };
    const status = String(review.status || "").toLowerCase();
    if (status === "pass") entry.pass += 1;
    else if (status === "fail") entry.fail += 1;
    map.set(clipId, entry);
    return map;
  }, new Map());

  const perAnnotator = new Map();
  annotations.forEach((ann) => {
    const clipId = ann.clip_id || ann.clipId;
    const clip = clippedById.get(clipId);
    if (!clip) return;
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return;

    const submitted = ensureDate(ann.submitted_at || ann.submittedAt);
    if (!submitted) return;
    if (submitted < windowFrom || submitted > windowTo) return;

    const annotatorId = ann.annotator_id || ann.annotatorId;
    if (!annotatorId) return;

    const entry = perAnnotator.get(annotatorId) || {
      annotator: annotatorId,
      clipsDone: 0,
      hoursDone: 0,
      qaPass: 0,
      qaTotal: 0,
      turnaroundMinutes: [],
    };

    entry.clipsDone += 1;
    const durationSec =
      Number(clip.duration_sec || clip.durationSec) ||
      Number(ann.duration_worked_sec || ann.durationWorkedSec) ||
      0;
    entry.hoursDone += durationSec / HOUR_SECONDS;

    const qa = qaByClip.get(clipId);
    if (qa) {
      entry.qaPass += qa.pass;
      entry.qaTotal += qa.pass + qa.fail;
    }

    const turnaround = calcTurnaroundMinutes(ann);
    if (turnaround != null) entry.turnaroundMinutes.push(turnaround);

    perAnnotator.set(annotatorId, entry);
  });

  return Array.from(perAnnotator.values())
    .map((entry) => ({
      annotator: entry.annotator,
      clipsDone: entry.clipsDone,
      hoursDone: Math.round(entry.hoursDone * 100) / 100,
      qaPassRate:
        entry.qaTotal > 0 ? entry.qaPass / entry.qaTotal : entry.qaPass > 0 ? 1 : 0,
      avgTurnaroundMin:
        entry.turnaroundMinutes.length > 0
          ? Math.round(
              entry.turnaroundMinutes.reduce((sum, val) => sum + val, 0) /
                entry.turnaroundMinutes.length
            )
          : null,
    }))
    .sort((a, b) => b.clipsDone - a.clipsDone);
}

function activeAnnotators(annotations, qaReviews, windowEnd, clipMap) {
  const cutoff = new Date(windowEnd.getTime() - DAY_MS);
  const active = new Set();

  annotations.forEach((ann) => {
    const clipId = ann.clip_id || ann.clipId;
    if (!clipMap.has(clipId)) return;
    const submitted = ensureDate(ann.submitted_at || ann.submittedAt);
    if (submitted && submitted >= cutoff && submitted <= windowEnd) {
      const annotatorId = ann.annotator_id || ann.annotatorId;
      if (annotatorId) active.add(annotatorId);
    }
  });

  qaReviews.forEach((review) => {
    const clipId = review.clip_id || review.clipId;
    if (!clipMap.has(clipId)) return;
    const created = ensureDate(review.created_at || review.createdAt);
    if (created && created >= cutoff && created <= windowEnd) {
      const reviewerId = review.reviewer_id || review.reviewerId;
      if (reviewerId) active.add(reviewerId);
    }
  });

  return active.size;
}

export async function getAdminStats(filters) {
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
    "language",
    "priority",
    "assigned_to",
    "duplicate_group_id",
    "rights_consent_status",
    "last_action_at",
    "updated_at",
    "created_at",
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

  const clipQuery = supabase.from("clips").select(clipFields).limit(10000);
  if (filters?.priority) {
    clipQuery.eq("priority", filters.priority);
  }
  if (filters?.dialect) {
    clipQuery.eq("dialect", filters.dialect);
  }
  if (filters?.country) {
    clipQuery.eq("country", filters.country);
  }
  if (filters?.annotatorId) {
    clipQuery.eq("assigned_to", filters.annotatorId);
  }

  const annotationQuery = supabase
    .from("annotations")
    .select(annotationFields)
    .limit(10000);
  const qaQuery = supabase.from("qa_reviews").select(qaFields).limit(10000);
  const flagQuery = supabase
    .from("flags")
    .select(flagFields)
    .order("created_at", { ascending: false })
    .limit(200);

  const [{ data: clips, error: clipsError }, { data: annotations, error: annError }, { data: qaReviews, error: qaError }, { data: flags, error: flagsError }] =
    await Promise.all([clipQuery, annotationQuery, qaQuery, flagQuery]);

  if (clipsError) throw clipsError;
  if (annError) throw annError;
  if (qaError) throw qaError;
  if (flagsError) throw flagsError;

  const augmentedClips = (clips || []).map((clip) => {
    const canonicalStatus = toCanonical(clip);
    return {
      ...clip,
      canonicalStatus,
      funnelStage: toFunnelStage(canonicalStatus),
      timestamp: clipTimestamp(clip),
    };
  });

  const filteredClips = augmentedClips.filter((clip) =>
    clipMatchesFilters(clip, { ...filters, ...window })
  );

  const totalClips = filteredClips.length;
  const totalHours = sumDurationSeconds(filteredClips) / HOUR_SECONDS;

  const statuses = filteredClips.reduce(
    (acc, clip) => {
      acc[clip.canonicalStatus] = (acc[clip.canonicalStatus] || 0) + 1;
      return acc;
    },
    {}
  );

  const backlogCount = filteredClips.reduce(
    (acc, clip) => acc + (isBacklog(clip.canonicalStatus) ? 1 : 0),
    0
  );
  const inAnnotationCount = filteredClips.reduce(
    (acc, clip) => acc + (isInAnnotation(clip.canonicalStatus) ? 1 : 0),
    0
  );
  const qaPendingCount = statuses[CANONICAL_STATUS.QA_PENDING] || 0;
  const qaFailCount = statuses[CANONICAL_STATUS.QA_FAIL] || 0;
  const completedCount = statuses[CANONICAL_STATUS.DONE] || 0;

  const durationDone =
    sumDurationSeconds(
      filteredClips.filter((clip) => clip.canonicalStatus === CANONICAL_STATUS.DONE)
    ) / HOUR_SECONDS;
  const pctCompleteByCount =
    totalClips > 0 ? clampPercent((completedCount / totalClips) * 100) : 0;
  const pctCompleteByDuration =
    totalHours > 0 ? clampPercent((durationDone / totalHours) * 100) : 0;

  const throughput7dCutoff = new Date(window.to.getTime() - 7 * DAY_MS);
  const throughput7d = filteredClips.filter((clip) => {
    if (clip.canonicalStatus !== CANONICAL_STATUS.DONE) return false;
    const ts = clip.timestamp;
    if (!ts) return false;
    return ts >= throughput7dCutoff && ts <= window.to;
  }).length;

  const clipMap = new Map(
    filteredClips.map((clip) => [clip.id || clip.clip_id || clip.clipId, clip])
  );

  const activeAnnotators24h = activeAnnotators(
    annotations || [],
    qaReviews || [],
    window.to,
    clipMap
  );

  const stuckRows = collectStuck(augmentedClips, filters || {}, now);
  const stuckOver24h = stuckRows.length;

  const priorityBuckets = filteredClips.reduce(
    (acc, clip) => {
      if (clip.canonicalStatus === CANONICAL_STATUS.DONE) return acc;
      const key = String(clip.priority ?? "").toLowerCase();
      if (key === "1" || key === "p1") acc.p1 += 1;
      else if (key === "2" || key === "p2") acc.p2 += 1;
      else if (key === "3" || key === "p3") acc.p3 += 1;
      return acc;
    },
    { p1: 0, p2: 0, p3: 0 }
  );

  const throughput30d = buildSeriesThroughput(
    filteredClips,
    window.from,
    window.to
  );
  const funnel = buildFunnelCounts(filteredClips);

  const byDialect = buildBreakdown(filteredClips, "dialect");
  const byCountry = buildBreakdown(filteredClips, "country");

  const leaderboard = buildLeaderboard(
    annotations || [],
    qaReviews || [],
    clipMap,
    window.from,
    window.to
  );

  const stuckTable = stuckRows
    .map((row) => ({
      clipId: row.clipId,
      status: row.status,
      priority: row.priority != null ? Number(row.priority) : null,
      assignedTo: row.assignedTo,
      lastActionAt: row.lastActionAt,
    }))
    .sort((a, b) => {
      const priorityA = a.priority ?? 999;
      const priorityB = b.priority ?? 999;
      if (priorityA !== priorityB) return priorityA - priorityB;
      const tsA = ensureDate(a.lastActionAt)?.getTime() || 0;
      const tsB = ensureDate(b.lastActionAt)?.getTime() || 0;
      return tsA - tsB;
    });

  const recentFlags = collectRecentFlags(flags || [], clipMap, 75);

  return {
    generatedAt: new Date().toISOString(),
    timeWindow: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    kpis: {
      totalClips,
      totalHours: Math.round(totalHours * 100) / 100,
      backlogCount,
      inAnnotationCount,
      qaPendingCount,
      qaFailCount,
      completedCount,
      pctCompleteByCount,
      pctCompleteByDuration,
      throughput7d,
      activeAnnotators24h,
      stuckOver24h,
      priority: priorityBuckets,
    },
    series: {
      throughput30d,
      funnel,
    },
    breakdowns: {
      byDialect,
      byCountry,
      annotatorLeaderboard: leaderboard,
    },
    tables: {
      stuck: stuckTable,
      recentFlags: recentFlags,
    },
  };
}
