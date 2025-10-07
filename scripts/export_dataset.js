#!/usr/bin/env node

const fs = require('fs');
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

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      source: { type: 'string', default: 'data/stage2_output' },
      out: { type: 'string', default: 'datasets' },
      'include-gold': { type: 'boolean', default: true },
      minF1: { type: 'string', default: '0.80' },
      splitRatio: { type: 'string', default: '0.8,0.1,0.1' },
    },
  });

  const version = values.version;
  if (!version) {
    console.error('Error: --version is required.');
    process.exit(1);
  }

  const sourceDir = path.resolve(values.source || 'data/stage2_output');
  const outDir = path.resolve(values.out || 'datasets');
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

  const datasetRoot = path.join(outDir, version);
  const clipsDestRoot = path.join(datasetRoot, 'clips');
  ensureDir(clipsDestRoot);

  const datasetRecords = [];
  const qaGlobal = {
    f1Values: [],
    maeValues: [],
    pctInBoundsValues: [],
    cueDeltaValues: [],
  };
  let totalDurationSec = 0;
  const splitCounts = {};
  const logEntries = [];

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

    const requiredFiles = [
      'transcript.vtt',
      'translation.vtt',
      'code_switch.vtt',
      'code_switch_spans.json',
      'diarization.rttm',
      'speaker_profiles.json',
      'qa_result.json',
    ];

    const missingFile = requiredFiles.find((file) => !fs.existsSync(path.join(clipSource, file)));
    if (missingFile) {
      logEntries.push(`SKIPPED ${assetId} reason=missing_file file=${missingFile}`);
      continue;
    }

    const totalDuration = sumDurationsFromVTT(transcriptPath);
    totalDurationSec += totalDuration;

    const split = hashToSplit(assetId, splitRatios, splitLabels);
    splitCounts[split] = (splitCounts[split] || 0) + 1;

    const destinationClipDir = path.join(clipsDestRoot, assetId);
    ensureDir(destinationClipDir);

    const files = {};
    for (const fileName of requiredFiles) {
      const srcPath = path.join(clipSource, fileName);
      const destPath = path.join(destinationClipDir, fileName);
      fs.copyFileSync(srcPath, destPath);
      files[fileName] = path.relative(datasetRoot, destPath);
    }

    const voiceTags = extractVoiceTagsFromVtt(transcriptPath);

    datasetRecords.push({
      asset_id: assetId,
      split,
      summary: {
        total_duration_sec: totalDuration,
      },
      qa: {
        code_switch_f1_at300ms: f1,
        diarization_boundary_mae_sec: Number(qa.diarization_boundary_mae_sec),
        cue_delta_sec: Number(qa.cue_delta_sec),
        translation_pct_in_bounds: Number(qa.translation_pct_in_bounds),
      },
      voice_tags: voiceTags,
      files,
    });

    qaGlobal.f1Values.push(f1);
    qaGlobal.maeValues.push(Number(qa.diarization_boundary_mae_sec));
    qaGlobal.pctInBoundsValues.push(Number(qa.translation_pct_in_bounds));
    qaGlobal.cueDeltaValues.push(Number(qa.cue_delta_sec));

    logEntries.push(`INCLUDED ${assetId} split=${split} duration_sec=${totalDuration.toFixed(3)}`);
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

  const datasetCard = `# Stage 2 Dataset Export - Version ${version}\n\n` +
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
    `This dataset is derived from Stage 2 pipeline outputs. Ensure all downstream usage respects the original content rights and internal compliance policies.`;

  fs.writeFileSync(datasetCardPath, datasetCard);

  const trainingSummary = {
    dataset_version: version,
    total_clips: datasetRecords.length,
    total_duration_hours: Number(durationHours.toFixed(2)),
    data_sources: ['Stage 2 aggregated outputs'],
    license_types: ['Internal use only'],
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
  };

  fs.writeFileSync(trainingSummaryPath, JSON.stringify(trainingSummary, null, 2));

  fs.writeFileSync(exportLogPath, logEntries.join('\n'));

  console.log(`Export complete. ${datasetRecords.length} clips written to ${datasetRoot}`);
}

main();
