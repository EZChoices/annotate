#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const IRR = require("../stage2/irr.js");

const recordsPath = path.resolve(__dirname, "..", "stage2", "irr_records.json");
const summaryPath = path.resolve(__dirname, "..", "stage2", "irr_summary.json");

function loadRecords() {
  try {
    if (!fs.existsSync(recordsPath)) {
      return null;
    }
    const raw = fs.readFileSync(recordsPath, "utf8");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("compute_irr: unable to read records", err);
    return null;
  }
}

function main() {
  const records = loadRecords();
  const summary = IRR.computeIRRSummary(records);
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`Wrote IRR summary to ${summaryPath}`);
  } catch (err) {
    console.error("compute_irr: failed to write summary", err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
