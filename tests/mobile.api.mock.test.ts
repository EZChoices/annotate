import test from "node:test";
import assert from "node:assert/strict";

import {
  mockClaimBundle,
  mockReleaseAssignment,
  mockHeartbeat,
  mockSubmit,
} from "../lib/mobile/mockRepo.ts";
import {
  consumeRateLimit,
  resetRateLimitBuckets,
} from "../lib/mobile/rateLimit.ts";

const contributorId = "tester";

test("mock bundle enforces single active bundle", () => {
  const bundle = mockClaimBundle(`${contributorId}-bundle`, 2);
  assert.equal(bundle.tasks.length, 2);
  assert.throws(
    () => mockClaimBundle(`${contributorId}-bundle`, 1),
    /BUNDLE_ACTIVE/,
    "second active bundle should throw"
  );
  const assignmentId = bundle.tasks[0].assignment_id;
  mockReleaseAssignment(assignmentId);
});

test("mock heartbeat extends lease timestamp", () => {
  const bundle = mockClaimBundle("heartbeat-user", 1);
  const task = bundle.tasks[0];
  const nextLease = mockHeartbeat(task.assignment_id);
  assert.equal(typeof nextLease, "string");
});

test("mock submit accumulates consensus", () => {
  const bundle = mockClaimBundle("submit-user", 1);
  const task = bundle.tasks[0];
  const first = mockSubmit(task.assignment_id, { approved: true });
  assert.equal(first.green_count >= 1, true);
  const second = mockSubmit(task.assignment_id, { approved: true });
  assert.equal(second.green_count >= first.green_count, true);
});

test("rate limiter buckets reset between tests", () => {
  resetRateLimitBuckets();
  const first = consumeRateLimit("rl-user", "submit/min", 2, 60_000);
  const second = consumeRateLimit("rl-user", "submit/min", 2, 60_000);
  const third = consumeRateLimit("rl-user", "submit/min", 2, 60_000);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, false);
});
