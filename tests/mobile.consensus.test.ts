import test from "node:test";
import assert from "node:assert/strict";

import {
  computeConsensus,
  updateReputation,
  type Vote,
} from "../lib/mobile/consensus.ts";

test("computeConsensus returns unknown for empty votes", () => {
  const result = computeConsensus([]);
  assert.equal(result.label, "unknown");
  assert.equal(result.green_count, 0);
  assert.equal(result.agreement_score, 0);
});

test("computeConsensus respects weighted winner", () => {
  const votes: Vote[] = [
    { contributor_id: "a", payload: {}, key: "A", weight: 1 },
    { contributor_id: "b", payload: {}, key: "B", weight: 3 },
    { contributor_id: "c", payload: {}, key: "A", weight: 1 },
  ];
  const result = computeConsensus(votes);
  assert.equal(result.label, "B");
  assert.equal(result.green_count, 3);
  assert.equal(result.agreement_score, Number((3 / 5).toFixed(3)));
});

test("computeConsensus prioritises preferred key on ties", () => {
  const votes: Vote[] = [
    { contributor_id: "a", payload: {}, key: "A", weight: 2 },
    { contributor_id: "b", payload: {}, key: "B", weight: 2 },
  ];
  const result = computeConsensus(votes, "A");
  assert.equal(result.label, "A");
});

test("updateReputation clamps between 0.5 and 1.5", () => {
  assert.equal(updateReputation(null, true) <= 1.5, true);
  assert.equal(updateReputation(null, false) >= 0.5, true);
});

test("updateReputation adjusts EWMA based on alignment", () => {
  const aligned = updateReputation(0.8, true);
  const misaligned = updateReputation(0.8, false);
  assert(aligned > misaligned);
  assert.equal(aligned, Number((0.6 * 0.8 + 0.4 * 1).toFixed(10)));
});
