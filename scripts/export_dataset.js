#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('util');
const { computeCoverageSummary } = require('./compute_coverage');

function listSubdirs(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

function isAssetId(name) {
  return /^ea_[A-Za-z0-9_]+$/.test(name);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((acc, val) => acc + val, 0) / arr.length;
}

function std(arr) {
  if (arr.length <= 1) return 0;
  const avg = mean(arr);
  const variance = arr.reduce((acc, val) => acc + (val - avg) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function parseVttTimestamp(value) {
  const match = value.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!match) {
    return 0;
  }
  const [, hh, mm, ss, fraction] = match;
  const hours = Number(hh) || 0;
  const minutes = Number(mm) || 0;
  const seconds = Number(ss) || 0;
  const millis = fraction ? Number(`0.${fraction}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + millis;
}

function sumDurationsFromVTT(vttPath) {
  if (!fs.existsSync(vttPath)) {
    return 0;
  }
  const content = fs.readFileSync(vttPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    if (line.includes('-->')) {
      const parts = line.split('-->');
      if (parts.length >= 2) {
        const start = parseVttTimestamp(parts[0]);
        const end = parseVttTimestamp(parts[1]);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
          total += end - start;
        }
      }
    }
  }
  return total;
}

const SENSITIVE_EVENT_CATEGORIES = [
  'pii_name',
  'pii_phone',
  'pii_email',
  'pii_address',
  'minor_face',
  'political',
  'religious',
  'explicit',
];

const PROVENANCE_FIELDS = [
  'collection_mode',
  'license_type',
  'license_document_id',
  'processing_location_country',
  'takedown_supported',
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(content) {
  if (!content) return content;
  const patternSegments = SENSITIVE_EVENT_CATEGORIES.map((category) => escapeRegex(category));
  patternSegments.push('pii_[a-z0-9_]+');
  patternSegments.push('safety_pii_[a-z0-9_]+');
  patternSegments.push('safety_minor_[a-z0-9_]+');
  patternSegments.push('safety_(?:explicit|political|religious)');
  const categoriesPattern = patternSegments.join('|');
  if (!categoriesPattern) {
    return content;
  }
  let sanitized = content;

  const classRegex = new RegExp(
    `(<c[^>]*\\b(?:${categoriesPattern})\\b[^>]*>)([\\s\\S]*?)(</c>)`,
    'gi'
  );
  sanitized = sanitized.replace(classRegex, (match, openTag, _inner, closeTag) => `${openTag}[REDACTED]${closeTag}`);

  const dataAttrRegex = new RegExp(
    `(<(?!/)[^>]*\\bdata-category\\s*=\\s*"(?:${categoriesPattern})"[^>]*>)([\\s\\S]*?)(</[^>]+>)`,
    'gi'
  );
  sanitized = sanitized.replace(dataAttrRegex, (match, openTag, _inner, closeTag) => `${openTag}[REDACTED]${closeTag}`);

  const noteRegex = new RegExp(
    `(NOTE[^\n]*\\b(?:${categoriesPattern})\\b[^\n]*:?)\\s*([^\n]*)`,
    'gi'
  );
  sanitized = sanitized.replace(noteRegex, (match, prefix) => `${prefix} [REDACTED]`);

  const inlineLabelRegex = new RegExp(
    `(\\b(?:${categoriesPattern})\\b\\s*:\\s*)([^\n]+)`,
    'gi'
  );
  sanitized = sanitized.replace(inlineLabelRegex, (match, prefix) => `${prefix}[REDACTED]`);

  return sanitized;
}

function redactVtt(vttPath) {
  if (!fs.existsSync(vttPath)) {
    return '';
  }
  const content = fs.readFileSync(vttPath, 'utf-8');
  return redactSensitiveText(content);
}

function blurVideoPlaceholder(assetPath) {
  if (!assetPath) return;
  if (!fs.existsSync(assetPath)) {
    return;
  }
  // Placeholder for future video redaction logic.
}

function samplePublicSubset(clips, minSec, maxSec) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return [];
  }
  const shuffled = [...clips];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const selected = [];
  let total = 0;
  for (const clip of shuffled) {
    const projected = total + (clip.totalDurationSec || 0);
    if (total >= minSec && projected > maxSec) {
      continue;
    }
    selected.push(clip);
    total = projected;
    if (total >= minSec && total <= maxSec) {
      break;
    }
  }

  if (total < minSec) {
    for (const clip of shuffled) {
      if (selected.includes(clip)) continue;
      selected.push(clip);
      total += clip.totalDurationSec || 0;
      if (total >= minSec) {
        break;
      }
    }
  }

  return selected.length ? selected : shuffled;
}

function findFirstVideoAsset(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return null;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (/\.(mp4|mov|mkv|webm)$/i.test(entry.name)) {
      return entry.name;
    }
  }
  return null;
}

function normalizeVoiceTag(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^S\d+$/i.test(raw)) {
    return raw.toUpperCase();
  }
  const spkMatch = /^SPK(\d+)$/i.exec(raw);
  if (spkMatch) {
    const num = Number(spkMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      return `S${num}`;
    }
  }
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) {
      return `S${num}`;
    }
  }
  if (/^[A-Za-z]$/.test(raw)) {
    const num = raw.toUpperCase().charCodeAt(0) - 64;
    if (num > 0) {
      return `S${num}`;
    }
  }
  return raw;
}

function parseVttCues(content) {
  const cues = [];
  if (!content) return cues;
  const normalized = content.replace(/\r/g, '');
  const blocks = normalized.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split(/\n/).filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    let timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) continue;
    const timeLine = lines[timeIndex];
    const parts = timeLine.split('-->');
    if (parts.length < 2) continue;
    const start = parseVttTimestamp(parts[0]);
    const end = parseVttTimestamp(parts[1]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const text = lines.slice(timeIndex + 1).join('\n');
    cues.push({ start, end, text });
  }
  return cues;
}

function extractVoiceTagsFromVtt(vttPath) {
  if (!fs.existsSync(vttPath)) {
    return [];
  }
  const content = fs.readFileSync(vttPath, 'utf-8');
  const cues = parseVttCues(content);
  const tags = [];
  cues.forEach((cue) => {
    const trimmed = String(cue.text || '').trim();
    const match = /^<v\s+([^>]+)>/i.exec(trimmed);
    if (!match) return;
    const speaker = normalizeVoiceTag(match[1]);
    if (!speaker) return;
    const text = trimmed.replace(/^<v\s+[^>]+>/i, '').trim();
    const start = Number.isFinite(cue.start) ? Number(cue.start.toFixed(3)) : null;
    const end = Number.isFinite(cue.end) ? Number(cue.end.toFixed(3)) : null;
    tags.push({ speaker, start, end, text });
  });
  return tags;
}

function hashToSplit(id, ratios, labels) {
  const hash = crypto.createHash('md5').update(id).digest('hex');
  const hashValue = parseInt(hash.slice(0, 8), 16);
  const normalizedHash = hashValue / 0xffffffff;
  const total = ratios.reduce((acc, val) => acc + val, 0);
  let cumulative = 0;
  for (let i = 0; i < ratios.length; i++) {
    cumulative += ratios[i] / total;
    if (normalizedHash <= cumulative || i === ratios.length - 1) {
      return labels[i] || `split${i + 1}`;
    }
  }
  return labels[0] || 'train';
}

function countWhere(arr, predicate) {
  return arr.reduce((count, item) => (predicate(item) ? count + 1 : count), 0);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseSplitRatios(value) {
  const ratios = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((num) => !Number.isNaN(num) && num >= 0);
  if (!ratios.length || ratios.every((num) => num === 0)) {
    throw new Error('Invalid --splitRatio configuration.');
  }
  return ratios;
}

function getSplitLabels(length) {
  const base = ['train', 'validation', 'test'];
  const labels = [];
  for (let i = 0; i < length; i++) {
    labels.push(base[i] || `split${i + 1}`);
  }
  return labels;
}

function parseCsv(content) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  let row = [];

  const pushCell = () => {
    row.push(current);
    current = '';
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      pushCell();
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && content[i + 1] === '\n') {
        i++;
      }
      pushCell();
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
    } else {
      current += char;
    }
  }

  if (current !== '' || inQuotes || row.length) {
    pushCell();
    rows.push(row);
  }

  return rows;
}

function sanitizeProvenanceString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'object') {
    return null;
  }
  const text = String(value).trim();
  return text.length ? text : null;
}

function normalizeTakedownValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const lower = trimmed.toLowerCase();
    if (['true', 'yes', 'y', '1', 'supported'].includes(lower)) {
      return true;
    }
    if (['false', 'no', 'n', '0', 'unsupported', 'not supported'].includes(lower)) {
      return false;
    }
    return trimmed;
  }
  return value;
}

function normalizeProvenanceRecord(raw) {
  const source =
    raw && typeof raw === 'object'
      ? raw.provenance && typeof raw.provenance === 'object'
        ? raw.provenance
        : raw
      : {};

  const pick = (...keys) => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        return source[key];
      }
    }
    return null;
  };

  const collectionMode = sanitizeProvenanceString(
    pick('collection_mode', 'collectionMode', 'collection-mode')
  );
  const licenseType = sanitizeProvenanceString(
    pick('license_type', 'licenseType', 'license-type')
  );
  const licenseDocumentId = sanitizeProvenanceString(
    pick(
      'license_document_id',
      'licenseDocumentId',
      'license_document',
      'licenseDocId',
      'license_documentid'
    )
  );
  const consentRef = sanitizeProvenanceString(
    pick('consent_ref', 'consentRef', 'consent_reference')
  );
  const processingLocation = sanitizeProvenanceString(
    pick(
      'processing_location_country',
      'processing_location',
      'processing_country',
      'processingLocationCountry',
      'processingLocation'
    )
  );
  const takedownSupported = normalizeTakedownValue(
    pick('takedown_supported', 'takedownSupported', 'takedown_support', 'takedown', 'takedownSupport')
  );

  return {
    collection_mode: collectionMode ?? null,
    license_type: licenseType ?? null,
    license_document_id:
      licenseDocumentId != null ? licenseDocumentId : consentRef ?? null,
    processing_location_country: processingLocation ?? null,
    takedown_supported: takedownSupported ?? null,
  };
}

function formatProvenanceCountKey(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

async function loadProvenanceLedger(filePath) {
  if (!filePath) {
    return {};
  }

  const resolvedPath = path.resolve(filePath);
  let content;
  try {
    content = await fsp.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read provenance ledger at ${resolvedPath}: ${err.message}`);
  }

  const assignRecord = (mapping, clipId, record) => {
    if (!clipId) return;
    const normalizedClipId = String(clipId).trim();
    if (!normalizedClipId) return;
    mapping[normalizedClipId] = normalizeProvenanceRecord(record || {});
  };

  const ext = path.extname(resolvedPath).toLowerCase();
  const mapping = {};

  if (ext === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON provenance ledger: ${err.message}`);
    }

    if (Array.isArray(parsed)) {
      parsed.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const clipId =
          entry.clip_id ||
          entry.clipId ||
          entry.asset_id ||
          entry.assetId ||
          entry.id;
        assignRecord(mapping, clipId, entry);
      });
      return mapping;
    }

    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([clipId, record]) => {
        assignRecord(mapping, clipId, record);
      });
      return mapping;
    }

    throw new Error('Provenance JSON must be an object or array.');
  }

  if (ext === '.csv') {
    const rows = parseCsv(content);
    if (!rows.length) {
      return {};
    }

    const headers = rows[0].map((header) => header.trim());
    const lowerHeaders = headers.map((header) => header.toLowerCase());
    const findIndex = (...candidates) => {
      for (const candidate of candidates) {
        const idx = lowerHeaders.indexOf(candidate.toLowerCase());
        if (idx !== -1) {
          return idx;
        }
      }
      return -1;
    };

    const clipIndex = findIndex('clip_id', 'clipid', 'asset_id', 'assetid', 'id');
    if (clipIndex === -1) {
      throw new Error('Provenance CSV must include a clip_id column.');
    }

    const collectionModeIndex = findIndex('collection_mode', 'collectionmode', 'collection-mode');
    const licenseTypeIndex = findIndex('license_type', 'licensetype', 'license-type');
    const licenseDocIndex = findIndex(
      'license_document_id',
      'license_document',
      'license_doc_id',
      'licensedocumentid'
    );
    const consentRefIndex = findIndex('consent_ref', 'consentref', 'consent_reference');
    const processingIndex = findIndex(
      'processing_location_country',
      'processing_country',
      'processing_location',
      'processinglocationcountry'
    );
    const takedownIndex = findIndex('takedown_supported', 'takedownsupported', 'takedown_support', 'takedown');

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length <= clipIndex) continue;
      const clipValue = row[clipIndex];
      const clipId = clipValue != null ? String(clipValue).trim() : '';
      if (!clipId) continue;

      const record = {
        collection_mode:
          collectionModeIndex !== -1 && row.length > collectionModeIndex
            ? row[collectionModeIndex]
            : null,
        license_type:
          licenseTypeIndex !== -1 && row.length > licenseTypeIndex ? row[licenseTypeIndex] : null,
        license_document_id:
          licenseDocIndex !== -1 && row.length > licenseDocIndex ? row[licenseDocIndex] : null,
        consent_ref:
          consentRefIndex !== -1 && row.length > consentRefIndex ? row[consentRefIndex] : null,
        processing_location_country:
          processingIndex !== -1 && row.length > processingIndex ? row[processingIndex] : null,
        takedown_supported:
          takedownIndex !== -1 && row.length > takedownIndex ? row[takedownIndex] : null,
      };

      assignRecord(mapping, clipId, record);
    }

    return mapping;
  }

  throw new Error('Unsupported provenance ledger format. Use CSV or JSON.');
}

async function loadRightsMetadata(filePath) {
  if (!filePath) {
    return {};
  }

  const resolvedPath = path.resolve(filePath);
  let content;
  try {
    content = await fsp.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read rights metadata file at ${resolvedPath}: ${err.message}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const normalizeRights = (value) => {
    const dedupe = (arr) => {
      const unique = [];
      const seen = new Set();
      for (const item of arr) {
        if (!seen.has(item)) {
          seen.add(item);
          unique.push(item);
        }
      }
      return unique;
    };
    if (Array.isArray(value)) {
      const cleaned = value
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
      return dedupe(cleaned);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          return normalizeRights(parsed);
        } catch (err) {
          // fall through to delimiter parsing
        }
      }
      const split = trimmed
        .split(/[;|,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return dedupe(split);
    }
    if (value === null || value === undefined) {
      return [];
    }
    const fallback = [String(value).trim()].filter((item) => item.length > 0);
    return dedupe(fallback);
  };

  const mapping = {};

  if (ext === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Invalid JSON rights metadata: ${err.message}`);
    }

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry) continue;
        const assetId = entry.asset_id || entry.assetId || entry.id;
        if (!assetId) continue;
        mapping[assetId] = normalizeRights(entry.rights || entry.licenses || []);
      }
    } else if (typeof parsed === 'object') {
      for (const [assetId, rightsValue] of Object.entries(parsed)) {
        mapping[assetId] = normalizeRights(rightsValue);
      }
    }
    return mapping;
  }

  if (ext === '.csv') {
    const rows = parseCsv(content);
    if (!rows.length) {
      return {};
    }
    const headers = rows[0].map((header) => header.trim());
    const assetIndex = headers.findIndex((header) => header === 'asset_id' || header === 'assetId' || header === 'id');
    const rightsIndex = headers.findIndex((header) => header === 'rights' || header === 'licenses');
    if (assetIndex === -1 || rightsIndex === -1) {
      throw new Error('Rights CSV must include asset_id and rights columns.');
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length <= Math.max(assetIndex, rightsIndex)) continue;
      const assetId = row[assetIndex] ? row[assetIndex].trim() : '';
      if (!assetId) continue;
      const rightsValue = row[rightsIndex];
      mapping[assetId] = normalizeRights(rightsValue);
    }
    return mapping;
  }

  throw new Error('Unsupported rights metadata format. Use CSV or JSON.');
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      source: { type: 'string', default: 'data/stage2_output' },
      out: { type: 'string', default: 'datasets' },
      'include-gold': { type: 'boolean', default: true },
      minF1: { type: 'string', default: '0.80' },
      splitRatio: { type: 'string', default: '0.8,0.1,0.1' },
      rights: { type: 'string' },
      provenance: { type: 'string' },
      public: { type: 'boolean', default: false },
    },
  });

  const version = values.version;
  if (!version) {
    console.error('Error: --version is required.');
    process.exit(1);
  }

  const sourceDir = path.resolve(values.source || 'data/stage2_output');
  const outDir = path.resolve(values.out || 'datasets');
  const publicRaw = values.public;
  const isPublic =
    typeof publicRaw === 'boolean'
      ? publicRaw
      : publicRaw === undefined
      ? false
      : String(publicRaw).toLowerCase() !== 'false';
  const includeGoldRaw = values['include-gold'];
  const includeGold =
    typeof includeGoldRaw === 'boolean'
      ? includeGoldRaw
      : includeGoldRaw === undefined
      ? true
      : String(includeGoldRaw).toLowerCase() !== 'false';
  const minF1 = Number(values.minF1 ?? '0.80');
  if (Number.isNaN(minF1)) {
    console.error('Error: --minF1 must be a number.');
    process.exit(1);
  }

  let splitRatios;
  try {
    splitRatios = parseSplitRatios(values.splitRatio || '0.8,0.1,0.1');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const splitLabels = getSplitLabels(splitRatios.length);

  const datasetFolderName = isPublic ? `${version}-public` : version;
  const datasetRoot = path.join(outDir, datasetFolderName);
  const clipsDestRoot = path.join(datasetRoot, 'clips');
  ensureDir(clipsDestRoot);

  let rightsByAsset = {};
  if (values.rights) {
    try {
      rightsByAsset = await loadRightsMetadata(values.rights);
    } catch (err) {
      console.warn(err.message);
      rightsByAsset = {};
    }
  }

  let provenanceByClip = {};
  if (values.provenance) {
    try {
      provenanceByClip = await loadProvenanceLedger(values.provenance);
    } catch (err) {
      console.warn(err.message);
      provenanceByClip = {};
    }
  }

  const requiredFiles = [
    'transcript.vtt',
    'translation.vtt',
    'code_switch.vtt',
    'code_switch_spans.json',
    'diarization.rttm',
    'speaker_profiles.json',
    'qa_result.json',
  ];

  const logEntries = [];
  const clipCandidates = [];
  const clipDirs = listSubdirs(sourceDir).filter(isAssetId);
  for (const assetId of clipDirs) {
    const clipSource = path.join(sourceDir, assetId);
    const qaPath = path.join(clipSource, 'qa_result.json');
    if (!fs.existsSync(qaPath)) {
      logEntries.push(`SKIPPED ${assetId} reason=missing_qa_result`);
      continue;
    }

    let qa;
    try {
      qa = JSON.parse(fs.readFileSync(qaPath, 'utf-8'));
    } catch (err) {
      logEntries.push(`SKIPPED ${assetId} reason=invalid_qa_json`);
      continue;
    }

    const requiredMetrics = [
      'code_switch_f1_at300ms',
      'diarization_boundary_mae_sec',
      'cue_delta_sec',
      'translation_pct_in_bounds',
    ];

    const hasAllMetrics = requiredMetrics.every(
      (metric) => qa[metric] !== undefined && qa[metric] !== null && !Number.isNaN(Number(qa[metric]))
    );
    if (!hasAllMetrics) {
      logEntries.push(`SKIPPED ${assetId} reason=missing_metrics`);
      continue;
    }

    const goldTarget = Boolean(
      qa.goldTarget || qa.gold_target || qa.isGold || qa.gold === true || qa.target === 'gold'
    );
    if (!includeGold && goldTarget) {
      logEntries.push(`SKIPPED ${assetId} reason=gold_target_excluded`);
      continue;
    }

    const f1 = Number(qa.code_switch_f1_at300ms);
    if (Number.isNaN(f1) || f1 < minF1) {
      logEntries.push(`SKIPPED ${assetId} reason=f1_below_threshold value=${f1.toFixed(4)}`);
      continue;
    }

    const transcriptPath = path.join(clipSource, 'transcript.vtt');
    if (!fs.existsSync(transcriptPath)) {
      logEntries.push(`SKIPPED ${assetId} reason=missing_transcript_vtt`);
      continue;
    }

    const missingFile = requiredFiles.find((file) => !fs.existsSync(path.join(clipSource, file)));
    if (missingFile) {
      logEntries.push(`SKIPPED ${assetId} reason=missing_file file=${missingFile}`);
      continue;
    }

    const totalDuration = sumDurationsFromVTT(transcriptPath);
    const split = hashToSplit(assetId, splitRatios, splitLabels);
    const rightsList = Array.isArray(rightsByAsset[assetId]) ? [...rightsByAsset[assetId]] : [];
    const qaMetrics = {
      f1,
      mae: Number(qa.diarization_boundary_mae_sec),
      cueDelta: Number(qa.cue_delta_sec),
      translationPct: Number(qa.translation_pct_in_bounds),
    };

    clipCandidates.push({
      assetId,
      clipSource,
      totalDurationSec: totalDuration,
      split,
      qaMetrics,
      rightsList,
    });
  }

  const datasetRecords = [];
  const qaGlobal = {
    f1Values: [],
    maeValues: [],
    pctInBoundsValues: [],
    cueDeltaValues: [],
  };
  const splitCounts = {};
  const rightsCounts = {};
  const provenanceValueCounts = {};
  PROVENANCE_FIELDS.forEach((field) => {
    provenanceValueCounts[field] = {};
  });
  let provenanceCompleteCount = 0;

  const MIN_PUBLIC_DURATION_SEC = 30 * 60;
  const MAX_PUBLIC_DURATION_SEC = 60 * 60;
  let selectedClips = clipCandidates;
  if (isPublic) {
    selectedClips = samplePublicSubset(clipCandidates, MIN_PUBLIC_DURATION_SEC, MAX_PUBLIC_DURATION_SEC);
    const selectedSet = new Set(selectedClips.map((clip) => clip.assetId));
    clipCandidates.forEach((clip) => {
      if (selectedSet.has(clip.assetId)) {
        logEntries.push(
          `PUBLIC_SELECTED ${clip.assetId} duration_sec=${clip.totalDurationSec.toFixed(3)}`
        );
      } else {
        logEntries.push(`PUBLIC_NOT_SELECTED ${clip.assetId}`);
      }
    });
    const selectedDurationSec = selectedClips.reduce(
      (acc, clip) => acc + (clip.totalDurationSec || 0),
      0
    );
    if (selectedDurationSec < MIN_PUBLIC_DURATION_SEC) {
      logEntries.push(
        `PUBLIC_WARNING insufficient_duration selected_sec=${selectedDurationSec.toFixed(3)}`
      );
    } else if (selectedDurationSec > MAX_PUBLIC_DURATION_SEC) {
      logEntries.push(
        `PUBLIC_WARNING duration_above_max selected_sec=${selectedDurationSec.toFixed(3)}`
      );
    }
  }

  let totalDurationSec = 0;
  for (const clip of selectedClips) {
    const destinationClipDir = path.join(clipsDestRoot, clip.assetId);
    ensureDir(destinationClipDir);

    const files = {};
    for (const fileName of requiredFiles) {
      const srcPath = path.join(clip.clipSource, fileName);
      const destPath = path.join(destinationClipDir, fileName);
      if (isPublic && (fileName === 'transcript.vtt' || fileName === 'translation.vtt')) {
        const redactedContent = redactVtt(srcPath);
        fs.writeFileSync(destPath, redactedContent);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      files[fileName] = path.relative(datasetRoot, destPath);
    }

    const videoFileName = findFirstVideoAsset(clip.clipSource);
    if (videoFileName) {
      const srcVideoPath = path.join(clip.clipSource, videoFileName);
      blurVideoPlaceholder(srcVideoPath);
      const destVideoPath = path.join(destinationClipDir, videoFileName);
      fs.copyFileSync(srcVideoPath, destVideoPath);
      files[videoFileName] = path.relative(datasetRoot, destVideoPath);
    }

    const transcriptDestPath = path.join(destinationClipDir, 'transcript.vtt');
    const voiceTags = extractVoiceTagsFromVtt(transcriptDestPath);

    const record = {
      asset_id: clip.assetId,
      split: clip.split,
      summary: {
        total_duration_sec: clip.totalDurationSec,
      },
      qa: {
        code_switch_f1_at300ms: clip.qaMetrics.f1,
        diarization_boundary_mae_sec: clip.qaMetrics.mae,
        cue_delta_sec: clip.qaMetrics.cueDelta,
        translation_pct_in_bounds: clip.qaMetrics.translationPct,
      },
      voice_tags: voiceTags,
      files,
      rights: clip.rightsList,
    };

    const provenanceEntry = provenanceByClip[clip.assetId] || {};
    const provenanceForRecord = {};
    PROVENANCE_FIELDS.forEach((field) => {
      const value = provenanceEntry[field];
      provenanceForRecord[field] = value !== undefined ? value : null;
    });
    Object.assign(record, provenanceForRecord);

    let hasCompleteProvenance = true;
    PROVENANCE_FIELDS.forEach((field) => {
      const value = record[field];
      if (value === null || value === undefined) {
        hasCompleteProvenance = false;
        return;
      }
      const counts = provenanceValueCounts[field];
      const key = formatProvenanceCountKey(value);
      counts[key] = (counts[key] || 0) + 1;
    });
    if (hasCompleteProvenance) {
      provenanceCompleteCount += 1;
    }

    if (isPublic) {
      record.blurred = true;
    }

    datasetRecords.push(record);

    qaGlobal.f1Values.push(clip.qaMetrics.f1);
    qaGlobal.maeValues.push(clip.qaMetrics.mae);
    qaGlobal.pctInBoundsValues.push(clip.qaMetrics.translationPct);
    qaGlobal.cueDeltaValues.push(clip.qaMetrics.cueDelta);

    totalDurationSec += clip.totalDurationSec;

    splitCounts[clip.split] = (splitCounts[clip.split] || 0) + 1;

    clip.rightsList.forEach((right) => {
      rightsCounts[right] = (rightsCounts[right] || 0) + 1;
    });

    const logLabel = isPublic ? 'PUBLIC_EXPORTED' : 'INCLUDED';
    logEntries.push(
      `${logLabel} ${clip.assetId} split=${clip.split} duration_sec=${clip.totalDurationSec.toFixed(3)}`
    );
  }

  const datasetJsonlPath = path.join(datasetRoot, 'dataset.jsonl');
  const qaSummaryPath = path.join(datasetRoot, 'qa_summary.json');
  const coverageSummaryPath = path.join(datasetRoot, 'coverage_summary.json');
  const datasetCardPath = path.join(datasetRoot, 'dataset_card.md');
  const trainingSummaryPath = path.join(datasetRoot, 'training_data_summary.json');
  const exportLogPath = path.join(datasetRoot, 'export_log.txt');

  const datasetJsonl = datasetRecords.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(datasetJsonlPath, datasetJsonl + (datasetRecords.length ? '\n' : ''));

  const qaSummary = {
    count: datasetRecords.length,
    mean_f1: datasetRecords.length ? mean(qaGlobal.f1Values) : 0,
    std_f1: datasetRecords.length ? std(qaGlobal.f1Values) : 0,
    mean_mae: datasetRecords.length ? mean(qaGlobal.maeValues) : 0,
    std_mae: datasetRecords.length ? std(qaGlobal.maeValues) : 0,
    mean_translation_pct_in_bounds: datasetRecords.length ? mean(qaGlobal.pctInBoundsValues) : 0,
    std_translation_pct_in_bounds: datasetRecords.length ? std(qaGlobal.pctInBoundsValues) : 0,
    mean_cue_delta_sec: datasetRecords.length ? mean(qaGlobal.cueDeltaValues) : 0,
    std_cue_delta_sec: datasetRecords.length ? std(qaGlobal.cueDeltaValues) : 0,
  };
  fs.writeFileSync(qaSummaryPath, JSON.stringify(qaSummary, null, 2));

  try {
    const coverageSummary = computeCoverageSummary({ datasetPath: datasetJsonlPath });
    fs.writeFileSync(coverageSummaryPath, JSON.stringify(coverageSummary, null, 2));
  } catch (err) {
    console.warn('Warning: failed to compute coverage summary', err);
  }

  const durationHours = totalDurationSec / 3600;
  const splitLines = Object.entries(splitCounts)
    .map(([name, count]) => `- ${name}: ${count}`)
    .join('\n');

  if (isPublic) {
    const publicSummaryPath = path.join(datasetRoot, 'public_eval_summary.json');
    const publicSummary = {
      clip_count: datasetRecords.length,
      total_minutes: Number((totalDurationSec / 60).toFixed(2)),
      rights_distribution: rightsCounts,
      duration_bounds_minutes: {
        min: MIN_PUBLIC_DURATION_SEC / 60,
        max: MAX_PUBLIC_DURATION_SEC / 60,
      },
    };
    fs.writeFileSync(publicSummaryPath, JSON.stringify(publicSummary, null, 2));
  }

  let datasetCard = `# Stage 2 Dataset Export - Version ${version}\n\n` +
    `- Total clips: ${datasetRecords.length}\n` +
    `- Total duration (hours): ${durationHours.toFixed(2)}\n` +
    `- Mean code-switch F1 @300ms: ${qaSummary.mean_f1.toFixed(4)}\n` +
    `- Mean diarization boundary MAE (sec): ${qaSummary.mean_mae.toFixed(4)}\n` +
    `- Mean translation % in bounds: ${qaSummary.mean_translation_pct_in_bounds.toFixed(4)}\n` +
    `- Mean cue delta (sec): ${qaSummary.mean_cue_delta_sec.toFixed(4)}\n\n` +
    `## Split Distribution\n${splitLines || '- None'}\n\n` +
    `## QA Metrics Distribution\n` +
    `- F1 std dev: ${qaSummary.std_f1.toFixed(4)}\n` +
    `- MAE std dev: ${qaSummary.std_mae.toFixed(4)}\n` +
    `- Translation % in bounds std dev: ${qaSummary.std_translation_pct_in_bounds.toFixed(4)}\n` +
    `- Cue delta std dev: ${qaSummary.std_cue_delta_sec.toFixed(4)}\n\n` +
    `## Rights Notice\n` +
    `This dataset is derived from Stage 2 pipeline outputs. Ensure all downstream usage respects the original content rights and internal compliance policies.\n\n` +
    `Each dataset record includes associated rights metadata to enable downstream usage policy enforcement.`;

  if (isPublic) {
    datasetCard +=
      `\n\n## Public Evaluation Subset\n` +
      `This export represents the public evaluation subset of the Stage 2 dataset. ` +
      `Transcripts and translations have safety- and privacy-sensitive spans replaced with [REDACTED], ` +
      `and video assets are flagged for blurring to support safe external evaluation. ` +
      `The subset is intended for public evaluation scenarios while protecting personal or sensitive content.`;
  }

  fs.writeFileSync(datasetCardPath, datasetCard);

  const trainingSummary = {
    dataset_version: version,
    total_clips: datasetRecords.length,
    total_duration_hours: Number(durationHours.toFixed(2)),
    data_sources: ['Stage 2 aggregated outputs'],
    license_types: [isPublic ? 'Public evaluation' : 'Internal use only'],
    languages: ['Code-switched (multiple)'],
    modalities: ['Audio', 'Text transcripts', 'Translations'],
    annotations: [
      'Transcripts',
      'Translations',
      'Code-switch spans',
      'Speaker diarization',
      'QA evaluations',
    ],
    average_code_switch_F1_at300ms: Number(qaSummary.mean_f1.toFixed(4)),
    average_diarization_boundary_MAE_sec: Number(qaSummary.mean_mae.toFixed(4)),
    collection_start: null,
    collection_end: null,
    rights_provenance_summary:
      'Clips sourced from Stage 2 pipeline outputs with validated rights for internal research use.',
    compliance_notes: 'Ensure usage complies with internal data handling and privacy policies.',
    rights_distribution: rightsCounts,
  };

  const provenanceCountsForSummary = {};
  PROVENANCE_FIELDS.forEach((field) => {
    provenanceCountsForSummary[field] = { ...provenanceValueCounts[field] };
  });
  const provenanceCompleteProportion =
    datasetRecords.length > 0
      ? Number((provenanceCompleteCount / datasetRecords.length).toFixed(4))
      : 0;

  trainingSummary.provenance_value_counts = provenanceCountsForSummary;
  trainingSummary.provenance_complete_count = provenanceCompleteCount;
  trainingSummary.provenance_complete_proportion = provenanceCompleteProportion;

  fs.writeFileSync(trainingSummaryPath, JSON.stringify(trainingSummary, null, 2));

  fs.writeFileSync(exportLogPath, logEntries.join('\n'));

  console.log(`Export complete. ${datasetRecords.length} clips written to ${datasetRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
