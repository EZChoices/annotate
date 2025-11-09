#!/usr/bin/env node
import fs from "node:fs";

const args = new URLSearchParams(process.argv.slice(2).join("&"));
const taskType = args.get("--task_type") || "accent_tag";
const limit = Number(args.get("--limit") || "100");
const dryRun = process.argv.includes("--dry-run");

console.log(
  `Precomputing hints for ${taskType} (limit ${limit})${dryRun ? " [dry-run]" : ""}`
);

const hints = Array.from({ length: limit }).map((_, idx) => ({
  task_id: `mock-hint-${idx}`,
  suggestion: `Synthetic hint for ${taskType} #${idx}`,
}));

if (dryRun) {
  console.log(JSON.stringify({ projected: hints.length, cost_usd: 0 }, null, 2));
  process.exit(0);
}

const out = `tmp/hints-${taskType}-${Date.now()}.json`;
fs.mkdirSync("tmp", { recursive: true });
fs.writeFileSync(out, JSON.stringify(hints, null, 2));
console.log(`Wrote ${hints.length} hints to ${out}`);
