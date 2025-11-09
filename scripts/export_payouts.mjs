#!/usr/bin/env node
import fs from "node:fs";

const from = process.env.FROM || process.argv[2] || "2025-01-01";
const to = process.env.TO || process.argv[3] || "2025-01-07";
const dryRun = process.argv.includes("--dry-run");

const rows = Array.from({ length: 5 }).map((_, idx) => ({
  contributor_id: `mock-user-${idx}`,
  tasks: 25 + idx * 3,
  amount_cents: 800 + idx * 50,
  period_start: from,
  period_end: to,
}));

const csv = [
  "contributor_id,tasks,amount_cents,period_start,period_end",
  ...rows.map(
    (row) =>
      `${row.contributor_id},${row.tasks},${row.amount_cents},${row.period_start},${row.period_end}`
  ),
].join("\n");

if (dryRun) {
  console.log(csv);
  process.exit(0);
}

const dir = "tmp/payouts";
fs.mkdirSync(dir, { recursive: true });
const file = `${dir}/payouts-${from}-${to}.csv`;
fs.writeFileSync(file, csv);
console.log(`Exported payouts to ${file}`);
