#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'];
const DATASET_REQUIRED_TYPES = {
  audio: {
    label: 'audio',
    candidateKeys: ['audio', 'audio_file', 'audio_path', 'audioFile', 'audioPath', 'media_audio', 'mediaAudio'],
    predicate: (key, value) => hasExtension(key, value, AUDIO_EXTENSIONS) || includesToken(key, value, 'audio'),
  },
  translation: {
    label: 'translation.vtt',
    candidateKeys: ['translation', 'translation_vtt', 'translationFile', 'translation_path', 'translation.vtt'],
    predicate: (key, value) => hasExtension(key, value, ['.vtt']) && includesToken(key, value, 'translation'),
  },
  diarization: {
    label: 'diarization.rttm',
    candidateKeys: ['diarization', 'diarization_rttm', 'diarization.rttm'],
    predicate: (key, value) => hasExtension(key, value, ['.rttm']) || includesToken(key, value, 'diarization'),
  },
  speakerProfiles: {
    label: 'speaker_profiles.json',
    candidateKeys: ['speaker_profiles', 'speakerProfiles', 'speaker_profiles.json'],
    predicate: (key, value) => hasExtension(key, value, ['.json']) && includesToken(key, value, 'speaker'),
  },
};

const QA_THRESHOLDS = {
  meanF1: 0.8,
  meanTranslationCompleteness: 0.9,
  maxDiarizationMae: 1.0,
};

function includesToken(key, value, token) {
  const lower = token.toLowerCase();
  return (
    (typeof key === 'string' && key.toLowerCase().includes(lower)) ||
    (typeof value === 'string' && value.toLowerCase().includes(lower))
  );
}

function hasExtension(key, value, extensions) {
  const check = (str) => {
    if (typeof str !== 'string') return false;
    const ext = path.extname(str).toLowerCase();
    return extensions.includes(ext);
  };
  return check(key) || check(value);
}

function parseJsonl(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Failed to parse dataset.jsonl line ${index + 1}: ${err.message}`);
    }
  }
  return records;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function mean(values) {
  const numeric = values.filter((v) => Number.isFinite(v));
  if (!numeric.length) return 0;
  return numeric.reduce((acc, val) => acc + val, 0) / numeric.length;
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (err) {
    return false;
  }
}

function resolveFilePath(record, datasetDir, descriptor) {
  const files = record && typeof record === 'object' ? record.files || {} : {};
  const candidates = [];

  descriptor.candidateKeys.forEach((key) => {
    if (files && Object.prototype.hasOwnProperty.call(files, key)) {
      const value = files[key];
      if (typeof value === 'string' && value.trim()) {
        candidates.push(value.trim());
      }
    }
  });

  const recordCandidates = asArray(record && record[descriptor.label]).filter((value) => typeof value === 'string');
  candidates.push(...recordCandidates);

  if (!candidates.length) {
    for (const [key, value] of Object.entries(files)) {
      if (typeof value !== 'string') continue;
      if (descriptor.predicate(key, value)) {
        candidates.push(value.trim());
        break;
      }
    }
  }

  for (const relative of candidates) {
    if (!relative) continue;
    const resolved = path.isAbsolute(relative) ? relative : path.resolve(datasetDir, relative);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function validateRecordFiles(record, datasetDir) {
  const missing = [];
  const resolvedPaths = {};

  for (const [key, descriptor] of Object.entries(DATASET_REQUIRED_TYPES)) {
    const resolved = resolveFilePath(record, datasetDir, descriptor);
    if (!resolved) {
      missing.push(`Missing reference for ${descriptor.label}`);
      continue;
    }
    const exists = await fileExists(resolved);
    if (!exists) {
      missing.push(`Referenced ${descriptor.label} not found at ${resolved}`);
      continue;
    }
    resolvedPaths[key] = resolved;
  }

  return { missing, resolvedPaths };
}

async function loadJsonFile(filePath, description) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to read ${description} at ${filePath}: ${err.message}`);
  }
}

function computeCoverageCompleteness(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return 0;
  }
  const fromField = Number(snapshot.coverage_completeness);
  if (Number.isFinite(fromField)) {
    return fromField;
  }
  const cells = Array.isArray(snapshot.cells) ? snapshot.cells : [];
  if (!cells.length) {
    return 0;
  }
  const sum = cells.reduce((acc, cell) => acc + (Number(cell.pct_of_target) || 0), 0);
  return sum / cells.length;
}

async function main() {
  const datasetDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!datasetDir) {
    console.error('Usage: node scripts/smoke_v0.1.js <dataset-directory>');
    process.exit(1);
  }

  const issues = [];

  const datasetJsonlPath = path.join(datasetDir, 'dataset.jsonl');
  let records = [];
  try {
    const datasetText = await fs.readFile(datasetJsonlPath, 'utf-8');
    records = parseJsonl(datasetText);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!records.length) {
    issues.push('Dataset has no records.');
  }

  let totalDurationSec = 0;
  let recordIndex = 0;
  for (const record of records) {
    recordIndex += 1;
    const duration = Number(
      (record && record.summary && record.summary.total_duration_sec) ||
        (record && record.summary && record.summary.total_duration_seconds)
    );
    if (!Number.isFinite(duration) || duration <= 0) {
      issues.push(`Record ${record && record.asset_id ? record.asset_id : recordIndex} has invalid duration.`);
    } else {
      totalDurationSec += duration;
    }

    const { missing } = await validateRecordFiles(record, datasetDir);
    missing.forEach((msg) => {
      issues.push(`Record ${record && record.asset_id ? record.asset_id : recordIndex}: ${msg}`);
    });
  }

  if (totalDurationSec <= 0) {
    issues.push('Total dataset duration is zero.');
  }

  const qaReportPath = path.join(datasetDir, 'qa_report.json');
  let meanF1 = 0;
  let meanMae = 0;
  let meanTranslation = 0;
  try {
    const qaReport = await loadJsonFile(qaReportPath, 'QA report');
    const summary = qaReport && qaReport.summary ? qaReport.summary : {};
    if (summary && Object.keys(summary).length) {
      meanF1 = Number(summary.averageCodeSwitchF1) || 0;
      meanMae = Number(summary.averageDiarizationMAE) || 0;
      meanTranslation = Number(
        summary.translationCompletenessAvg !== undefined
          ? summary.translationCompletenessAvg
          : summary.translationCharRatioAvg
      );
    }
    if (!meanF1 || !meanMae || !meanTranslation) {
      const clips = Array.isArray(qaReport && qaReport.clips) ? qaReport.clips : [];
      if (clips.length) {
        const f1Values = clips.map((clip) => Number(clip && clip.codeswitch_f1));
        const maeValues = clips.map((clip) => Number(clip && clip.diarization_mae));
        const translationValues = clips.map((clip) => {
          const comp = Number(clip && clip.translation_completeness);
          if (Number.isFinite(comp)) return comp;
          const ratio = Number(clip && clip.translation_char_ratio);
          return Number.isFinite(ratio) ? ratio : null;
        });
        meanF1 = meanF1 || mean(f1Values);
        meanMae = meanMae || mean(maeValues);
        meanTranslation = meanTranslation || mean(translationValues);
      }
    }
  } catch (err) {
    issues.push(err.message);
  }

  if (!Number.isFinite(meanF1) || meanF1 <= 0) {
    issues.push('Mean code-switch F1 could not be computed.');
  } else if (meanF1 < QA_THRESHOLDS.meanF1) {
    issues.push(`Mean code-switch F1 ${meanF1.toFixed(4)} is below threshold ${QA_THRESHOLDS.meanF1}.`);
  }

  if (!Number.isFinite(meanMae) || meanMae <= 0) {
    issues.push('Mean diarization MAE could not be computed.');
  } else if (meanMae > QA_THRESHOLDS.maxDiarizationMae) {
    issues.push(`Mean diarization MAE ${meanMae.toFixed(4)} exceeds threshold ${QA_THRESHOLDS.maxDiarizationMae}.`);
  }

  if (!Number.isFinite(meanTranslation) || meanTranslation <= 0) {
    issues.push('Mean translation completeness could not be computed.');
  } else if (meanTranslation < QA_THRESHOLDS.meanTranslationCompleteness) {
    issues.push(
      `Mean translation completeness ${meanTranslation.toFixed(4)} is below threshold ${QA_THRESHOLDS.meanTranslationCompleteness}.`
    );
  }

  const coverageSnapshotPath = path.join(datasetDir, 'coverage_snapshot.json');
  let coverageCompleteness = 0;
  try {
    const snapshot = await loadJsonFile(coverageSnapshotPath, 'coverage snapshot');
    coverageCompleteness = computeCoverageCompleteness(snapshot);
    const lowestCells = snapshot ? snapshot.lowest_cells : undefined;
    if (!Array.isArray(lowestCells)) {
      issues.push('Coverage snapshot missing lowest_cells array.');
    }
  } catch (err) {
    issues.push(err.message);
  }

  const trainingSummaryPath = path.join(datasetDir, 'training_data_summary.json');
  let provenanceProportion = 0;
  try {
    const trainingSummary = await loadJsonFile(trainingSummaryPath, 'training data summary');
    const completeCount = Number(trainingSummary && trainingSummary.provenance_complete_count) || 0;
    const proportion = Number(trainingSummary && trainingSummary.provenance_complete_proportion);
    if (Number.isFinite(proportion)) {
      provenanceProportion = proportion;
    } else if (records.length) {
      provenanceProportion = completeCount / records.length;
    }
    console.log(
      `Provenance completeness: ${completeCount} of ${records.length} records (${(
        (provenanceProportion || 0) * 100
      ).toFixed(2)}%).`
    );
  } catch (err) {
    issues.push(err.message);
  }

  const datasetCardPath = path.join(datasetDir, 'dataset_card.md');
  try {
    const datasetCard = await fs.readFile(datasetCardPath, 'utf-8');
    if (!/##\s+Coverage snapshot/i.test(datasetCard)) {
      issues.push('dataset_card.md is missing a Coverage snapshot section.');
    }
    if (!/##\s+Provenance/i.test(datasetCard)) {
      issues.push('dataset_card.md is missing a Provenance summary section.');
    }
  } catch (err) {
    issues.push(`Failed to read dataset card at ${datasetCardPath}: ${err.message}`);
  }

  const totalHours = totalDurationSec / 3600;
  console.log(
    `SUMMARY total_records=${records.length} total_hours=${totalHours.toFixed(2)} mean_f1=${meanF1
      .toFixed(4)} diarization_mae=${meanMae.toFixed(4)} translation_completeness=${meanTranslation
      .toFixed(4)} coverage_completeness=${coverageCompleteness.toFixed(4)} provenance_complete_proportion=${provenanceProportion.toFixed(4)}`
  );

  if (issues.length) {
    console.error('Smoke checks failed:');
    issues.forEach((issue) => console.error(`- ${issue}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
