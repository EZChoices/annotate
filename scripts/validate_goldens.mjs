#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/validate_goldens.mjs <file.ndjson>");
  process.exit(1);
}

const text = fs.readFileSync(file, "utf8");
const lines = text.trim().split(/\r?\n/);
let valid = 0;
const errors = [];
for (const [index, line] of lines.entries()) {
  if (!line.trim()) continue;
  try {
    const json = JSON.parse(line);
    if (!json.asset_id || !json.clip || !json.task_type) {
      throw new Error("Missing required fields");
    }
    valid += 1;
  } catch (error) {
    errors.push({ line: index + 1, error: error.message });
  }
}

if (errors.length) {
  console.error("Validation failed:");
  for (const err of errors) {
    console.error(`Line ${err.line}: ${err.error}`);
  }
  process.exit(1);
}

console.log(`Validated ${valid} golden rows successfully.`);
