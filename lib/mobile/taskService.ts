import { randomUUID } from "crypto";
import { getServiceSupabase } from "../supabaseServer";
import type { Database } from "../../types/supabase";
import {
  MOBILE_BUNDLE_TTL_MINUTES,
  MOBILE_DEFAULT_BUNDLE_SIZE,
  MOBILE_GOLDEN_RATIO,
  MOBILE_LEASE_MINUTES,
  MOBILE_MIN_GREENS_REVIEW,
  MOBILE_MIN_GREENS_SKIP_QA,
  MOBILE_TARGET_VOTES,
} from "./constants";
import type {
  ContributorRow,
  MobileBundleResponse,
  MobileClaimResponse,
  MobileClipPayload,
  MobileTaskResponseBody,
  TaskType,
} from "./types";
import { hasTaskTypeCapability, parseCapabilities } from "./capabilities";
import { persistAnnotationPayload } from "./storage";
import { MobileApiError } from "./errors";
import { logMobileEvent } from "./events";

type Supabase = ReturnType<typeof getServiceSupabase>;

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];
type ClipRow = Database["public"]["Tables"]["clips"]["Row"];
type MediaAssetRow = Database["public"]["Tables"]["media_assets"]["Row"];
type AssignmentRow = Database["public"]["Tables"]["task_assignments"]["Row"];
type StatsRow = Database["public"]["Tables"]["contributor_stats"]["Row"];

interface TaskRecord extends TaskRow {
  clip: ClipRow | null;
}

type SkipReasonCode =
  | "missing_clip"
  | "capability_mismatch"
  | "eligibility_failure"
  | "already_assigned"
  | "no_open_slots"
  | "assignment_insert_failed"
  | "bundle_reuse"
  | "assignment_update_failed";

export interface SkipReason {
  taskId: string;
  reason: SkipReasonCode;
}

const DEFAULT_EWMA = 0.8;
function normalizePayload(value: any) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({});
  }
}

async function expireStaleBundle(
  supabase: Supabase,
  contributorId: string
) {
  const { data: bundle } = await supabase
    .from("task_bundles")
    .select("*")
    .eq("contributor_id", contributorId)
    .eq("state", "active")
    .maybeSingle();
  if (!bundle) return null;
  const expiresAt = new Date(bundle.created_at);
  expiresAt.setMinutes(expiresAt.getMinutes() + bundle.ttl_minutes);
  if (expiresAt < new Date()) {
    await supabase
      .from("task_bundles")
      .update({ state: "expired" })
      .eq("id", bundle.id);
    await logMobileEvent(contributorId, "bundle_expired", {
      bundle_id: bundle.id,
    });
    return null;
  }
  return bundle;
}

async function fetchTaskPrice(
  supabase: Supabase,
  task: TaskRow
): Promise<number> {
  if (Number.isFinite(task.price_cents) && (task.price_cents as number) > 0) {
    return task.price_cents as number;
  }
  const { data } = await supabase
    .from("task_prices")
    .select("base_cents, surge_multiplier")
    .eq("task_type", task.task_type)
    .maybeSingle();
  if (data) {
    return Math.round((data.base_cents || 0) * (data.surge_multiplier || 1));
  }
  return 0;
}

export async function claimSingleTask(
  contributor: ContributorRow,
  supabase: Supabase,
  opts: { bundleId?: string | null; leaseMinutes?: number } = {}
): Promise<{ task: MobileClaimResponse | null; skipReasons: SkipReason[] }> {
  const useGolden = Math.random() < MOBILE_GOLDEN_RATIO;
  const contributorCaps = parseCapabilities(contributor);
  const skipReasons: SkipReason[] = [];
  const recordSkip = (task: TaskRow, reason: SkipReasonCode) => {
    skipReasons.push({ taskId: task.id, reason });
  };
  const candidateSets = [
    await fetchCandidates(supabase, { goldenOnly: useGolden }),
    await fetchCandidates(supabase, { goldenOnly: false }),
  ];

  for (const candidates of candidateSets) {
    for (const task of candidates) {
      if (!task.clip) {
        recordSkip(task, "missing_clip");
        await logMobileEvent(contributor.id, "task_skipped", {
          task_id: task.id,
          reason: "missing_clip",
        });
        continue;
      }

      if (!hasTaskTypeCapability(contributorCaps, task.task_type)) {
        recordSkip(task, "capability_mismatch");
        await logMobileEvent(contributor.id, "task_skipped", {
          task_id: task.id,
          reason: "capability_mismatch",
        });
        continue;
      }

      if (
        task.task_type !== "translation_check" &&
        !isTaskEligible(contributor, contributorCaps, task, task.clip)
      ) {
        recordSkip(task, "eligibility_failure");
        await logMobileEvent(contributor.id, "task_skipped", {
          task_id: task.id,
          reason: "eligibility_failure",
        });
        continue;
      }
      const assignments = await loadAssignments(supabase, task.id);
      const totalAssignments = assignments.length;
      const targetVotes = task.target_votes || MOBILE_TARGET_VOTES;

      if (
        assignments.some(
          (assignment) =>
            assignment.contributor_id === contributor.id &&
            assignment.state !== "released" &&
            new Date(assignment.lease_expires_at) > new Date()
        )
      ) {
        recordSkip(task, "already_assigned");
        continue;
      }

      if (totalAssignments >= targetVotes) {
        recordSkip(task, "no_open_slots");
        continue;
      }

      const openSlots =
        task.task_type === "translation_check"
          ? Number.POSITIVE_INFINITY
          : targetVotes - totalAssignments;

      if (openSlots <= 0) {
        recordSkip(task, "no_open_slots");
        continue;
      }

      const leaseMinutes = opts.leaseMinutes ?? MOBILE_LEASE_MINUTES;
      const leaseExpiresAt = new Date(
        Date.now() + leaseMinutes * 60 * 1000
      ).toISOString();

      let assignmentId = randomUUID();
      let claimedLeaseExpiresAt = leaseExpiresAt;
      const insertResult = await supabase
        .from("task_assignments")
        .insert({
          id: assignmentId,
          task_id: task.id,
          contributor_id: contributor.id,
          bundle_id: opts.bundleId ?? null,
          lease_expires_at: leaseExpiresAt,
          state: "leased",
        })
        .select("id")
        .single();

      if (insertResult.error) {
        const { data: existingAssignment } = await supabase
          .from("task_assignments")
          .select("id, bundle_id")
          .eq("task_id", task.id)
          .eq("contributor_id", contributor.id)
          .maybeSingle();

        if (!existingAssignment) {
          recordSkip(task, "assignment_insert_failed");
          continue;
        }

        const renewedLeaseExpiresAt = new Date(
          Date.now() + MOBILE_BUNDLE_TTL_MINUTES * 60 * 1000
        ).toISOString();
        const updateResult = await supabase
          .from("task_assignments")
          .update({
            state: "leased",
            lease_expires_at: renewedLeaseExpiresAt,
            bundle_id: opts.bundleId ?? existingAssignment.bundle_id ?? null,
          })
          .eq("id", existingAssignment.id);

        if (updateResult.error) {
          recordSkip(task, "assignment_update_failed");
          continue;
        }

        assignmentId = existingAssignment.id;
        claimedLeaseExpiresAt = renewedLeaseExpiresAt;
      } else if (insertResult.data?.id) {
        assignmentId = insertResult.data.id;
      }

      await supabase
        .from("tasks")
        .update({ status: "in_progress" })
        .eq("id", task.id);

      const price = await fetchTaskPrice(supabase, task);

      await logMobileEvent(contributor.id, "task_claimed", {
        task_id: task.id,
        bundle_id: opts.bundleId ?? null,
      });

      let clipPayload = buildClipPayload(task.clip);

      if (task.clip?.asset_id) {
        const { data: asset } = await supabase
          .from("media_assets")
          .select("id, uri, meta")
          .eq("id", task.clip.asset_id)
          .maybeSingle();

        if (asset) {
          clipPayload = buildClipPayload(task.clip, asset);
        }
      }

      return {
        task: {
          task_id: task.id,
          assignment_id: assignmentId,
          lease_expires_at: claimedLeaseExpiresAt,
          clip: clipPayload,
          task_type: task.task_type as TaskType,
          ai_suggestion: (task.ai_suggestion as Record<string, any>) || undefined,
          price_cents: price,
          bundle_id: opts.bundleId ?? undefined,
        },
        skipReasons,
      };
    }
  }

  return { task: null, skipReasons };
}

export async function claimBundle(
  contributor: ContributorRow,
  supabase: Supabase,
  count: number = MOBILE_DEFAULT_BUNDLE_SIZE
): Promise<MobileBundleResponse> {
  await expireStaleBundle(supabase, contributor.id);

  const { data: openBundle, error: openBundleError } = await supabase
    .from("task_bundles")
    .select("*")
    .eq("contributor_id", contributor.id)
    .neq("state", "closed")
    .limit(1)
    .maybeSingle();

  if (openBundleError) {
    throw new MobileApiError(
      "SERVER_ERROR",
      500,
      "Failed to check existing bundles"
    );
  }

  if (openBundle) {
    const { error: closeError } = await supabase
      .from("task_bundles")
      .update({ state: "closed" })
      .eq("id", openBundle.id);

    if (closeError) {
      throw new MobileApiError("SERVER_ERROR", 500, "Failed to close bundle");
    }
  }

  const bundleInsert = await supabase
    .from("task_bundles")
    .insert({
      contributor_id: contributor.id,
      ttl_minutes: MOBILE_BUNDLE_TTL_MINUTES,
      state: "active",
    })
    .select("*")
    .single();

  let bundle = bundleInsert.data;
  let lastSkipReasons: SkipReason[] = [];

  if (bundleInsert.error || !bundleInsert.data) {
    const { data: existingBundle, error: existingBundleError } = await supabase
      .from("task_bundles")
      .select("*")
      .eq("contributor_id", contributor.id)
      .neq("state", "closed")
      .maybeSingle();

    if (existingBundleError || !existingBundle) {
      const message = bundleInsert.error?.message || "Failed to create bundle";
      throw new MobileApiError(
        "SERVER_ERROR",
        500,
        `Failed to create bundle: ${message}`
      );
    }

    bundle = existingBundle;
    lastSkipReasons = [{ taskId: bundle.id, reason: "bundle_reuse" }];
  }

  const tasks: MobileClaimResponse[] = [];

  for (let i = 0; i < count; i++) {
    const { task: claimed, skipReasons } = await claimSingleTask(
      contributor,
      supabase,
      {
        bundleId: bundle.id,
        leaseMinutes: MOBILE_BUNDLE_TTL_MINUTES,
      }
    );
    if (!claimed) {
      lastSkipReasons = [...lastSkipReasons, ...skipReasons];
      break;
    }
    tasks.push(claimed);
  }

  if (tasks.length === 0) {
    await supabase
      .from("task_bundles")
      .update({ state: "closed" })
      .eq("id", bundle.id);
    const error = new MobileApiError("NO_TASKS", 404, "No tasks available");
    error.skipReasons = lastSkipReasons;
    throw error;
  }

  await logMobileEvent(contributor.id, "bundle_created", {
    bundle_id: bundle.id,
    count: tasks.length,
  });

  return { bundle_id: bundle.id, tasks };
}

export async function releaseAssignment(
  contributor: ContributorRow,
  supabase: Supabase,
  assignmentId: string,
  reason?: string
) {
  const assignment = await loadAssignmentForContributor(
    supabase,
    assignmentId,
    contributor.id
  );

  if (assignment.state === "submitted" || assignment.state === "released") {
    return assignment;
  }

  await supabase
    .from("task_assignments")
    .update({
      state: "released",
      lease_expires_at: new Date().toISOString(),
    })
    .eq("id", assignmentId);

  await logMobileEvent(contributor.id, "task_released", {
    assignment_id: assignmentId,
    task_id: assignment.task_id,
    reason,
  });

  await maybeCloseBundle(supabase, assignment.bundle_id);
  return assignment;
}

export async function refreshLease(
  contributor: ContributorRow,
  supabase: Supabase,
  assignmentId: string,
  playbackRatio?: number,
  watchedMs?: number
) {
  const assignment = await loadAssignmentForContributor(
    supabase,
    assignmentId,
    contributor.id
  );

  if (assignment.state !== "leased") {
    throw new MobileApiError(
      "LEASE_CONFLICT",
      409,
      "Assignment is no longer active"
    );
  }

  const leaseExpiresAt = new Date(
    Date.now() + MOBILE_LEASE_MINUTES * 60 * 1000
  ).toISOString();
  await supabase
    .from("task_assignments")
    .update({
      lease_expires_at: leaseExpiresAt,
      last_heartbeat_at: new Date().toISOString(),
      playback_ratio: playbackRatio ?? assignment.playback_ratio,
      watched_ms: watchedMs ?? assignment.watched_ms,
    })
    .eq("id", assignmentId);

  return leaseExpiresAt;
}

export async function submitAssignment(
  contributor: ContributorRow,
  supabase: Supabase,
  body: MobileTaskResponseBody
) {
  const assignment = await loadAssignmentForContributor(
    supabase,
    body.assignment_id,
    contributor.id
  );

  if (assignment.state === "submitted") {
    throw new MobileApiError(
      "LEASE_CONFLICT",
      409,
      "Assignment already submitted"
    );
  }

  if (new Date(assignment.lease_expires_at) < new Date()) {
    throw new MobileApiError("LEASE_EXPIRED", 410, "Assignment expired");
  }

  const { data: taskRow, error: taskError } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", assignment.task_id)
    .single();
  if (taskError || !taskRow) {
    throw new MobileApiError(
      "SERVER_ERROR",
      500,
      "Task metadata missing"
    );
  }

  validatePlayback(body);

  await supabase
    .from("task_responses")
    .upsert({
      task_id: assignment.task_id,
      contributor_id: contributor.id,
      payload: body.payload,
      duration_ms: body.duration_ms,
      playback_ratio: body.playback_ratio,
    });

  await supabase
    .from("task_assignments")
    .update({
      state: "submitted",
      playback_ratio: body.playback_ratio,
      watched_ms: body.watched_ms ?? null,
    })
    .eq("id", assignment.id);

  await persistAnnotationPayload({
    clipId: taskRow.clip_id,
    taskId: assignment.task_id,
    taskType: taskRow.task_type,
    contributorId: contributor.id,
    payload: body.payload,
  });

  const normalized = normalizePayload(body.payload);
  const consensus = await recomputeConsensus(
    supabase,
    taskRow,
    assignment.task_id,
    body.payload,
    contributor.id,
    normalized
  );

  await logMobileEvent(contributor.id, "task_submitted", {
    task_id: assignment.task_id,
    green_count: consensus.green_count,
    status: consensus.status,
  });

  const alignedWithConsensus = normalized === consensus.winning_key;
  await updateContributorStats(
    supabase,
    contributor.id,
    alignedWithConsensus,
    consensus.golden_match
  );

  await maybeCloseBundle(supabase, assignment.bundle_id);

  return consensus;
}

export async function getClipContext(
  supabase: Supabase,
  clipId: string
): Promise<{
  clip: MobileClipPayload;
  prev?: MobileClipPayload | null;
  next?: MobileClipPayload | null;
}> {
  const { data: clip, error } = await supabase
    .from("clips")
    .select("*")
    .eq("id", clipId)
    .single();

  if (error || !clip) {
    throw new MobileApiError("VALIDATION_FAILED", 404, "Clip not found");
  }

  const result: {
    clip: MobileClipPayload;
    prev?: MobileClipPayload | null;
    next?: MobileClipPayload | null;
  } = {
    clip: buildClipPayload(clip),
  };

  if (clip.context_prev_clip) {
    const prev = await supabase
      .from("clips")
      .select("*")
      .eq("id", clip.context_prev_clip)
      .maybeSingle();
    if (prev.data) {
      result.prev = buildClipPayload(prev.data);
    }
  }

  if (clip.context_next_clip) {
    const next = await supabase
      .from("clips")
      .select("*")
      .eq("id", clip.context_next_clip)
      .maybeSingle();
    if (next.data) {
      result.next = buildClipPayload(next.data);
    }
  }

  return result;
}

async function fetchCandidates(
  supabase: Supabase,
  opts: { goldenOnly?: boolean; limit?: number }
): Promise<TaskRecord[]> {
  let query = supabase
    .from("tasks")
    .select("*, clip:clips(*)")
    .in("status", ["pending", "in_progress"]);
  if (opts.goldenOnly) {
    query = query.eq("is_golden", true);
  }
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 25);
  return ((data as TaskRecord[]) ?? []).filter(Boolean);
}

export async function summarizeCandidateTasks(
  supabase: Supabase,
  opts: { limit?: number } = {}
) {
  const limit = opts.limit ?? 50;
  const [goldenCandidates, regularCandidates] = await Promise.all([
    fetchCandidates(supabase, { goldenOnly: true, limit }),
    fetchCandidates(supabase, { goldenOnly: false, limit }),
  ]);

  return {
    goldenCandidates: goldenCandidates.length,
    regularCandidates: regularCandidates.length,
    totalCandidates: goldenCandidates.length + regularCandidates.length,
  };
}

async function loadAssignments(supabase: Supabase, taskId: string) {
  const { data } = await supabase
    .from("task_assignments")
    .select("id, contributor_id, state, lease_expires_at")
    .eq("task_id", taskId);
  return (data as AssignmentRow[]) ?? [];
}

function countActiveVotes(assignments: AssignmentRow[]) {
  return assignments.filter((assignment) =>
    ["leased", "submitted"].includes(assignment.state)
  ).length;
}

function buildClipPayload(
  clip: ClipRow | null,
  asset?: MediaAssetRow | null
): MobileClipPayload {
  if (!clip) {
    throw new MobileApiError("SERVER_ERROR", 500, "Clip metadata missing");
  }
  const meta = (clip.meta as any) || {};
  const assetMeta = (asset?.meta as any) || {};
  const speakers =
    Array.isArray(clip.speakers) && clip.speakers.every((s) => typeof s === "string")
      ? (clip.speakers as string[])
      : [];
  const assetUri = asset?.uri ?? null;
  const audioUrl =
    assetUri ||
    meta.audio_url ||
    meta.audio ||
    meta.audio_uri ||
    meta.audio_proxy_url ||
    null;
  const videoUrl = assetUri || meta.video_url || meta.video || null;
  const captionsUrl =
    asset
      ? assetMeta.transcript_vtt_url ?? null
      : (clip as any)?.captions_vtt_url ||
        meta.captions_vtt_url ||
        meta.subtitles_vtt_url ||
        meta.transcript_vtt_url ||
        null;
  const captionsPreference =
    meta.captions_auto_enabled ?? meta.captions_auto ?? meta.auto_captions;
  const captionsAuto =
    captionsPreference === undefined ? Boolean(captionsUrl) : Boolean(captionsPreference);
  return {
    id: clip.id,
    asset_id: clip.asset_id,
    start_ms: clip.start_ms,
    end_ms: clip.end_ms,
    overlap_ms: clip.overlap_ms ?? 0,
    speakers,
    audio_url: audioUrl,
    video_url: videoUrl,
    captions_vtt_url: captionsUrl,
    captions_auto_enabled: captionsAuto,
    context_prev_clip: clip.context_prev_clip,
    context_next_clip: clip.context_next_clip,
  };
}

async function loadAssignmentForContributor(
  supabase: Supabase,
  assignmentId: string,
  contributorId: string
) {
  const { data, error } = await supabase
    .from("task_assignments")
    .select("*")
    .eq("id", assignmentId)
    .single();
  if (error || !data) {
    throw new MobileApiError("LEASE_CONFLICT", 404, "Assignment not found");
  }
  if (data.contributor_id !== contributorId) {
    throw new MobileApiError(
      "FORBIDDEN",
      403,
      "Assignment does not belong to user"
    );
  }
  return data;
}

function validatePlayback(body: MobileTaskResponseBody) {
  if (body.playback_ratio < 0.7) {
    throw new MobileApiError(
      "PLAYBACK_TOO_SHORT",
      422,
      "Playback ratio must be >= 0.7"
    );
  }
  if (body.duration_ms < 1500) {
    throw new MobileApiError(
      "PLAYBACK_TOO_SHORT",
      422,
      "Duration too short"
    );
  }
}

async function recomputeConsensus(
  supabase: Supabase,
  taskRow: Database["public"]["Tables"]["tasks"]["Row"] | null,
  taskId: string,
  latestPayload: any,
  submittingContributorId: string,
  normalizedSubmission: string
) {
  let task = taskRow;
  if (!task) {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .single();
    if (error || !data) {
      throw new MobileApiError("SERVER_ERROR", 500, "Task missing");
    }
    task = data;
  }

  const { data: responses } = await supabase
    .from("task_responses")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });

  const contributorIds = (responses || [])
    .map((response) => response.contributor_id)
    .filter(Boolean);
  const statsMap = new Map<string, StatsRow>();
  if (contributorIds.length) {
    const { data: stats } = await supabase
      .from("contributor_stats")
      .select("*")
      .in("contributor_id", contributorIds);
    (stats || []).forEach((row) => {
      statsMap.set(row.contributor_id, row as StatsRow);
    });
  }

  const votes =
    responses?.map((response) => {
      const weight = Math.min(
        1.5,
        0.5 + (statsMap.get(response.contributor_id)?.ewma_agreement ?? DEFAULT_EWMA)
      );
      return {
        contributor_id: response.contributor_id,
        payload: response.payload,
        key: normalizePayload(response.payload),
        weight,
      };
    }) ?? [];

  if (votes.length === 0) {
    votes.push({
      contributor_id: submittingContributorId,
      payload: latestPayload,
      key: normalizedSubmission,
      weight: 1,
    });
  }

  const grouped = new Map<
    string,
    { payload: any; weight: number; contributors: string[] }
  >();
  for (const vote of votes) {
    const existing = grouped.get(vote.key);
    if (existing) {
      existing.weight += vote.weight;
      existing.contributors.push(vote.contributor_id);
    } else {
      grouped.set(vote.key, {
        payload: vote.payload,
        weight: vote.weight,
        contributors: [vote.contributor_id],
      });
    }
  }

  const sorted = Array.from(grouped.entries()).sort(
    (a, b) => b[1].weight - a[1].weight
  );
  const winner = sorted[0];
  const winningKey = winner?.[0] ?? normalizedSubmission;
  const consensusPayload = winner?.[1]?.payload ?? latestPayload;

  const totalWeight = votes.reduce((sum, vote) => sum + vote.weight, 0) || 1;
  const agreementScore = (winner?.[1]?.weight ?? 0) / totalWeight;
  const greenCount =
    winner?.[1]?.contributors.length ?? (responses?.length || 1);

  let finalStatus = task?.status ?? "pending";
  if (greenCount >= (task?.min_green_for_skip_qa || MOBILE_MIN_GREENS_SKIP_QA)) {
    finalStatus = "auto_approved";
  } else if (
    greenCount >= (task?.min_green_for_review || MOBILE_MIN_GREENS_REVIEW)
  ) {
    finalStatus = "needs_review";
  }

  const votesPayload = votes.map(({ contributor_id, payload, weight }) => ({
    contributor_id,
    payload,
    weight,
  }));

  await supabase
    .from("task_consensus")
    .upsert({
      task_id: taskId,
      consensus: consensusPayload,
      votes: votesPayload,
      green_count: greenCount,
      agreement_score: agreementScore,
      final_status: finalStatus,
    });

  await supabase.from("tasks").update({ status: finalStatus }).eq("id", taskId);

  let goldenMatch: boolean | null = null;
  if (task?.is_golden && task?.golden_answer) {
    const goldenKey = normalizePayload(task.golden_answer);
    goldenMatch = normalizedSubmission === goldenKey;
    await logMobileEvent(submittingContributorId, "golden_evaluated", {
      task_id: taskId,
      matched: goldenMatch,
    });
  }

  return {
    ok: true,
    green_count: greenCount,
    status: finalStatus,
    agreement_score: agreementScore,
    winning_key: winningKey,
    golden_match: goldenMatch,
  };
}

async function updateContributorStats(
  supabase: Supabase,
  contributorId: string,
  aligned: boolean,
  goldenMatch: boolean | null
) {
  const { data } = await supabase
    .from("contributor_stats")
    .select("*")
    .eq("contributor_id", contributorId)
    .maybeSingle();

  const ewma = data?.ewma_agreement ?? DEFAULT_EWMA;
  const nextEwma = 0.85 * ewma + 0.15 * (aligned ? 1 : 0);
  const tasksTotal = (data?.tasks_total ?? 0) + 1;
  const tasksAgreed = (data?.tasks_agreed ?? 0) + (aligned ? 1 : 0);

  let goldenTotal = data?.golden_total ?? 0;
  let goldenCorrect = data?.golden_correct ?? 0;
  if (typeof goldenMatch === "boolean") {
    goldenTotal += 1;
    if (goldenMatch) goldenCorrect += 1;
  }

  await supabase.from("contributor_stats").upsert({
    contributor_id: contributorId,
    ewma_agreement: nextEwma,
    tasks_total: tasksTotal,
    tasks_agreed: tasksAgreed,
    last_active: new Date().toISOString(),
    golden_total: goldenTotal,
    golden_correct: goldenCorrect,
  } satisfies Partial<StatsRow>);
}

async function maybeCloseBundle(
  supabase: Supabase,
  bundleId: string | null
) {
  if (!bundleId) return;
  const { data } = await supabase
    .from("task_assignments")
    .select("state")
    .eq("bundle_id", bundleId);
  const hasActive = data?.some((row) => row.state === "leased");
  if (!hasActive) {
    await supabase
      .from("task_bundles")
      .update({ state: "closed" })
      .eq("id", bundleId);
    const bundle = await supabase
      .from("task_bundles")
      .select("contributor_id")
      .eq("id", bundleId)
      .single();
    if (bundle.data?.contributor_id) {
      await logMobileEvent(bundle.data.contributor_id, "bundle_closed", {
        bundle_id: bundleId,
      });
    }
  }
}

function tierRank(tier?: string | null) {
  switch (tier) {
    case "gold":
      return 3;
    case "silver":
      return 2;
    default:
      return 1;
  }
}

function matchesTier(current: string | null, required: string | null) {
  if (!required) return true;
  return tierRank(current) >= tierRank(required);
}

function isTaskEligible(
  contributor: ContributorRow,
  caps: ReturnType<typeof parseCapabilities>,
  task: TaskRow,
  clip: ClipRow | null
) {
  const taskMeta = ((task.meta as any) || {}) as Record<string, any>;
  const clipMeta = ((clip?.meta as any) || {}) as Record<string, any>;

  if (!matchesTier(contributor.tier, taskMeta.required_tier)) {
    return false;
  }

  if (taskMeta.required_locale && contributor.locale) {
    if (taskMeta.required_locale !== contributor.locale) return false;
  }

  if (taskMeta.required_geo_country && contributor.geo_country) {
    if (taskMeta.required_geo_country !== contributor.geo_country) return false;
  }

  const requiredRoles: string[] = taskMeta.required_roles || [];
  if (requiredRoles.length) {
    const hasRole =
      requiredRoles.some(
        (role) => caps.roles.has(role) || contributor.role === role
      ) || requiredRoles.includes("any");
    if (!hasRole) return false;
  }

  switch (task.task_type) {
    case "translation_check": {
      const direction =
        taskMeta.direction || clipMeta.direction || taskMeta.lang_pair;
      if (direction && !caps.canTranslate.has(direction)) {
        return false;
      }
      const sourceLang = taskMeta.source_lang || clipMeta.source_lang;
      if (
        sourceLang &&
        caps.langs.size > 0 &&
        !caps.langs.has(sourceLang)
      ) {
        return false;
      }
      break;
    }
    case "accent_tag": {
      const region =
        taskMeta.accent_region ||
        clipMeta.accent_region ||
        clipMeta.dialect_region;
      if (
        region &&
        caps.accentRegions.size > 0 &&
        !caps.accentRegions.has(region)
      ) {
        return false;
      }
      break;
    }
    case "emotion_tag":
    case "gesture_tag": {
      const language = taskMeta.language || clipMeta.language;
      if (language && caps.langs.size > 0 && !caps.langs.has(language)) {
        return false;
      }
      break;
    }
    default:
      break;
  }

  return true;
}
