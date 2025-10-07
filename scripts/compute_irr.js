#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const IRR = require("../stage2/irr");

function readJson(filePath){
  try{
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  }catch(err){
    console.warn(`IRR: unable to read records from ${filePath}`, err.message);
    return [];
  }
}

function writeJson(filePath, data){
  try{
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }catch(err){
    console.error(`IRR: failed to write summary to ${filePath}`, err.message);
    process.exitCode = 1;
  }
}

function main(){
  const recordsPath = path.resolve(__dirname, "..", "irr_records.json");
  const outputPath = path.resolve(__dirname, "..", "irr_summary.json");
  const records = readJson(recordsPath);
  const summary = IRR.computeIRRSummary(records);
  writeJson(outputPath, summary);
  console.log(`IRR summary written to ${outputPath}`);
}

if(require.main === module){
  main();
}
