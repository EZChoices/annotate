"use strict";

// Basic Stage 2 flow controller with offline queue and simple VTT editors.

const EAQ = {
  SPEC: {
    maxCacheMB: 300,
    cueMin: 0.6,
    cueMax: 6.0,
    csMinSec: 0.4,
    backoffMs: [1000,2000,5000,10000,30000],
    emotionMinSec: 1.5
  },
  state: {
    annotator: null,
    manifest: null,
    idx: 0,
    transcriptVTT: '',
    translationVTT: '',
    codeSwitchVTT: '',
    transcriptCues: [],
    translationCues: [],
    codeSwitchCues: [],
    codeSwitchSpans: [],
    codeSwitchSelectedIndex: null,
    codeSwitchHistory: [],
    codeSwitchFuture: [],
    codeSwitchActive: null,
    codeSwitchSummary: null,
    codeSwitchToastTimer: null,
    codeSwitchDrag: null,
    emotionSpans: [],
    emotionHistory: [],
    emotionFuture: [],
    emotionActive: null,
    emotionSelectedIndex: null,
    emotionDrag: null,
    safetyEvents: [],
    safetyHistory: [],
    safetyFuture: [],
    safetySelectedIndex: null,
    safetyDrag: null,
    clipFlagged: false,
    diarSegments: [],
    diarSelectedIndex: null,
    diarColorMap: {},
    diarizationSourcePath: null,
    speakerProfiles: [],
    startedAt: 0,
    lintReport: { errors: [], warnings: [] }
  }
};

const SPEAKER_GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'nonbinary', label: 'Nonbinary' },
  { value: 'unknown', label: 'Unknown' }
];
const SPEAKER_GENDERS = SPEAKER_GENDER_OPTIONS.map(opt=> opt.value);
const SPEAKER_GENDER_SET = new Set(SPEAKER_GENDERS);

const SPEAKER_AGE_OPTIONS = [
  { value: 'child', label: 'Child' },
  { value: 'teen', label: 'Teen' },
  { value: 'young_adult', label: 'Young Adult' },
  { value: 'adult', label: 'Adult' },
  { value: 'elderly', label: 'Elderly' },
  { value: 'unknown', label: 'Unknown' }
];
const SPEAKER_AGE_BANDS = SPEAKER_AGE_OPTIONS.map(opt=> opt.value);
const SPEAKER_AGE_SET = new Set(SPEAKER_AGE_BANDS);

const SPEAKER_DIALECT_OPTIONS = [
  { value: 'levantine', label: 'Levantine' },
  { value: 'iraqi', label: 'Iraqi' },
  { value: 'gulf', label: 'Gulf' },
  { value: 'yemeni', label: 'Yemeni' },
  { value: 'egyptian', label: 'Egyptian' },
  { value: 'maghrebi', label: 'Maghrebi' },
  { value: 'msa', label: 'MSA' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'other', label: 'Other' },
  { value: 'unknown', label: 'Unknown' }
];
const SPEAKER_DIALECTS = SPEAKER_DIALECT_OPTIONS.map(opt=> opt.value);
const SPEAKER_DIALECT_SET = new Set(SPEAKER_DIALECTS);

const CODE_SWITCH_LANGS = {
  eng: { label: 'EN', color: '#2b7cff', background: 'rgba(43,124,255,0.28)' },
  fra: { label: 'FR', color: '#9b59b6', background: 'rgba(155,89,182,0.28)' },
  other: { label: 'Other', color: '#16a085', background: 'rgba(22,160,133,0.28)' }
};

const CODE_SWITCH_MIN_DURATION = EAQ.SPEC.csMinSec || 0.4;

const EMOTION_OPTIONS = [
  { id: 'neutral', label: 'Neutral', color: '#6b7280', background: 'rgba(107,114,128,0.35)' },
  { id: 'happy', label: 'Happy', color: '#f59e0b', background: 'rgba(245,158,11,0.38)' },
  { id: 'angry', label: 'Angry', color: '#ef4444', background: 'rgba(239,68,68,0.4)' },
  { id: 'sad', label: 'Sad', color: '#3b82f6', background: 'rgba(59,130,246,0.35)' },
  { id: 'excited', label: 'Excited', color: '#8b5cf6', background: 'rgba(139,92,246,0.4)' },
  { id: 'other', label: 'Other', color: '#10b981', background: 'rgba(16,185,129,0.38)' }
];

const EMOTION_LABEL_SET = new Set(EMOTION_OPTIONS.map(opt=> opt.id));
const EMOTION_ALIASES = {
  anger: 'angry',
  mad: 'angry',
  upset: 'angry',
  happiness: 'happy',
  joy: 'happy',
  joyful: 'happy',
  excite: 'excited',
  excited: 'excited',
  sadness: 'sad',
  upset_sad: 'sad',
  neutral: 'neutral'
};

const SAFETY_EVENT_TYPES = [
  { id: 'pii_name', label: 'PII: Name', color: '#f97316' },
  { id: 'pii_phone', label: 'PII: Phone', color: '#ef4444' },
  { id: 'minor_face', label: 'Minor Face', color: '#0ea5e9' },
  { id: 'political', label: 'Political', color: '#a855f7' },
  { id: 'religious', label: 'Religious', color: '#22c55e' },
  { id: 'explicit', label: 'Explicit', color: '#dc2626' }
];

const SAFETY_TYPE_SET = new Set(SAFETY_EVENT_TYPES.map(opt=> opt.id));

const EMOTION_MIN_DURATION = EAQ.SPEC.emotionMinSec || 1.5;
const EMOTION_DRAG_MAX_DELTA = 0.2;
const SAFETY_DEFAULT_DURATION = 0.5;
const SAFETY_DRAG_MAX_DELTA = 0.5;

const MANIFEST_STORAGE_KEY = 'ea_stage2_manifest';

const DIARIZATION_COLORS = [
  '#4e79a7',
  '#f28e2b',
  '#e15759',
  '#76b7b2',
  '#59a14f',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac'
];

function saveManifestToStorage(manifest){
  if(!manifest) return;
  try{
    localStorage.setItem(MANIFEST_STORAGE_KEY, JSON.stringify(manifest));
  }catch{}
}

function loadManifestFromStorage(){
  try{
    const raw = localStorage.getItem(MANIFEST_STORAGE_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch{
    return null;
  }
}

function getAnnotatorId(){
  try{
    const k = 'ea_stage2_annotator_id';
    let v = localStorage.getItem(k);
    if(!v){ v = Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); }
    return v;
  }catch{ return 'anonymous'; }
}

function qs(id){ return document.getElementById(id); }

function escapeHtml(str){
  return String(str||'').replace(/[&<>"']/g, (s)=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":"&#39;"
  })[s]);
}

function normalizeSpeakerGender(val){
  const raw = val==null ? '' : String(val).trim().toLowerCase();
  if(!raw) return 'unknown';
  const normalized = raw.replace(/[\s-]+/g,'_');
  const aliases = {
    m: 'male',
    male: 'male',
    man: 'male',
    f: 'female',
    female: 'female',
    woman: 'female',
    non_binary: 'nonbinary',
    nonbinary: 'nonbinary',
    nb: 'nonbinary'
  };
  const candidate = aliases[normalized] || normalized;
  return SPEAKER_GENDER_SET.has(candidate) ? candidate : 'unknown';
}

function normalizeSpeakerAge(val){
  const raw = val==null ? '' : String(val).trim().toLowerCase();
  if(!raw) return 'unknown';
  const normalized = raw.replace(/[\s-]+/g,'_');
  return SPEAKER_AGE_SET.has(normalized) ? normalized : 'unknown';
}

function normalizeSpeakerDialect(val){
  const raw = val==null ? '' : String(val).trim().toLowerCase();
  if(!raw) return 'unknown';
  const normalized = raw.replace(/[\s-]+/g,'_');
  const aliases = {
    levant: 'levantine',
    levantine: 'levantine',
    syria: 'levantine',
    gulf: 'gulf',
    gulf_arabic: 'gulf',
    arabian_peninsula: 'gulf',
    iraq: 'iraqi',
    iraqi: 'iraqi',
    mesopotamia: 'iraqi',
    yemen: 'yemeni',
    yemeni: 'yemeni',
    egypt: 'egyptian',
    egyptian: 'egyptian',
    egyption: 'egyptian',
    maghreb: 'maghrebi',
    maghrebi: 'maghrebi',
    msa: 'msa',
    fusha: 'msa',
    classical: 'msa',
    modern_standard_arabic: 'msa',
    mixed: 'mixed',
    hybrid: 'mixed',
    sudan: 'other',
    horn_of_africa: 'other',
    other: 'other',
    unknown: 'unknown'
  };
  const candidate = aliases[normalized] || normalized;
  return SPEAKER_DIALECT_SET.has(candidate) ? candidate : 'unknown';
}

// Utility helpers -----------------------------------------------------------

function normalizeCueText(text){
  return String(text||'').replace(/[\s\u00A0]+/g, ' ').trim();
}

function countWords(text){
  const norm = normalizeCueText(text);
  if(!norm) return 0;
  return norm.split(/\s+/).filter(Boolean).length;
}

function parseVttSafe(text){
  try{ return VTT.parse(text||''); }
  catch{ return []; }
}

function chunkTextByPunctuation(text){
  const norm = normalizeCueText(text);
  if(!norm) return [];
  const parts = norm.match(/[^?!.,…]+[?!.,…]?/g);
  if(!parts) return [norm];
  return parts.map(part=> normalizeCueText(part)).filter(Boolean);
}

function splitWordsEvenly(text, desiredCount){
  const words = normalizeCueText(text).split(/\s+/).filter(Boolean);
  if(words.length === 0) return [];
  const count = Math.max(1, Math.min(desiredCount||1, words.length));
  const chunks = [];
  let idx = 0;
  for(let i=0;i<count;i++){
    const remaining = words.length - idx;
    const slotsLeft = count - i;
    const take = Math.max(1, Math.round(remaining / slotsLeft));
    const slice = words.slice(idx, idx + take);
    if(slice.length){ chunks.push(slice.join(' ')); }
    idx += take;
  }
  if(idx < words.length && chunks.length){
    chunks[chunks.length-1] = `${chunks[chunks.length-1]} ${words.slice(idx).join(' ')}`.trim();
  }
  return chunks;
}

function enforceWordLimit(chunks, limit){
  const out = [];
  const maxWords = Math.max(1, limit||18);
  (chunks||[]).forEach(chunk=>{
    const words = normalizeCueText(chunk).split(/\s+/).filter(Boolean);
    if(words.length <= maxWords){
      if(words.length){ out.push(words.join(' ')); }
      return;
    }
    const needed = Math.max(2, Math.ceil(words.length / maxWords));
    const pieces = splitWordsEvenly(words.join(' '), needed);
    pieces.forEach(p=>{ if(p && normalizeCueText(p)){ out.push(normalizeCueText(p)); } });
  });
  return out;
}

function allocateDurations(totalDuration, count, weights){
  const minDur = EAQ.SPEC.cueMin || 0.6;
  const maxDur = EAQ.SPEC.cueMax || 6.0;
  const preferredMin = Math.max(minDur, 2.5);
  const preferredMax = Math.min(maxDur, 4.0);
  const durations = [];
  if(count <= 0){ return durations; }
  let remainingDuration = totalDuration;
  let remainingWeight = (weights||[]).reduce((sum, w)=>{
    const val = Number.isFinite(w) && w>0 ? w : 0;
    return sum + val;
  }, 0);
  if(remainingWeight <= 0){ remainingWeight = count; }
  for(let i=0;i<count;i++){
    const segmentsLeft = count - i;
    const weight = (weights && Number.isFinite(weights[i]) && weights[i]>0) ? weights[i] : (remainingWeight/segmentsLeft);
    let ideal = remainingDuration * (weight / remainingWeight);
    if(!Number.isFinite(ideal) || ideal <= 0){ ideal = remainingDuration / segmentsLeft; }
    if(segmentsLeft === 1){
      durations.push(remainingDuration);
      break;
    }
    let maxAllowed = remainingDuration - (segmentsLeft - 1) * minDur;
    let minAllowed = remainingDuration - (segmentsLeft - 1) * maxDur;
    maxAllowed = Math.max(maxAllowed, minDur);
    minAllowed = Math.max(minDur, Math.min(maxAllowed, minAllowed));
    let segDur = ideal;
    segDur = Math.min(segDur, maxAllowed);
    segDur = Math.max(segDur, minAllowed);
    segDur = Math.min(segDur, maxDur);
    segDur = Math.max(segDur, minDur);
    if(segmentsLeft * preferredMin <= remainingDuration){
      segDur = Math.max(segDur, preferredMin);
    }
    if(segmentsLeft * preferredMax >= remainingDuration){
      segDur = Math.min(segDur, preferredMax);
    }
    segDur = Math.min(segDur, maxAllowed);
    segDur = Math.max(segDur, minAllowed);
    segDur = Math.min(segDur, maxDur);
    segDur = Math.max(segDur, minDur);
    segDur = Math.min(segDur, remainingDuration - (segmentsLeft - 1) * minDur);
    segDur = Math.max(segDur, minDur);
    durations.push(segDur);
    remainingDuration -= segDur;
    remainingWeight -= weight;
  }
  if(durations.length < count){
    const deficit = count - durations.length;
    for(let i=0;i<deficit;i++){ durations.push(minDur); }
  }
  const sum = durations.reduce((s,v)=> s+v, 0);
  if(Math.abs(sum - totalDuration) > 0.01 && durations.length){
    const diff = totalDuration - sum;
    durations[durations.length-1] += diff;
  }
  return durations;
}

function autoSplitCue(cue){
  const minDur = EAQ.SPEC.cueMin || 0.6;
  const maxDur = EAQ.SPEC.cueMax || 6.0;
  const wordLimit = 18;
  if(!cue || typeof cue !== 'object'){ return []; }
  const start = Math.max(0, +cue.start || 0);
  const end = Math.max(start, +cue.end || start);
  const duration = end - start;
  const text = normalizeCueText(cue.text);
  const baseCue = { start, end, text: text || (cue.text||'') };
  if(duration <= 0){ return [baseCue]; }
  const needsSplit = duration > maxDur + 0.01 || countWords(text) > wordLimit;
  if(!needsSplit){ return [baseCue]; }
  let targetSegments = Math.max(2, Math.ceil(duration / 4));
  while(targetSegments > 1 && duration / targetSegments < minDur){ targetSegments--; }
  const textWordCount = countWords(text);
  if(textWordCount > wordLimit){
    targetSegments = Math.max(targetSegments, Math.ceil(textWordCount / wordLimit));
  }
  if(targetSegments <= 1){ return [baseCue]; }
  let chunks = [];
  const punctChunks = chunkTextByPunctuation(text);
  if(punctChunks.length >= targetSegments){
    const temp = punctChunks.slice();
    while(temp.length && chunks.length < targetSegments){
      const remainingSegments = targetSegments - chunks.length;
      const take = Math.max(1, Math.round(temp.length / remainingSegments));
      const piece = temp.splice(0, take).join(' ').trim();
      if(piece){ chunks.push(piece); }
    }
    if(temp.length){
      const tail = temp.join(' ').trim();
      if(chunks.length){ chunks[chunks.length-1] = `${chunks[chunks.length-1]} ${tail}`.trim(); }
      else { chunks.push(tail); }
    }
  }
  if(chunks.length === 0){
    chunks = splitWordsEvenly(text, targetSegments);
  }
  chunks = enforceWordLimit(chunks, wordLimit);
  if(chunks.length === 0){ chunks = [text]; }
  const weights = chunks.map(chunk=> Math.max(1, countWords(chunk)));
  const durations = allocateDurations(duration, chunks.length, weights);
  const out = [];
  let cursor = start;
  for(let i=0;i<chunks.length;i++){
    const segDur = durations[i] || (duration / chunks.length);
    const segEnd = (i === chunks.length-1) ? end : Math.min(end, cursor + segDur);
    out.push({ start: cursor, end: segEnd, text: chunks[i] });
    cursor = segEnd;
  }
  if(out.length){ out[out.length-1].end = end; }
  return out;
}

function secToLabel(sec){
  if(!Number.isFinite(sec)) return '00:00.000';
  const s = Math.max(0, sec);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const rem = s - h*3600 - m*60;
  const hh = String(h).padStart(2,'0');
  const mm = String(m).padStart(2,'0');
  const ss = rem.toFixed(3).padStart(6,'0');
  return `${hh}:${mm}:${ss}`;
}

function msKey(sec){
  if(!Number.isFinite(sec)) return 0;
  return Math.round(Math.max(0, sec) * 1000);
}

function stripSpeakerTags(text){
  return String(text||'').replace(/<\/?v[^>]*>/gi, '').trim();
}

// Normalize diarization segment bounds and provide safe defaults.
function sanitizeDiarSegment(segment){
  if(!segment || typeof segment !== 'object'){ return { start:0, end:0, duration:0, speaker:'spk', label:'S1' }; }
  const start = Math.max(0, Number(segment.start) || 0);
  let end = Number(segment.end);
  if(!Number.isFinite(end) || end < start){
    const duration = Number(segment.duration);
    end = Number.isFinite(duration) ? start + Math.max(0, duration) : start;
  }
  const speakerId = segment.speaker ? String(segment.speaker).trim() : 'spk';
  const label = segment.label ? String(segment.label).trim() : '';
  return {
    start,
    end: Math.max(start, end),
    duration: Math.max(0, (Number.isFinite(end) ? end : start) - start),
    speaker: speakerId || 'spk',
    label: label || null
  };
}

// Returns the next unused color from the palette for diarization speakers.
function nextDiarColor(used){
  for(const color of DIARIZATION_COLORS){
    if(!used.has(color)){ used.add(color); return color; }
  }
  const fallback = '#7f8c8d';
  used.add(fallback);
  return fallback;
}

// Ensure speakers keep a stable color assignment across renders.
function buildDiarColorMap(segments){
  const existing = EAQ.state && EAQ.state.diarColorMap ? EAQ.state.diarColorMap : {};
  const map = {};
  const used = new Set();
  Object.keys(existing||{}).forEach(key=>{
    if(existing[key]){ used.add(existing[key]); }
  });
  segments.forEach(seg=>{
    const key = seg && seg.speaker ? String(seg.speaker) : 'spk';
    if(map[key]) return;
    if(existing[key]){
      map[key] = existing[key];
      used.add(existing[key]);
    } else {
      map[key] = nextDiarColor(used);
    }
  });
  return map;
}

function colorForSpeaker(speakerId){
  const key = speakerId ? String(speakerId) : 'spk';
  const map = EAQ.state && EAQ.state.diarColorMap ? EAQ.state.diarColorMap : {};
  return map[key] || '#7f8c8d';
}

// Store diarization segments in state and refresh dependent UI (timeline + list).
function setDiarSegments(segments, options){
  const opts = Object.assign({ preserveSelection: false, sourcePath: undefined, focusSegment: null }, options||{});
  const currentSelection = EAQ.state.diarSelectedIndex;
  const normalized = (segments||[])
    .map(sanitizeDiarSegment)
    .filter(seg=> Number.isFinite(seg.start) && Number.isFinite(seg.end))
    .map(seg=> Object.assign({}, seg, { duration: Math.max(0, seg.end - seg.start) }))
    .sort((a,b)=> a.start - b.start || a.end - b.end);
  const speakerOrder = new Map();
  normalized.forEach(seg=>{
    const key = seg.speaker || 'spk';
    if(!speakerOrder.has(key)){ speakerOrder.set(key, `S${speakerOrder.size + 1}`); }
    seg.label = seg.label || speakerOrder.get(key) || `S${speakerOrder.size}`;
  });
  EAQ.state.diarSegments = normalized;
  EAQ.state.diarColorMap = buildDiarColorMap(normalized);
  if(opts.sourcePath !== undefined){
    EAQ.state.diarizationSourcePath = opts.sourcePath || null;
  }
  let preferredIndex = null;
  if(opts.focusSegment && typeof opts.focusSegment === 'object'){
    const focus = sanitizeDiarSegment(opts.focusSegment);
    preferredIndex = normalized.findIndex(seg=>{
      return seg.speaker === focus.speaker && Math.abs(seg.start - focus.start) < 0.0005 && Math.abs(seg.end - focus.end) < 0.0005;
    });
    if(preferredIndex === -1){
      preferredIndex = normalized.findIndex(seg=> seg.speaker === focus.speaker && Math.abs(seg.start - focus.start) < 0.06);
    }
    if(preferredIndex === -1){ preferredIndex = null; }
  }
  if(preferredIndex != null){
    EAQ.state.diarSelectedIndex = preferredIndex;
  } else if(opts.preserveSelection && typeof currentSelection === 'number'){
    if(!normalized.length){
      EAQ.state.diarSelectedIndex = null;
    } else if(currentSelection >= normalized.length){
      EAQ.state.diarSelectedIndex = normalized.length - 1;
    } else {
      EAQ.state.diarSelectedIndex = currentSelection;
    }
  } else {
    EAQ.state.diarSelectedIndex = null;
  }
  renderDiarTimeline();
  renderDiarList();
}

// Focus the nearest transcript cue and audio position for a diarization selection.
function scrollTranscriptToTime(timeSec){
  if(!Number.isFinite(timeSec)) return;
  const cues = Array.isArray(EAQ.state.transcriptCues) ? EAQ.state.transcriptCues : [];
  if(!cues.length) return;
  let targetIndex = 0;
  let bestScore = Infinity;
  cues.forEach((cue, idx)=>{
    if(!cue) return;
    const start = Number(cue.start) || 0;
    const end = Number(cue.end) || start;
    if(timeSec >= start && timeSec <= end){
      targetIndex = idx;
      bestScore = -1;
      return;
    }
    const diff = Math.abs(timeSec - start);
    if(diff < bestScore){
      bestScore = diff;
      targetIndex = idx;
    }
  });
  const timelineEl = qs('timeline');
  if(timelineEl){
    const cue = cues[targetIndex];
    const detail = { index: targetIndex, cue };
    timelineEl.dispatchEvent(new CustomEvent('tl:cue-select', { detail, bubbles: false }));
  }
  const transcriptBox = qs('transcriptVTT');
  if(transcriptBox && typeof transcriptBox.value === 'string'){
    const cue = cues[targetIndex];
    const label = cue ? secToLabel(cue.start) : null;
    if(label){
      const pos = transcriptBox.value.indexOf(label);
      if(pos >= 0){
        try{
          transcriptBox.focus({ preventScroll: true });
          transcriptBox.setSelectionRange(pos, pos + label.length);
          const ratio = pos / Math.max(1, transcriptBox.value.length);
          transcriptBox.scrollTop = ratio * transcriptBox.scrollHeight;
        }catch{}
      }
    }
  }
  const audio = qs('audio');
  if(audio && Number.isFinite(timeSec)){
    try{ audio.currentTime = Math.max(0, timeSec); }
    catch{}
  }
}

function selectDiarSegment(index, options){
  const segments = Array.isArray(EAQ.state.diarSegments) ? EAQ.state.diarSegments : [];
  const valid = Number.isFinite(index) && index >= 0 && index < segments.length;
  EAQ.state.diarSelectedIndex = valid ? index : null;
  renderDiarTimeline();
  renderDiarList();
  if(valid && (!options || options.focusTranscript !== false)){
    scrollTranscriptToTime(segments[index].start);
  }
}

// Paint diarization spans on the dedicated timeline lane.
function renderDiarTimeline(){
  const container = qs('diarTimeline');
  if(!container) return;
  const segments = Array.isArray(EAQ.state.diarSegments) ? EAQ.state.diarSegments : [];
  container.innerHTML = '';
  container.classList.toggle('empty', segments.length === 0);
  if(!segments.length) return;
  const duration = estimateMediaDuration();
  if(!Number.isFinite(duration) || duration <= 0){ return; }
  const frag = document.createDocumentFragment();
  segments.forEach((seg, idx)=>{
    const left = Math.max(0, Math.min(1, seg.start / duration));
    const width = Math.max(0, Math.min(1, (seg.end - seg.start) / duration));
    const el = document.createElement('div');
    el.className = 'diar-seg';
    if(EAQ.state.diarSelectedIndex === idx){ el.classList.add('selected'); }
    el.style.left = `${left * 100}%`;
    el.style.width = `${Math.max(width * 100, 0.75)}%`;
    el.style.setProperty('--diar-color', colorForSpeaker(seg.speaker));
    const displayLabel = seg.label || seg.speaker || `S${idx+1}`;
    el.title = `${displayLabel}: ${secToLabel(seg.start)} → ${secToLabel(seg.end)}`;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${displayLabel} ${secToLabel(seg.start)} to ${secToLabel(seg.end)}`);
    el.dataset.index = String(idx);
    el.dataset.speaker = seg.speaker || '';
    el.dataset.label = displayLabel;
    el.tabIndex = 0;
    el.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      selectDiarSegment(idx, { focusTranscript: true });
    });
    el.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        selectDiarSegment(idx, { focusTranscript: true });
      }
    });
    frag.appendChild(el);
  });
  container.appendChild(frag);
}

function autoSplitCues(cues){
  if(!Array.isArray(cues) || !cues.length) return [];
  const expanded = [];
  cues.forEach(cue=>{ expanded.push(...autoSplitCue(cue)); });
  return VTT.normalize(expanded);
}

function runAutoSplitSelfTest(){
  if(typeof console === 'undefined') return;
  try{
    const sample = { start: 0, end: 10, text: 'Testing auto split. This cue should divide cleanly, with natural breaks.' };
    const result = autoSplitCue(sample);
    console.assert(Array.isArray(result) && result.length > 1, 'autoSplitCue should split long cues.');
    const totalDuration = result.reduce((sum, cue)=> sum + Math.max(0, (+cue.end||0) - (+cue.start||0)), 0);
    console.assert(Math.abs(totalDuration - (sample.end - sample.start)) < 0.05, 'autoSplitCue preserves duration.');
    console.assert(result.every(cue=> ((+cue.end||0) - (+cue.start||0)) <= (EAQ.SPEC.cueMax + 0.01)), 'autoSplitCue respects cueMax.');
  }catch(err){
    try{ console.warn('Auto split self-check failed', err); }catch{}
  }
}

if(typeof window !== 'undefined'){
  try{ runAutoSplitSelfTest(); }
  catch{}
}

async function fetchWithProxy(url){
  if(!url) return null;
  const options = { cache: 'no-store' };
  try{
    const res = await fetch(url, options);
    if(res && res.ok) return res;
  }catch{}
  try{
    const fallback = `/api/proxy_audio?src=${encodeURIComponent(url)}`;
    const res = await fetch(fallback, options);
    if(res && res.ok) return res;
  }catch{}
  return null;
}

function relocateErrorsList(activeScreenId){
  const el = qs('errorsList');
  if(!el) return;
  const allowed = new Set(['screen_translation','screen_codeswitch','screen_emotionSafety','screen_review']);
  if(!allowed.has(activeScreenId)){
    el.classList.add('hide');
    return;
  }
  const screen = qs(activeScreenId);
  if(!screen) return;
  const anchor = screen.querySelector('h3, h2, h1');
  if(anchor){ anchor.insertAdjacentElement('afterend', el); }
  else { screen.insertBefore(el, screen.firstChild || null); }
  if(el.textContent.trim()){ el.classList.remove('hide'); }
}

function updateErrorsList(lint, targetScreenId){
  const el = qs('errorsList');
  if(!el) return;
  if(targetScreenId){ relocateErrorsList(targetScreenId); }
  el.classList.remove('error');
  el.classList.remove('warn');
  if(!lint){
    el.textContent = '';
    el.classList.add('hide');
    return;
  }
  const errors = Array.isArray(lint.errors) ? lint.errors : [];
  const warnings = Array.isArray(lint.warnings) ? lint.warnings : [];
  const parts = [];
  if(errors.length){ parts.push(`Errors (${errors.length}): ${errors.join('; ')}`); }
  if(warnings.length){ parts.push(`Warnings (${warnings.length}): ${warnings.join('; ')}`); }
  if(parts.length === 0){
    el.textContent = 'No validation issues detected.';
    el.classList.remove('hide');
  } else {
    el.textContent = parts.join(' ');
    el.classList.remove('hide');
  }
  if(errors.length){ el.classList.add('error'); }
  if(!errors.length && warnings.length){ el.classList.add('warn'); }
}

function pushIssue(list, message){
  if(!message) return;
  if(!Array.isArray(list)) return;
  if(!list.includes(message)){ list.push(message); }
}

function show(id){
  ['screen_welcome','screen_transcript','screen_translation','screen_codeswitch','screen_emotionSafety','screen_diar','screen_review']
    .forEach(x=> qs(x).classList.toggle('hide', x!==id));
  relocateErrorsList(id);
}

async function hydrateManifestTranslations(manifest){
  if(!manifest || !Array.isArray(manifest.items)) return manifest;
  const jobs = manifest.items.map(async (item)=>{
    if(!item) return;
    const prefill = item.prefill = item.prefill || {};
    const candidateUrl = (item.transcript && item.transcript.translation_vtt_url) || prefill.translation_vtt_url;
    if(!candidateUrl || prefill.translation_vtt){ return; }
    try{
      const res = await fetchWithProxy(candidateUrl);
      if(res){
        prefill.translation_vtt = await res.text();
        prefill.translation_vtt_url = candidateUrl;
      }
    }catch{}
  });
  try{ await Promise.all(jobs); }
  catch{}
  return manifest;
}

async function loadManifest(){
  const annot = encodeURIComponent(EAQ.state.annotator);
  const url = `/api/tasks?stage=2&annotator_id=${annot}`;
  try{
    const res = await fetch(url, {cache:'no-store'});
    if(!res.ok) throw new Error('tasks fetch');
    const manifest = await res.json();
    await hydrateManifestTranslations(manifest);
    EAQ.state.manifest = manifest;
    saveManifestToStorage(manifest);
    return manifest;
  }catch(err){
    const cached = loadManifestFromStorage();
    if(cached){
      await hydrateManifestTranslations(cached);
      EAQ.state.manifest = cached;
      return cached;
    }
    throw err;
  }
}

function currentItem(){
  const m = EAQ.state.manifest; if(!m||!m.items) return null; return m.items[EAQ.state.idx]||null;
}

function prefetchAssetsForItem(item){
  if(!item) return;
  const media = item.media || {};
  const prefill = item.prefill || {};
  const urls = [
    media.audio_proxy_url,
    media.video_hls_url,
    prefill.diarization_rttm_url,
    prefill.transcript_vtt_url,
    prefill.transcript_ctm_url,
    prefill.translation_vtt_url,
    prefill.code_switch_vtt_url
  ];
  urls.forEach((url)=>{
    if(!url) return;
    try{
      fetchWithProxy(url).catch(()=>{});
    }catch{}
  });
}

async function prefetchNext(){
  try{
    const manifest = EAQ.state.manifest;
    if(!manifest || !Array.isArray(manifest.items)) return;
    const it = manifest.items[EAQ.state.idx+1];
    if(it){ prefetchAssetsForItem(it); }
  }catch{}
}

function loadAudio(){
  const it = currentItem(); if(!it) return;
  const a = qs('audio'); if(!a) return;
  EAQ.audio = a;
  a.src = it.media && it.media.audio_proxy_url ? it.media.audio_proxy_url : '/public/sample.mp4';
  a.play().catch(()=>{});
  prefetchAssetsForItem(it);
  const wave = qs('wave'); if(wave){ Wave.attach(wave); Wave.load(a.src); }
  const tl = qs('timeline');
  if(tl){
    const attachTl = ()=> Timeline.attach(tl, a.duration||0, EAQ.state.transcriptCues, (cues)=>{
      EAQ.state.transcriptCues = VTT.normalize(cues);
      qs('transcriptVTT').value = VTT.stringify(EAQ.state.transcriptCues);
      alignTranslationToTranscript({ preserveScroll: true });
    });
    if(isFinite(a.duration) && a.duration>0){ attachTl(); }
    else { a.addEventListener('loadedmetadata', attachTl, { once:true }); }
    // paint overlays from CS and Events
    setInterval(()=>{
      const safetyOverlay = (EAQ.state.safetyEvents||[]).map(evt=>({ start: Math.max(0, +evt.startSec||0), end: Math.max(0, +evt.endSec||0) }));
      Timeline.setOverlays(EAQ.state.codeSwitchCues||[], safetyOverlay);
    }, 600);
  }
}

function basicValidation(){
  const errs = [];
  if(!EAQ.state.transcriptVTT.trim()) errs.push('Transcript VTT is empty');
  if(!EAQ.state.translationVTT.trim()) errs.push('Translation VTT is empty');
  if(!/^WEBVTT/m.test(EAQ.state.transcriptVTT)) errs.push('Transcript VTT missing WEBVTT');
  if(!/^WEBVTT/m.test(EAQ.state.translationVTT)) errs.push('Translation VTT missing WEBVTT');
  if(EAQ.state.codeSwitchVTT.trim() && !/^WEBVTT/m.test(EAQ.state.codeSwitchVTT)) errs.push('Code-switch VTT missing WEBVTT');
  return errs;
}

function validateAnnotation(){
  const report = { errors: [], warnings: [] };
  const minDur = EAQ.SPEC.cueMin || 0.6;
  const maxDur = EAQ.SPEC.cueMax || 6.0;
  const csMin = EAQ.SPEC.csMinSec || 0.4;
  const tolerance = 0.05;

  try{
    const basics = basicValidation();
    basics.forEach(err=> pushIssue(report.errors, err));
  }catch{}

  const transcriptCues = VTT.normalize(EAQ.state.transcriptCues || []);
  if(!transcriptCues.length){
    pushIssue(report.errors, 'Transcript has no cues.');
  }
  transcriptCues.forEach((cue, idx)=>{
    const start = +cue.start || 0;
    const end = +cue.end || 0;
    const duration = Math.max(0, end - start);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end <= start){
      pushIssue(report.errors, `Transcript cue #${idx+1} has invalid timings.`);
    }
    if(duration < minDur - tolerance){
      pushIssue(report.errors, `Transcript cue #${idx+1} is ${duration.toFixed(2)}s (< ${minDur.toFixed(2)}s).`);
    } else if(duration < minDur){
      pushIssue(report.warnings, `Transcript cue #${idx+1} is ${duration.toFixed(2)}s (min ${minDur.toFixed(2)}s).`);
    }
    if(duration > maxDur + tolerance){
      pushIssue(report.errors, `Transcript cue #${idx+1} is ${duration.toFixed(2)}s (> ${maxDur.toFixed(2)}s).`);
    } else if(duration > maxDur){
      pushIssue(report.warnings, `Transcript cue #${idx+1} is ${duration.toFixed(2)}s (over ${maxDur.toFixed(2)}s).`);
    }
    const words = countWords(cue.text);
    if(words > 18){
      pushIssue(report.warnings, `Transcript cue #${idx+1} has ${words} words (limit 18).`);
    }
    if(idx>0){
      const prev = transcriptCues[idx-1];
      const gap = start - (+prev.end || 0);
      if(start < (+prev.start || 0) - 0.01){
        pushIssue(report.errors, `Transcript cue #${idx+1} starts before cue #${idx}.`);
      }
      if(start < (+prev.end || 0) - 0.01){
        const overlap = ((+prev.end || 0) - start).toFixed(2);
        pushIssue(report.errors, `Transcript cue #${idx+1} overlaps previous cue by ${overlap}s.`);
      }
      if(gap > 0.5 + 0.01){
        pushIssue(report.errors, `Gap of ${gap.toFixed(2)}s between transcript cues #${idx} and #${idx+1}.`);
      }
    }
  });

  const translationCues = VTT.normalize(EAQ.state.translationCues || []);
  if(transcriptCues.length !== translationCues.length){
    pushIssue(report.errors, `Translation cue count (${translationCues.length}) must match transcript cue count (${transcriptCues.length}).`);
  }
  const missingTranslations = [];
  translationCues.forEach((cue, idx)=>{
    if(!cue) return;
    const text = normalizeCueText(cue.text);
    if(!text){ missingTranslations.push(idx); }
  });
  if(missingTranslations.length){
    const labels = missingTranslations.map(i=> `#${i+1}`).join(', ');
    pushIssue(report.errors, `Missing translation text for cues ${labels}.`);
  }
  report.translationMissingIndices = missingTranslations;

  const csSpans = snapshotCodeSwitchSpans().sort((a,b)=> (a.start||0) - (b.start||0) || (a.end||0) - (b.end||0));
  const csIssues = [];
  const allowedLangs = new Set(['eng','fra','other']);
  csSpans.forEach((span, idx)=>{
    const start = +span.start || 0;
    const end = +span.end || 0;
    const duration = Math.max(0, end - start);
    if(duration < csMin - 0.01){
      const msg = `Code-switch span #${idx+1} is ${duration.toFixed(2)}s (< ${csMin.toFixed(2)}s).`;
      pushIssue(report.errors, msg);
      csIssues.push(msg);
    } else if(duration < csMin){
      pushIssue(report.warnings, `Code-switch span #${idx+1} is ${duration.toFixed(2)}s (min ${csMin.toFixed(2)}s).`);
    }
    if(!allowedLangs.has((span.lang||'').toLowerCase())){
      const msg = `Code-switch span #${idx+1} has invalid language "${span.lang}".`;
      pushIssue(report.errors, msg);
      csIssues.push(msg);
    }
    if(idx>0){
      const prev = csSpans[idx-1];
      if(start < (+prev.end || 0) - 0.01){
        const msg = `Code-switch span #${idx+1} overlaps previous span.`;
        pushIssue(report.errors, msg);
        csIssues.push(msg);
      }
    }
  });
  report.codeSwitchIssues = csIssues;

  const diarSpeakers = listUniqueSpeakers();
  if(diarSpeakers.length){
    const profiles = Array.isArray(EAQ.state.speakerProfiles) ? EAQ.state.speakerProfiles : [];
    const missingSpeakers = [];
    const invalidSpeakers = [];
    diarSpeakers.forEach((speakerId, idx)=>{
      const profile = profiles.find(p=> p && p.speaker_id === speakerId);
      const display = profile && profile.display_label ? profile.display_label : `S${idx+1}`;
      if(!profile){
        missingSpeakers.push(display);
        return;
      }
      const gender = normalizeSpeakerGender(profile.apparent_gender);
      const age = normalizeSpeakerAge(profile.apparent_age_band);
      const dialect = normalizeSpeakerDialect(profile.dialect_subregion);
      if(!SPEAKER_GENDER_SET.has(gender) || !SPEAKER_AGE_SET.has(age) || !SPEAKER_DIALECT_SET.has(dialect)){
        invalidSpeakers.push(display);
      }
    });
    if(missingSpeakers.length){
      const label = missingSpeakers.join(', ');
      pushIssue(report.errors, `Speaker attributes missing for ${label}.`);
    }
    if(invalidSpeakers.length){
      const label = invalidSpeakers.join(', ');
      pushIssue(report.errors, `Review gender, age band, and dialect selections for ${label}. Unknown is allowed.`);
    }
  }

  const emotionSpans = cloneEmotionSpans(EAQ.state.emotionSpans || []);
  emotionSpans.forEach((span, idx)=>{
    const duration = Math.max(0, span.endSec - span.startSec);
    if(duration < EMOTION_MIN_DURATION - 0.01){
      pushIssue(report.errors, `Emotion span #${idx+1} is ${duration.toFixed(2)}s (< ${EMOTION_MIN_DURATION.toFixed(2)}s).`);
    } else if(duration < EMOTION_MIN_DURATION){
      pushIssue(report.warnings, `Emotion span #${idx+1} is ${duration.toFixed(2)}s (min ${EMOTION_MIN_DURATION.toFixed(2)}s).`);
    }
    if(idx>0){
      const prev = emotionSpans[idx-1];
      if(span.startSec < prev.endSec - 0.01){
        pushIssue(report.warnings, `Emotion span #${idx+1} overlaps span #${idx}. Adjust to remove overlap.`);
      }
    }
  });

  const safetyEvents = cloneSafetyEvents(EAQ.state.safetyEvents || []);
  safetyEvents.forEach((evt, idx)=>{
    const duration = Math.max(0, evt.endSec - evt.startSec);
    if(duration <= 0){
      pushIssue(report.errors, `Safety event #${idx+1} has invalid timing.`);
    }
    if(idx>0){
      const prev = safetyEvents[idx-1];
      if(evt.startSec < prev.endSec - 0.01){
        pushIssue(report.errors, `Safety event #${idx+1} overlaps event #${idx}.`);
      }
    }
  });

  return report;
}

function runValidationAndDisplay(targetScreenId){
  const lint = validateAnnotation();
  EAQ.state.lintReport = lint;
  updateErrorsList(lint, targetScreenId);
  updateTranslationWarnings(lint);
  if(lint && Array.isArray(lint.codeSwitchIssues) && lint.codeSwitchIssues.length){
    updateCodeSwitchNotice(lint.codeSwitchIssues[0]);
  } else {
    updateCodeSwitchNotice('');
  }
  return lint;
}

function estimateMediaDuration(){
  const audioEl = qs('audio');
  if(audioEl && isFinite(audioEl.duration) && audioEl.duration > 0){
    return audioEl.duration;
  }
  const item = currentItem();
  if(item && item.media && isFinite(+item.media.duration_sec)){
    return +item.media.duration_sec;
  }
  const cues = EAQ.state.transcriptCues || [];
  return cues.reduce((max, cue)=> Math.max(max, +cue.end || 0), 0);
}

function refreshTimeline(){
  if(typeof Timeline === 'undefined' || typeof Timeline.update !== 'function'){ return; }
  const duration = estimateMediaDuration();
  Timeline.update(duration, EAQ.state.transcriptCues || []);
  if(typeof Timeline.setOverlays === 'function'){
    const safetyOverlay = (EAQ.state.safetyEvents||[]).map(evt=>({ start: Math.max(0, +evt.startSec||0), end: Math.max(0, +evt.endSec||0) }));
    Timeline.setOverlays(EAQ.state.codeSwitchCues || [], safetyOverlay);
  }
  renderDiarTimeline();
}

async function enqueueAndSync(lintReport){
  const lint = lintReport || validateAnnotation();
  EAQ.state.lintReport = lint;
  if(lint && Array.isArray(lint.errors) && lint.errors.length){
    updateErrorsList(lint, 'screen_review');
    return false;
  }
  const it = currentItem(); if(!it) return false;
  const csSnapshot = snapshotCodeSwitchSpans();
  const csExports = buildCodeSwitchExports(csSnapshot);
  EAQ.state.codeSwitchVTT = csExports.vtt;
  EAQ.state.codeSwitchSummary = csExports.summary;
  const csJsonText = JSON.stringify(csExports.summary);
  setCodeSwitchSpans(csSnapshot, { pushHistory: false });
  const files = {
    diarization_rttm: rttmStringify(EAQ.state.diarSegments||[], it.asset_id || 'rec'),
    diarization_rttm_source: EAQ.state.diarizationSourcePath || null,
    transcript_vtt: EAQ.state.transcriptVTT,
    transcript_ctm: null,
    translation_vtt: EAQ.state.translationVTT,
    code_switch_vtt: EAQ.state.codeSwitchVTT || '',
    code_switch_spans_json: csJsonText,
    speaker_profiles_json: (function(){ try{ return JSON.stringify(EAQ.state.speakerProfiles||[]); }catch{ return '[]'; } })()
  };
  const emotionVtt = buildEmotionVTT(EAQ.state.emotionSpans || []);
  const eventsVtt = buildSafetyEventsVTT(EAQ.state.safetyEvents || []);
  if(emotionVtt){ files.emotion_vtt = emotionVtt; }
  if(eventsVtt){ files.events_vtt = eventsVtt; }

  const timeSpentSec = Math.max(0, Math.round((Date.now() - (EAQ.state.startedAt||Date.now()))/1000));
  const lintSummary = Object.assign({}, lint, {
    errors: Array.isArray(lint.errors) ? lint.errors.slice() : [],
    warnings: Array.isArray(lint.warnings) ? lint.warnings.slice() : [],
    severity_max: (Array.isArray(lint.errors) && lint.errors.length) ? 'error' : ((Array.isArray(lint.warnings) && lint.warnings.length) ? 'warning' : 'ok')
  });

  const payload = {
    asset_id: it.asset_id,
    files,
    summary: {
      contains_code_switch: csSnapshot.length > 0,
      code_switch_languages: csExports.summary.languages || [],
      cs_total_duration_sec: csExports.summary.total_duration_sec,
      non_arabic_token_ratio_est: csExports.summary.non_arabic_duration_ratio,
      events_present: (EAQ.state.safetyEvents||[]).length > 0,
      clipFlagged: !!EAQ.state.clipFlagged
    },
    qa: {
      annotator_id: EAQ.state.annotator,
      second_annotator_id: null,
      adjudicator_id: null,
      gold_target: !!it.gold_target,
      gold_check: !!it.gold_target ? 'pending' : 'not_applicable',
      time_spent_sec: timeSpentSec,
      clip_id: it.asset_id || it.id || it.clip_id || it.clipId || null,
      lint: lintSummary
    },
    lint: lintSummary,
    client_meta: { device: navigator.userAgent }
  };

  let qaResult = null;
  if(it.gold_target && window.QAMetrics && typeof window.QAMetrics.computeQAResult === 'function'){
    try{
      const predicted = {
        codeSwitchSpans: csSnapshot,
        diarization: EAQ.state.diarSegments || [],
        transcript: EAQ.state.transcriptVTT,
        translation: EAQ.state.translationVTT
      };
      const goldSource = it.gold || it.gold_annotations || it.qa_gold || it.reference || it.prefill || {};
      const thresholds = it.qa_thresholds || it.qaThresholds || null;
      qaResult = window.QAMetrics.computeQAResult(predicted, goldSource, { thresholds });
      if(qaResult){
        payload.qa.gold_check = qaResult.pass ? 'pass' : 'fail';
        payload.qa.codeswitch_f1 = qaResult.codeswitch && Number.isFinite(qaResult.codeswitch.f1) ? qaResult.codeswitch.f1 : null;
        payload.qa.codeswitch_precision = qaResult.codeswitch && Number.isFinite(qaResult.codeswitch.precision) ? qaResult.codeswitch.precision : null;
        payload.qa.codeswitch_recall = qaResult.codeswitch && Number.isFinite(qaResult.codeswitch.recall) ? qaResult.codeswitch.recall : null;
        payload.qa.diarization_mae = qaResult.diarization && Number.isFinite(qaResult.diarization.mae) ? qaResult.diarization.mae : null;
        payload.qa.cue_avg_length_sec = qaResult.cues && Number.isFinite(qaResult.cues.avgCueLengthSec) ? qaResult.cues.avgCueLengthSec : null;
        payload.qa.cue_diff_sec = qaResult.cues && Number.isFinite(qaResult.cues.targetDiffSec) ? qaResult.cues.targetDiffSec : null;
        payload.qa.translation_completeness = qaResult.translation && Number.isFinite(qaResult.translation.completeness) ? qaResult.translation.completeness : null;
        payload.qa.translation_correctness = qaResult.translation && Number.isFinite(qaResult.translation.correctness) ? qaResult.translation.correctness : null;
        payload.qa.translation_char_ratio = qaResult.cues && Number.isFinite(qaResult.cues.translationCompleteness) ? qaResult.cues.translationCompleteness : null;
        payload.qa.scores = {
          accuracy: qaResult.accuracyScore,
          consistency: qaResult.consistencyScore,
          cue: qaResult.cueScore,
          translation: qaResult.translationScore,
          overall: qaResult.overallScore
        };
        payload.qa.metrics = qaResult;
      }
    }catch(err){
      console.warn('QA computation failed', err);
      payload.qa.gold_check = 'error';
    }
  }

  const clipId = it.asset_id || it.id || it.clip_id || it.clipId;
  if(window.QAMetrics && typeof window.QAMetrics.recordResult === 'function'){
    try{
      window.QAMetrics.recordResult(clipId, {
        qa: payload.qa,
        metrics: qaResult,
        clip: {
          clipId,
          title: it.title || it.clip_title || it.display_title || null,
          language: it.language || null,
          gold_target: !!it.gold_target
        }
      });
    }catch(err){
      console.warn('Failed to record QA result', err);
    }
  }

  try{ await EAIDB.saveLintReport(it.asset_id, lintSummary); }
  catch{}

  await EAIDB.enqueue(payload);
  trySyncWithBackoff();
  try{
    if('serviceWorker' in navigator && 'SyncManager' in window){
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('ea-sync');
    }
  }catch{}
  return true;
}

async function trySyncOnce(){
  const items = await EAIDB.peekBatch(10);
  if(items.length===0) return true;
  try{
    const res = await fetch('/api/annotations/batch', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(items)
    });
    const ok = res.ok;
    if(ok){ await EAIDB.removeBatch(items.map(x=>x._id)); }
    return ok;
  }catch{ return false; }
}

async function trySyncWithBackoff(){
  for(const ms of EAQ.SPEC.backoffMs){
    const ok = await trySyncOnce();
    if(ok) return;
    await new Promise(r=> setTimeout(r, ms));
  }
}

function bindUI(){
  qs('startBtn').addEventListener('click', async ()=>{
    qs('downloadStatus').textContent = 'Loading tasks...';
    try{
      await loadManifest();
      const prefill = await loadPrefillForCurrent();
      if(prefill){ await loadTranslationAndCodeSwitch(prefill); }
      loadAudio();
      prefetchNext();
      EAQ.state.startedAt = Date.now();
      show('screen_transcript');
      refreshTimeline();
      qs('downloadStatus').textContent = 'Tasks loaded.';
    }catch{
      qs('downloadStatus').textContent = 'Failed to load tasks. Using offline queue.';
    }
  });

  qs('transcriptNext').addEventListener('click', ()=>{
    const box = qs('transcriptVTT');
    EAQ.state.transcriptVTT = box ? box.value : '';
    EAQ.state.transcriptCues = VTT.normalize(parseVttSafe(EAQ.state.transcriptVTT));
    alignTranslationToTranscript({ focusIndex: 0 });
    show('screen_translation');
    runValidationAndDisplay('screen_translation');
  });

  const lockTranslation = qs('lockTranslation');
  if(lockTranslation){
    lockTranslation.addEventListener('change', ()=>{
      collectTranslationInputs();
      alignTranslationToTranscript({ preserveScroll: true });
      runValidationAndDisplay('screen_translation');
    });
  }

  qs('translationNext').addEventListener('click', ()=>{
    collectTranslationInputs();
    updateTranslationVTTFromState();
    runValidationAndDisplay('screen_translation');
    show('screen_codeswitch');
    renderCodeSwitchTimeline();
    renderSpeakerCards();
    runValidationAndDisplay('screen_codeswitch');
  });

  const speakerError = qs('speakerDrawerError');
  qs('csNext').addEventListener('click', ()=>{
    const snapshot = snapshotCodeSwitchSpans();
    const exports = buildCodeSwitchExports(snapshot);
    EAQ.state.codeSwitchVTT = exports.vtt;
    EAQ.state.codeSwitchSummary = exports.summary;
    const box = qs('codeSwitchVTT'); if(box) box.value = exports.vtt;
    const speakerValid = syncSpeakerProfilesFromUI({ silent: true });
    if(!speakerValid){
      syncSpeakerProfilesFromUI({ silent: false });
      runValidationAndDisplay('screen_codeswitch');
      return;
    }
    if(speakerError){ speakerError.classList.add('hide'); speakerError.textContent = ''; }
    runValidationAndDisplay('screen_codeswitch');
    show('screen_emotionSafety');
    runValidationAndDisplay('screen_emotionSafety');
  });

  const timelineEl = qs('timeline');
  if(timelineEl){
    timelineEl.addEventListener('tl:cue-select', (ev)=>{
      const detail = ev && ev.detail ? ev.detail : {};
      if(detail && Number.isFinite(detail.index)){
        EAQ.state.activeCueIndex = detail.index;
        const translationScreen = qs('screen_translation');
        const isVisible = translationScreen && !translationScreen.classList.contains('hide');
        if(isVisible){ focusTranslationField(detail.index, { scroll: true }); }
      }
    });
  }

  setupEmotionSafetyControls();

  const emotionSafetyNext = qs('emotionSafetyNext');
  if(emotionSafetyNext){
    emotionSafetyNext.addEventListener('click', ()=>{
      cancelEmotionCapture();
      cancelEmotionDrag();
      cancelSafetyDrag();
      renderEmotionSafetyTimeline();
      show('screen_diar');
      runValidationAndDisplay('screen_diar');
    });
  }
  const diarNext = qs('diarNext'); if(diarNext) diarNext.addEventListener('click', ()=>{ runValidationAndDisplay('screen_review'); show('screen_review'); });

  qs('submitBtn').addEventListener('click', async ()=>{
    const submittedClip = currentItem();
    const transcriptBox = qs('transcriptVTT');
    const translationBox = qs('translationVTT');
    const csBox = qs('codeSwitchVTT');
    EAQ.state.transcriptVTT = transcriptBox ? transcriptBox.value : EAQ.state.transcriptVTT;
    EAQ.state.codeSwitchVTT = csBox ? csBox.value : EAQ.state.codeSwitchVTT;
    EAQ.state.transcriptCues = VTT.normalize(parseVttSafe(EAQ.state.transcriptVTT));
    collectTranslationInputs();
    updateTranslationVTTFromState();
    const csSnapshotSubmit = snapshotCodeSwitchSpans();
    const csExportsSubmit = buildCodeSwitchExports(csSnapshotSubmit);
    EAQ.state.codeSwitchVTT = csExportsSubmit.vtt;
    EAQ.state.codeSwitchSummary = csExportsSubmit.summary;
    if(csBox) csBox.value = csExportsSubmit.vtt;
    setCodeSwitchSpans(csSnapshotSubmit, { pushHistory: false });
    const lint = runValidationAndDisplay('screen_review');
    if(lint.errors && lint.errors.length){
      alert('Please resolve validation errors before submitting.');
      return;
    }
    const ok = await enqueueAndSync(lint);
    if(!ok){ return; }
    if(typeof window !== 'undefined' && window.QAMetrics && typeof window.QAMetrics.generateReport === 'function'){
      try{
        const qaReport = window.QAMetrics.generateReport({
          manifest: EAQ.state.manifest,
          annotator: EAQ.state.annotator
        });
        localStorage.setItem('qa_report', JSON.stringify(qaReport));
      }catch(err){
        console.warn('Failed to generate QA report', err);
      }
    }
    EAQ.state.idx = (EAQ.state.idx + 1) % Math.max(1, EAQ.state.manifest.items.length);
    qs('transcriptVTT').value = '';
    qs('translationVTT').value = '';
    qs('codeSwitchVTT').value = '';
    EAQ.state.emotionSpans = [];
    EAQ.state.emotionHistory = [];
    EAQ.state.emotionFuture = [];
    EAQ.state.emotionSelectedIndex = null;
    EAQ.state.safetyEvents = [];
    EAQ.state.safetyHistory = [];
    EAQ.state.safetyFuture = [];
    EAQ.state.safetySelectedIndex = null;
    EAQ.state.clipFlagged = false;
    renderEmotionSafetyTimeline();
    EAQ.state.speakerProfiles = [];
    const speakerCards = qs('speakerCards'); if(speakerCards) speakerCards.innerHTML = '';
    const prefill = await loadPrefillForCurrent();
    if(prefill){ await loadTranslationAndCodeSwitch(prefill); }
    loadAudio();
    prefetchNext();
    EAQ.state.startedAt = Date.now();
    show('screen_transcript');
    refreshTimeline();
  });
}

window.addEventListener('load', ()=>{
  EAQ.state.annotator = getAnnotatorId();
  bindUI();
  window.addEventListener('online', ()=>{ trySyncWithBackoff(); });
  if('serviceWorker' in navigator){
    navigator.serviceWorker.addEventListener('message', (ev)=>{
      if(ev && ev.data && ev.data.type==='ea-sync'){ trySyncWithBackoff(); }
    });
  }
  // Bind basic editing controls
  const a = qs('audio');
  EAQ.audio = a;
  qs('rewindBtn').addEventListener('click', ()=>{ if(a) a.currentTime = Math.max(0, a.currentTime - 3); });
  qs('splitBtn').addEventListener('click', ()=>{
    if(!a) return;
    const box = qs('transcriptVTT');
    const t = a.currentTime;
    const cues = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : parseVttSafe(box ? box.value : '');
    for(let i=0;i<cues.length;i++){
      const c = cues[i];
      if(t > c.start && t < c.end && (t - c.start) >= EAQ.SPEC.cueMin && (c.end - t) >= EAQ.SPEC.cueMin){
        const left = { start:c.start, end:t, text:c.text };
        const right = { start:t, end:c.end, text:c.text };
        cues.splice(i,1,left,right);
        EAQ.state.transcriptCues = VTT.normalize(cues);
        const serialized = VTT.stringify(EAQ.state.transcriptCues);
        EAQ.state.transcriptVTT = serialized;
        if(box) box.value = serialized;
        alignTranslationToTranscript({ preserveScroll: true });
        refreshTimeline();
        runValidationAndDisplay('screen_transcript');
        break;
      }
    }
  });
  const splitAllBtn = qs('splitAllBtn');
  if(splitAllBtn){
    splitAllBtn.addEventListener('click', ()=>{
      const box = qs('transcriptVTT');
      const source = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : parseVttSafe(box ? box.value : '');
      const splitted = autoSplitCues(source);
      if(!splitted.length) return;
      EAQ.state.transcriptCues = splitted;
      const serialized = VTT.stringify(splitted);
      EAQ.state.transcriptVTT = serialized;
      if(box) box.value = serialized;
      alignTranslationToTranscript({ preserveScroll: true });
      refreshTimeline();
      runValidationAndDisplay('screen_transcript');
    });
  }
  qs('mergeBtn').addEventListener('click', ()=>{
    const box = qs('transcriptVTT');
    const cues = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : parseVttSafe(box ? box.value : '');
    for(let i=0;i<cues.length-1;i++){
      const cur = cues[i], nxt = cues[i+1];
      if(Math.abs(cur.end - nxt.start) < 0.25){
        const merged = { start: cur.start, end: nxt.end, text: `${cur.text}\n${nxt.text}`.trim() };
        cues.splice(i,2,merged);
        EAQ.state.transcriptCues = VTT.normalize(cues);
        const serialized = VTT.stringify(EAQ.state.transcriptCues);
        EAQ.state.transcriptVTT = serialized;
        if(box) box.value = serialized;
        alignTranslationToTranscript({ preserveScroll: true });
        refreshTimeline();
        runValidationAndDisplay('screen_transcript');
        break;
      }
    }
  });

  // Code-switch interactive overlay
  const langButtons = [
    ['btnEN','eng'],
    ['btnFR','fra'],
    ['btnOther','other']
  ];
  langButtons.forEach(([id, lang])=>{
    const btn = qs(id);
    if(!btn) return;
    btn.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); startCodeSwitchSpan(lang); });
    btn.addEventListener('pointerup', ()=> endCodeSwitchSpan());
    btn.addEventListener('pointercancel', ()=> endCodeSwitchSpan());
    btn.addEventListener('pointerleave', ()=> endCodeSwitchSpan());
  });

  const timelineContainer = qs('codeSwitchTimeline');
  if(timelineContainer){
    timelineContainer.addEventListener('click', ()=> selectCodeSwitchSpan(null));
  }

  const diarTimeline = qs('diarTimeline');
  if(diarTimeline){
    diarTimeline.addEventListener('click', (ev)=>{
      if(ev.target === diarTimeline){
        selectDiarSegment(null, { focusTranscript: false });
      }
    });
  }

  const nudgeButtons = [
    ['nudgeStartMinus','start',-0.2],
    ['nudgeStartPlus','start',0.2],
    ['nudgeEndMinus','end',-0.2],
    ['nudgeEndPlus','end',0.2]
  ];
  nudgeButtons.forEach(([id, part, delta])=>{
    const btn = qs(id);
    if(!btn) return;
    btn.addEventListener('click', ()=> nudgeSelectedSpan(part, delta));
  });

  const csUndo = qs('csUndo'); if(csUndo) csUndo.addEventListener('click', ()=> undoCodeSwitch());
  const csRedo = qs('csRedo'); if(csRedo) csRedo.addEventListener('click', ()=> redoCodeSwitch());

  const wave = qs('wave');
  if(wave){
    function seekFromEvent(ev){
      const rect = wave.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
      if(a && a.duration){ a.currentTime = Wave.timeAtX(x, a.duration); }
    }
    wave.addEventListener('click', seekFromEvent);
  }
  const zi = qs('zoomIn'), zo = qs('zoomOut'), sl = qs('scrollLeft'), sr = qs('scrollRight');
  if(zi) zi.addEventListener('click', ()=> Wave.setZoom(0.8));
  if(zo) zo.addEventListener('click', ()=> Wave.setZoom(1.25));
  if(sl) sl.addEventListener('click', ()=> Wave.scroll(-0.1));
  if(sr) sr.addEventListener('click', ()=> Wave.scroll(0.1));

  const clr = qs('clearLocal');
  if(clr){
    clr.addEventListener('click', async ()=>{
      try{ const db = indexedDB.deleteDatabase('ea_stage2_db'); }catch{}
      try{ localStorage.removeItem('ea_stage2_annotator_id'); }catch{}
      try{
        const keys = await caches.keys();
        await Promise.all(keys.map(k=> caches.delete(k)));
      }catch{}
      alert('Local data cleared.');
    });
  }
});

// Prefill loader and alignment helpers
async function loadPrefillForCurrent(){
  const it = currentItem(); if(!it) return;
  EAQ.state.emotionSpans = [];
  EAQ.state.emotionHistory = [];
  EAQ.state.emotionFuture = [];
  EAQ.state.emotionSelectedIndex = null;
  EAQ.state.emotionActive = null;
  EAQ.state.safetyEvents = [];
  EAQ.state.safetyHistory = [];
  EAQ.state.safetyFuture = [];
  EAQ.state.safetySelectedIndex = null;
  EAQ.state.safetyDrag = null;
  EAQ.state.clipFlagged = false;
  renderEmotionSafetyTimeline();
  EAQ.state.speakerProfiles = [];
  EAQ.state.lintReport = { errors: [], warnings: [] };
  updateErrorsList(null);
  const speakerContainer = qs('speakerCards');
  if(speakerContainer) speakerContainer.innerHTML = '<em>Loading speaker attributes...</em>';
  const speakerErrorBox = qs('speakerDrawerError');
  if(speakerErrorBox){ speakerErrorBox.classList.add('hide'); speakerErrorBox.textContent = ''; }
  const prefill = it.prefill || {};
  const translationBox = qs('translationVTT'); if(translationBox) translationBox.value = '';
  const csBox = qs('codeSwitchVTT'); if(csBox) csBox.value = '';
  EAQ.state.translationVTT = '';
  EAQ.state.translationCues = [];
  EAQ.state.codeSwitchVTT = '';
  EAQ.state.codeSwitchCues = [];
  EAQ.state.codeSwitchSpans = [];
  EAQ.state.codeSwitchHistory = [];
  EAQ.state.codeSwitchFuture = [];
  EAQ.state.codeSwitchSelectedIndex = null;
  EAQ.state.codeSwitchActive = null;
  EAQ.state.codeSwitchSummary = null;
  EAQ.state.codeSwitchDrag = null;
  updateCodeSwitchNotice('');
  renderCodeSwitchTimeline();

  // Transcript
  if(prefill.transcript_vtt_url){
    try{
      let vttText = '';
      const res = await fetchWithProxy(prefill.transcript_vtt_url);
      if(res) vttText = await res.text();
      EAQ.state.transcriptVTT = vttText;
      qs('transcriptVTT').value = vttText;
      if(vttText.trim()){ EAQ.state.transcriptCues = VTT.normalize(VTT.parse(vttText)); }
      else { EAQ.state.transcriptCues = []; }
    } catch{}
  } else if(typeof prefill.transcript_vtt === 'string' && prefill.transcript_vtt.trim()){
    EAQ.state.transcriptVTT = prefill.transcript_vtt;
    qs('transcriptVTT').value = prefill.transcript_vtt;
    try{ EAQ.state.transcriptCues = VTT.normalize(VTT.parse(prefill.transcript_vtt)); }catch{}
  }

  const needsSplit = (EAQ.state.transcriptCues||[]).some(c=>{
    const duration = Math.max(0, (+c.end||0) - (+c.start||0));
    return duration > (EAQ.SPEC.cueMax || 6.0) + 0.01 || countWords(c.text) > 18;
  });
  if(needsSplit){
    const splitCues = autoSplitCues(EAQ.state.transcriptCues||[]);
    if(splitCues.length){
      EAQ.state.transcriptCues = splitCues;
      const updated = VTT.stringify(splitCues);
      EAQ.state.transcriptVTT = updated;
      const transcriptBox = qs('transcriptVTT');
      if(transcriptBox) transcriptBox.value = updated;
    }
  }

  // Speaker profiles prefill (robust)
  const allowedGenders = new Set(SPEAKER_GENDERS);
  const allowedAges = new Set(SPEAKER_AGE_BANDS);
  const allowedDialects = new Set(SPEAKER_DIALECTS);

  const normalizeProfile = (entry, idx, fallback)=>{
    const data = entry && typeof entry === 'object' ? entry : {};
    const normEnum = (val, fallbackVal)=>{
      if(val==null) return fallbackVal;
      const str = String(val).trim();
      if(!str) return fallbackVal;
      return str.toLowerCase().replace(/[\s-]+/g,'_');
    };
    const speakerIdRaw = data.speaker_id || data.diarization_speaker || data.speaker || fallback || `spk${idx+1}`;
    const genderCandidate = normalizeSpeakerGender(data.apparent_gender);
    const genderNorm = allowedGenders.has(genderCandidate) ? genderCandidate : 'unknown';
    const ageCandidate = normalizeSpeakerAge(data.apparent_age_band);
    const ageNorm = allowedAges.has(ageCandidate) ? ageCandidate : 'unknown';
    const dialectCandidate = normalizeSpeakerDialect(data.dialect_subregion);
    const dialectNorm = allowedDialects.has(dialectCandidate) ? dialectCandidate : 'unknown';
    return Object.assign({}, data, {
      speaker_id: String(speakerIdRaw || `spk${idx+1}`),
      display_label: String(data.display_label || data.label || `S${idx+1}`),
      apparent_gender: genderNorm,
      apparent_age_band: ageNorm,
      dialect_subregion: dialectNorm
    });
  };

  let speakerPrefillRaw = null;
  if(prefill.speaker_profiles_json_url){
    try{ speakerPrefillRaw = await fetch(prefill.speaker_profiles_json_url).then(r=> r.text()); }
    catch{}
  } else if(prefill.speaker_profiles_json){
    speakerPrefillRaw = prefill.speaker_profiles_json;
  }
  if(speakerPrefillRaw!=null){
    let parsed = speakerPrefillRaw;
    if(typeof parsed === 'string'){
      try{ parsed = JSON.parse(parsed); }
      catch{ parsed = []; }
    }
    if(Array.isArray(parsed)){
      EAQ.state.speakerProfiles = parsed.map((p, idx)=> normalizeProfile(p, idx, p && (p.speaker_id || p.diarization_speaker || p.speaker)));
    } else if(parsed && typeof parsed === 'object'){
      const keys = Object.keys(parsed);
      EAQ.state.speakerProfiles = keys.map((key, idx)=> normalizeProfile(parsed[key], idx, key));
    }
  }

  // Diarization prefill (RTTM)
  const diarSourcePath = prefill.diarization_rttm_path || prefill.diarization_rttm_url || null;
  if(prefill.diarization_rttm_url){
    try{
      const t = await fetch(prefill.diarization_rttm_url).then(r=> r.text());
      const parsed = parseRTTM(t);
      setDiarSegments(parsed, { sourcePath: diarSourcePath, preserveSelection: false });
    }
    catch{
      setDiarSegments([], { sourcePath: diarSourcePath, preserveSelection: false });
    }
  } else if(prefill.diarization_rttm){
    let parsed = [];
    try{ parsed = parseRTTM(prefill.diarization_rttm); }
    catch{ parsed = []; }
    setDiarSegments(parsed, { sourcePath: diarSourcePath, preserveSelection: false });
  } else {
    setDiarSegments([], { sourcePath: diarSourcePath, preserveSelection: false });
  }

  // Emotion prefill
  let emotionText = null;
  if(prefill.emotion_vtt_url){
    try{ emotionText = await fetch(prefill.emotion_vtt_url).then(r=> r.text()); }
    catch{}
  } else if(typeof prefill.emotion_vtt === 'string'){
    emotionText = prefill.emotion_vtt;
  }
  if(typeof emotionText === 'string' && emotionText.trim()){
    commitEmotionSpans(parseEmotionVTT(emotionText), { replaceHistory: true });
  } else {
    commitEmotionSpans([], { replaceHistory: true });
  }

  // Safety / events prefill
  let eventsText = null;
  if(prefill.events_vtt_url){
    try{ eventsText = await fetch(prefill.events_vtt_url).then(r=> r.text()); }
    catch{}
  } else if(typeof prefill.events_vtt === 'string'){
    eventsText = prefill.events_vtt;
  }
  if(typeof eventsText === 'string' && eventsText.trim()){
    commitSafetyEvents(parseSafetyEventsVTT(eventsText), { replaceHistory: true });
  } else {
    commitSafetyEvents([], { replaceHistory: true });
  }

  const clipToggle = qs('clipFlagToggle');
  const clipPrefill = prefill.clipFlagged === true || prefill.clip_flagged === true;
  EAQ.state.clipFlagged = clipPrefill;
  if(clipToggle){ clipToggle.checked = EAQ.state.clipFlagged; }
  refreshTimeline();
  return prefill;
}

function setPrefillNotice(message){
  const screen = qs('screen_transcript');
  if(!screen) return;
  let notice = document.getElementById('prefillNotice');
  if(!notice){
    notice = document.createElement('div');
    notice.id = 'prefillNotice';
    notice.className = 'notice hide';
    notice.style.marginTop = '.5rem';
    const timeline = qs('timeline');
    if(timeline && timeline.parentNode){
      timeline.insertAdjacentElement('afterend', notice);
    } else {
      screen.insertBefore(notice, screen.firstChild || null);
    }
  }
  if(message){
    notice.textContent = message;
    notice.classList.remove('hide');
    notice.classList.add('error');
  } else {
    notice.textContent = '';
    notice.classList.add('hide');
    notice.classList.remove('error');
  }
}

async function loadTranslationAndCodeSwitch(prefill){
  const data = prefill || {};
  const errors = [];
  setPrefillNotice('');

  let translationText = '';
  let translationFetchFailed = false;
  if(typeof data.translation_vtt_url === 'string' && data.translation_vtt_url){
    try{
      const res = await fetchWithProxy(data.translation_vtt_url);
      if(res){
        translationText = await res.text();
      } else {
        translationFetchFailed = true;
        errors.push('translation');
      }
    }catch{
      translationFetchFailed = true;
      errors.push('translation');
    }
  } else if(typeof data.translation_vtt === 'string' && data.translation_vtt.trim()){
    translationText = data.translation_vtt;
  }

  if(translationText){
    EAQ.state.translationCues = VTT.normalize(parseTranslationVttToEntries(translationText));
    EAQ.state.translationVTT = translationText;
  } else if(translationFetchFailed){
    EAQ.state.translationCues = (EAQ.state.transcriptCues||[]).map(c=> ({ start:c.start, end:c.end, text:'' }));
    EAQ.state.translationVTT = '';
  } else {
    EAQ.state.translationCues = Array.isArray(EAQ.state.translationCues) ? EAQ.state.translationCues : [];
    EAQ.state.translationVTT = EAQ.state.translationVTT || '';
  }

  let csText = '';
  if(typeof data.code_switch_vtt_url === 'string' && data.code_switch_vtt_url){
    try{
      const res = await fetchWithProxy(data.code_switch_vtt_url);
      if(res){
        csText = await res.text();
      } else {
        errors.push('code-switch');
      }
    }catch{
      errors.push('code-switch');
    }
  } else if(typeof data.code_switch_vtt === 'string' && data.code_switch_vtt.trim()){
    csText = data.code_switch_vtt;
  }

  if(csText){
    EAQ.state.codeSwitchVTT = csText;
    let spans = [];
    try{ spans = parseCodeSwitchVttToSpans(csText); }
    catch{ spans = []; }
    if(spans.length){
      setCodeSwitchSpans(spans, { pushHistory: false, preserveSelection: false });
    } else {
      await prefillCodeSwitchSpans(data);
    }
  } else {
    await prefillCodeSwitchSpans(data);
  }

  alignTranslationToTranscript({ focusIndex: 0 });

  if(errors.length){
    const unique = Array.from(new Set(errors));
    let label = unique[0];
    if(unique.length > 1){
      const head = unique.slice(0, -1).join(', ');
      label = `${head} and ${unique[unique.length-1]}`;
    }
    setPrefillNotice(`Failed to load ${label} prefill. Using empty placeholders.`);
  } else {
    setPrefillNotice('');
  }
  refreshTimeline();
}

function parseTranslationVttToEntries(text){
  const cues = parseVttSafe(text);
  return cues.map((cue)=>{
    const start = Number.isFinite(+cue.start) ? +cue.start : 0;
    const end = Number.isFinite(+cue.end) ? +cue.end : start;
    return { start, end, text: stripSpeakerTags(cue.text) };
  });
}

function isTranslationLocked(){
  const el = document.getElementById('lockTranslation');
  return !el || el.checked;
}

function ensureTranslationAlignment(transcript, translations, options){
  const lock = isTranslationLocked();
  const preserveExisting = options && options.preserveExisting !== false;
  const aligned = [];
  const existingByKey = new Map();
  if(preserveExisting){
    translations.forEach((entry, idx)=>{
      if(!entry) return;
      const referenceStart = lock && transcript[idx] ? transcript[idx].start : entry.start;
      existingByKey.set(msKey(referenceStart), Object.assign({}, entry));
    });
  }
  transcript.forEach((cue, idx)=>{
    const key = lock ? msKey(cue.start) : msKey((translations[idx] && translations[idx].start) || cue.start);
    const existing = preserveExisting ? (existingByKey.get(key) || translations[idx]) : null;
    const text = existing && typeof existing.text === 'string' ? existing.text : '';
    const start = lock ? cue.start : (existing && Number.isFinite(existing.start) ? existing.start : cue.start);
    const end = lock ? cue.end : (existing && Number.isFinite(existing.end) ? existing.end : cue.end);
    aligned.push({ start, end, text });
  });
  if(!transcript.length && translations.length){
    return translations.map(entry=> Object.assign({}, entry));
  }
  return aligned;
}

function buildTranslationCueText(transcriptCue, translationText){
  const baseText = String(translationText||'').trim();
  const match = /<v\s+([^>]+)>/i.exec(transcriptCue && transcriptCue.text ? transcriptCue.text : '');
  if(match){ return `<v ${match[1]}>${baseText}`; }
  return baseText;
}

function updateTranslationVTTFromState(){
  const transcript = Array.isArray(EAQ.state.transcriptCues) ? EAQ.state.transcriptCues : [];
  const translations = Array.isArray(EAQ.state.translationCues) ? EAQ.state.translationCues : [];
  const cues = transcript.map((cue, idx)=> ({
    start: cue.start,
    end: cue.end,
    text: buildTranslationCueText(cue, translations[idx] ? translations[idx].text : '')
  }));
  const serialized = VTT.stringify(cues);
  EAQ.state.translationVTT = serialized;
  const hidden = qs('translationVTT');
  if(hidden) hidden.value = serialized;
}

function focusTranslationField(index, options){
  const container = qs('translationList');
  if(!container) return;
  const textarea = container.querySelector(`textarea[data-translation-index="${index}"]`);
  if(!textarea) return;
  const shouldScroll = !options || options.scroll !== false;
  if(shouldScroll){
    try{ textarea.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch{}
  }
  textarea.focus({ preventScroll: true });
}

function handleTranslationInput(index, value){
  if(!Array.isArray(EAQ.state.translationCues)) EAQ.state.translationCues = [];
  const cue = EAQ.state.translationCues[index];
  if(cue){ cue.text = value; }
  else {
    EAQ.state.translationCues[index] = { start: 0, end: 0, text: value };
  }
  updateTranslationVTTFromState();
}

function renderTranslationList(options){
  const container = qs('translationList');
  if(!container) return;
  const transcript = Array.isArray(EAQ.state.transcriptCues) ? EAQ.state.transcriptCues : [];
  const translations = Array.isArray(EAQ.state.translationCues) ? EAQ.state.translationCues : [];
  const focusIndex = options && Number.isFinite(options.focusIndex) ? options.focusIndex : null;
  const preserveScroll = options && options.preserveScroll;
  const prevScroll = preserveScroll ? container.scrollTop : 0;
  container.innerHTML = '';
  if(!transcript.length){
    container.innerHTML = '<em>No transcript cues available.</em>';
    updateTranslationWarnings(EAQ.state.lintReport);
    return;
  }
  const frag = document.createDocumentFragment();
  transcript.forEach((cue, idx)=>{
    const row = document.createElement('div');
    row.className = 'translation-row';
    row.dataset.index = String(idx);

    const header = document.createElement('div');
    header.className = 'translation-row__header';
    header.innerHTML = `<strong>Cue #${idx+1}</strong><span>${secToLabel(cue.start)} → ${secToLabel(cue.end)}</span>`;

    const original = document.createElement('div');
    original.className = 'translation-row__original';
    const originalText = stripSpeakerTags(cue.text);
    original.textContent = originalText || '—';

    const textarea = document.createElement('textarea');
    textarea.className = 'translation-row__input';
    textarea.dataset.translationIndex = String(idx);
    textarea.value = translations[idx] ? translations[idx].text || '' : '';
    textarea.setAttribute('aria-label', `Translation for cue ${idx+1}`);
    textarea.addEventListener('input', (ev)=>{
      handleTranslationInput(idx, ev.target.value);
      runValidationAndDisplay('screen_translation');
    });
    textarea.addEventListener('focus', ()=>{ EAQ.state.activeCueIndex = idx; });

    const alert = document.createElement('div');
    alert.className = 'translation-row__alert hide';

    row.appendChild(header);
    row.appendChild(original);
    row.appendChild(textarea);
    row.appendChild(alert);
    row.addEventListener('click', (ev)=>{
      if(ev.target === textarea) return;
      textarea.focus({ preventScroll: true });
    });

    frag.appendChild(row);
  });
  container.appendChild(frag);
  if(preserveScroll){ container.scrollTop = prevScroll; }
  if(focusIndex!=null){ focusTranslationField(focusIndex); }
  updateTranslationWarnings(EAQ.state.lintReport);
}

function collectTranslationInputs(){
  const container = qs('translationList');
  if(!container) return;
  const fields = container.querySelectorAll('textarea[data-translation-index]');
  fields.forEach((field)=>{
    const idx = parseInt(field.getAttribute('data-translation-index')||'-1',10);
    if(!Number.isFinite(idx) || idx<0) return;
    handleTranslationInput(idx, field.value);
  });
  updateTranslationVTTFromState();
}

function updateTranslationWarnings(lint){
  const issues = lint && Array.isArray(lint.translationMissingIndices) ? lint.translationMissingIndices : [];
  const missingSet = new Set(issues);
  const container = qs('translationList');
  if(container){
    container.querySelectorAll('.translation-row').forEach(row=>{
      const idx = parseInt(row.getAttribute('data-index')||'-1',10);
      const alert = row.querySelector('.translation-row__alert');
      if(missingSet.has(idx)){
        row.classList.add('missing');
        if(alert){
          alert.textContent = 'Translation required for this cue.';
          alert.classList.remove('hide');
        }
      } else {
        row.classList.remove('missing');
        if(alert){
          alert.textContent = '';
          alert.classList.add('hide');
        }
      }
    });
  }
  const sticky = qs('translationStickyNotice');
  if(sticky){
    if(issues.length){
      const labels = issues.map(i=> `#${i+1}`).join(', ');
      sticky.textContent = `Missing translations for ${labels}.`;
      sticky.classList.remove('hide');
    } else {
      sticky.textContent = '';
      sticky.classList.add('hide');
    }
  }
}

function alignTranslationToTranscript(options){
  const transcript = Array.isArray(EAQ.state.transcriptCues) ? EAQ.state.transcriptCues : [];
  const translations = Array.isArray(EAQ.state.translationCues) ? EAQ.state.translationCues : [];
  const opts = Object.assign({ preserveExisting: true }, options||{});
  EAQ.state.translationCues = ensureTranslationAlignment(transcript, translations, opts);
  if(opts.forceEmpty){
    EAQ.state.translationCues = EAQ.state.translationCues.map(entry=> Object.assign({}, entry, { text: '' }));
  }
  renderTranslationList({ focusIndex: opts.focusIndex, preserveScroll: opts.preserveScroll });
  updateTranslationVTTFromState();
}

function showCodeSwitchToast(message){
  if(!message) return;
  const toast = qs('csToast');
  if(!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  if(EAQ.state.codeSwitchToastTimer){ clearTimeout(EAQ.state.codeSwitchToastTimer); }
  EAQ.state.codeSwitchToastTimer = setTimeout(()=>{
    toast.classList.remove('show');
  }, 2200);
}

function updateCodeSwitchNotice(message){
  const notice = qs('codeSwitchNotice');
  if(!notice) return;
  if(message){
    notice.textContent = message;
    notice.classList.remove('hide');
  } else {
    notice.textContent = '';
    notice.classList.add('hide');
  }
}

function snapshotCodeSwitchSpans(){
  return (EAQ.state.codeSwitchSpans || []).map(span=> ({
    start: +span.start || 0,
    end: +span.end || 0,
    lang: (span.lang || 'other').toLowerCase(),
    confidence: Number.isFinite(span.confidence) ? span.confidence : 0.8
  }));
}

function snapCodeSwitchTime(time){
  const step = 0.12; // 120ms increments fallback
  if(!Number.isFinite(time)) return 0;
  return Math.max(0, Math.round(time / step) * step);
}

function sanitizeCodeSwitchSpan(span){
  const duration = estimateMediaDuration();
  const minDur = CODE_SWITCH_MIN_DURATION;
  const start = Math.max(0, Math.min(duration, Number.isFinite(span.start) ? span.start : 0));
  let end = Math.max(0, Math.min(duration, Number.isFinite(span.end) ? span.end : start));
  if(end - start < minDur){ end = Math.min(duration, start + minDur); }
  const lang = CODE_SWITCH_LANGS[span.lang] ? span.lang : 'other';
  const confidence = Number.isFinite(span.confidence) ? span.confidence : 0.8;
  return { start, end, lang, confidence };
}

function buildCodeSwitchExports(spans){
  const duration = estimateMediaDuration();
  let total = 0;
  const langs = new Set();
  const cues = [];
  const summarySpans = spans.map(span=>{
    const clean = sanitizeCodeSwitchSpan(span);
    const diff = Math.max(0, clean.end - clean.start);
    total += diff;
    langs.add(clean.lang);
    cues.push({
      start: clean.start,
      end: clean.end,
      text: JSON.stringify({ lang: clean.lang, type: 'phrase_switch', confidence: Number(clean.confidence.toFixed(2)) })
    });
    return {
      start: clean.start,
      end: clean.end,
      lang: clean.lang,
      confidence: Number(clean.confidence.toFixed(2))
    };
  });
  const vtt = VTT.stringify(cues);
  const ratio = duration > 0 ? Math.round((total / duration) * 1000) / 1000 : 0;
  const summary = {
    spans: summarySpans,
    span_count: summarySpans.length,
    total_duration_sec: Math.round(total * 1000) / 1000,
    languages: Array.from(langs),
    non_arabic_duration_ratio: ratio
  };
  return { vtt, summary, langs };
}

function setCodeSwitchSpans(spans, options){
  const opts = Object.assign({ pushHistory: true, preserveSelection: true }, options||{});
  const normalized = (spans||[]).map(sanitizeCodeSwitchSpan).sort((a,b)=> a.start - b.start || a.end - b.end);
  EAQ.state.codeSwitchSpans = normalized;
  const exports = buildCodeSwitchExports(normalized);
  EAQ.state.codeSwitchVTT = exports.vtt;
  EAQ.state.codeSwitchSummary = exports.summary;
  EAQ.state.codeSwitchCues = normalized.map(span=> ({ start: span.start, end: span.end, text: (CODE_SWITCH_LANGS[span.lang] || {}).label || span.lang.toUpperCase() }));
  const csBox = qs('codeSwitchVTT'); if(csBox) csBox.value = exports.vtt;
  if(opts.pushHistory){
    const snapshot = snapshotCodeSwitchSpans();
    EAQ.state.codeSwitchHistory = (EAQ.state.codeSwitchHistory || []).concat([snapshot]);
    if((EAQ.state.codeSwitchHistory||[]).length > 100){ EAQ.state.codeSwitchHistory.shift(); }
    EAQ.state.codeSwitchFuture = [];
  }
  if(opts.preserveSelection !== false){
    if(typeof EAQ.state.codeSwitchSelectedIndex === 'number'){
      if(EAQ.state.codeSwitchSelectedIndex >= normalized.length){
        EAQ.state.codeSwitchSelectedIndex = normalized.length ? normalized.length - 1 : null;
      }
    }
  } else {
    EAQ.state.codeSwitchSelectedIndex = null;
  }
  renderCodeSwitchTimeline();
  if(typeof Timeline !== 'undefined' && typeof Timeline.setOverlays === 'function'){
    const safetyOverlay = (EAQ.state.safetyEvents||[]).map(evt=>({ start: Math.max(0, +evt.startSec||0), end: Math.max(0, +evt.endSec||0) }));
    Timeline.setOverlays(EAQ.state.codeSwitchCues || [], safetyOverlay);
  }
}

function canPlaceCodeSwitchSpan(span, ignoreIndex){
  const spans = snapshotCodeSwitchSpans();
  for(let i=0;i<spans.length;i++){
    if(i === ignoreIndex) continue;
    const existing = spans[i];
    if(existing.start < span.end && span.start < existing.end){
      return false;
    }
  }
  return true;
}

function selectCodeSwitchSpan(index){
  if(index==null || index<0){
    EAQ.state.codeSwitchSelectedIndex = null;
  } else {
    EAQ.state.codeSwitchSelectedIndex = index;
  }
  renderCodeSwitchTimeline();
}

function beginCodeSwitchDrag(ev, index, edge, spanEl){
  ev.preventDefault();
  const container = qs('codeSwitchTimeline');
  if(!container) return;
  const rect = container.getBoundingClientRect();
  EAQ.state.codeSwitchDrag = {
    index,
    edge,
    pointerId: ev.pointerId,
    rect,
    element: spanEl,
    original: snapshotCodeSwitchSpans()
  };
  try{ ev.target.setPointerCapture(ev.pointerId); }
  catch{}
  document.addEventListener('pointermove', handleCodeSwitchDragMove);
  document.addEventListener('pointerup', handleCodeSwitchDragEnd);
}

function applyDragPreview(drag, time){
  const spans = drag.original.map(span=> Object.assign({}, span));
  const span = spans[drag.index];
  if(!span) return null;
  const duration = estimateMediaDuration();
  const minDur = CODE_SWITCH_MIN_DURATION;
  const minGap = 0.02;
  if(drag.edge === 'start'){
    const prev = spans[drag.index - 1];
    let start = Math.max(0, Math.min(time, span.end - minDur));
    if(prev){ start = Math.max(start, prev.end + minGap); }
    span.start = Math.min(start, span.end - minDur);
  } else {
    const next = spans[drag.index + 1];
    let end = Math.min(duration, Math.max(time, span.start + minDur));
    if(next){ end = Math.min(end, next.start - minGap); }
    span.end = Math.max(end, span.start + minDur);
  }
  const left = Math.max(0, span.start / (duration || 1));
  const width = Math.max(0, (span.end - span.start) / (duration || 1));
  if(drag.element){
    drag.element.style.left = `${left * 100}%`;
    drag.element.style.width = `${Math.max(0, width * 100)}%`;
  }
  drag.preview = spans;
  return spans;
}

function handleCodeSwitchDragMove(ev){
  const drag = EAQ.state.codeSwitchDrag;
  if(!drag || ev.pointerId !== drag.pointerId) return;
  const ratio = Math.max(0, Math.min(1, (ev.clientX - drag.rect.left) / Math.max(1, drag.rect.width)));
  const duration = estimateMediaDuration();
  const snapped = snapCodeSwitchTime(ratio * duration);
  applyDragPreview(drag, snapped);
}

function handleCodeSwitchDragEnd(ev){
  const drag = EAQ.state.codeSwitchDrag;
  if(!drag || ev.pointerId !== drag.pointerId) return;
  document.removeEventListener('pointermove', handleCodeSwitchDragMove);
  document.removeEventListener('pointerup', handleCodeSwitchDragEnd);
  try{ ev.target.releasePointerCapture(ev.pointerId); }
  catch{}
  const result = drag.preview || drag.original;
  EAQ.state.codeSwitchDrag = null;
  setCodeSwitchSpans(result, { pushHistory: true });
  selectCodeSwitchSpan(Math.min(drag.index, (EAQ.state.codeSwitchSpans||[]).length-1));
}

function renderCodeSwitchTimeline(){
  const container = qs('codeSwitchTimeline');
  if(!container) return;
  const duration = Math.max(estimateMediaDuration(), 0.001);
  container.innerHTML = '';
  const spans = snapshotCodeSwitchSpans();
  const frag = document.createDocumentFragment();
  spans.forEach((span, idx)=>{
    const info = CODE_SWITCH_LANGS[span.lang] || CODE_SWITCH_LANGS.other;
    const el = document.createElement('div');
    el.className = `cs-span cs-span--${span.lang}`;
    if(EAQ.state.codeSwitchSelectedIndex === idx){ el.classList.add('selected'); }
    const left = Math.max(0, Math.min(1, span.start / duration));
    const width = Math.max(0, Math.min(1, (span.end - span.start) / duration));
    el.style.left = `${left * 100}%`;
    el.style.width = `${Math.max(width * 100, 0.5)}%`;
    el.dataset.index = String(idx);
    const label = document.createElement('span');
    label.className = 'cs-span__label';
    label.textContent = info.label || span.lang.toUpperCase();
    el.appendChild(label);
    el.addEventListener('click', (event)=>{
      event.stopPropagation();
      selectCodeSwitchSpan(idx);
    });
    const handleStart = document.createElement('div');
    handleStart.className = 'cs-handle start';
    handleStart.addEventListener('pointerdown', (ev)=> beginCodeSwitchDrag(ev, idx, 'start', el));
    const handleEnd = document.createElement('div');
    handleEnd.className = 'cs-handle end';
    handleEnd.addEventListener('pointerdown', (ev)=> beginCodeSwitchDrag(ev, idx, 'end', el));
    el.appendChild(handleStart);
    el.appendChild(handleEnd);
    frag.appendChild(el);
  });
  if(EAQ.state.codeSwitchActive){
    const active = EAQ.state.codeSwitchActive;
    const audio = qs('audio');
    const current = audio ? audio.currentTime : active.start;
    const previewEnd = Math.max(active.start + 0.05, current);
    const info = CODE_SWITCH_LANGS[active.lang] || CODE_SWITCH_LANGS.other;
    const el = document.createElement('div');
    el.className = `cs-span cs-span--${active.lang} active-preview`;
    const left = Math.max(0, Math.min(1, active.start / duration));
    const width = Math.max(0, Math.min(1, (previewEnd - active.start) / duration));
    el.style.left = `${left * 100}%`;
    el.style.width = `${Math.max(width * 100, 0.5)}%`;
    const label = document.createElement('span');
    label.className = 'cs-span__label';
    label.textContent = info.label || active.lang.toUpperCase();
    el.appendChild(label);
    frag.appendChild(el);
  }
  container.appendChild(frag);
}

function scheduleActiveSpanRender(){
  if(!EAQ.state.codeSwitchActive) return;
  renderCodeSwitchTimeline();
  EAQ.state.codeSwitchActive.raf = requestAnimationFrame(scheduleActiveSpanRender);
}

function startCodeSwitchSpan(lang){
  const audio = qs('audio');
  if(!audio) return;
  if(EAQ.state.codeSwitchActive){
    showCodeSwitchToast('Finish the current span before starting another.');
    return;
  }
  const safeLang = CODE_SWITCH_LANGS[lang] ? lang : 'other';
  EAQ.state.codeSwitchActive = { lang: safeLang, start: audio.currentTime || 0, raf: null };
  scheduleActiveSpanRender();
}

function endCodeSwitchSpan(){
  const active = EAQ.state.codeSwitchActive;
  const audio = qs('audio');
  if(!active || !audio){ EAQ.state.codeSwitchActive = null; renderCodeSwitchTimeline(); return; }
  if(active.raf){ cancelAnimationFrame(active.raf); }
  EAQ.state.codeSwitchActive = null;
  const end = audio.currentTime || 0;
  const start = Math.max(0, active.start || 0);
  const duration = end - start;
  if(duration < CODE_SWITCH_MIN_DURATION){
    showCodeSwitchToast('Hold the language button for at least 400ms.');
    renderCodeSwitchTimeline();
    return;
  }
  const newSpan = sanitizeCodeSwitchSpan({ start, end, lang: active.lang, confidence: 0.8 });
  if(!canPlaceCodeSwitchSpan(newSpan)){
    showCodeSwitchToast('New span overlaps an existing span.');
    renderCodeSwitchTimeline();
    return;
  }
  const spans = snapshotCodeSwitchSpans();
  spans.push(newSpan);
  setCodeSwitchSpans(spans, { pushHistory: true });
  selectCodeSwitchSpan((EAQ.state.codeSwitchSpans||[]).length-1);
}

function nudgeSelectedSpan(part, delta){
  const spans = snapshotCodeSwitchSpans();
  const idx = EAQ.state.codeSwitchSelectedIndex;
  if(idx==null || idx<0 || idx>=spans.length) return;
  const span = spans[idx];
  const duration = estimateMediaDuration();
  if(part === 'start'){
    span.start = snapCodeSwitchTime(span.start + delta);
    span.start = Math.max(0, Math.min(span.start, span.end - CODE_SWITCH_MIN_DURATION));
    if(idx>0){ span.start = Math.max(span.start, spans[idx-1].end + 0.02); }
  } else {
    span.end = snapCodeSwitchTime(span.end + delta);
    span.end = Math.max(span.end, span.start + CODE_SWITCH_MIN_DURATION);
    if(idx < spans.length-1){ span.end = Math.min(span.end, spans[idx+1].start - 0.02); }
    span.end = Math.min(span.end, duration);
  }
  if(span.end <= span.start + CODE_SWITCH_MIN_DURATION - 0.001){
    showCodeSwitchToast('Cannot reduce span below minimum duration.');
    return;
  }
  setCodeSwitchSpans(spans, { pushHistory: true });
  selectCodeSwitchSpan(idx);
}

function undoCodeSwitch(){
  const history = EAQ.state.codeSwitchHistory || [];
  if(history.length === 0) return;
  const current = snapshotCodeSwitchSpans();
  const previous = history[history.length-1];
  EAQ.state.codeSwitchHistory = history.slice(0, -1);
  EAQ.state.codeSwitchFuture = (EAQ.state.codeSwitchFuture || []).concat([current]);
  setCodeSwitchSpans(previous, { pushHistory: false });
}

function redoCodeSwitch(){
  const future = EAQ.state.codeSwitchFuture || [];
  if(future.length === 0) return;
  const current = snapshotCodeSwitchSpans();
  const next = future[future.length-1];
  EAQ.state.codeSwitchFuture = future.slice(0, -1);
  EAQ.state.codeSwitchHistory = (EAQ.state.codeSwitchHistory || []).concat([current]);
  setCodeSwitchSpans(next, { pushHistory: false });
}

function parseCtmTokens(text){
  const tokens = [];
  (text||'').split(/\r?\n/).forEach(line=>{
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s+/);
    if(parts.length < 5) return;
    const start = parseFloat(parts[2]);
    const dur = parseFloat(parts[3]);
    const word = parts[4];
    if(!Number.isFinite(start) || !Number.isFinite(dur) || !word) return;
    tokens.push({ start, end: start + dur, word });
  });
  return tokens.sort((a,b)=> a.start - b.start);
}

function groupLatinTokens(tokens){
  const spans = [];
  let current = null;
  const latin = /[A-Za-z]/;
  tokens.forEach(tok=>{
    if(!latin.test(tok.word||'')){ current = null; return; }
    if(!current){
      current = { start: tok.start, end: tok.end, tokens: [tok] };
      spans.push(current);
      return;
    }
    const gap = tok.start - current.end;
    if(gap <= 0.2){
      current.end = tok.end;
      current.tokens.push(tok);
    } else {
      current = { start: tok.start, end: tok.end, tokens: [tok] };
      spans.push(current);
    }
  });
  if(!spans.length) return [];
  const merged = [];
  spans.forEach(span=>{
    if(!merged.length){ merged.push(span); return; }
    const last = merged[merged.length-1];
    if(span.start - last.end <= 0.25){
      last.end = span.end;
      last.tokens = last.tokens.concat(span.tokens);
    } else {
      merged.push(span);
    }
  });
  return merged
    .filter(span=> (span.tokens||[]).length >= 3)
    .map(span=> ({ start: span.start, end: span.end, lang: 'eng', confidence: 0.8 }));
}

function groupLatinFromTranscript(){
  const spans = [];
  const cues = EAQ.state.transcriptCues || [];
  cues.forEach(cue=>{
    const text = stripSpeakerTags(cue.text||'');
    if(!text) return;
    const matches = Array.from(text.matchAll(/[A-Za-z][A-Za-z'’\-]*/g));
    if(!matches.length) return;
    let current = [];
    const flush = ()=>{
      if(current.length >= 3){
        const duration = Math.max(0, (+cue.end||0) - (+cue.start||0));
        const startIdx = current[0].index || 0;
        const endIdx = (current[current.length-1].index || 0) + current[current.length-1][0].length;
        const ratioStart = startIdx / Math.max(1, text.length);
        const ratioEnd = endIdx / Math.max(1, text.length);
        const startTime = (+cue.start||0) + ratioStart * duration;
        let endTime = (+cue.start||0) + ratioEnd * duration;
        if(endTime - startTime < CODE_SWITCH_MIN_DURATION){ endTime = startTime + CODE_SWITCH_MIN_DURATION; }
        spans.push({ start: startTime, end: Math.min(+cue.end||endTime, endTime), lang: 'eng', confidence: 0.8 });
      }
      current = [];
    };
    matches.forEach(match=>{
      if(!current.length){ current.push(match); return; }
      const prev = current[current.length-1];
      const gap = (match.index||0) - ((prev.index||0) + prev[0].length);
      if(gap <= 2){
        current.push(match);
      } else {
        flush();
        current.push(match);
      }
    });
    flush();
  });
  return spans;
}

async function prefillCodeSwitchSpans(prefill){
  const data = prefill || {};
  let spans = [];
  let ctmText = '';
  if(data.transcript_ctm_url){
    try{
      const res = await fetchWithProxy(data.transcript_ctm_url);
      if(res){ ctmText = await res.text(); }
    }catch{}
  } else if(typeof data.transcript_ctm === 'string'){
    ctmText = data.transcript_ctm;
  }
  if(ctmText){
    const tokens = parseCtmTokens(ctmText);
    spans = groupLatinTokens(tokens);
  }
  if(!spans.length){
    spans = groupLatinFromTranscript();
  }
  if(spans.length){
    setCodeSwitchSpans(spans, { pushHistory: false, preserveSelection: false });
  } else {
    setCodeSwitchSpans([], { pushHistory: false, preserveSelection: false });
  }
}

function parseCodeSwitchVttToSpans(text){
  const cues = parseVttSafe(text);
  return cues.map(cue=>{
    const raw = (cue.text||'').trim();
    let lang = 'other';
    let confidence = 0.8;
    if(raw){
      try{
        const parsed = JSON.parse(raw);
        if(parsed && typeof parsed === 'object'){
          if(typeof parsed.lang === 'string'){ lang = parsed.lang.toLowerCase(); }
          if(Number.isFinite(+parsed.confidence)){ confidence = +parsed.confidence; }
        }
      }catch{
        const upper = raw.toUpperCase();
        if(upper.includes('FR')) lang = 'fra';
        else if(upper.includes('EN')) lang = 'eng';
      }
    }
    return { start: +cue.start || 0, end: +cue.end || 0, lang: CODE_SWITCH_LANGS[lang] ? lang : 'other', confidence };
  });
}

function rttmStringify(segments, recId){
  try{
    const id = (recId || 'rec').toString().replace(/\s+/g,'_');
    return (segments||[]).map(s=>{
      const tbeg = Math.max(0, +s.start || 0).toFixed(3);
      const tdur = Math.max(0, (+s.end || 0) - (+s.start || 0)).toFixed(3);
      const spk = (s.speaker || 'spk').toString().replace(/\s+/g,'_');
      return `SPEAKER ${id} 1 ${tbeg} ${tdur} <NA> <NA> ${spk} <NA> <NA>`;
    }).join('\n');
  }catch{ return ''; }
}

function parseRTTM(text){
  const out = [];
  const lines = (text||'').split(/\r?\n/);
  for(const ln of lines){
    const t = ln.trim(); if(!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if(parts[0] !== 'SPEAKER' || parts.length < 8) continue;
    const tbeg = parseFloat(parts[3]||'0');
    const tdur = parseFloat(parts[4]||'0');
    if(!Number.isFinite(tbeg) || !Number.isFinite(tdur)) continue;
    const start = Math.max(0, tbeg);
    const end = Math.max(start, start + Math.max(0, tdur));
    const spk = (parts[7] || 'spk').trim() || 'spk';
    out.push({ start, end, duration: Math.max(0, end - start), speaker: spk });
  }
  out.sort((a,b)=> a.start - b.start || a.end - b.end);
  const order = new Map();
  out.forEach(seg=>{
    const key = seg.speaker || 'spk';
    if(!order.has(key)){ order.set(key, `S${order.size + 1}`); }
    seg.label = order.get(key) || key;
  });
  return out;
}

function renderDiarList(){
  const el = qs('diarList'); if(!el) return;
  const segments = Array.isArray(EAQ.state.diarSegments) ? EAQ.state.diarSegments : [];
  if(!segments.length){
    el.innerHTML = '<em>No diarization loaded.</em>';
    renderSpeakerCards();
    return;
  }
  const frag = document.createDocumentFragment();
  segments.forEach((seg, idx)=>{
    const row = document.createElement('div');
    row.className = 'diar-row';
    if(EAQ.state.diarSelectedIndex === idx){ row.classList.add('selected'); }
    row.dataset.diarIndex = String(idx);

    const badge = document.createElement('code');
    badge.textContent = seg.label || `S${idx+1}`;
    badge.style.background = colorForSpeaker(seg.speaker);
    badge.style.color = '#fff';
    badge.style.padding = '0 6px';
    badge.style.borderRadius = '4px';
    badge.style.fontWeight = '600';
    badge.title = seg.speaker || badge.textContent;

    const info = document.createElement('span');
    info.textContent = `${secToLabel(seg.start)} → ${secToLabel(seg.end)} (${seg.speaker})`;
    info.style.flex = '1 1 auto';
    info.style.minWidth = '0';

    const duration = document.createElement('span');
    duration.style.marginLeft = 'auto';
    duration.style.fontSize = '.85rem';
    duration.style.color = 'var(--muted, #666)';
    duration.textContent = `${Math.max(0, seg.end - seg.start).toFixed(2)}s`;

    const minusBtn = document.createElement('button');
    minusBtn.textContent = '-50ms';
    minusBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const segmentsCopy = (EAQ.state.diarSegments||[]).map((entry, entryIdx)=>{
        if(entryIdx !== idx) return Object.assign({}, entry);
        const candidate = Math.max(0, entry.start - 0.05);
        const maxStart = Math.max(0, entry.end - 0.05);
        const newStart = Math.min(candidate, maxStart);
        if(Math.abs(newStart - entry.start) > 0.5) return Object.assign({}, entry);
        if(newStart >= entry.end) return Object.assign({}, entry);
        return Object.assign({}, entry, { start: newStart });
      });
      const focusSegment = segmentsCopy[idx];
      setDiarSegments(segmentsCopy, { preserveSelection: true, focusSegment });
    });

    const plusBtn = document.createElement('button');
    plusBtn.textContent = '+50ms';
    plusBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const segmentsCopy = (EAQ.state.diarSegments||[]).map((entry, entryIdx)=>{
        if(entryIdx !== idx) return Object.assign({}, entry);
        const candidate = Math.max(0, entry.start + 0.05);
        const maxStart = Math.max(0, entry.end - 0.05);
        const newStart = Math.min(candidate, maxStart);
        if(Math.abs(newStart - entry.start) > 0.5) return Object.assign({}, entry);
        if(newStart >= entry.end) return Object.assign({}, entry);
        return Object.assign({}, entry, { start: newStart });
      });
      const focusSegment = segmentsCopy[idx];
      setDiarSegments(segmentsCopy, { preserveSelection: true, focusSegment });
    });

    row.appendChild(badge);
    row.appendChild(minusBtn);
    row.appendChild(plusBtn);
    row.appendChild(info);
    row.appendChild(duration);

    row.addEventListener('click', ()=> selectDiarSegment(idx, { focusTranscript: true }));
    frag.appendChild(row);
  });
  el.innerHTML = '';
  el.appendChild(frag);
  renderSpeakerCards();
}

function listUniqueSpeakers(){
  const segments = Array.isArray(EAQ.state.diarSegments) ? EAQ.state.diarSegments : [];
  const labelMap = new Map();
  segments.forEach(seg=>{
    if(!seg) return;
    const speakerId = seg.speaker ? String(seg.speaker) : 'spk';
    if(!labelMap.has(speakerId)){
      labelMap.set(speakerId, seg.label || speakerId);
    }
  });
  const seen = [];
  const seenSet = new Set();
  for(const seg of segments){
    if(!seg) continue;
    const speakerId = seg.speaker!=null ? String(seg.speaker) : 'spk';
    if(!seenSet.has(speakerId)){
      seenSet.add(speakerId);
      seen.push(speakerId);
    }
  }
  return seen;
}

function renderSpeakerCards(){
  const container = qs('speakerCards');
  if(!container) return;

  const speakers = listUniqueSpeakers();
  const errorBox = qs('speakerDrawerError');
  if(!speakers.length){
    container.innerHTML = '<em>No diarization loaded. Speaker attributes unavailable.</em>';
    EAQ.state.speakerProfiles = [];
    if(errorBox){ errorBox.classList.add('hide'); errorBox.textContent = ''; }
    return;
  }

  const existing = Array.isArray(EAQ.state.speakerProfiles) ? EAQ.state.speakerProfiles : [];
  const normalized = speakers.map((speakerId, idx)=>{
    const found = existing.find((p)=> p && p.speaker_id === speakerId) || {};
    const defaultLabel = labelMap.get(speakerId) || `S${idx+1}`;
    const display = String(found.display_label || defaultLabel);
    const genderSel = normalizeValue(found.apparent_gender, 'unknown', allowedGenderVals);
    const ageSel = normalizeValue(found.apparent_age_band, 'unknown', allowedAgeVals);
    const dialectSel = normalizeValue(found.dialect_subregion, 'unknown', allowedDialectVals);
    return Object.assign({}, found, {
    const display = String(found.display_label || `S${idx+1}`);
    const gender = normalizeSpeakerGender(found.apparent_gender);
    const age = normalizeSpeakerAge(found.apparent_age_band);
    const dialect = normalizeSpeakerDialect(found.dialect_subregion);
    return {
      speaker_id: String(speakerId),
      display_label: display,
      apparent_gender: SPEAKER_GENDER_SET.has(gender) ? gender : 'unknown',
      apparent_age_band: SPEAKER_AGE_SET.has(age) ? age : 'unknown',
      dialect_subregion: SPEAKER_DIALECT_SET.has(dialect) ? dialect : 'unknown'
    };
  });
  EAQ.state.speakerProfiles = normalized;

  const renderOptions = (options, selected)=>{
    const active = selected && typeof selected === 'string' ? selected : 'unknown';
    return options.map((opt)=>{
      const attrs = [`value="${escapeHtml(opt.value)}"`];
      if(opt.value === active){ attrs.push('selected'); }
      return `<option ${attrs.join(' ')}>${escapeHtml(opt.label)}</option>`;
    }).join('');
  };

  const cards = normalized.map((profile, idx)=>{
    const display = String(profile.display_label || `S${idx+1}`);
    const speakerId = String(profile.speaker_id || `spk${idx+1}`);
    const accent = colorForSpeaker(speakerId);
    const cardStyle = `margin-bottom:1rem;border-left:6px solid ${escapeHtml(accent)};padding-left:.75rem;`;
    const genderSel = normalizeValue(profile.apparent_gender, 'unknown', allowedGenderVals);
    const ageSel = normalizeValue(profile.apparent_age_band, 'unknown', allowedAgeVals);
    const dialectSel = normalizeValue(profile.dialect_subregion, 'unknown', allowedDialectVals);
    const genderOptionsHtml = renderOptions(genderOptions, genderSel);
    const ageOptionsHtml = renderOptions(ageOptions, ageSel);
    const dialectOptionsHtml = renderOptions(dialectOptions, dialectSel);
    return `<div class="notice" data-speaker-card data-speaker-id="${escapeHtml(speakerId)}" data-display-label="${escapeHtml(display)}" style="${cardStyle}">`+
      `<h4 style="margin:0 0 .5rem 0;">${escapeHtml(display)} <small style="font-weight:normal;color:var(--text-muted,inherit);">(Diar speaker: ${escapeHtml(speakerId)})</small></h4>`+
      `<label style="display:block;margin-bottom:.5rem;">Apparent gender <select name="apparent_gender">${genderOptionsHtml}</select></label>`+
      `<label style="display:block;margin-bottom:.5rem;">Apparent age band <select name="apparent_age_band">${ageOptionsHtml}</select></label>`+
      `<label style="display:block;margin-bottom:.5rem;">Dialect sub-region <select name="dialect_subregion">${dialectOptionsHtml}</select></label>`+
    `</div>`;
    const display = profile.display_label || `S${idx+1}`;
    const speakerId = profile.speaker_id || `spk${idx+1}`;
    const genderOptions = renderOptions(SPEAKER_GENDER_OPTIONS, profile.apparent_gender || 'unknown');
    const ageOptions = renderOptions(SPEAKER_AGE_OPTIONS, profile.apparent_age_band || 'unknown');
    const dialectOptions = renderOptions(SPEAKER_DIALECT_OPTIONS, profile.dialect_subregion || 'unknown');
    return `<section class="speaker-card" data-speaker-card data-speaker-id="${escapeHtml(speakerId)}" data-display-label="${escapeHtml(display)}">`+
      `<p class="speaker-card__title"><strong>${escapeHtml(display)}</strong><span class="speaker-card__subtitle">Diar speaker: ${escapeHtml(speakerId)}</span></p>`+
      `<label>Apparent gender<select name="apparent_gender" class="speaker-card__select">${genderOptions}</select></label>`+
      `<label>Apparent age band<select name="apparent_age_band" class="speaker-card__select">${ageOptions}</select></label>`+
      `<label>Dialect sub-region<select name="dialect_subregion" class="speaker-card__select">${dialectOptions}</select></label>`+
    `</section>`;
  }).join('');
  container.innerHTML = cards;

  container.querySelectorAll('select').forEach((selectEl)=>{
    selectEl.addEventListener('change', ()=>{
      syncSpeakerProfilesFromUI({ silent: true });
      runValidationAndDisplay('screen_codeswitch');
    });
  });

  syncSpeakerProfilesFromUI({ silent: true });
}

function syncSpeakerProfilesFromUI(options){
  const opts = options || {};
  const container = qs('speakerCards');
  if(!container){
    EAQ.state.speakerProfiles = [];
    return true;
  }
  const cards = Array.from(container.querySelectorAll('[data-speaker-card]'));
  if(!cards.length){
    EAQ.state.speakerProfiles = [];
    const errorBox = qs('speakerDrawerError');
    if(errorBox){ errorBox.classList.add('hide'); errorBox.textContent = ''; }
    return true;
  }

  const profiles = [];
  const missing = [];
  cards.forEach((card, idx)=>{
    const speakerId = card.getAttribute('data-speaker-id') || `spk${idx+1}`;
    const displayLabel = card.getAttribute('data-display-label') || `S${idx+1}`;
    const genderSel = card.querySelector('select[name="apparent_gender"]');
    const ageSel = card.querySelector('select[name="apparent_age_band"]');
    const dialectSel = card.querySelector('select[name="dialect_subregion"]');
    const genderRaw = genderSel ? genderSel.value : '';
    const ageRaw = ageSel ? ageSel.value : '';
    const dialectRaw = dialectSel ? dialectSel.value : '';
    const gender = normalizeSpeakerGender(genderRaw);
    const age = normalizeSpeakerAge(ageRaw);
    const dialect = normalizeSpeakerDialect(dialectRaw);
    const genderValid = !!genderSel && genderSel.value !== '' && SPEAKER_GENDER_SET.has(gender);
    const ageValid = !!ageSel && ageSel.value !== '' && SPEAKER_AGE_SET.has(age);
    const dialectValid = !!dialectSel && dialectSel.value !== '' && SPEAKER_DIALECT_SET.has(dialect);
    if(!genderValid || !ageValid || !dialectValid){
      missing.push(displayLabel || speakerId);
    }
    profiles.push({
      speaker_id: String(speakerId),
      display_label: String(displayLabel),
      apparent_gender: SPEAKER_GENDER_SET.has(gender) ? gender : 'unknown',
      apparent_age_band: SPEAKER_AGE_SET.has(age) ? age : 'unknown',
      dialect_subregion: SPEAKER_DIALECT_SET.has(dialect) ? dialect : 'unknown'
    });
  });

  EAQ.state.speakerProfiles = profiles;

  const errorBox = qs('speakerDrawerError');
  if(missing.length){
    if(!opts.silent && errorBox){
      const label = missing.length === 1 ? missing[0] : `${missing.slice(0,-1).join(', ')} and ${missing.slice(-1)[0]}`;
      errorBox.textContent = `Select gender, age band, and dialect for ${label}. Unknown is allowed.`;
      errorBox.classList.remove('hide');
    }
    return false;
  }
  if(errorBox){ errorBox.classList.add('hide'); errorBox.textContent = ''; }
  return true;
}

function normalizeEmotionLabel(label){
  const raw = String(label || '').trim().toLowerCase();
  if(!raw){ return 'neutral'; }
  if(EMOTION_LABEL_SET.has(raw)) return raw;
  if(raw in EMOTION_ALIASES && EMOTION_LABEL_SET.has(EMOTION_ALIASES[raw])){
    return EMOTION_ALIASES[raw];
  }
  if(raw.includes('happy')) return 'happy';
  if(raw.includes('angry') || raw.includes('mad')) return 'angry';
  if(raw.includes('sad')) return 'sad';
  if(raw.includes('excite')) return 'excited';
  if(raw.includes('neutral')) return 'neutral';
  return 'other';
}

function getEmotionOption(label){
  const normalized = normalizeEmotionLabel(label);
  return EMOTION_OPTIONS.find(opt=> opt.id === normalized) || EMOTION_OPTIONS[0];
}

function cloneEmotionSpans(spans){
  return (Array.isArray(spans) ? spans : []).map(span=>{
    const startCandidate = Number.isFinite(span.startSec) ? span.startSec : (Number.isFinite(span.start) ? span.start : 0);
    const normStart = Math.max(0, startCandidate || 0);
    const endCandidate = Number.isFinite(span.endSec) ? span.endSec : (Number.isFinite(span.end) ? span.end : normStart + EMOTION_MIN_DURATION);
    const normEnd = Math.max(normStart, endCandidate);
    return {
      startSec: normStart,
      endSec: normEnd,
      label: normalizeEmotionLabel(span.label || span.text),
      confidence: Number.isFinite(span.confidence) ? Math.max(0, Math.min(1, span.confidence)) : 0.9
    };
  }).filter(span=> span.endSec > span.startSec).sort((a,b)=> a.startSec - b.startSec || a.endSec - b.endSec);
}

function cloneSafetyEvents(events){
  return (Array.isArray(events) ? events : []).map(evt=>{
    const startCandidate = Number.isFinite(evt.startSec) ? evt.startSec : (Number.isFinite(evt.start) ? evt.start : 0);
    const normStart = Math.max(0, startCandidate || 0);
    const endCandidate = Number.isFinite(evt.endSec) ? evt.endSec : (Number.isFinite(evt.end) ? evt.end : normStart + SAFETY_DEFAULT_DURATION);
    const duration = Math.max(0.05, endCandidate - normStart);
    const type = normalizeSafetyType(evt.type || evt.label || evt.text);
    return {
      startSec: normStart,
      endSec: normStart + duration,
      type
    };
  }).filter(evt=> evt.endSec > evt.startSec).sort((a,b)=> a.startSec - b.startSec || a.endSec - b.endSec);
}

function normalizeSafetyType(type){
  const raw = String(type || '').trim().toLowerCase();
  if(SAFETY_TYPE_SET.has(raw)) return raw;
  return 'pii_name';
}

function getSafetyOption(type){
  const normalized = normalizeSafetyType(type);
  return SAFETY_EVENT_TYPES.find(opt=> opt.id === normalized) || SAFETY_EVENT_TYPES[0];
}

function insertEmotionSpan(existingSpans, candidate){
  const spans = cloneEmotionSpans(existingSpans);
  const duration = Math.max(estimateMediaDuration() || 0, candidate.endSec || candidate.startSec || 0);
  const label = normalizeEmotionLabel(candidate.label || candidate.text);
  const confidence = Number.isFinite(candidate.confidence) ? Math.max(0, Math.min(1, candidate.confidence)) : 0.9;
  const startCandidate = Number.isFinite(candidate.startSec) ? candidate.startSec : (Number.isFinite(candidate.start) ? candidate.start : 0);
  const endCandidate = Number.isFinite(candidate.endSec) ? candidate.endSec : (Number.isFinite(candidate.end) ? candidate.end : (startCandidate + EMOTION_MIN_DURATION));
  let start = Math.max(0, startCandidate || 0);
  let end = Math.max(start + EMOTION_MIN_DURATION, endCandidate || start);
  const totalDuration = duration > 0 ? duration : Math.max(end, start + EMOTION_MIN_DURATION);
  if(end - start < EMOTION_MIN_DURATION){ end = start + EMOTION_MIN_DURATION; }
  if(end > totalDuration){
    end = totalDuration;
    if(end - start < EMOTION_MIN_DURATION){
      start = Math.max(0, end - EMOTION_MIN_DURATION);
    }
  }
  const insertIndex = spans.findIndex(span=> span.startSec > start);
  const idx = insertIndex === -1 ? spans.length : insertIndex;
  const prev = spans[idx-1] || null;
  const next = spans[idx] || null;
  const windowStart = prev ? prev.endSec : 0;
  const windowEnd = next ? next.startSec : totalDuration;
  if(windowEnd - windowStart < EMOTION_MIN_DURATION - 0.001){
    return null;
  }
  const maxStart = windowEnd - EMOTION_MIN_DURATION;
  start = Math.min(Math.max(start, windowStart), maxStart);
  end = Math.max(start + EMOTION_MIN_DURATION, Math.min(end, windowEnd));
  if(end - start < EMOTION_MIN_DURATION - 0.001){
    return null;
  }
  spans.splice(idx, 0, { startSec: start, endSec: end, label, confidence });
  return { spans, index: idx };
}

function insertSafetyEvent(existingEvents, candidate){
  const events = cloneSafetyEvents(existingEvents);
  const startCandidate = Number.isFinite(candidate.startSec) ? candidate.startSec : (Number.isFinite(candidate.start) ? candidate.start : 0);
  const durationCandidate = Number.isFinite(candidate.duration) ? candidate.duration : ((Number.isFinite(candidate.endSec) ? candidate.endSec : (Number.isFinite(candidate.end) ? candidate.end : startCandidate + SAFETY_DEFAULT_DURATION)) - startCandidate);
  const duration = Math.max(0.05, durationCandidate || SAFETY_DEFAULT_DURATION);
  let start = Math.max(0, startCandidate || 0);
  const totalDuration = Math.max(estimateMediaDuration() || 0, start + duration);
  const insertIndex = events.findIndex(evt=> evt.startSec > start);
  const idx = insertIndex === -1 ? events.length : insertIndex;
  const prev = events[idx-1] || null;
  const next = events[idx] || null;
  const windowStart = prev ? prev.endSec : 0;
  const windowEnd = next ? next.startSec : totalDuration;
  if(windowEnd - windowStart < duration - 0.001){
    return null;
  }
  start = Math.min(Math.max(start, windowStart), windowEnd - duration);
  const end = start + duration;
  const type = normalizeSafetyType(candidate.type || candidate.label || candidate.text);
  events.splice(idx, 0, { startSec: start, endSec: end, type });
  return { events, index: idx };
}

function commitEmotionSpans(spans, options){
  const opts = Object.assign({ pushHistory: true }, options||{});
  const normalized = cloneEmotionSpans(spans);
  if(opts.replaceHistory){
    EAQ.state.emotionHistory = [];
    EAQ.state.emotionFuture = [];
  } else if(opts.pushHistory){
    EAQ.state.emotionHistory.push(cloneEmotionSpans(EAQ.state.emotionSpans));
    if(EAQ.state.emotionHistory.length > 100){ EAQ.state.emotionHistory.shift(); }
    EAQ.state.emotionFuture = [];
  }
  EAQ.state.emotionSpans = normalized;
  if(typeof opts.selectIndex === 'number'){
    if(normalized.length === 0){ EAQ.state.emotionSelectedIndex = null; }
    else { EAQ.state.emotionSelectedIndex = Math.max(0, Math.min(normalized.length-1, opts.selectIndex)); }
  } else if(normalized.length === 0){
    EAQ.state.emotionSelectedIndex = null;
  } else if(EAQ.state.emotionSelectedIndex!=null && EAQ.state.emotionSelectedIndex >= normalized.length){
    EAQ.state.emotionSelectedIndex = normalized.length-1;
  }
  renderEmotionSafetyTimeline();
}

function commitSafetyEvents(events, options){
  const opts = Object.assign({ pushHistory: true }, options||{});
  const normalized = cloneSafetyEvents(events);
  if(opts.replaceHistory){
    EAQ.state.safetyHistory = [];
    EAQ.state.safetyFuture = [];
  } else if(opts.pushHistory){
    EAQ.state.safetyHistory.push(cloneSafetyEvents(EAQ.state.safetyEvents));
    if(EAQ.state.safetyHistory.length > 100){ EAQ.state.safetyHistory.shift(); }
    EAQ.state.safetyFuture = [];
  }
  EAQ.state.safetyEvents = normalized;
  if(typeof opts.selectIndex === 'number'){
    if(normalized.length === 0){ EAQ.state.safetySelectedIndex = null; }
    else { EAQ.state.safetySelectedIndex = Math.max(0, Math.min(normalized.length-1, opts.selectIndex)); }
  } else if(normalized.length === 0){
    EAQ.state.safetySelectedIndex = null;
  } else if(EAQ.state.safetySelectedIndex!=null && EAQ.state.safetySelectedIndex >= normalized.length){
    EAQ.state.safetySelectedIndex = normalized.length-1;
  }
  renderEmotionSafetyTimeline();
}

function buildEmotionVTT(spans){
  const list = cloneEmotionSpans(spans);
  if(!list.length) return '';
  const lines = ['WEBVTT',''];
  list.forEach(span=>{
    lines.push(`${secToLabel(span.startSec)} --> ${secToLabel(span.endSec)}`);
    lines.push(JSON.stringify({ emotion: span.label }));
    lines.push('');
  });
  return lines.join('\n');
}

function buildSafetyEventsVTT(events){
  const list = cloneSafetyEvents(events);
  if(!list.length) return '';
  const lines = ['WEBVTT',''];
  list.forEach(evt=>{
    lines.push(`${secToLabel(evt.startSec)} --> ${secToLabel(evt.endSec)}`);
    lines.push(JSON.stringify({ event: evt.type }));
    lines.push('');
  });
  return lines.join('\n');
}

function parseEmotionVTT(text){
  const spans = [];
  try{
    const cues = VTT.parse(text||'');
    cues.forEach(cue=>{
      const start = Math.max(0, cue.start || 0);
      const end = Math.max(start, cue.end || start);
      let label = (cue.text || '').trim();
      try{
        const parsed = JSON.parse(label);
        if(parsed && typeof parsed === 'object' && parsed.emotion){
          label = parsed.emotion;
        }
      }catch{}
      spans.push({ startSec: start, endSec: end, label: normalizeEmotionLabel(label), confidence: 0.9 });
    });
  }catch{}
  let working = [];
  spans.sort((a,b)=> a.startSec - b.startSec || a.endSec - b.endSec).forEach(span=>{
    const inserted = insertEmotionSpan(working, span);
    if(inserted){ working = inserted.spans; }
  });
  return working;
}

function parseSafetyEventsVTT(text){
  const events = [];
  try{
    const cues = VTT.parse(text||'');
    cues.forEach(cue=>{
      const start = Math.max(0, cue.start || 0);
      const end = Math.max(start, cue.end || (start + SAFETY_DEFAULT_DURATION));
      let type = (cue.text || '').trim();
      try{
        const parsed = JSON.parse(type);
        if(parsed && typeof parsed === 'object' && parsed.event){
          type = parsed.event;
        }
      }catch{}
      events.push({ startSec: start, endSec: end, type: normalizeSafetyType(type) });
    });
  }catch{}
  let working = [];
  events.sort((a,b)=> a.startSec - b.startSec || a.endSec - b.endSec).forEach(evt=>{
    const inserted = insertSafetyEvent(working, evt);
    if(inserted){ working = inserted.events; }
  });
  return working;
}

function renderEmotionSafetyTimeline(){
  const emotionLane = qs('emotionLane');
  const safetyLane = qs('safetyLane');
  const emotionEmpty = qs('emotionEmptyNotice');
  const safetyEmpty = qs('safetyEmptyNotice');
  const clipToggle = qs('clipFlagToggle');
  if(clipToggle){ clipToggle.checked = !!EAQ.state.clipFlagged; }
  const durationEstimate = estimateMediaDuration();
  const safeDuration = durationEstimate > 0 ? durationEstimate : Math.max(1, (EAQ.state.transcriptCues||[]).reduce((max, cue)=> Math.max(max, cue.end||0), 0));

  if(emotionLane){
    emotionLane.innerHTML = '';
    const baseSpans = cloneEmotionSpans(EAQ.state.emotionSpans || []).map((span, index)=> Object.assign({}, span, { sourceIndex: index }));
    if(EAQ.state.emotionActive){
      const active = EAQ.state.emotionActive;
      baseSpans.push({
        startSec: Math.max(0, active.startSec||0),
        endSec: Math.max(Math.max(0, active.startSec||0), active.endSec||active.startSec||0),
        label: normalizeEmotionLabel(active.label||'neutral'),
        confidence: active.confidence || 0.9,
        preview: true
      });
    }
    baseSpans.forEach(span=>{
      const option = getEmotionOption(span.label);
      const spanEl = document.createElement('div');
      spanEl.className = 'emotion-span';
      spanEl.style.background = option.background;
      spanEl.style.border = `1px solid ${option.color}`;
      const left = safeDuration > 0 ? (Math.max(0, Math.min(safeDuration, span.startSec)) / safeDuration) * 100 : 0;
      const width = safeDuration > 0 ? Math.max(0.5, ((Math.max(span.startSec, Math.min(safeDuration, span.endSec)) - Math.max(0, Math.min(safeDuration, span.startSec))) / safeDuration) * 100) : 100;
      spanEl.style.left = `${left}%`;
      spanEl.style.width = `${width}%`;
      const labelEl = document.createElement('span');
      labelEl.className = 'emotion-span__label';
      labelEl.textContent = option.label.toLowerCase();
      spanEl.appendChild(labelEl);
      if(span.preview){
        spanEl.classList.add('preview');
      } else {
        spanEl.dataset.index = String(span.sourceIndex);
        if(EAQ.state.emotionSelectedIndex === span.sourceIndex){ spanEl.classList.add('selected'); }
        spanEl.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          EAQ.state.emotionSelectedIndex = span.sourceIndex;
          renderEmotionSafetyTimeline();
        });
        const handleStart = document.createElement('div');
        handleStart.className = 'emotion-span__handle start';
        handleStart.addEventListener('pointerdown', (ev)=> beginEmotionHandleDrag(span.sourceIndex, 'start', ev));
        const handleEnd = document.createElement('div');
        handleEnd.className = 'emotion-span__handle end';
        handleEnd.addEventListener('pointerdown', (ev)=> beginEmotionHandleDrag(span.sourceIndex, 'end', ev));
        spanEl.appendChild(handleStart);
        spanEl.appendChild(handleEnd);
      }
      emotionLane.appendChild(spanEl);
    });
    if(emotionEmpty){
      const hasSpans = (EAQ.state.emotionSpans||[]).length > 0;
      emotionEmpty.classList.toggle('hide', hasSpans);
    }
  }

  if(safetyLane){
    safetyLane.innerHTML = '';
    const baseEvents = cloneSafetyEvents(EAQ.state.safetyEvents || []).map((evt, index)=> Object.assign({}, evt, { sourceIndex: index }));
    baseEvents.forEach(evt=>{
      const option = getSafetyOption(evt.type);
      const evEl = document.createElement('div');
      evEl.className = 'safety-event';
      evEl.style.background = option.color;
      const left = safeDuration > 0 ? (Math.max(0, Math.min(safeDuration, evt.startSec)) / safeDuration) * 100 : 0;
      const width = safeDuration > 0 ? Math.max(0.5, ((Math.max(evt.startSec, Math.min(safeDuration, evt.endSec)) - Math.max(0, Math.min(safeDuration, evt.startSec))) / safeDuration) * 100) : 5;
      evEl.style.left = `${left}%`;
      evEl.style.width = `${width}%`;
      evEl.dataset.index = String(evt.sourceIndex);
      evEl.setAttribute('aria-label', option.label);
      if(EAQ.state.safetySelectedIndex === evt.sourceIndex){ evEl.classList.add('selected'); }
      evEl.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        EAQ.state.safetySelectedIndex = evt.sourceIndex;
        renderEmotionSafetyTimeline();
      });
      evEl.addEventListener('pointerdown', (ev)=> beginSafetyDrag(evt.sourceIndex, ev));
      const labelEl = document.createElement('span');
      labelEl.className = 'safety-event__label';
      labelEl.textContent = option.label.replace('PII: ','');
      evEl.appendChild(labelEl);
      safetyLane.appendChild(evEl);
    });
    if(safetyEmpty){
      const hasEvents = (EAQ.state.safetyEvents||[]).length > 0;
      safetyEmpty.classList.toggle('hide', hasEvents);
    }
  }
}

function setupEmotionSafetyControls(){
  const emotionContainer = qs('emotionButtons');
  if(emotionContainer && !emotionContainer.dataset.bound){
    emotionContainer.dataset.bound = '1';
    EMOTION_OPTIONS.forEach(opt=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = opt.label;
      btn.dataset.emotion = opt.id;
      emotionContainer.appendChild(btn);
      btn.addEventListener('pointerdown', (ev)=>{ ev.preventDefault(); startEmotionCapture(opt.id, ev); });
      btn.addEventListener('keydown', (ev)=>{
        if(ev.key === 'Enter' || ev.key === ' '){
          ev.preventDefault();
          startEmotionCapture(opt.id, ev);
          setTimeout(()=> finishEmotionCapture(), 220);
        }
      });
    });
  }

  const safetyContainer = qs('safetyButtons');
  if(safetyContainer && !safetyContainer.dataset.bound){
    safetyContainer.dataset.bound = '1';
    SAFETY_EVENT_TYPES.forEach(opt=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = opt.label;
      btn.dataset.eventType = opt.id;
      safetyContainer.appendChild(btn);
      btn.addEventListener('click', ()=> addSafetyEvent(opt.id));
    });
  }

  const clipToggle = qs('clipFlagToggle');
  if(clipToggle && !clipToggle.dataset.bound){
    clipToggle.dataset.bound = '1';
    clipToggle.checked = !!EAQ.state.clipFlagged;
    clipToggle.addEventListener('change', ()=>{ EAQ.state.clipFlagged = !!clipToggle.checked; });
  }

  const emotionUndo = qs('emotionUndo');
  if(emotionUndo && !emotionUndo.dataset.bound){
    emotionUndo.dataset.bound = '1';
    emotionUndo.addEventListener('click', ()=> undoEmotion());
  }
  const emotionRedo = qs('emotionRedo');
  if(emotionRedo && !emotionRedo.dataset.bound){
    emotionRedo.dataset.bound = '1';
    emotionRedo.addEventListener('click', ()=> redoEmotion());
  }
  const emotionDelete = qs('emotionDelete');
  if(emotionDelete && !emotionDelete.dataset.bound){
    emotionDelete.dataset.bound = '1';
    emotionDelete.addEventListener('click', ()=> deleteSelectedEmotion());
  }
  const safetyUndo = qs('safetyUndo');
  if(safetyUndo && !safetyUndo.dataset.bound){
    safetyUndo.dataset.bound = '1';
    safetyUndo.addEventListener('click', ()=> undoSafety());
  }
  const safetyRedo = qs('safetyRedo');
  if(safetyRedo && !safetyRedo.dataset.bound){
    safetyRedo.dataset.bound = '1';
    safetyRedo.addEventListener('click', ()=> redoSafety());
  }
  const safetyDelete = qs('safetyDelete');
  if(safetyDelete && !safetyDelete.dataset.bound){
    safetyDelete.dataset.bound = '1';
    safetyDelete.addEventListener('click', ()=> deleteSelectedSafety());
  }

  const emotionLane = qs('emotionLane');
  if(emotionLane && !emotionLane.dataset.bound){
    emotionLane.dataset.bound = '1';
    emotionLane.addEventListener('click', (ev)=>{
      if(ev.target === emotionLane){
        EAQ.state.emotionSelectedIndex = null;
        renderEmotionSafetyTimeline();
      }
    });
  }
  const safetyLane = qs('safetyLane');
  if(safetyLane && !safetyLane.dataset.bound){
    safetyLane.dataset.bound = '1';
    safetyLane.addEventListener('click', (ev)=>{
      if(ev.target === safetyLane){
        EAQ.state.safetySelectedIndex = null;
        renderEmotionSafetyTimeline();
      }
    });
  }

  renderEmotionSafetyTimeline();
}

function startEmotionCapture(label, ev){
  if(EAQ.state.emotionActive){ cancelEmotionCapture(); }
  const audio = EAQ.audio;
  if(!audio) return;
  const startSec = Math.max(0, audio.currentTime || 0);
  const active = {
    label: normalizeEmotionLabel(label),
    startSec,
    endSec: startSec,
    confidence: 0.9
  };
  EAQ.state.emotionActive = active;
  const update = ()=>{
    if(EAQ.state.emotionActive !== active) return;
    active.endSec = Math.max(active.startSec, audio.currentTime || active.startSec);
    renderEmotionSafetyTimeline();
    active.raf = requestAnimationFrame(update);
  };
  active.raf = requestAnimationFrame(update);
  active.handlePointerUp = ()=> finishEmotionCapture();
  active.handlePointerCancel = ()=> cancelEmotionCapture();
  window.addEventListener('pointerup', active.handlePointerUp);
  window.addEventListener('pointercancel', active.handlePointerCancel);
}

function finishEmotionCapture(){
  const active = EAQ.state.emotionActive;
  if(!active) return;
  if(active.raf){ cancelAnimationFrame(active.raf); }
  window.removeEventListener('pointerup', active.handlePointerUp);
  window.removeEventListener('pointercancel', active.handlePointerCancel);
  const audio = EAQ.audio;
  const duration = Math.max(estimateMediaDuration() || 0, audio && audio.duration ? audio.duration : 0);
  let start = Math.max(0, active.startSec || 0);
  let end = Math.max(start + EMOTION_MIN_DURATION, audio ? (audio.currentTime || active.endSec || start) : (active.endSec || start));
  if(duration > 0){ end = Math.min(end, duration); }
  if(end - start < EMOTION_MIN_DURATION){
    if(duration > 0 && duration >= EMOTION_MIN_DURATION){
      start = Math.max(0, Math.min(start, duration - EMOTION_MIN_DURATION));
      end = Math.max(start + EMOTION_MIN_DURATION, end);
    } else {
      end = start + EMOTION_MIN_DURATION;
    }
  }
  const inserted = insertEmotionSpan(EAQ.state.emotionSpans || [], { startSec: start, endSec: end, label: active.label, confidence: active.confidence });
  EAQ.state.emotionActive = null;
  if(inserted){
    commitEmotionSpans(inserted.spans, { pushHistory: true, selectIndex: inserted.index });
  } else {
    renderEmotionSafetyTimeline();
    showCodeSwitchToast('Not enough space for emotion span.');
  }
}

function cancelEmotionCapture(){
  const active = EAQ.state.emotionActive;
  if(!active) return;
  if(active.raf){ cancelAnimationFrame(active.raf); }
  window.removeEventListener('pointerup', active.handlePointerUp);
  window.removeEventListener('pointercancel', active.handlePointerCancel);
  EAQ.state.emotionActive = null;
  renderEmotionSafetyTimeline();
}

function beginEmotionHandleDrag(index, edge, ev){
  ev.preventDefault();
  const spans = cloneEmotionSpans(EAQ.state.emotionSpans || []);
  if(index < 0 || index >= spans.length) return;
  const lane = qs('emotionLane');
  if(!lane) return;
  const rect = lane.getBoundingClientRect();
  EAQ.state.emotionDrag = {
    index,
    edge,
    pointerId: ev.pointerId,
    rect,
    originalSpans: spans,
    workingSpans: cloneEmotionSpans(spans),
    originalStart: spans[index].startSec,
    originalEnd: spans[index].endSec
  };
  document.addEventListener('pointermove', onEmotionDragMove);
  document.addEventListener('pointerup', endEmotionDrag);
  document.addEventListener('pointercancel', cancelEmotionDrag);
}

function onEmotionDragMove(ev){
  const drag = EAQ.state.emotionDrag;
  if(!drag) return;
  if(drag.pointerId!=null && ev.pointerId!=null && ev.pointerId !== drag.pointerId) return;
  const lane = qs('emotionLane');
  if(!lane) return;
  const rect = drag.rect || lane.getBoundingClientRect();
  const spans = drag.workingSpans;
  const span = spans[drag.index];
  if(!span) return;
  const duration = Math.max(estimateMediaDuration() || 0, spans[spans.length-1].endSec || 0);
  const safeDuration = duration > 0 ? duration : Math.max(span.endSec, EMOTION_MIN_DURATION);
  const x = ev.clientX || (ev.touches && ev.touches[0] ? ev.touches[0].clientX : rect.left);
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  const pointerTime = ratio * safeDuration;
  const prev = drag.index > 0 ? spans[drag.index-1] : null;
  const next = drag.index < spans.length-1 ? spans[drag.index+1] : null;
  if(drag.edge === 'start'){
    const minStart = prev ? prev.endSec : 0;
    const maxStart = next ? Math.min(next.startSec - EMOTION_MIN_DURATION, drag.originalStart + EMOTION_DRAG_MAX_DELTA) : drag.originalStart + EMOTION_DRAG_MAX_DELTA;
    const allowedMin = Math.max(minStart, drag.originalStart - EMOTION_DRAG_MAX_DELTA);
    const newStart = Math.min(Math.max(pointerTime, allowedMin), Math.min(maxStart, span.endSec - EMOTION_MIN_DURATION));
    span.startSec = Math.max(minStart, newStart);
    if(span.endSec - span.startSec < EMOTION_MIN_DURATION){
      span.endSec = span.startSec + EMOTION_MIN_DURATION;
    }
  } else {
    const nextStart = next ? next.startSec : safeDuration;
    const maxEnd = Math.min(nextStart, drag.originalEnd + EMOTION_DRAG_MAX_DELTA);
    const minEnd = Math.max(span.startSec + EMOTION_MIN_DURATION, drag.originalEnd - EMOTION_DRAG_MAX_DELTA);
    const newEnd = Math.min(Math.max(pointerTime, minEnd), maxEnd);
    span.endSec = Math.max(span.startSec + EMOTION_MIN_DURATION, newEnd);
  }
  EAQ.state.emotionSpans = cloneEmotionSpans(spans);
  EAQ.state.emotionSelectedIndex = drag.index;
  renderEmotionSafetyTimeline();
}

function endEmotionDrag(){
  const drag = EAQ.state.emotionDrag;
  if(!drag) return;
  document.removeEventListener('pointermove', onEmotionDragMove);
  document.removeEventListener('pointerup', endEmotionDrag);
  document.removeEventListener('pointercancel', cancelEmotionDrag);
  EAQ.state.emotionDrag = null;
  EAQ.state.emotionSpans = drag.originalSpans;
  commitEmotionSpans(drag.workingSpans, { pushHistory: true, selectIndex: drag.index });
}

function cancelEmotionDrag(){
  const drag = EAQ.state.emotionDrag;
  if(!drag) return;
  document.removeEventListener('pointermove', onEmotionDragMove);
  document.removeEventListener('pointerup', endEmotionDrag);
  document.removeEventListener('pointercancel', cancelEmotionDrag);
  EAQ.state.emotionDrag = null;
  EAQ.state.emotionSpans = drag.originalSpans;
  renderEmotionSafetyTimeline();
}

function beginSafetyDrag(index, ev){
  ev.preventDefault();
  const events = cloneSafetyEvents(EAQ.state.safetyEvents || []);
  if(index < 0 || index >= events.length) return;
  const lane = qs('safetyLane');
  if(!lane) return;
  const rect = lane.getBoundingClientRect();
  const event = events[index];
  const duration = Math.max(0.05, event.endSec - event.startSec);
  const pointerTime = rect.width > 0 ? ((ev.clientX - rect.left) / rect.width) * Math.max(estimateMediaDuration() || 0, event.endSec) : event.startSec;
  EAQ.state.safetyDrag = {
    index,
    pointerId: ev.pointerId,
    rect,
    duration,
    offset: pointerTime - event.startSec,
    originalEvents: events,
    workingEvents: cloneSafetyEvents(events)
  };
  EAQ.state.safetySelectedIndex = index;
  document.addEventListener('pointermove', onSafetyDragMove);
  document.addEventListener('pointerup', endSafetyDrag);
  document.addEventListener('pointercancel', cancelSafetyDrag);
}

function onSafetyDragMove(ev){
  const drag = EAQ.state.safetyDrag;
  if(!drag) return;
  if(drag.pointerId!=null && ev.pointerId!=null && ev.pointerId !== drag.pointerId) return;
  const lane = qs('safetyLane');
  if(!lane) return;
  const rect = drag.rect || lane.getBoundingClientRect();
  const events = drag.workingEvents;
  const evt = events[drag.index];
  if(!evt) return;
  const duration = Math.max(estimateMediaDuration() || 0, events[events.length-1].endSec || 0);
  const safeDuration = duration > 0 ? duration : Math.max(evt.endSec, SAFETY_DEFAULT_DURATION);
  const x = ev.clientX || (ev.touches && ev.touches[0] ? ev.touches[0].clientX : rect.left);
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  let newStart = ratio * safeDuration - (drag.offset || 0);
  const prev = drag.index > 0 ? events[drag.index-1] : null;
  const next = drag.index < events.length-1 ? events[drag.index+1] : null;
  const minStart = prev ? prev.endSec : 0;
  const maxStart = next ? next.startSec - drag.duration : safeDuration - drag.duration;
  newStart = Math.min(Math.max(newStart, minStart), maxStart);
  evt.startSec = newStart;
  evt.endSec = newStart + drag.duration;
  EAQ.state.safetyEvents = cloneSafetyEvents(events);
  renderEmotionSafetyTimeline();
}

function endSafetyDrag(){
  const drag = EAQ.state.safetyDrag;
  if(!drag) return;
  document.removeEventListener('pointermove', onSafetyDragMove);
  document.removeEventListener('pointerup', endSafetyDrag);
  document.removeEventListener('pointercancel', cancelSafetyDrag);
  EAQ.state.safetyDrag = null;
  EAQ.state.safetyEvents = drag.originalEvents;
  commitSafetyEvents(drag.workingEvents, { pushHistory: true, selectIndex: drag.index });
}

function cancelSafetyDrag(){
  const drag = EAQ.state.safetyDrag;
  if(!drag) return;
  document.removeEventListener('pointermove', onSafetyDragMove);
  document.removeEventListener('pointerup', endSafetyDrag);
  document.removeEventListener('pointercancel', cancelSafetyDrag);
  EAQ.state.safetyDrag = null;
  EAQ.state.safetyEvents = drag.originalEvents;
  renderEmotionSafetyTimeline();
}

function addSafetyEvent(type){
  const audio = EAQ.audio;
  if(!audio) return;
  const start = Math.max(0, audio.currentTime || 0);
  const inserted = insertSafetyEvent(EAQ.state.safetyEvents || [], { startSec: start, endSec: start + SAFETY_DEFAULT_DURATION, type: normalizeSafetyType(type) });
  if(inserted){
    commitSafetyEvents(inserted.events, { pushHistory: true, selectIndex: inserted.index });
  } else {
    showCodeSwitchToast('No room for another event at this time.');
  }
}

function undoEmotion(){
  if(!EAQ.state.emotionHistory || !EAQ.state.emotionHistory.length) return;
  const snapshot = EAQ.state.emotionHistory.pop();
  EAQ.state.emotionFuture.push(cloneEmotionSpans(EAQ.state.emotionSpans));
  EAQ.state.emotionSpans = cloneEmotionSpans(snapshot);
  EAQ.state.emotionSelectedIndex = null;
  renderEmotionSafetyTimeline();
}

function redoEmotion(){
  if(!EAQ.state.emotionFuture || !EAQ.state.emotionFuture.length) return;
  const snapshot = EAQ.state.emotionFuture.pop();
  EAQ.state.emotionHistory.push(cloneEmotionSpans(EAQ.state.emotionSpans));
  EAQ.state.emotionSpans = cloneEmotionSpans(snapshot);
  renderEmotionSafetyTimeline();
}

function deleteSelectedEmotion(){
  const idx = EAQ.state.emotionSelectedIndex;
  if(idx==null) return;
  const spans = cloneEmotionSpans(EAQ.state.emotionSpans || []);
  if(idx < 0 || idx >= spans.length) return;
  spans.splice(idx, 1);
  commitEmotionSpans(spans, { pushHistory: true, selectIndex: Math.min(idx, spans.length-1) });
}

function undoSafety(){
  if(!EAQ.state.safetyHistory || !EAQ.state.safetyHistory.length) return;
  const snapshot = EAQ.state.safetyHistory.pop();
  EAQ.state.safetyFuture.push(cloneSafetyEvents(EAQ.state.safetyEvents));
  EAQ.state.safetyEvents = cloneSafetyEvents(snapshot);
  EAQ.state.safetySelectedIndex = null;
  renderEmotionSafetyTimeline();
}

function redoSafety(){
  if(!EAQ.state.safetyFuture || !EAQ.state.safetyFuture.length) return;
  const snapshot = EAQ.state.safetyFuture.pop();
  EAQ.state.safetyHistory.push(cloneSafetyEvents(EAQ.state.safetyEvents));
  EAQ.state.safetyEvents = cloneSafetyEvents(snapshot);
  renderEmotionSafetyTimeline();
}

function deleteSelectedSafety(){
  const idx = EAQ.state.safetySelectedIndex;
  if(idx==null) return;
  const events = cloneSafetyEvents(EAQ.state.safetyEvents || []);
  if(idx < 0 || idx >= events.length) return;
  events.splice(idx, 1);
  commitSafetyEvents(events, { pushHistory: true, selectIndex: Math.min(idx, events.length-1) });
}
