#!/usr/bin/env node

const fsp = require('fs/promises');
const path = require('path');

const STAGE2_OUTPUT_DIR = path.resolve(__dirname, '..', 'data', 'stage2_output');
const IRR_DIR = path.resolve(__dirname, '..', 'data', 'irr');
const IRR_JSON_PATH = path.join(IRR_DIR, 'irr.json');
const IRR_TREND_PATH = path.join(IRR_DIR, 'irr_trend.json');
const IRR_LOG_DIR = path.join(IRR_DIR, 'logs');

const TARGET_LABEL = 'hasCS';
const REQUIRED_PASSES = new Set([1, 2]);
const MIN_CELL_ITEMS = 10;

function formatIsoDate(date = new Date()) {
  return new Date(date).toISOString();
}

function formatDateYMD(date = new Date()) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to read JSON from ${filePath}: ${err.message}`);
  }
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(filePath, text, 'utf8');
}

function normalizeCategory(value, fallback = 'unknown') {
  if (value == null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const str = String(value).trim();
  if (!str) return fallback;
  return str.toLowerCase();
}

function getFirstDefined(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      return obj[key];
    }
  }
  return null;
}

function inferCellKey(itemMeta) {
  if (!itemMeta || typeof itemMeta !== 'object') {
    return 'unknown:unknown:*:*';
  }

  const candidateCells = [];
  if (itemMeta.assigned_cell && typeof itemMeta.assigned_cell === 'object') {
    candidateCells.push(itemMeta.assigned_cell);
  }
  if (itemMeta.assignment && typeof itemMeta.assignment === 'object') {
    if (itemMeta.assignment.cell && typeof itemMeta.assignment.cell === 'object') {
      candidateCells.push(itemMeta.assignment.cell);
    }
    if (Array.isArray(itemMeta.assignment.cells)) {
      candidateCells.push(...itemMeta.assignment.cells.filter((cell) => cell && typeof cell === 'object'));
    }
  }
  if (itemMeta.cell && typeof itemMeta.cell === 'object') {
    candidateCells.push(itemMeta.cell);
  }
  if (Array.isArray(itemMeta.cells)) {
    candidateCells.push(...itemMeta.cells.filter((cell) => cell && typeof cell === 'object'));
  }

  const cellObj = candidateCells.find((cell) => cell && typeof cell === 'object') || itemMeta;

  const dialectFamily = normalizeCategory(
    getFirstDefined(cellObj, [
      'dialect_family',
      'dialectFamily',
      'dialect_family_code',
      'dialect_family_label',
      'dialect',
    ])
  );

  const subregion = normalizeCategory(
    getFirstDefined(cellObj, [
      'subregion',
      'dialect_subregion',
      'dialectSubregion',
      'dialect_region',
      'sub_dialect',
    ])
  );

  return `${dialectFamily}:${subregion}:*:*`;
}

function parsePassNumber(segment) {
  if (!segment) return null;
  const match = String(segment).toLowerCase().match(/pass[_-]?(\d+)/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

function inferAnnotatorFromSegments(segments, passIndex) {
  const isValid = (seg) =>
    seg &&
    typeof seg === 'string' &&
    !/^pass[_-]?\d+$/i.test(seg) &&
    seg.toLowerCase() !== 'merged' &&
    seg.toLowerCase() !== 'aggregate';

  const before = passIndex > 0 ? segments[passIndex - 1] : null;
  if (isValid(before)) return before;

  const after = passIndex + 1 < segments.length ? segments[passIndex + 1] : null;
  if (isValid(after)) return after;

  for (const seg of segments) {
    if (isValid(seg)) return seg;
  }
  return 'unknown';
}

async function collectPassAnnotations(assetDir) {
  const results = new Map();

  let entries;
  try {
    entries = await fsp.readdir(assetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { passes: results };
    throw err;
  }

  const stack = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ rel: entry.name, abs: path.join(assetDir, entry.name) }));

  while (stack.length > 0) {
    const current = stack.pop();
    let dirEntries;
    try {
      dirEntries = await fsp.readdir(current.abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    for (const dirent of dirEntries) {
      const relPath = path.join(current.rel, dirent.name);
      const absPath = path.join(assetDir, relPath);
      if (dirent.isDirectory()) {
        stack.push({ rel: relPath, abs: absPath });
        continue;
      }
      if (!dirent.isFile()) continue;
      if (dirent.name !== 'code_switch_spans.json') continue;

      const segments = relPath.split(path.sep);
      const passIndex = segments.findIndex((segment) => parsePassNumber(segment) != null);
      const passNumber = passIndex >= 0 ? parsePassNumber(segments[passIndex]) : null;
      if (passNumber == null || !REQUIRED_PASSES.has(passNumber)) {
        continue;
      }

      const annotatorId = inferAnnotatorFromSegments(segments, passIndex);
      let spansJson;
      try {
        spansJson = await readJson(absPath);
      } catch (err) {
        console.warn(`Failed to read ${absPath}: ${err.message}`);
        continue;
      }
      if (!spansJson || typeof spansJson !== 'object') {
        continue;
      }
      const spans = Array.isArray(spansJson.spans) ? spansJson.spans : [];
      const vote = spans.length > 0 ? 1 : 0;

      const existing = results.get(passNumber);
      if (existing) {
        // Prefer the latest file modification time if duplicates exist.
        try {
          const stat = await fsp.stat(absPath);
          const existingStat = existing.stat;
          if (!existingStat || (stat && stat.mtimeMs >= existingStat.mtimeMs)) {
            results.set(passNumber, { vote, annotatorId, path: absPath, stat });
          }
        } catch {
          // Fallback to overwrite with latest encountered file.
          results.set(passNumber, { vote, annotatorId });
        }
      } else {
        let stat = null;
        try {
          stat = await fsp.stat(absPath);
        } catch {
          stat = null;
        }
        results.set(passNumber, { vote, annotatorId, path: absPath, stat });
      }
    }
  }

  return { passes: results };
}

function computeNominalKrippendorffAlpha(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  let totalPairs = 0;
  let disagreementSum = 0;
  let totalRatings = 0;
  const categoryCounts = new Map();

  for (const ratings of items) {
    if (!Array.isArray(ratings)) continue;
    const filtered = ratings
      .map((value) => {
        if (value == null) return null;
        const num = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(num) ? num : null;
      })
      .filter((value) => value != null);
    if (filtered.length < 2) continue;

    totalRatings += filtered.length;
    totalPairs += (filtered.length * (filtered.length - 1)) / 2;

    for (const value of filtered) {
      const key = String(value);
      categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
    }

    for (let i = 0; i < filtered.length; i += 1) {
      for (let j = i + 1; j < filtered.length; j += 1) {
        if (filtered[i] !== filtered[j]) {
          disagreementSum += 1;
        }
      }
    }
  }

  if (totalPairs === 0) {
    return null;
  }

  const Do = disagreementSum / totalPairs;

  if (totalRatings <= 1) {
    return null;
  }

  const denom = totalRatings * (totalRatings - 1);
  if (denom === 0) {
    return null;
  }

  let deNumerator = 0;
  for (const count of categoryCounts.values()) {
    deNumerator += count * (totalRatings - count);
  }
  const De = deNumerator / denom;

  if (!Number.isFinite(De) || De === 0) {
    return Do === 0 ? 1 : 0;
  }

  const alpha = 1 - Do / De;
  return Number.isFinite(alpha) ? alpha : null;
}

async function loadAssets() {
  let assetEntries;
  try {
    assetEntries = await fsp.readdir(STAGE2_OUTPUT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw new Error(`Failed to read assets from ${STAGE2_OUTPUT_DIR}: ${err.message}`);
  }

  const assets = [];

  for (const entry of assetEntries) {
    if (!entry.isDirectory()) continue;
    const assetId = entry.name;
    const assetDir = path.join(STAGE2_OUTPUT_DIR, assetId);

    const { passes } = await collectPassAnnotations(assetDir);
    const pass1 = passes.get(1);
    const pass2 = passes.get(2);

    if (!pass1 || !pass2) {
      continue;
    }

    const votes = [pass1.vote, pass2.vote];
    const annotatorSet = new Set();
    if (pass1.annotatorId && pass1.annotatorId !== 'unknown') {
      annotatorSet.add(pass1.annotatorId);
    }
    if (pass2.annotatorId && pass2.annotatorId !== 'unknown') {
      annotatorSet.add(pass2.annotatorId);
    }

    if (annotatorSet.size < 2) {
      continue;
    }

    let itemMeta = null;
    try {
      itemMeta = await readJson(path.join(assetDir, 'item_meta.json'));
    } catch (err) {
      console.warn(`Failed to read item_meta.json for asset ${assetId}: ${err.message}`);
    }

    const cell = inferCellKey(itemMeta);
    assets.push({ assetId, cell, votes });
  }

  return assets;
}

function buildSummary(assets) {
  const items = assets.map((asset) => asset.votes);
  const alphaGlobal = computeNominalKrippendorffAlpha(items);

  const grouped = new Map();
  assets.forEach((asset) => {
    if (!grouped.has(asset.cell)) {
      grouped.set(asset.cell, []);
    }
    grouped.get(asset.cell).push(asset.votes);
  });

  const byCell = [];
  for (const [cell, votesList] of grouped.entries()) {
    const nItems = votesList.length;
    const alpha = nItems >= MIN_CELL_ITEMS ? computeNominalKrippendorffAlpha(votesList) : null;
    byCell.push({ cell, alpha, n_items: nItems });
  }

  byCell.sort((a, b) => a.cell.localeCompare(b.cell));

  return {
    alphaGlobal,
    nItemsGlobal: assets.length,
    byCell,
  };
}

async function updateTrend({ alphaGlobal, nItemsGlobal, byCell }) {
  let trend = [];
  try {
    const existing = await readJson(IRR_TREND_PATH);
    if (Array.isArray(existing)) {
      trend = existing;
    }
  } catch (err) {
    console.warn(`Failed to read existing trend data: ${err.message}`);
  }

  const today = formatDateYMD();
  const filtered = trend.filter((entry) => entry && entry.date !== today);

  filtered.push({
    date: today,
    alpha_global: alphaGlobal,
    n_items_global: nItemsGlobal,
    by_cell: byCell.map((entry) => ({
      cell: entry.cell,
      alpha: entry.alpha,
      n_items: entry.n_items,
    })),
  });

  while (filtered.length > 30) {
    filtered.shift();
  }

  await writeJson(IRR_TREND_PATH, filtered);
}

async function writeLog({ alphaGlobal, nItemsGlobal, byCell, assets }) {
  const timestamp = formatIsoDate();
  const today = formatDateYMD();
  const logPath = path.join(IRR_LOG_DIR, `irr_${today.replace(/-/g, '')}.txt`);

  const lines = [];
  lines.push(`[${timestamp}] IRR nightly summary`);
  lines.push(`Assets considered: ${assets.length}`);
  lines.push(`Global alpha: ${alphaGlobal == null ? 'null' : alphaGlobal.toFixed(6)}`);
  lines.push(`Global items: ${nItemsGlobal}`);
  lines.push('');
  lines.push('Per-cell metrics:');
  byCell.forEach((entry) => {
    const alphaStr = entry.alpha == null ? 'null' : entry.alpha.toFixed(6);
    lines.push(`  - ${entry.cell}: n=${entry.n_items}, alpha=${alphaStr}`);
  });

  await ensureDir(IRR_LOG_DIR);
  await fsp.writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  await ensureDir(IRR_DIR);

  const assets = await loadAssets();
  const summary = buildSummary(assets);

  const output = {
    generated_at: formatIsoDate(),
    label: TARGET_LABEL,
    alpha_global: summary.alphaGlobal,
    n_items_global: summary.nItemsGlobal,
    by_cell: summary.byCell,
  };

  await writeJson(IRR_JSON_PATH, output);
  await updateTrend(summary);
  await writeLog({ ...summary, assets });

  console.log(`Generated IRR summary for ${summary.nItemsGlobal} assets.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
