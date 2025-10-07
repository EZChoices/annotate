#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const IRR = require("../stage2/irr.js");

const recordsPath = path.resolve(__dirname, "..", "stage2", "irr_records.json");
const summaryPath = path.resolve(__dirname, "..", "stage2", "irr_summary.json");

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`IRR: records file not found at ${filePath}`);
      return [];
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw) {
      console.warn(`IRR: records file is empty at ${filePath}`);
      return [];
    }
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`IRR: unable to read or parse records from ${filePath}`, err.message);
    return [];
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`IRR summary written to ${filePath}`);
  } catch (err) {
    console.error(`IRR: failed to write summary to ${filePath}`, err.message);
    process.exitCode = 1;
  }
}

function main() {
  const records = readJson(recordsPath);
  const summary = IRR.computeIRRSummary(records);
  writeJson(summaryPath, summary);
}

if (require.main === module) {
  main();
}
