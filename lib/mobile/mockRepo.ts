import { randomUUID } from "crypto";
import {
  generateMockBundle,
  generateMockTask,
  getMockContext,
  isMobileMockMode,
} from "./mockData";
import { computeConsensus, updateReputation } from "./consensus";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
} from "./types";
import {
  BundleRecord,
  createBundleRecord,
  DEFAULT_BUNDLE_TTL_MS,
  ensureSingleActiveBundle,
  expireBundlesInPlace,
} from "./bundle";

type AssignmentState = "leased" | "released" | "submitted";

interface Assignment {
  id: string;
  task: MobileClaimResponse;
  contributorId: string;
  leaseExpiresAt: number;
  state: AssignmentState;
  bundleId?: string;
  playbackStarted?: boolean;
}

const BACKLOG_FACTOR = 80;
const LEASE_MS = 15 * 60 * 1000;

const backlog = new Map<string, MobileClaimResponse[]>();
const assignments = new Map<string, Assignment>();
const bundles = new Map<string, BundleRecord>();
const responses = new Map<string, { contributorId: string; payload: any }[]>();
const reputation = new Map<string, number>();

function ensureBacklog() {
  if (backlog.size > 0) return;
  const sample = generateMockBundle(3).tasks;
  for (let i = 0; i < BACKLOG_FACTOR; i += 1) {
    for (const task of sample) {
      const clone: MobileClaimResponse = {
        ...task,
        task_id: `${task.task_id}-${i}-${randomUUID()}`,
        assignment_id: randomUUID(),
      };
      const existing = backlog.get(clone.task_type) || [];
      existing.push(clone);
      backlog.set(clone.task_type, existing);
    }
  }
}

function recycleAssignment(assignment: Assignment) {
  const queue = backlog.get(assignment.task.task_type) || [];
  queue.push(generateMockTask());
  backlog.set(assignment.task.task_type, queue);
}

export function mockPeek(taskType?: string) {
  ensureBacklog();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [type, list] of backlog.entries()) {
    counts[type] = list.length;
    total += list.length;
  }
  const estimate =
    total === 0
      ? 0
      : Math.max(5, Math.round((counts[taskType || "translation_check"] || 0) * 12));
  return {
    count: total,
    backlog_by_type: counts,
    est_wait_seconds: estimate,
  };
}

function recycleBundleAssignments(bundle: BundleRecord) {
  for (const assignmentId of bundle.assignmentIds) {
    const assignment = assignments.get(assignmentId);
    if (assignment && assignment.state === "leased") {
      assignment.state = "released";
      recycleAssignment(assignment);
    }
  }
}

export function mockClaimBundle(
  contributorId: string,
  count: number
): MobileBundleResponse {
  ensureBacklog();
  expireBundlesInPlace(bundles, recycleBundleAssignments);
  const existing = ensureSingleActiveBundle(bundles.values(), contributorId);
  if (existing) {
    const tasks = existing.assignmentIds
      .map((assignmentId) => assignments.get(assignmentId))
      .filter(Boolean)
      .map((assignment) => assignment!.task);

    return { bundle_id: existing.id, tasks };
  }
  const bundleId = `mock-bundle-${randomUUID()}`;
  const bundle = createBundleRecord(bundleId, contributorId, DEFAULT_BUNDLE_TTL_MS);
  const tasks: MobileClaimResponse[] = [];
  for (let i = 0; i < count; i += 1) {
    const queue = backlog.get("translation_check") || [];
    const nextTask = queue.shift() || generateMockTask();
    backlog.set("translation_check", queue);
    const assignmentId = randomUUID();
    const assignment: Assignment = {
      id: assignmentId,
      task: {
        ...nextTask,
        assignment_id: assignmentId,
        lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
        bundle_id: bundleId,
      },
      contributorId,
      leaseExpiresAt: Date.now() + LEASE_MS,
      state: "leased",
      bundleId,
    };
    assignments.set(assignmentId, assignment);
    bundle.assignmentIds.push(assignmentId);
    tasks.push(assignment.task);
  }
  bundles.set(bundleId, bundle);
  return { bundle_id: bundleId, tasks };
}

export function mockReleaseAssignment(assignmentId: string) {
  const assignment = assignments.get(assignmentId);
  if (!assignment) return;
  if (assignment.state === "leased") {
    assignment.state = "released";
    recycleAssignment(assignment);
  }
}

export function mockHeartbeat(assignmentId: string) {
  const assignment = assignments.get(assignmentId);
  if (!assignment) return null;
  if (assignment.state !== "leased") return assignment.task.lease_expires_at;
  assignment.leaseExpiresAt = Date.now() + LEASE_MS;
  assignment.task.lease_expires_at = new Date(assignment.leaseExpiresAt).toISOString();
  return assignment.task.lease_expires_at;
}

export function mockContext(clipId: string) {
  return getMockContext(clipId);
}

export function mockSubmit(
  assignmentId: string,
  payload: any
) {
  const assignment = assignments.get(assignmentId);
  if (!assignment) {
    throw new Error("LEASE_CONFLICT");
  }
  assignment.state = "submitted";
  const list = responses.get(assignment.task.task_id) || [];
  list.push({ contributorId: assignment.contributorId, payload });
  responses.set(assignment.task.task_id, list);
  const votes = list.map((entry) => ({
    contributor_id: entry.contributorId,
    payload: entry.payload,
    key: JSON.stringify(entry.payload),
    weight: reputation.get(entry.contributorId) ?? 1,
  }));
  const consensus = computeConsensus(votes);
  for (const entry of votes) {
    const aligned = entry.key === consensus.label;
    reputation.set(
      entry.contributor_id,
      updateReputation(reputation.get(entry.contributor_id), aligned)
    );
  }
  return {
    ok: true,
    green_count: consensus.green_count,
    status: "submitted",
    agreement_score: consensus.agreement_score,
    payload,
  };
}

export function mockClaimSingle(contributorId: string) {
  ensureBacklog();
  const task = generateMockTask();
  const assignmentId = randomUUID();
  const assignment: Assignment = {
    id: assignmentId,
    task: {
      ...task,
      assignment_id: assignmentId,
      lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
    },
    contributorId,
    leaseExpiresAt: Date.now() + LEASE_MS,
    state: "leased",
  };
  assignments.set(assignmentId, assignment);
  return assignment.task;
}

export function mockModeActive() {
  return isMobileMockMode();
}
