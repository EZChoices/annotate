#!/usr/bin/env node

const fsp = require('fs/promises');
const path = require('path');

const STAGE2_OUTPUT_DIR = process.env.STAGE2_OUTPUT_DIR
  ? path.resolve(process.env.STAGE2_OUTPUT_DIR)
  : path.resolve(__dirname, '..', 'data', 'stage2_output');
const IRR_DIR = process.env.IRR_OUTPUT_DIR
  ? path.resolve(process.env.IRR_OUTPUT_DIR)
  : path.resolve(__dirname, '..', 'data', 'irr');
const IRR_JSON_PATH = path.join(IRR_DIR, 'irr.json');
const IRR_TREND_PATH = path.join(IRR_DIR, 'irr_trend.json');
const IRR_LOG_DIR = path.join(IRR_DIR, 'logs');

const TARGET_LABEL = 'hasCS';
const REQUIRED_PASSES = new Set([1, 2]);
const MIN_CELL_ITEMS = 10;
const VOICE_TAG_ALIGNMENT_THRESHOLD_SEC = 0.12;
const DEFAULT_METRIC_KEY = 'hasCS';
const VOICE_TAG_REGEX = /^<v\s+S\d+>/i;

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

function parseBooleanFlag(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['yes', 'y', 'true', 't', '1'].includes(normalized)) return true;
    if (['no', 'n', 'false', 'f', '0'].includes(normalized)) return false;
  }
  return null;
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

function parseVttTimestamp(value) {
  if (!value) return NaN;
  const match = String(value).match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!match) return NaN;
  const hours = Number.parseInt(match[1], 10) || 0;
  const minutes = Number.parseInt(match[2], 10) || 0;
  const seconds = Number.parseInt(match[3], 10) || 0;
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function parseVttCues(content) {
  const cues = [];
  if (!content) return cues;
  const normalized = String(content).replace(/\r/g, '');
  const blocks = normalized.split(/\n\n+/);
  blocks.forEach((block) => {
    const lines = block.split(/\n/).filter((line) => line.trim() !== '');
    if (!lines.length) return;
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) return;
    const timeLine = lines[timeIndex];
    const parts = timeLine.split('-->');
    if (parts.length < 2) return;
    const start = parseVttTimestamp(parts[0]);
    const end = parseVttTimestamp(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const text = lines.slice(timeIndex + 1).join('\n');
    cues.push({ start, end, text });
  });
  return cues;
}

function mapVoiceTagCues(cues) {
  return (Array.isArray(cues) ? cues : []).map((cue, index) => {
    const text = typeof cue.text === 'string' ? cue.text : '';
    const trimmed = text.trim();
    const hasVoiceTag = VOICE_TAG_REGEX.test(trimmed);
    return {
      index,
      start: Number.isFinite(cue.start) ? Number(cue.start) : null,
      end: Number.isFinite(cue.end) ? Number(cue.end) : null,
      text,
      trimmed,
      hasVoiceTag,
    };
  });
}

function alignVoiceTagCues(cuesA, cuesB, threshold = VOICE_TAG_ALIGNMENT_THRESHOLD_SEC) {
  const pairs = [];
  if (!Array.isArray(cuesA) || !Array.isArray(cuesB)) return pairs;
  let i = 0;
  let j = 0;
  while (i < cuesA.length && j < cuesB.length) {
    const cueA = cuesA[i];
    const cueB = cuesB[j];
    const startA = Number.isFinite(cueA.start) ? cueA.start : null;
    const startB = Number.isFinite(cueB.start) ? cueB.start : null;
    if (startA == null) {
      i += 1;
      continue;
    }
    if (startB == null) {
      j += 1;
      continue;
    }
    const diff = startA - startB;
    if (Math.abs(diff) <= threshold) {
      pairs.push({ cueA, cueB });
      i += 1;
      j += 1;
    } else if (diff < 0) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function toFiniteNumber(value) {
  if (value == null) return null;
  const num = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(num) ? num : null;
}

function getCandidateObjects(root) {
  if (!root || typeof root !== 'object') return [];
  const stack = [root];
  const visited = new Set();
  const collected = [];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    collected.push(current);
    Object.values(current).forEach((value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        stack.push(value);
      }
    });
  }
  return collected;
}

function isMultiSpeakerMeta(meta) {
  const candidates = getCandidateObjects(meta);
  if (!candidates.length) return false;

  const boolKeys = [
    'multi_speaker',
    'multiSpeaker',
    'multispeaker',
    'is_multi_speaker',
    'isMultiSpeaker',
  ];
  const countKeys = [
    'speaker_count',
    'speakerCount',
    'num_speakers',
    'numSpeakers',
    'speakers_count',
    'speakersCount',
    'speaker_count_estimate',
    'speakerCountEstimate',
  ];
  const arrayKeys = [
    'speaker_profiles',
    'speakerProfiles',
    'speakers',
    'speaker_ids',
    'speakerIds',
  ];

  for (const obj of candidates) {
    for (const key of boolKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const parsed = parseBooleanFlag(obj[key]);
        if (parsed === true) return true;
      }
    }
    for (const key of countKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const numeric = toFiniteNumber(obj[key]);
        if (Number.isFinite(numeric) && numeric >= 2) return true;
      }
    }
    for (const key of arrayKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = obj[key];
        if (Array.isArray(value) && value.filter(Boolean).length >= 2) return true;
        if (value && typeof value === 'object') {
          const arr = Object.values(value).filter(Boolean);
          if (arr.length >= 2) return true;
        }
      }
    }
  }
  return false;
}

function shouldReplace(existingStat, newStat) {
  if (!existingStat && newStat) return true;
  if (!newStat) return false;
  if (!existingStat) return true;
  return newStat.mtimeMs >= existingStat.mtimeMs;
}

function inferAssetLabel(meta, assetId) {
  const candidates = getCandidateObjects(meta);
  const labelKeys = [
    'asset_label',
    'assetLabel',
    'clip_label',
    'clipLabel',
    'clip_name',
    'clipName',
    'title',
    'name',
    'display_name',
    'displayName',
  ];
  for (const obj of candidates) {
    for (const key of labelKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
        const value = String(obj[key]).trim();
        if (value) return value;
      }
    }
  }
  return assetId != null ? String(assetId) : null;
}

async function collectPassData(assetDir) {
  const passes = new Map();

  let entries;
  try {
    entries = await fsp.readdir(assetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { passes };
    throw err;
  }

  const stack = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ rel: entry.name, abs: path.join(assetDir, entry.name) }));

  while (stack.length) {
    const current = stack.pop();
    const { rel, abs } = current;
    let dirEntries;
    try {
      dirEntries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    for (const child of dirEntries) {
      const relPath = path.join(rel, child.name);
      const absPath = path.join(assetDir, relPath);
      if (child.isDirectory()) {
        stack.push({ rel: relPath, abs: absPath, dirent: child });
        continue;
      }
      if (!child.isFile()) continue;

      const segments = relPath.split(path.sep);
      const passIndex = segments.findIndex((segment) => parsePassNumber(segment) != null);
      const passNumber = passIndex >= 0 ? parsePassNumber(segments[passIndex]) : null;
      if (passNumber == null || !REQUIRED_PASSES.has(passNumber)) continue;

      const annotatorId = inferAnnotatorFromSegments(segments, passIndex);
      const record = passes.get(passNumber) || {
        annotatorId,
        vote: null,
        voteStat: null,
        voiceCues: null,
        voiceStat: null,
      };

      if (record.annotatorId === 'unknown' && annotatorId && annotatorId !== 'unknown') {
        record.annotatorId = annotatorId;
      }

      if (child.name === 'code_switch_spans.json') {
        let stat = null;
        try {
          stat = await fsp.stat(absPath);
        } catch {
          stat = null;
        }
        if (!shouldReplace(record.voteStat, stat)) {
          passes.set(passNumber, record);
          continue;
        }
        let spansJson;
        try {
          spansJson = await readJson(absPath);
        } catch (err) {
          console.warn(`Failed to read ${absPath}: ${err.message}`);
          passes.set(passNumber, record);
          continue;
        }
        const spans = Array.isArray(spansJson && spansJson.spans) ? spansJson.spans : [];
        record.vote = spans.length > 0 ? 1 : 0;
        record.voteStat = stat;
        passes.set(passNumber, record);
        continue;
      }

      if (child.name === 'transcript.vtt') {
        let stat = null;
        try {
          stat = await fsp.stat(absPath);
        } catch {
          stat = null;
        }
        if (!shouldReplace(record.voiceStat, stat)) {
          passes.set(passNumber, record);
          continue;
        }
        let content;
        try {
          content = await fsp.readFile(absPath, 'utf8');
        } catch (err) {
          console.warn(`Failed to read ${absPath}: ${err.message}`);
          passes.set(passNumber, record);
          continue;
        }
        const cues = mapVoiceTagCues(parseVttCues(content));
        record.voiceCues = cues;
        record.voiceStat = stat;
        passes.set(passNumber, record);
      }
    }
  }

  return { passes };
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

async function loadAssetMetrics() {
  let assetEntries;
  try {
    assetEntries = await fsp.readdir(STAGE2_OUTPUT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { hasCSItems: [], voiceTagItems: [], voiceTagMissing: [], assets: [] };
    }
    throw new Error(`Failed to read assets from ${STAGE2_OUTPUT_DIR}: ${err.message}`);
  }

  const hasCSItems = [];
  const voiceTagItems = [];
  const voiceTagMissing = [];
  const assetSummaries = [];

  for (const entry of assetEntries) {
    if (!entry.isDirectory()) continue;
    const assetId = entry.name;
    const assetDir = path.join(STAGE2_OUTPUT_DIR, assetId);

    const { passes } = await collectPassData(assetDir);
    const pass1 = passes.get(1);
    const pass2 = passes.get(2);
    if (!pass1 || !pass2) continue;

    const annotatorSet = new Set();
    if (pass1.annotatorId && pass1.annotatorId !== 'unknown') {
      annotatorSet.add(pass1.annotatorId);
    }
    if (pass2.annotatorId && pass2.annotatorId !== 'unknown') {
      annotatorSet.add(pass2.annotatorId);
    }
    if (annotatorSet.size < 2) continue;

    let itemMeta = null;
    try {
      itemMeta = await readJson(path.join(assetDir, 'item_meta.json'));
    } catch (err) {
      console.warn(`Failed to read item_meta.json for asset ${assetId}: ${err.message}`);
    }

    const cell = inferCellKey(itemMeta);
    const multiSpeaker = isMultiSpeakerMeta(itemMeta);
    const assetLabel = inferAssetLabel(itemMeta, assetId);

    const hasCSVotes = [];
    if (typeof pass1.vote === 'number') hasCSVotes.push(pass1.vote);
    if (typeof pass2.vote === 'number') hasCSVotes.push(pass2.vote);
    if (hasCSVotes.length >= 2) {
      hasCSItems.push({ assetId, cell, votes: hasCSVotes.slice(0, 2) });
    }

    const cues1 = Array.isArray(pass1.voiceCues) ? pass1.voiceCues : [];
    const cues2 = Array.isArray(pass2.voiceCues) ? pass2.voiceCues : [];
    const aligned = alignVoiceTagCues(cues1, cues2);
    aligned.forEach(({ cueA, cueB }) => {
      const voteA = cueA && cueA.hasVoiceTag ? 1 : 0;
      const voteB = cueB && cueB.hasVoiceTag ? 1 : 0;
      voiceTagItems.push({
        assetId,
        cell,
        votes: [voteA, voteB],
        cueA,
        cueB,
        annotators: [pass1.annotatorId || null, pass2.annotatorId || null],
        multiSpeaker,
        assetLabel,
      });

      if (!voteA && !voteB && multiSpeaker) {
        voiceTagMissing.push({
          asset_id: assetId,
          asset_label: assetLabel,
          cell,
          cue_index_pass1: cueA ? cueA.index : null,
          cue_index_pass2: cueB ? cueB.index : null,
          start: cueA && Number.isFinite(cueA.start)
            ? cueA.start
            : cueB && Number.isFinite(cueB.start)
              ? cueB.start
              : null,
          end: cueA && Number.isFinite(cueA.end)
            ? cueA.end
            : cueB && Number.isFinite(cueB.end)
              ? cueB.end
              : null,
          pass_1: {
            annotator_id: pass1.annotatorId || null,
            has_voice_tag: false,
            text: cueA ? cueA.trimmed || cueA.text || '' : '',
          },
          pass_2: {
            annotator_id: pass2.annotatorId || null,
            has_voice_tag: false,
            text: cueB ? cueB.trimmed || cueB.text || '' : '',
          },
        });
      }
    });

    assetSummaries.push({
      assetId,
      cell,
      hasCSVotes: hasCSVotes.length >= 2,
      voiceTagPairs: aligned.length,
    });
  }

  return { hasCSItems, voiceTagItems, voiceTagMissing, assets: assetSummaries };
}

function buildAlphaSummary(items) {
  const valid = (items || [])
    .map((item) => {
      if (!item || !Array.isArray(item.votes)) return null;
      const filteredVotes = item.votes
        .map((value) => (value == null ? null : Number(value)))
        .filter((value) => value === 0 || value === 1);
      if (filteredVotes.length < 2) return null;
      return {
        cell: item.cell || 'unknown:unknown:*:*',
        votes: filteredVotes,
      };
    })
    .filter(Boolean);

  const alphaGlobal = computeNominalKrippendorffAlpha(valid.map((item) => item.votes));

  const grouped = new Map();
  valid.forEach((item) => {
    if (!grouped.has(item.cell)) {
      grouped.set(item.cell, []);
    }
    grouped.get(item.cell).push(item.votes);
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
    nItemsGlobal: valid.length,
    byCell,
  };
}

async function updateTrend(metricSummaries) {
  let existing;
  try {
    existing = await readJson(IRR_TREND_PATH);
  } catch (err) {
    console.warn(`Failed to read existing trend data: ${err.message}`);
  }

  let trendData;
  if (Array.isArray(existing)) {
    trendData = { [DEFAULT_METRIC_KEY]: existing };
  } else if (existing && typeof existing === 'object') {
    trendData = existing;
  } else {
    trendData = {};
  }

  const today = formatDateYMD();
  const nextTrend = {};

  Object.entries(metricSummaries || {}).forEach(([metricKey, summary]) => {
    if (!summary) return;
    const previousSeries = Array.isArray(trendData[metricKey]) ? trendData[metricKey] : [];
    const filtered = previousSeries.filter((entry) => entry && entry.date !== today);
    filtered.push({
      date: today,
      alpha_global: summary.alphaGlobal,
      n_items: summary.nItemsGlobal,
      by_cell: Array.isArray(summary.byCell)
        ? summary.byCell.map((entry) => ({
            cell: entry.cell,
            alpha: entry.alpha,
            n_items: entry.n_items,
          }))
        : [],
    });
    while (filtered.length > 30) {
      filtered.shift();
    }
    nextTrend[metricKey] = filtered;
  });

  await writeJson(IRR_TREND_PATH, nextTrend);
}

async function writeLog({ generatedAt, metrics, assets }) {
  const timestamp = formatIsoDate();
  const today = formatDateYMD();
  const logPath = path.join(IRR_LOG_DIR, `irr_${today.replace(/-/g, '')}.txt`);

  const lines = [];
  lines.push(`[${timestamp}] IRR nightly summary`);
  if (generatedAt) {
    lines.push(`Generated at: ${generatedAt}`);
  }
  if (Array.isArray(assets)) {
    lines.push(`Assets considered: ${assets.length}`);
  }
  lines.push('');

  Object.entries(metrics || {}).forEach(([key, summary]) => {
    if (!summary) return;
    const alphaStr = summary.alphaGlobal == null ? 'null' : summary.alphaGlobal.toFixed(6);
    lines.push(`Metric ${key}: alpha=${alphaStr}, items=${summary.nItemsGlobal}`);
    if (key === 'voiceTag_presence' && summary.missingCount != null) {
      lines.push(`  Missing voice tags (multi-speaker): ${summary.missingCount}`);
    }
    if (Array.isArray(summary.byCell) && summary.byCell.length) {
      lines.push('  Per-cell metrics:');
      summary.byCell.forEach((entry) => {
        const alphaDisplay = entry.alpha == null ? 'n<10' : entry.alpha.toFixed(6);
        lines.push(`    - ${entry.cell}: n=${entry.n_items}, alpha=${alphaDisplay}`);
      });
    }
    lines.push('');
  });

  await ensureDir(IRR_LOG_DIR);
  await fsp.writeFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  await ensureDir(IRR_DIR);

  const metricsData = await loadAssetMetrics();
  const hasCSSummary = buildAlphaSummary(metricsData.hasCSItems);
  const voiceTagSummary = buildAlphaSummary(metricsData.voiceTagItems);
  const generatedAt = formatIsoDate();

  const output = {
    generated_at: generatedAt,
    label: TARGET_LABEL,
    hasCS: {
      alpha_global: hasCSSummary.alphaGlobal,
      n_items: hasCSSummary.nItemsGlobal,
      by_cell: hasCSSummary.byCell,
    },
    voiceTag_presence: {
      alpha_global: voiceTagSummary.alphaGlobal,
      n_items: voiceTagSummary.nItemsGlobal,
      by_cell: voiceTagSummary.byCell,
      missing_voice_tags: metricsData.voiceTagMissing,
    },
  };

  await writeJson(IRR_JSON_PATH, output);
  await updateTrend({
    hasCS: hasCSSummary,
    voiceTag_presence: voiceTagSummary,
  });
  await writeLog({
    generatedAt,
    metrics: {
      hasCS: hasCSSummary,
      voiceTag_presence: { ...voiceTagSummary, missingCount: metricsData.voiceTagMissing.length },
    },
    assets: metricsData.assets,
  });

  console.log(
    `Generated IRR summary for ${hasCSSummary.nItemsGlobal} assets and ${voiceTagSummary.nItemsGlobal} aligned cues.`
  );
}

module.exports = {
  buildAlphaSummary,
  computeNominalKrippendorffAlpha,
  alignVoiceTagCues,
  mapVoiceTagCues,
  parseVttCues,
  parseVttTimestamp,
  loadAssetMetrics,
  isMultiSpeakerMeta,
  VOICE_TAG_ALIGNMENT_THRESHOLD_SEC,
  MIN_CELL_ITEMS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
