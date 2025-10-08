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

function normalizeTargetField(value) {
  if (value == null) return '*';
  const str = String(value).trim();
  if (!str) return '*';
  if (str === '*') return '*';
  return str.toLowerCase();
}

function loadCoverageTargets(filePath) {
  const resolved = path.resolve(filePath);
  const fallback = { defaultTarget: 25, rules: [] };
  if (!fs.existsSync(resolved)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    const meta = parsed && typeof parsed === 'object' ? parsed.meta || {} : {};
    const defaultTargetRaw = Number(meta.default_target_per_cell);
    const defaultTarget =
      Number.isFinite(defaultTargetRaw) && defaultTargetRaw > 0 ? defaultTargetRaw : fallback.defaultTarget;

    const targetsArray = Array.isArray(parsed && parsed.targets) ? parsed.targets : [];
    const rules = targetsArray
      .map((rule) => {
        if (!rule || typeof rule !== 'object') {
          return null;
        }
        const targetValue = Number(rule.target);
        if (!Number.isFinite(targetValue) || targetValue <= 0) {
          return null;
        }
        const normalizedRule = {
          dialect_family: normalizeTargetField(rule.dialect_family),
          subregion: normalizeTargetField(rule.subregion),
          apparent_gender: normalizeTargetField(rule.apparent_gender),
          apparent_age_band: normalizeTargetField(rule.apparent_age_band),
          target: targetValue,
        };
        normalizedRule.specificity = ['dialect_family', 'subregion', 'apparent_gender', 'apparent_age_band'].reduce(
          (acc, key) => (normalizedRule[key] !== '*' ? acc + 1 : acc),
          0
        );
        return normalizedRule;
      })
      .filter(Boolean);

    return { defaultTarget, rules };
  } catch (err) {
    throw new Error(`Failed to read coverage targets from ${resolved}: ${err.message}`);
  }
}

function normalizeSnapshotValue(value) {
  if (value == null) return 'unknown';
  const str = String(value).trim();
  if (!str) return 'unknown';
  return str.toLowerCase();
}

function extractCoverageCells(summary) {
  if (!summary || typeof summary !== 'object') return [];

  if (Array.isArray(summary.coverage)) {
    return summary.coverage.map((entry) => ({
      dialect_family: normalizeSnapshotValue(entry && entry.dialect_family),
      subregion: normalizeSnapshotValue(entry && entry.dialect_subregion),
      apparent_gender: normalizeSnapshotValue(entry && entry.gender),
      apparent_age_band: normalizeSnapshotValue(entry && entry.age_band),
      count: Number(entry && entry.count) || 0,
    }));
  }

  const heatmap = summary.coverage_heatmap;
  if (!heatmap || typeof heatmap !== 'object') {
    return [];
  }

  const cells = [];
  Object.entries(heatmap).forEach(([dialectFamily, subregions]) => {
    if (!subregions || typeof subregions !== 'object') return;
    Object.entries(subregions).forEach(([subregion, genders]) => {
      if (!genders || typeof genders !== 'object') return;
      Object.entries(genders).forEach(([gender, ageBands]) => {
        if (!ageBands || typeof ageBands !== 'object') return;
        Object.entries(ageBands).forEach(([ageBand, count]) => {
          cells.push({
            dialect_family: normalizeSnapshotValue(dialectFamily),
            subregion: normalizeSnapshotValue(subregion),
            apparent_gender: normalizeSnapshotValue(gender),
            apparent_age_band: normalizeSnapshotValue(ageBand),
            count: Number(count) || 0,
          });
        });
      });
    });
  });
  return cells;
}

function resolveCellTarget(cell, targetsConfig) {
  const config = targetsConfig || {};
  const defaultTarget = Number(config.defaultTarget) > 0 ? Number(config.defaultTarget) : 25;
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const normalizedCell = {
    dialect_family: normalizeSnapshotValue(cell && cell.dialect_family),
    subregion: normalizeSnapshotValue(cell && cell.subregion),
    apparent_gender: normalizeSnapshotValue(cell && cell.apparent_gender),
    apparent_age_band: normalizeSnapshotValue(cell && cell.apparent_age_band),
  };

  let bestRule = null;
  rules.forEach((rule) => {
    if (!rule || typeof rule !== 'object') return;
    const targetValue = Number(rule.target);
    if (!Number.isFinite(targetValue) || targetValue <= 0) {
      return;
    }
    const matches = ['dialect_family', 'subregion', 'apparent_gender', 'apparent_age_band'].every((key) => {
      if (rule[key] === '*') return true;
      return normalizedCell[key] === rule[key];
    });
    if (!matches) return;
    if (!bestRule || (rule.specificity || 0) > (bestRule.specificity || 0)) {
      bestRule = rule;
    }
  });

  if (bestRule) {
    return Number(bestRule.target);
  }
  return defaultTarget;
}

function buildCoverageSnapshot(summary, targetsConfig) {
  const cellsSource = extractCoverageCells(summary);
  const targets = targetsConfig || { defaultTarget: 25, rules: [] };

  const cells = cellsSource.map((cell) => {
    const targetValue = resolveCellTarget(cell, targets);
    const count = Number(cell.count) >= 0 ? Number(cell.count) : 0;
    const effectiveTarget = Number.isFinite(targetValue) && targetValue > 0 ? targetValue : targets.defaultTarget || 25;
    const ratio = effectiveTarget > 0 ? count / effectiveTarget : 0;
    const pctOfTarget = Math.min(1, Math.max(0, ratio));
    const deficit = effectiveTarget > 0 ? Math.max(0, effectiveTarget - count) : 0;

    return {
      dialect_family: normalizeSnapshotValue(cell.dialect_family),
      subregion: normalizeSnapshotValue(cell.subregion),
      apparent_gender: normalizeSnapshotValue(cell.apparent_gender),
      apparent_age_band: normalizeSnapshotValue(cell.apparent_age_band),
      count,
      target: Number(effectiveTarget.toFixed(4)),
      pct_of_target: Number(pctOfTarget.toFixed(4)),
      deficit: Number(deficit.toFixed(4)),
    };
  });

  const completeness =
    cells.length > 0
      ? Number(
          (
            cells.reduce((acc, cell) => acc + (Number(cell.pct_of_target) || 0), 0) /
            cells.length
          ).toFixed(4)
        )
      : 0;

  const lowestCells = cells
    .filter((cell) => Number(cell.deficit) > 0)
    .sort((a, b) => b.deficit - a.deficit || (a.pct_of_target || 0) - (b.pct_of_target || 0))
    .slice(0, 10)
    .map((cell) => ({ ...cell }));

  return {
    generated_at: new Date().toISOString(),
    default_target_per_cell: Number(targets.defaultTarget) || 25,
    cells,
    coverage_completeness: completeness,
    lowest_cells: lowestCells,
  };
}

function resolveCoverageTargetsPath(explicitPath, datasetPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const datasetDir = datasetPath ? path.dirname(path.resolve(datasetPath)) : process.cwd();
  const candidates = [
    path.join(datasetDir, 'coverage_targets.json'),
    path.resolve(__dirname, '..', 'coverage_targets.json'),
    path.resolve(process.cwd(), 'coverage_targets.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
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
  const totalsByDialectFamily = {};
  const totalsBySubregion = {};
  const totalsByGender = {};
  const totalsByAgeBand = {};
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
      totalsByDialectFamily[dialectFamily] = (totalsByDialectFamily[dialectFamily] || 0) + 1;
      totalsBySubregion[dialectSubregion] = (totalsBySubregion[dialectSubregion] || 0) + 1;
      totalsByGender[gender] = (totalsByGender[gender] || 0) + 1;
      totalsByAgeBand[ageBand] = (totalsByAgeBand[ageBand] || 0) + 1;
      totalProfiles += 1;
    });
  });

  const coverageHeatmap = {};
  const coverageProportions = {};

  const ensureNested = (target, key) => {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = {};
    }
    return target[key];
  };

  const coverage = Array.from(combinationCounts.entries())
    .map(([key, count]) => {
      const [dialectFamily, dialectSubregion, gender, ageBand] = key.split('||');
      const percent = totalProfiles > 0 ? (count / totalProfiles) * 100 : 0;

      const dfCounts = ensureNested(coverageHeatmap, dialectFamily);
      const srCounts = ensureNested(dfCounts, dialectSubregion);
      const genderCounts = ensureNested(srCounts, gender);
      genderCounts[ageBand] = count;

      const dfProportions = ensureNested(coverageProportions, dialectFamily);
      const srProportions = ensureNested(dfProportions, dialectSubregion);
      const genderProportions = ensureNested(srProportions, gender);
      genderProportions[ageBand] = Number(percent.toFixed(4));

      return {
        dialect_family: dialectFamily,
        dialect_subregion: dialectSubregion,
        gender,
        age_band: ageBand,
        count,
      };
    })
    .sort((a, b) => b.count - a.count || a.dialect_family.localeCompare(b.dialect_family));

  const sortObject = (obj) =>
    Object.keys(obj)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
      }, {});

  const totalsCounts = {
    dialect_family: sortObject(totalsByDialectFamily),
    dialect_subregion: sortObject(totalsBySubregion),
    gender: sortObject(totalsByGender),
    age_band: sortObject(totalsByAgeBand),
  };

  const totalsProportions = Object.entries(totalsCounts).reduce((acc, [dimension, counts]) => {
    acc[dimension] = Object.entries(counts).reduce((dimensionAcc, [category, count]) => {
      const percent = totalProfiles > 0 ? (count / totalProfiles) * 100 : 0;
      dimensionAcc[category] = Number(percent.toFixed(4));
      return dimensionAcc;
    }, {});
    return acc;
  }, {});

  const summary = {
    generated_at: new Date().toISOString(),
    total_profiles: totalProfiles,
    coverage,
    coverage_heatmap: coverageHeatmap,
    coverage_proportions: coverageProportions,
    coverage_totals: {
      counts: totalsCounts,
      proportions: totalsProportions,
    },
  };

  return summary;
}

function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', short: 'd' },
      out: { type: 'string', short: 'o' },
      targets: { type: 'string', short: 't' },
      snapshot: { type: 'string', short: 's' },
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

  const targetsPath = resolveCoverageTargetsPath(values.targets || values.t, datasetPath);
  const snapshotLocation = path.resolve(
    values.snapshot || values.s || path.join(path.dirname(outputLocation), 'coverage_snapshot.json')
  );

  try {
    const summaryForSnapshot = JSON.parse(fs.readFileSync(outputLocation, 'utf-8'));
    const targetsConfig = loadCoverageTargets(targetsPath);
    const snapshot = buildCoverageSnapshot(summaryForSnapshot, targetsConfig);
    fs.writeFileSync(snapshotLocation, JSON.stringify(snapshot, null, 2));
    console.log(`Coverage snapshot written to ${snapshotLocation}`);
  } catch (err) {
    console.warn(`Warning: failed to compute coverage snapshot: ${err.message}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { computeCoverageSummary, buildCoverageSnapshot };
