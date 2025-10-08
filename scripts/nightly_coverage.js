#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { buildCoverageSnapshot } = require('./compute_coverage');

const DATA_DIR = path.resolve(__dirname, '..', 'stage2', 'data');
const SUMMARY_PATH = path.join(DATA_DIR, 'coverage_summary.json');
const TARGETS_PATH = path.join(DATA_DIR, 'coverage_targets.json');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'coverage_snapshot.json');
const PREV_SNAPSHOT_PATH = path.join(DATA_DIR, 'coverage_snapshot.prev.json');
const STATE_PATH = path.join(DATA_DIR, 'nightly_coverage_state.json');
const ALERTS_LOG_PATH = path.join(DATA_DIR, 'alerts.log');
const ALERTS_JSON_PATH = path.join(DATA_DIR, 'alerts.json');

const FALLBACK_TARGETS = path.resolve(__dirname, '..', 'coverage_targets.json');
const MAX_ALERT_LOG_LINES = 1000;
const ALERT_FEED_SIZE = 50;
const LOW_COVERAGE_THRESHOLD = 0.25;
const ALERT_MIN_STALE_HOURS = 48;
const ALERT_REPEAT_HOURS = 24;

function formatUtcTimestamp(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString();
  }
  const iso = d.toISOString();
  return `${iso.slice(0, 16)}Z`;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read JSON from ${filePath}: ${err.message}`);
  }
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(filePath, text, 'utf-8');
}

function normalizeCategory(value) {
  if (value == null) return 'unknown';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  const str = String(value).trim().toLowerCase();
  return str || 'unknown';
}

function buildCellKey(cell) {
  if (!cell || typeof cell !== 'object') {
    return 'unknown:unknown:unknown:unknown';
  }
  const parts = [
    normalizeCategory(cell.dialect_family ?? cell.dialectFamily ?? cell.dialect_family_code),
    normalizeCategory(cell.subregion ?? cell.dialect_subregion ?? cell.subregion_code),
    normalizeCategory(cell.apparent_gender ?? cell.gender ?? cell.apparentGender),
    normalizeCategory(cell.apparent_age_band ?? cell.age_band ?? cell.apparentAgeBand),
  ];
  return parts.join(':');
}

function mapSnapshotCells(snapshot) {
  const map = new Map();
  if (!snapshot || !Array.isArray(snapshot.cells)) {
    return map;
  }
  snapshot.cells.forEach((cell) => {
    const key = buildCellKey(cell);
    map.set(key, cell);
  });
  return map;
}

async function loadState() {
  const raw = await readJson(STATE_PATH);
  if (!raw || typeof raw !== 'object') {
    return {
      lastSummaryMtimeMs: 0,
      lastRunAt: null,
      cells: {},
    };
  }
  const cells = raw.cells && typeof raw.cells === 'object' ? raw.cells : {};
  return {
    lastSummaryMtimeMs: Number(raw.lastSummaryMtimeMs) || 0,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
    cells,
  };
}

function cloneState(state) {
  return {
    lastSummaryMtimeMs: state.lastSummaryMtimeMs,
    lastRunAt: state.lastRunAt,
    cells: Object.fromEntries(Object.entries(state.cells || {}).map(([key, value]) => [key, { ...value }])),
  };
}

async function updateAlertsArtifacts({ appendedEntries = [], feedTimestamp }) {
  let existingLines = [];
  try {
    const currentLog = await fsp.readFile(ALERTS_LOG_PATH, 'utf-8');
    existingLines = currentLog.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Failed to read alerts log: ${err.message}`);
    }
  }

  const newLines = [...existingLines, ...appendedEntries.map((entry) => JSON.stringify(entry))];
  while (newLines.length > MAX_ALERT_LOG_LINES) {
    newLines.shift();
  }

  if (newLines.length > 0) {
    await fsp.writeFile(ALERTS_LOG_PATH, `${newLines.join('\n')}\n`, 'utf-8');
  } else {
    await fsp.writeFile(ALERTS_LOG_PATH, '', 'utf-8');
  }

  const alertsOnly = [];
  newLines.forEach((line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'alert') {
        alertsOnly.push({
          timestamp: parsed.timestamp,
          cell: parsed.cell,
          pct_of_target: parsed.pct_of_target,
          deficit: parsed.deficit,
          stale_hours: parsed.stale_hours,
        });
      }
    } catch (err) {
      // Ignore malformed log lines but retain them in the log for auditability.
    }
  });

  const feed = {
    generated_at: feedTimestamp || formatUtcTimestamp(),
    alerts: alertsOnly.slice(-ALERT_FEED_SIZE),
  };
  await writeJson(ALERTS_JSON_PATH, feed);
}

async function detectNoChange(summaryStat, state) {
  if (!summaryStat) return false;
  if (!state || !state.lastSummaryMtimeMs) return false;
  return summaryStat.mtimeMs <= state.lastSummaryMtimeMs;
}

async function rotateSnapshots() {
  try {
    await fsp.unlink(PREV_SNAPSHOT_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fsp.rename(SNAPSHOT_PATH, PREV_SNAPSHOT_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function main() {
  await ensureDir(DATA_DIR);

  const summaryStat = await fsp.stat(SUMMARY_PATH).catch(() => null);
  if (!summaryStat) {
    throw new Error(`Coverage summary not found at ${SUMMARY_PATH}`);
  }

  const targetsPath = (await fsp.stat(TARGETS_PATH).catch(() => null)) ? TARGETS_PATH : FALLBACK_TARGETS;
  const targetsStat = await fsp.stat(targetsPath).catch(() => null);
  if (!targetsStat) {
    throw new Error(`Coverage targets not found at ${TARGETS_PATH} or fallback ${FALLBACK_TARGETS}`);
  }

  const state = await loadState();

  if (await detectNoChange(summaryStat, state)) {
    const timestamp = formatUtcTimestamp();
    const entry = {
      type: 'no_change',
      timestamp,
      message: 'No new QA coverage updates detected; snapshot generation skipped.',
    };
    await updateAlertsArtifacts({ appendedEntries: [entry], feedTimestamp: timestamp });
    const nextState = cloneState(state);
    nextState.lastRunAt = timestamp;
    await writeJson(STATE_PATH, nextState);
    console.log('[nightly_coverage] No changes detected; skipped snapshot refresh.');
    return;
  }

  const summary = await readJson(SUMMARY_PATH);
  if (!summary) {
    throw new Error(`Coverage summary at ${SUMMARY_PATH} is empty or invalid.`);
  }
  const targets = await readJson(targetsPath);
  if (!targets) {
    throw new Error(`Coverage targets at ${targetsPath} are empty or invalid.`);
  }

  const snapshot = buildCoverageSnapshot(summary, targets);
  const generatedAt = formatUtcTimestamp(new Date());
  snapshot.generated_at = generatedAt;

  const previousSnapshot = await readJson(SNAPSHOT_PATH);
  if (previousSnapshot && typeof previousSnapshot === 'object' && previousSnapshot.generated_at) {
    previousSnapshot.generated_at = previousSnapshot.generated_at;
  }

  await rotateSnapshots();
  await writeJson(SNAPSHOT_PATH, snapshot);

  const prevCells = mapSnapshotCells(previousSnapshot);
  const now = new Date(generatedAt);
  const stateCells = state.cells || {};
  const newStateCells = {};
  const appendedEntries = [];

  snapshot.cells.forEach((cell) => {
    const key = buildCellKey(cell);
    const pct = Number(cell && cell.pct_of_target);
    const deficit = Number(cell && cell.deficit);
    const prevCell = prevCells.get(key);
    const prevPct = Number(prevCell && prevCell.pct_of_target);
    const wasLowBefore = Number.isFinite(prevPct) && prevPct < LOW_COVERAGE_THRESHOLD;
    const previousState = stateCells[key] || {};

    let belowSince = previousState.belowSince;
    if (pct < LOW_COVERAGE_THRESHOLD) {
      if (!belowSince) {
        if (wasLowBefore && previousSnapshot && previousSnapshot.generated_at) {
          belowSince = previousState.belowSince || previousSnapshot.generated_at;
        } else {
          belowSince = generatedAt;
        }
      }
    } else {
      belowSince = null;
    }

    let lastAlertedAt = previousState.lastAlertedAt || null;

    if (pct < LOW_COVERAGE_THRESHOLD && wasLowBefore && belowSince) {
      const belowDate = new Date(belowSince);
      if (!Number.isNaN(belowDate.getTime())) {
        const staleHours = (now.getTime() - belowDate.getTime()) / 3_600_000;
        const lastAlertDate = lastAlertedAt ? new Date(lastAlertedAt) : null;
        const hoursSinceAlert =
          lastAlertDate && !Number.isNaN(lastAlertDate.getTime())
            ? (now.getTime() - lastAlertDate.getTime()) / 3_600_000
            : Infinity;
        if (staleHours >= ALERT_MIN_STALE_HOURS && hoursSinceAlert >= ALERT_REPEAT_HOURS) {
          appendedEntries.push({
            type: 'alert',
            timestamp: generatedAt,
            cell: key,
            pct_of_target: Number.isFinite(pct) ? Number(pct.toFixed(4)) : 0,
            deficit: Number.isFinite(deficit) ? Number(deficit.toFixed(4)) : 0,
            stale_hours: Number(staleHours.toFixed(1)),
          });
          lastAlertedAt = generatedAt;
        }
      }
    }

    newStateCells[key] = {
      belowSince,
      lastSeen: generatedAt,
      lastPct: Number.isFinite(pct) ? Number(pct.toFixed(4)) : null,
      lastDeficit: Number.isFinite(deficit) ? Number(deficit.toFixed(4)) : null,
      lastAlertedAt,
    };
  });

  const nextState = {
    lastSummaryMtimeMs: summaryStat.mtimeMs,
    lastRunAt: generatedAt,
    cells: newStateCells,
  };

  await writeJson(STATE_PATH, nextState);
  await updateAlertsArtifacts({ appendedEntries, feedTimestamp: generatedAt });

  console.log('[nightly_coverage] Coverage snapshot refreshed.');
  if (appendedEntries.length) {
    const alertCount = appendedEntries.filter((entry) => entry.type === 'alert').length;
    if (alertCount) {
      console.log(`[nightly_coverage] ${alertCount} persistent low-coverage alert(s) recorded.`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[nightly_coverage] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  formatUtcTimestamp,
  buildCellKey,
};
