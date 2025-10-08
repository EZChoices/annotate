#!/usr/bin/env node

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.ADJUDICATION_CONFIG_PATH
  ? path.resolve(process.env.ADJUDICATION_CONFIG_PATH)
  : path.join(ROOT_DIR, 'config', 'adjudication.json');
const STAGE2_OUTPUT_DIR = process.env.STAGE2_OUTPUT_DIR
  ? path.resolve(process.env.STAGE2_OUTPUT_DIR)
  : path.join(ROOT_DIR, 'data', 'stage2_output');
const REVIEW_DIR = process.env.ADJUDICATION_OUTPUT_DIR
  ? path.resolve(process.env.ADJUDICATION_OUTPUT_DIR)
  : path.join(ROOT_DIR, 'data', 'review');
const QUEUE_PATH = path.join(REVIEW_DIR, 'adjudication_queue.json');
const LOG_DIR = path.join(REVIEW_DIR, 'logs');

const VOICE_TAG_REGEX = /^<v\s+S\d+>/i;
const VOICE_TAG_ALIGNMENT_THRESHOLD_SEC = 0.12;

const QA_F1_KEYS = new Set([
  'low_f1',
  'codeswitch_low_f1',
  'code_switch_low_f1',
  'rolling_median_code_switch_f1',
  'rolling_median_codeswitch_f1',
  'median_code_switch_f1',
  'median_codeswitch_f1',
  'codeswitch_f1_median',
  'code_switch_median_f1',
  'codeswitch_median_f1',
  'median_codeswitch',
  'code_switch_f1',
  'codeswitch_f1',
]);

const QA_CUES_KEYS = new Set([
  'pct_cues_in_bounds',
  'pct_cues_within_bounds',
  'percent_cues_in_bounds',
  'percentage_cues_in_bounds',
  'cues_pct_in_bounds',
  'cues_in_bounds_pct',
  'cues_in_bounds',
  'cue_in_bounds_pct',
]);

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
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`Failed to read JSON from ${filePath}: ${err.message}`);
  }
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(filePath, text, 'utf8');
}

function computeSha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
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
      candidateCells.push(
        ...itemMeta.assignment.cells.filter((cell) => cell && typeof cell === 'object')
      );
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

function shouldReplace(existingStat, newStat) {
  if (!existingStat && newStat) return true;
  if (!newStat) return false;
  if (!existingStat) return true;
  return newStat.mtimeMs >= existingStat.mtimeMs;
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
      if (passNumber == null) continue;

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

function coerceNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/[,\s%]+/g, '');
    const num = Number.parseFloat(normalized);
    if (!Number.isFinite(num)) return null;
    return num;
  }
  return null;
}

function normalizeProbabilityValue(value) {
  const num = coerceNumber(value);
  if (num == null) return null;
  if (Math.abs(num) > 1) {
    return num / 100;
  }
  return num;
}

function normalizePercentValue(value) {
  const num = coerceNumber(value);
  if (num == null) return null;
  if (num <= 1 && num >= 0) {
    return num * 100;
  }
  return num;
}

function extractQaMetrics(source) {
  if (!source || typeof source !== 'object') {
    return { f1: null, cuesInBounds: null };
  }

  const queue = [source];
  let f1 = null;
  let cues = null;

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      const lowerKey = key.toLowerCase();
      if (f1 == null && QA_F1_KEYS.has(lowerKey)) {
        f1 = normalizeProbabilityValue(value);
      }
      if (cues == null && QA_CUES_KEYS.has(lowerKey)) {
        cues = normalizePercentValue(value);
      }
      if (f1 != null && cues != null) {
        return { f1, cuesInBounds: cues };
      }
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return { f1, cuesInBounds: cues };
}

function isDoublePassTarget(itemMeta, qaResult) {
  const candidates = [itemMeta, qaResult];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidate.double_pass_target === true) return true;
    if (candidate.doublePassTarget === true) return true;
    if (candidate.double_pass === true) return true;
    if (candidate.doublePass === true) return true;
    if (candidate.target_type === 'double_pass') return true;
    if (candidate.assignment && candidate.assignment.double_pass_target === true) return true;
    if (candidate.assignments && Array.isArray(candidate.assignments)) {
      if (candidate.assignments.some((entry) => entry && entry.pass_number >= 2)) {
        return true;
      }
    }
  }
  return false;
}

function getAdjudicationStatus(itemMeta) {
  if (!itemMeta || typeof itemMeta !== 'object') return null;
  const adjudication = itemMeta.adjudication;
  if (adjudication && typeof adjudication === 'object') {
    if (typeof adjudication.status === 'string') {
      return adjudication.status.toLowerCase();
    }
  }
  return null;
}

async function loadExistingQueue() {
  const data = await readJson(QUEUE_PATH);
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry && typeof entry === 'object' ? entry : null))
    .filter(Boolean);
}

function toReasonArray(set) {
  return Array.from(new Set(set)).sort();
}

async function writeLog({ configSha, stats, candidates }) {
  await ensureDir(LOG_DIR);
  const today = formatDateYMD();
  const timestamp = formatIsoDate();
  const logPath = path.join(LOG_DIR, `adjudication_${configSha}_${today}.log`);

  const lines = [];
  lines.push(`[${timestamp}] nightly adjudication summary`);
  lines.push(`Config SHA: ${configSha}`);
  lines.push(`Assets scanned: ${stats.scanned}`);
  lines.push(`Double-pass targets: ${stats.doublePassTargets}`);
  lines.push(`Skipped locked/resolved: ${stats.locked}`);
  lines.push(`Eligible candidates: ${candidates.length}`);
  lines.push(`Inserted: ${stats.inserted}`);
  lines.push(`Updated: ${stats.updated}`);
  if (candidates.length) {
    lines.push('Details:');
    candidates.forEach((candidate) => {
      lines.push(
        `  - ${candidate.assetId}: reasons=${candidate.reasons.join(', ')}; annotators=${JSON.stringify(
          candidate.passAnnotators
        )}`
      );
    });
  }
  lines.push('');

  await fsp.appendFile(logPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  let configRaw;
  try {
    configRaw = await fsp.readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Adjudication config not found at ${CONFIG_PATH}`);
    }
    throw new Error(`Failed to read adjudication config at ${CONFIG_PATH}: ${err.message}`);
  }

  let config;
  try {
    config = JSON.parse(configRaw);
  } catch (err) {
    throw new Error(`Failed to parse adjudication config: ${err.message}`);
  }

  const configSha = computeSha1(configRaw);

  let assetEntries;
  try {
    assetEntries = await fsp.readdir(STAGE2_OUTPUT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      assetEntries = [];
    } else {
      throw new Error(`Failed to read stage2 output at ${STAGE2_OUTPUT_DIR}: ${err.message}`);
    }
  }

  const minCuePairs = Number.isFinite(config.min_cue_pairs_for_voiceTag)
    ? Number(config.min_cue_pairs_for_voiceTag)
    : 0;
  const includeVoiceTag = Boolean(
    config && config.gates && config.gates.include_voice_tag_disagreements
  );
  const lowF1Threshold =
    config && config.gates && Number.isFinite(config.gates.require_low_f1_lt)
      ? Number(config.gates.require_low_f1_lt)
      : null;
  const cuesThreshold =
    config && config.gates && Number.isFinite(config.gates.require_cues_in_bounds_lt)
      ? Number(config.gates.require_cues_in_bounds_lt)
      : null;

  const candidates = [];
  const stats = {
    scanned: 0,
    doublePassTargets: 0,
    locked: 0,
    inserted: 0,
    updated: 0,
  };

  for (const entry of assetEntries) {
    if (!entry.isDirectory()) continue;
    const assetId = entry.name;
    const assetDir = path.join(STAGE2_OUTPUT_DIR, assetId);
    stats.scanned += 1;

    const { passes } = await collectPassData(assetDir);
    const pass1 = passes.get(1);
    const pass2 = passes.get(2);
    if (!pass1 || !pass2) continue;

    let itemMeta = null;
    try {
      itemMeta = await readJson(path.join(assetDir, 'item_meta.json'));
    } catch (err) {
      console.warn(`Failed to read item_meta.json for asset ${assetId}: ${err.message}`);
    }

    const adjudicationStatus = getAdjudicationStatus(itemMeta);
    if (adjudicationStatus === 'locked' || adjudicationStatus === 'resolved') {
      stats.locked += 1;
      continue;
    }

    let qaResult = null;
    try {
      qaResult = await readJson(path.join(assetDir, 'qa_result.json'));
    } catch (err) {
      console.warn(`Failed to read qa_result.json for asset ${assetId}: ${err.message}`);
    }

    if (!isDoublePassTarget(itemMeta, qaResult)) {
      continue;
    }
    stats.doublePassTargets += 1;

    const passAnnotators = {
      pass_1: pass1.annotatorId || null,
      pass_2: pass2.annotatorId || null,
    };

    const hasCSVote1 = typeof pass1.vote === 'number' ? pass1.vote : null;
    const hasCSVote2 = typeof pass2.vote === 'number' ? pass2.vote : null;
    const hasCSDisagreement =
      hasCSVote1 != null && hasCSVote2 != null && hasCSVote1 !== hasCSVote2;

    const cues1 = Array.isArray(pass1.voiceCues) ? pass1.voiceCues : [];
    const cues2 = Array.isArray(pass2.voiceCues) ? pass2.voiceCues : [];
    const aligned = alignVoiceTagCues(cues1, cues2);
    const voiceTagPairs = aligned.length;
    let voiceTagDisagreement = false;
    if (voiceTagPairs >= minCuePairs) {
      voiceTagDisagreement = aligned.some(({ cueA, cueB }) => {
        const voteA = cueA && cueA.hasVoiceTag ? 1 : 0;
        const voteB = cueB && cueB.hasVoiceTag ? 1 : 0;
        return voteA !== voteB;
      });
    }

    const qaMetrics = extractQaMetrics(qaResult);
    const lowF1Risk =
      lowF1Threshold != null && qaMetrics.f1 != null && qaMetrics.f1 < lowF1Threshold;
    const cuesRisk =
      cuesThreshold != null && qaMetrics.cuesInBounds != null && qaMetrics.cuesInBounds < cuesThreshold;

    const reasons = new Set();
    if (lowF1Risk) reasons.add('low_f1');
    if (cuesRisk) reasons.add('cues_out_of_bounds');
    if (hasCSDisagreement && (lowF1Risk || cuesRisk)) {
      reasons.add('hasCS_disagreement');
    }
    if (includeVoiceTag && voiceTagDisagreement) {
      reasons.add('voiceTag_disagreement');
    }

    if (!reasons.has('hasCS_disagreement') && !reasons.has('voiceTag_disagreement')) {
      continue;
    }

    const cell = inferCellKey(itemMeta);
    candidates.push({
      assetId,
      reasons: toReasonArray(reasons),
      passAnnotators,
      cell,
      qaMetrics,
    });
  }

  const existingQueue = await loadExistingQueue();
  const existingMap = new Map(existingQueue.map((entry) => [entry.asset_id, entry]));
  const nowIso = formatIsoDate();

  for (const candidate of candidates) {
    const existing = existingMap.get(candidate.assetId);
    if (existing) {
      const mergedReasons = toReasonArray(new Set([...(existing.reasons || []), ...candidate.reasons]));
      existing.reasons = mergedReasons;
      existing.last_seen_at = nowIso;
      existing.config_sha = configSha;
      existing.pass_annotators = candidate.passAnnotators;
      existing.cell = candidate.cell;
      existingMap.set(candidate.assetId, existing);
      stats.updated += 1;
      continue;
    }

    const record = {
      asset_id: candidate.assetId,
      reasons: candidate.reasons,
      queued_at: nowIso,
      last_seen_at: nowIso,
      status: 'pending',
      assignee: null,
      pass_annotators: candidate.passAnnotators,
      cell: candidate.cell,
      config_sha: configSha,
    };
    existingMap.set(candidate.assetId, record);
    stats.inserted += 1;
  }

  const nextQueue = Array.from(existingMap.values()).sort((a, b) => {
    const idA = a.asset_id || '';
    const idB = b.asset_id || '';
    return idA.localeCompare(idB);
  });

  await ensureDir(path.dirname(QUEUE_PATH));
  await writeJson(QUEUE_PATH, nextQueue);
  await writeLog({ configSha, stats, candidates });

  console.log(
    `Processed ${stats.scanned} assets, queued ${stats.inserted} new and updated ${stats.updated} adjudication records.`
  );
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
