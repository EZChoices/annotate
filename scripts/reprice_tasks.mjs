#!/usr/bin/env node
const dryRun = process.argv.includes("--dry-run");
const backlog = {
  translation_check: 320,
  accent_tag: 120,
  emotion_tag: 50,
};

function surge(count) {
  return Math.min(1.5, 1 + count / 500);
}

const result = Object.fromEntries(
  Object.entries(backlog).map(([type, count]) => [type, surge(count)])
);

if (dryRun) {
  console.log("Surge preview:", JSON.stringify(result, null, 2));
} else {
  console.log("Applying surge multipliers (mock):", result);
}
