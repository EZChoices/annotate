import { randomUUID } from "crypto";
import {
  generateMockBundle,
  generateMockTask,
  getMockContext,
  isMobileMockMode,
} from "./mockData";
import type {
  MobileBundleResponse,
  MobileClaimResponse,
} from "./types";

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

interface Bundle {
  id: string;
  contributorId: string;
  state: "active" | "expired" | "closed";
  createdAt: number;
  ttlMs: number;
  assignmentIds: string[];
}

const BACKLOG_FACTOR = 80;
const DEFAULT_TTL_MS = 45 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;

const backlog = new Map<string, MobileClaimResponse[]>();
const assignments = new Map<string, Assignment>();
const bundles = new Map<string, Bundle>();

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

function expireBundles(now = Date.now()) {
  for (const bundle of bundles.values()) {
    if (bundle.state !== "active") continue;
    if (bundle.createdAt + bundle.ttlMs < now) {
      bundle.state = "expired";
      for (const assignmentId of bundle.assignmentIds) {
        const assignment = assignments.get(assignmentId);
        if (assignment && assignment.state === "leased") {
          assignment.state = "released";
          recycleAssignment(assignment);
        }
      }
    }
  }
}

export function mockClaimBundle(
  contributorId: string,
  count: number
): MobileBundleResponse {
  ensureBacklog();
  expireBundles();
  const existing = Array.from(bundles.values()).find(
    (bundle) =>
      bundle.contributorId === contributorId && bundle.state === "active"
  );
  if (existing) {
    throw new Error("BUNDLE_ACTIVE");
  }
  const bundleId = `mock-bundle-${randomUUID()}`;
  const bundle: Bundle = {
    id: bundleId,
    contributorId,
    state: "active",
    createdAt: Date.now(),
    ttlMs: DEFAULT_TTL_MS,
    assignmentIds: [],
  };
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
  return {
    ok: true,
    green_count: 3,
    status: "submitted",
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
