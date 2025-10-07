#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

function readJsonl(datasetPath) {
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset not found at ${datasetPath}`);
  }
  const content = fs.readFileSync(datasetPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const records = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`Failed to parse JSON on line ${index + 1}: ${err.message}`);
    }
  });
  return records;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.profiles)) return value.profiles;
    if (Array.isArray(value.speakers)) return value.speakers;
    return Object.values(value);
  }
  return [];
}

function getFirst(obj, keys) {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] != null) {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeCategory(value) {
  if (value == null) return 'unknown';
  const str = String(value).trim();
  if (!str) return 'unknown';
  return str.toLowerCase();
}

function loadProfilesFromFile(record, datasetDir) {
  const files = record && record.files ? record.files : {};
  const profilePathRaw =
    files['speaker_profiles.json'] || files.speaker_profiles || files.speakerProfiles;
  if (!profilePathRaw) {
    return [];
  }
  const resolved = path.resolve(datasetDir, profilePathRaw);
  if (!fs.existsSync(resolved)) {
    return [];
  }
  try {
    const text = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(text);
    return asArray(parsed);
  } catch (err) {
    console.warn(`Warning: failed to read speaker profiles at ${resolved}: ${err.message}`);
    return [];
  }
}

function extractSpeakerProfiles(record, datasetDir) {
  const profiles = [];
  profiles.push(...asArray(record && record.speaker_profiles));
  profiles.push(...asArray(record && record.speakerProfiles));
  profiles.push(...loadProfilesFromFile(record, datasetDir));
  return profiles.filter(Boolean);
}

function computeCoverageSummary(options) {
  if (!options || !options.datasetPath) {
    throw new Error('datasetPath is required');
  }
  const datasetPath = path.resolve(options.datasetPath);
  const datasetDir = options.datasetDir
    ? path.resolve(options.datasetDir)
    : path.dirname(datasetPath);

  const records = readJsonl(datasetPath);
  const combinationCounts = new Map();
  let totalProfiles = 0;

  records.forEach((record) => {
    const profiles = extractSpeakerProfiles(record, datasetDir);
    profiles.forEach((profile) => {
      if (!profile || typeof profile !== 'object') {
        return;
      }
      const dialectFamily = normalizeCategory(
        getFirst(profile, ['dialect_family', 'dialectFamily', 'dialect_family_code'])
      );
      const dialectSubregion = normalizeCategory(
        getFirst(profile, ['dialect_subregion', 'dialectSubregion', 'dialect'])
      );
      const gender = normalizeCategory(
        getFirst(profile, ['apparent_gender', 'gender', 'gender_norm'])
      );
      const ageBand = normalizeCategory(
        getFirst(profile, ['apparent_age_band', 'age_band', 'age'])
      );

      const key = `${dialectFamily}||${dialectSubregion}||${gender}||${ageBand}`;
      combinationCounts.set(key, (combinationCounts.get(key) || 0) + 1);
      totalProfiles += 1;
    });
  });

  const coverage = Array.from(combinationCounts.entries())
    .map(([key, count]) => {
      const [dialectFamily, dialectSubregion, gender, ageBand] = key.split('||');
      return {
        dialect_family: dialectFamily,
        dialect_subregion: dialectSubregion,
        gender,
        age_band: ageBand,
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.dialect_family.localeCompare(b.dialect_family));

  const summary = {
    generated_at: new Date().toISOString(),
    total_profiles: totalProfiles,
    coverage,
  };

  return summary;
}

function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', short: 'd' },
      out: { type: 'string', short: 'o' },
    },
  });

  const datasetPath = values.dataset || values.d || null;
  if (!datasetPath) {
    console.error('Error: --dataset path is required.');
    process.exit(1);
  }

  const outputLocation = path.resolve(
    values.out || values.o || path.join(path.dirname(path.resolve(datasetPath)), 'coverage_summary.json')
  );
  const summary = computeCoverageSummary({
    datasetPath,
  });
  fs.writeFileSync(outputLocation, JSON.stringify(summary, null, 2));
  console.log(`Coverage summary written to ${outputLocation}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { computeCoverageSummary };
