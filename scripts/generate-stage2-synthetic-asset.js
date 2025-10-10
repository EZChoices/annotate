#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUTPUT_ROOT = path.join(
  __dirname,
  '..',
  'public',
  'data',
  'stage2_output',
  'synthetic_long_clip',
);

const CLIP_DURATION = 15 * 60; // 15 minutes
const TRANSCRIPT_CUE_COUNT = 360;
const SPAN_COUNT = 200;
const DIAR_SEGMENT_DURATION = 7.5;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function formatTime(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(clamped / 3600)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((clamped % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const secs = (clamped % 60).toFixed(3).padStart(6, '0');
  return `${hours}:${minutes}:${secs}`;
}

function buildCues({ label, offset = 0 }) {
  const cues = [];
  const step = CLIP_DURATION / TRANSCRIPT_CUE_COUNT;
  for (let i = 0; i < TRANSCRIPT_CUE_COUNT; i += 1) {
    const start = Number((i * step + offset).toFixed(3));
    const baseEnd = start + step * 0.92;
    const end = i === TRANSCRIPT_CUE_COUNT - 1 ? CLIP_DURATION : Math.min(CLIP_DURATION, baseEnd);
    cues.push({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      text: `${label} transcript cue ${i + 1}`,
    });
  }
  return cues;
}

function cuesToVtt(cues) {
  const lines = ['WEBVTT', ''];
  cues.forEach((cue, index) => {
    lines.push(`${formatTime(cue.start)} --> ${formatTime(cue.end)}`);
    lines.push(cue.text || `Cue ${index + 1}`);
    lines.push('');
  });
  return `${lines.join('\n').trim()}\n`;
}

function buildCodeSwitchSpans(label) {
  const spans = [];
  const languages = ['eng', 'fra', 'ara', 'other'];
  const spanLength = CLIP_DURATION / SPAN_COUNT;
  for (let i = 0; i < SPAN_COUNT; i += 1) {
    const start = Number((i * spanLength).toFixed(3));
    const end = Number(Math.min(CLIP_DURATION, start + spanLength * 0.95).toFixed(3));
    spans.push({
      start,
      end,
      lang: languages[(i + (label === 'Pass 2' ? 1 : 0)) % languages.length],
    });
  }
  return spans;
}

function buildDiarization() {
  const entries = [];
  let start = 0;
  let speaker = 1;
  while (start < CLIP_DURATION) {
    const duration = Math.min(DIAR_SEGMENT_DURATION, CLIP_DURATION - start);
    entries.push(
      [
        'SPEAKER',
        'synthetic_long_clip',
        '1',
        start.toFixed(3),
        duration.toFixed(3),
        '<NA>',
        '<NA>',
        `S${speaker}`,
        '<NA>',
      ].join(' '),
    );
    start += duration;
    speaker = speaker === 1 ? 2 : 1;
  }
  return `${entries.join('\n')}\n`;
}

function buildMarkerVtt(label) {
  const step = CLIP_DURATION / 30;
  const cues = [];
  for (let i = 0; i < 30; i += 1) {
    const start = Number((i * step).toFixed(3));
    const end = Number(Math.min(CLIP_DURATION, start + 1.5).toFixed(3));
    cues.push({ start, end, text: `${label} marker ${i + 1}` });
  }
  return cuesToVtt(cues);
}

function writeFile(target, contents) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, contents);
}

function createPass(passNumber) {
  const label = `Pass ${passNumber}`;
  const offset = passNumber === 2 ? 0.12 : 0;
  const transcript = buildCues({ label, offset });
  const translation = transcript.map((cue, index) => ({
    start: cue.start,
    end: cue.end,
    text: `${label} translation line ${index + 1}`,
  }));
  const spans = buildCodeSwitchSpans(label);

  const baseDir = path.join(OUTPUT_ROOT, `pass_${passNumber}`);
  writeFile(path.join(baseDir, 'transcript.vtt'), cuesToVtt(transcript));
  writeFile(path.join(baseDir, 'translation.vtt'), cuesToVtt(translation));
  writeFile(
    path.join(baseDir, 'code_switch_spans.json'),
    JSON.stringify({ spans }, null, 2),
  );
  writeFile(path.join(baseDir, 'diarization.rttm'), buildDiarization());
  writeFile(path.join(baseDir, 'emotion.vtt'), buildMarkerVtt(`${label} emotion`));
  writeFile(path.join(baseDir, 'events.vtt'), buildMarkerVtt(`${label} event`));
}

function createItemMeta() {
  const meta = {
    asset_id: 'synthetic_long_clip',
    cell: 'SYN-001',
    review_status: 'assigned',
    adjudication: { status: 'in_progress' },
    assignments: [
      { pass_number: 1, annotator_id: 'annotator_alpha' },
      { pass_number: 2, annotator_id: 'annotator_beta' },
    ],
    passes: {
      pass_1: {
        annotator_id: 'annotator_alpha',
        audio_url: '/public/sample.mp4',
      },
      pass_2: {
        annotator_id: 'annotator_beta',
        audio_url: '/public/sample.mp4',
      },
    },
  };
  writeFile(path.join(OUTPUT_ROOT, 'item_meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

function main() {
  createPass(1);
  createPass(2);
  createItemMeta();
  console.log('Synthetic Stage-2 asset generated at', OUTPUT_ROOT);
}

main();
