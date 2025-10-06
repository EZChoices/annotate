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
    eventsCues: [],
    diarSegments: [],
    speakerProfiles: [],
    emotionVTT: '',
    emotionCues: [],
    startedAt: 0,
    lintReport: { errors: [], warnings: [] }
  }
};

const SPEAKER_GENDERS = ['male','female','nonbinary','unknown'];
const SPEAKER_AGE_BANDS = ['child','teen','young_adult','adult','elderly','unknown'];
const SPEAKER_DIALECTS = ['Levantine','Iraqi','Gulf','Yemeni','Egyptian','Maghrebi','MSA','Mixed','Other','Unknown'];

const MANIFEST_STORAGE_KEY = 'ea_stage2_manifest';

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
  const allowed = new Set(['screen_translation','screen_speaker','screen_review']);
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
  ['screen_welcome','screen_transcript','screen_translation','screen_codeswitch','screen_speaker','screen_emotion','screen_pii','screen_diar','screen_review']
    .forEach(x=> qs(x).classList.toggle('hide', x!==id));
  relocateErrorsList(id);
}

async function loadManifest(){
  const annot = encodeURIComponent(EAQ.state.annotator);
  const url = `/api/tasks?stage=2&annotator_id=${annot}`;
  try{
    const res = await fetch(url, {cache:'no-store'});
    if(!res.ok) throw new Error('tasks fetch');
    const manifest = await res.json();
    EAQ.state.manifest = manifest;
    saveManifestToStorage(manifest);
    return manifest;
  }catch(err){
    const cached = loadManifestFromStorage();
    if(cached){
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
      alignTranslationToTranscript();
    });
    if(isFinite(a.duration) && a.duration>0){ attachTl(); }
    else { a.addEventListener('loadedmetadata', attachTl, { once:true }); }
    // paint overlays from CS and Events
    setInterval(()=>{
      Timeline.setOverlays(EAQ.state.codeSwitchCues||[], EAQ.state.eventsCues||[]);
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

  const csCues = VTT.normalize(EAQ.state.codeSwitchCues || []).slice().sort((a,b)=> (+a.start||0) - (+b.start||0));
  csCues.forEach((cue, idx)=>{
    const start = +cue.start || 0;
    const end = +cue.end || 0;
    const duration = Math.max(0, end - start);
    if(duration < csMin - 0.01){
      pushIssue(report.errors, `Code-switch span #${idx+1} is ${duration.toFixed(2)}s (< ${csMin.toFixed(2)}s).`);
    } else if(duration < csMin){
      pushIssue(report.warnings, `Code-switch span #${idx+1} is ${duration.toFixed(2)}s (min ${csMin.toFixed(2)}s).`);
    }
    if(idx>0){
      const prev = csCues[idx-1];
      if(start < (+prev.end || 0) - 0.01){
        pushIssue(report.errors, `Code-switch span #${idx+1} overlaps previous span.`);
      }
    }
  });

  return report;
}

function runValidationAndDisplay(targetScreenId){
  const lint = validateAnnotation();
  EAQ.state.lintReport = lint;
  updateErrorsList(lint, targetScreenId);
  return lint;
}

function refreshTimeline(){
  if(typeof Timeline === 'undefined' || typeof Timeline.update !== 'function'){ return; }
  const audioEl = qs('audio');
  let duration = 0;
  if(audioEl && isFinite(audioEl.duration) && audioEl.duration > 0){
    duration = audioEl.duration;
  } else {
    const item = currentItem();
    if(item && item.media && isFinite(+item.media.duration_sec)){
      duration = +item.media.duration_sec;
    } else {
      const cues = EAQ.state.transcriptCues || [];
      duration = cues.reduce((max, cue)=> Math.max(max, +cue.end || 0), 0);
    }
  }
  Timeline.update(duration, EAQ.state.transcriptCues || []);
  if(typeof Timeline.setOverlays === 'function'){
    Timeline.setOverlays(EAQ.state.codeSwitchCues || [], EAQ.state.eventsCues || []);
  }
}

async function enqueueAndSync(lintReport){
  const lint = lintReport || validateAnnotation();
  EAQ.state.lintReport = lint;
  if(lint && Array.isArray(lint.errors) && lint.errors.length){
    updateErrorsList(lint, 'screen_review');
    return false;
  }
  const it = currentItem(); if(!it) return false;
  const payload = {
    asset_id: it.asset_id,
    files: {
      diarization_rttm: rttmStringify(EAQ.state.diarSegments||[], it.asset_id || 'rec'),
      transcript_vtt: EAQ.state.transcriptVTT,
      transcript_ctm: null,
      translation_vtt: EAQ.state.translationVTT,
      code_switch_vtt: EAQ.state.codeSwitchVTT || '',
      code_switch_spans_json: codeSwitchJson(EAQ.state.codeSwitchCues||[]).json,
      events_vtt: (function(){
        const ev = qs('eventsVTT');
        if(ev && ev.value.trim()) return ev.value;
        return (EAQ.state.eventsCues||[]).length ? VTT.stringify(EAQ.state.eventsCues) : '';
      })(),
      emotion_vtt: EAQ.state.emotionVTT || '',
      speaker_profiles_json: (function(){ try{ return JSON.stringify(EAQ.state.speakerProfiles||[]); }catch{ return '[]'; } })()
    },
    summary: {
      contains_code_switch: (EAQ.state.codeSwitchCues||[]).length > 0,
      code_switch_languages: Array.from(codeSwitchJson(EAQ.state.codeSwitchCues||[]).langs),
      cs_total_duration_sec: codeSwitchJson(EAQ.state.codeSwitchCues||[]).total,
      non_arabic_token_ratio_est: 0
    },
    qa: {
      annotator_id: EAQ.state.annotator,
      second_annotator_id: null,
      adjudicator_id: null,
      gold_check: 'pass',
      time_spent_sec: Math.max(0, Math.round((Date.now() - (EAQ.state.startedAt||Date.now()))/1000)),
      lint
    },
    lint,
    client_meta: { device: navigator.userAgent }
  };

  try{ await EAIDB.saveLintReport(it.asset_id, lint); }
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
    alignTranslationToTranscript();
    show('screen_translation');
    runValidationAndDisplay('screen_translation');
  });

  qs('translationNext').addEventListener('click', ()=>{
    const box = qs('translationVTT');
    EAQ.state.translationVTT = box ? box.value : '';
    EAQ.state.translationCues = VTT.normalize(parseVttSafe(EAQ.state.translationVTT));
    runValidationAndDisplay('screen_translation');
    show('screen_codeswitch');
  });

  qs('csNext').addEventListener('click', ()=>{
    const box = qs('codeSwitchVTT');
    EAQ.state.codeSwitchVTT = box ? box.value : '';
    EAQ.state.codeSwitchCues = VTT.normalize(parseVttSafe(EAQ.state.codeSwitchVTT));
    show('screen_speaker');
    runValidationAndDisplay('screen_speaker');
  });

  const speakerNext = qs('speakerNext');
  if(speakerNext){
    speakerNext.addEventListener('click', ()=>{
      const container = qs('speakerCards');
      const cards = container ? Array.from(container.querySelectorAll('[data-speaker-card]')) : [];
      const profiles = cards.map((card, idx)=>{
        const speakerId = card.getAttribute('data-speaker-id') || `spk${idx+1}`;
        const displayLabel = card.getAttribute('data-display-label') || `S${idx+1}`;
        const genderSel = card.querySelector('select[name="apparent_gender"]');
        const ageSel = card.querySelector('select[name="apparent_age_band"]');
        const dialectSel = card.querySelector('select[name="dialect_subregion"]');
        const apparent_gender = genderSel ? (genderSel.value || 'unknown') : 'unknown';
        const apparent_age_band = ageSel ? (ageSel.value || 'unknown') : 'unknown';
        const dialect_subregion = dialectSel ? (dialectSel.value || 'unknown') : 'unknown';
        const existing = Array.isArray(EAQ.state.speakerProfiles) ? EAQ.state.speakerProfiles.find(p=> p && p.speaker_id === speakerId) : null;
        return Object.assign({}, existing||{}, {
          speaker_id: speakerId,
          display_label: displayLabel,
          apparent_gender,
          apparent_age_band,
          dialect_subregion
        });
      });
      EAQ.state.speakerProfiles = profiles;
      show('screen_emotion');
    });
  }

  const emotionNext = qs('emotionNext');
  if(emotionNext){
    emotionNext.addEventListener('click', ()=>{
      const box = qs('emotionVTT');
      const text = box ? box.value : '';
      EAQ.state.emotionVTT = text || '';
      if(text && text.trim()){
        try{ EAQ.state.emotionCues = VTT.normalize(VTT.parse(text)); }
        catch{ EAQ.state.emotionCues = []; }
      } else if((EAQ.state.emotionCues||[]).length){
        EAQ.state.emotionVTT = VTT.stringify(VTT.normalize(EAQ.state.emotionCues));
        if(box) box.value = EAQ.state.emotionVTT;
      } else {
        EAQ.state.emotionCues = [];
      }
      show('screen_pii');
    });
  }

  // PII/events buttons
  const evtBtns = document.querySelectorAll('[data-evt]');
  const openEvt = new Map();
  function now(){ const a=qs('audio'); return a && a.currentTime || 0; }
  evtBtns.forEach(b=>{
    b.addEventListener('click', ()=>{
      const k = b.getAttribute('data-evt');
      if(!openEvt.has(k)){
        openEvt.set(k, now());
        b.classList.add('selected');
      } else {
        const s = openEvt.get(k); openEvt.delete(k);
        b.classList.remove('selected');
        EAQ.state.eventsCues.push({ start:s, end:now(), text:k });
        EAQ.state.eventsCues = VTT.normalize(EAQ.state.eventsCues);
        const box = qs('eventsVTT'); if(box) box.value = VTT.stringify(EAQ.state.eventsCues);
      }
    });
  });

  const piiNext = qs('piiNext'); if(piiNext) piiNext.addEventListener('click', ()=>{ show('screen_diar'); });
  const diarNext = qs('diarNext'); if(diarNext) diarNext.addEventListener('click', ()=>{ runValidationAndDisplay('screen_review'); show('screen_review'); });

  qs('submitBtn').addEventListener('click', async ()=>{
    const transcriptBox = qs('transcriptVTT');
    const translationBox = qs('translationVTT');
    const csBox = qs('codeSwitchVTT');
    EAQ.state.transcriptVTT = transcriptBox ? transcriptBox.value : EAQ.state.transcriptVTT;
    EAQ.state.translationVTT = translationBox ? translationBox.value : EAQ.state.translationVTT;
    EAQ.state.codeSwitchVTT = csBox ? csBox.value : EAQ.state.codeSwitchVTT;
    EAQ.state.transcriptCues = VTT.normalize(parseVttSafe(EAQ.state.transcriptVTT));
    EAQ.state.translationCues = VTT.normalize(parseVttSafe(EAQ.state.translationVTT));
    EAQ.state.codeSwitchCues = VTT.normalize(parseVttSafe(EAQ.state.codeSwitchVTT));
    const lint = runValidationAndDisplay('screen_review');
    if(lint.errors && lint.errors.length){
      alert('Please resolve validation errors before submitting.');
      return;
    }
    const ok = await enqueueAndSync(lint);
    if(!ok){ return; }
    EAQ.state.idx = (EAQ.state.idx + 1) % Math.max(1, EAQ.state.manifest.items.length);
    qs('transcriptVTT').value = '';
    qs('translationVTT').value = '';
    qs('codeSwitchVTT').value = '';
    const ev = qs('eventsVTT'); if(ev) ev.value = '';
    const emoBox = qs('emotionVTT'); if(emoBox) emoBox.value = '';
    EAQ.state.emotionVTT = '';
    EAQ.state.emotionCues = [];
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
        alignTranslationToTranscript();
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
      alignTranslationToTranscript();
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
        alignTranslationToTranscript();
        refreshTimeline();
        runValidationAndDisplay('screen_transcript');
        break;
      }
    }
  });

  // Code-switch quick-mark buttons
  let pressStart = null, pressLang = null;
  function startPress(lang){ if(!a) return; pressLang = lang; pressStart = a.currentTime; }
  function endPress(){
    if(!a || pressStart==null || !pressLang) return;
    const end = a.currentTime;
    if(end-pressStart >= EAQ.SPEC.csMinSec){
      EAQ.state.codeSwitchCues.push({ start: pressStart, end, text: pressLang });
      EAQ.state.codeSwitchCues = VTT.normalize(EAQ.state.codeSwitchCues);
      qs('codeSwitchVTT').value = VTT.stringify(EAQ.state.codeSwitchCues);
    }
    pressStart=null; pressLang=null;
  }
  qs('btnEN').addEventListener('mousedown', ()=> startPress('EN'));
  qs('btnEN').addEventListener('touchstart', ()=> startPress('EN'));
  qs('btnEN').addEventListener('mouseup', endPress);
  qs('btnEN').addEventListener('touchend', endPress);
  qs('btnFR').addEventListener('mousedown', ()=> startPress('FR'));
  qs('btnFR').addEventListener('touchstart', ()=> startPress('FR'));
  qs('btnFR').addEventListener('mouseup', endPress);
  qs('btnFR').addEventListener('touchend', endPress);
  qs('btnOther').addEventListener('mousedown', ()=> startPress('Other'));
  qs('btnOther').addEventListener('touchstart', ()=> startPress('Other'));
  qs('btnOther').addEventListener('mouseup', endPress);
  qs('btnOther').addEventListener('touchend', endPress);
  qs('nudgeMinus').addEventListener('click', ()=>{
    const cues = EAQ.state.codeSwitchCues; if(!cues.length) return;
    cues[cues.length-1].start = Math.max(0, cues[cues.length-1].start - 0.2);
    qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(cues));
  });
  qs('nudgePlus').addEventListener('click', ()=>{
    const cues = EAQ.state.codeSwitchCues; if(!cues.length) return;
    cues[cues.length-1].end = cues[cues.length-1].end + 0.2;
    qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(cues));
  });
  qs('csUndo').addEventListener('click', ()=>{
    EAQ.state.codeSwitchCues.pop();
    qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(EAQ.state.codeSwitchCues));
  });

  // Emotion quick-mark buttons
  let emoStart = null, emoLabel = null;
  function startEmotion(label){ if(!a) return; emoLabel = label; emoStart = a.currentTime; }
  function endEmotion(){
    if(!a || emoStart==null || !emoLabel) return;
    const end = a.currentTime;
    const min = EAQ.SPEC.emotionMinSec || 1.5;
    if(end - emoStart >= min){
      if(!Array.isArray(EAQ.state.emotionCues)) EAQ.state.emotionCues = [];
      EAQ.state.emotionCues.push({ start: emoStart, end, text: emoLabel });
      EAQ.state.emotionCues = VTT.normalize(EAQ.state.emotionCues);
      const out = VTT.stringify(EAQ.state.emotionCues);
      EAQ.state.emotionVTT = out;
      const box = qs('emotionVTT'); if(box) box.value = out;
    }
    emoStart = null; emoLabel = null;
  }
  const emotionButtons = [
    ['btnNeutral','neutral'],
    ['btnHappy','happy'],
    ['btnAngry','angry'],
    ['btnSad','sad'],
    ['btnExcited','excited'],
    ['btnOtherEmo','other']
  ];
  emotionButtons.forEach(([id,label])=>{
    const btn = qs(id);
    if(!btn) return;
    const start = ()=> startEmotion(label);
    const end = ()=> endEmotion();
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', ()=>{ if(emoLabel===label) endEmotion(); });
    btn.addEventListener('touchend', end);
    btn.addEventListener('touchcancel', end);
  });
  const emoUndo = qs('emoUndo');
  if(emoUndo){
    emoUndo.addEventListener('click', ()=>{
      if(!Array.isArray(EAQ.state.emotionCues)) EAQ.state.emotionCues = [];
      EAQ.state.emotionCues.pop();
      EAQ.state.emotionCues = VTT.normalize(EAQ.state.emotionCues);
      const out = EAQ.state.emotionCues.length ? VTT.stringify(EAQ.state.emotionCues) : '';
      EAQ.state.emotionVTT = out;
      const box = qs('emotionVTT'); if(box) box.value = out;
    });
  }

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
  const emotionBox = qs('emotionVTT'); if(emotionBox) emotionBox.value = '';
  EAQ.state.emotionVTT = '';
  EAQ.state.emotionCues = [];
  EAQ.state.speakerProfiles = [];
  EAQ.state.lintReport = { errors: [], warnings: [] };
  updateErrorsList(null);
  const speakerContainer = qs('speakerCards');
  if(speakerContainer) speakerContainer.innerHTML = '<em>Loading speaker attributes...</em>';
  const prefill = it.prefill || {};
  const translationBox = qs('translationVTT'); if(translationBox) translationBox.value = '';
  const csBox = qs('codeSwitchVTT'); if(csBox) csBox.value = '';
  EAQ.state.translationVTT = '';
  EAQ.state.translationCues = [];
  EAQ.state.codeSwitchVTT = '';
  EAQ.state.codeSwitchCues = [];

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
  const allowedGenders = new Set(['male','female','nonbinary','unknown']);
  const allowedAges = new Set(['child','teen','young_adult','adult','elderly','unknown']);
  const allowedDialects = new Set(['unknown','levant','gulf','egypt','maghreb','mesopotamia','sudan','arabian_peninsula','horn_of_africa','other']);

  const normalizeProfile = (entry, idx, fallback)=>{
    const data = entry && typeof entry === 'object' ? entry : {};
    const normEnum = (val, fallbackVal)=>{
      if(val==null) return fallbackVal;
      const str = String(val).trim();
      if(!str) return fallbackVal;
      return str.toLowerCase().replace(/[\s-]+/g,'_');
    };
    const speakerIdRaw = data.speaker_id || data.diarization_speaker || data.speaker || fallback || `spk${idx+1}`;
    const genderNorm = normEnum(data.apparent_gender, 'unknown');
    const ageNorm = normEnum(data.apparent_age_band, 'unknown');
    const dialectNorm = normEnum(data.dialect_subregion, 'unknown');
    return Object.assign({}, data, {
      speaker_id: String(speakerIdRaw || `spk${idx+1}`),
      display_label: String(data.display_label || data.label || `S${idx+1}`),
      apparent_gender: allowedGenders.has(genderNorm) ? genderNorm : 'unknown',
      apparent_age_band: allowedAges.has(ageNorm) ? ageNorm : 'unknown',
      dialect_subregion: allowedDialects.has(dialectNorm) ? dialectNorm : 'unknown'
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
  if(prefill.diarization_rttm_url){
    try{
      const t = await fetch(prefill.diarization_rttm_url).then(r=> r.text());
      EAQ.state.diarSegments = parseRTTM(t);
      renderDiarList();
    }
    catch{
      EAQ.state.diarSegments = [];
      renderDiarList();
    }
  } else if(prefill.diarization_rttm){
    try{ EAQ.state.diarSegments = parseRTTM(prefill.diarization_rttm); }
    catch{ EAQ.state.diarSegments = []; }
    renderDiarList();
  } else {
    EAQ.state.diarSegments = [];
    renderDiarList();
  }

  // Emotion prefill
  let emotionText = null;
  if(prefill.emotion_vtt_url){
    try{ emotionText = await fetch(prefill.emotion_vtt_url).then(r=> r.text()); }
    catch{}
  } else if(typeof prefill.emotion_vtt === 'string'){
    emotionText = prefill.emotion_vtt;
  }
  if(typeof emotionText === 'string'){
    EAQ.state.emotionVTT = emotionText;
    if(emotionBox) emotionBox.value = emotionText;
    if(emotionText.trim()){
      try{ EAQ.state.emotionCues = VTT.normalize(VTT.parse(emotionText)); }
      catch{ EAQ.state.emotionCues = []; }
    }
  } else {
    EAQ.state.emotionVTT = '';
    EAQ.state.emotionCues = [];
    if(emotionBox) emotionBox.value = '';
  }
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
  const translationBox = qs('translationVTT');
  const csBox = qs('codeSwitchVTT');
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
    EAQ.state.translationVTT = translationText;
    if(translationBox) translationBox.value = translationText;
    try{ EAQ.state.translationCues = VTT.normalize(VTT.parse(translationText)); }
    catch{ EAQ.state.translationCues = []; }
  } else if(translationFetchFailed){
    const base = (EAQ.state.transcriptCues||[]).map(c=> ({ start:c.start, end:c.end, text:'' }));
    EAQ.state.translationCues = base;
    EAQ.state.translationVTT = VTT.stringify(base);
    if(translationBox) translationBox.value = EAQ.state.translationVTT;
  } else {
    EAQ.state.translationCues = EAQ.state.translationCues || [];
    EAQ.state.translationVTT = VTT.stringify(EAQ.state.translationCues);
    if(translationBox) translationBox.value = EAQ.state.translationVTT;
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
    if(csBox) csBox.value = csText;
    try{ EAQ.state.codeSwitchCues = VTT.normalize(VTT.parse(csText)); }
    catch{ EAQ.state.codeSwitchCues = []; }
  } else {
    EAQ.state.codeSwitchCues = [];
    EAQ.state.codeSwitchVTT = VTT.stringify([]);
    if(csBox) csBox.value = EAQ.state.codeSwitchVTT;
  }

  alignTranslationToTranscript();
  if(translationBox){ EAQ.state.translationVTT = translationBox.value; }
  if(csBox){ EAQ.state.codeSwitchVTT = csBox.value; }

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

function alignTranslationToTranscript(){
  const tr = EAQ.state.transcriptCues || [];
  let tl = EAQ.state.translationCues || [];
  const lock = (function(){ const el = document.getElementById('lockTranslation'); return !el || el.checked; })();
  if(!lock){ return; }
  if(tl.length === 0 && tr.length > 0){
    tl = tr.map(c=> ({ start:c.start, end:c.end, text:'' }));
  }
  // Adjust counts by duplicating or merging adjacent
  while(tl.length < tr.length){ tl.push({ start: tr[tl.length].start, end: tr[tl.length].end, text: '' }); }
  while(tl.length > tr.length && tl.length>1){
    const a = tl[tl.length-2], b = tl[tl.length-1];
    tl.splice(tl.length-2, 2, { start:a.start, end:b.end, text:`${a.text}\n${b.text}`.trim() });
  }
  // Copy timings from transcript to keep locked
  for(let i=0;i<tr.length;i++){ if(tl[i]){ tl[i].start = tr[i].start; tl[i].end = tr[i].end; } }
  EAQ.state.translationCues = tl;
  const serialized = VTT.stringify(tl);
  qs('translationVTT').value = serialized;
  EAQ.state.translationVTT = serialized;
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

function codeSwitchJson(cues){
  const map = { 'EN':'eng', 'FR':'fra', 'OTHER':'other' };
  let total = 0; const langs = new Set();
  const items = (cues||[]).map(c=>{
    const s = +c.start || 0, e = +c.end || 0; const dur = Math.max(0, e - s); total += dur;
    const lang = map[(c.text||'').trim().toUpperCase()] || 'other';
    langs.add(lang);
    return { start:s, end:e, lang };
  });
  return { json: JSON.stringify(items), total: Math.round(total*1000)/1000, langs };
}

function parseRTTM(text){
  const out = [];
  const lines = (text||'').split(/\r?\n/);
  for(const ln of lines){
    const t = ln.trim(); if(!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if(parts[0] !== 'SPEAKER') continue;
    const tbeg = parseFloat(parts[3]||'0'), tdur = parseFloat(parts[4]||'0');
    const spk = parts[7] || 'spk';
    out.push({ start: tbeg, end: tbeg+tdur, speaker: spk });
  }
  return out.sort((a,b)=> a.start-b.start);
}

function renderDiarList(){
  const el = qs('diarList'); if(!el) return;
  const rows = (EAQ.state.diarSegments||[]).map((s,i)=>{
    return `<div style="display:flex;gap:.5rem;align-items:center;margin:.25rem 0">`+
      `<code>#${i+1}</code>`+
      `<button data-d="-" data-i="${i}">-50ms</button>`+
      `<button data-d="+" data-i="${i}">+50ms</button>`+
      `<span>start=${s.start.toFixed(2)} end=${s.end.toFixed(2)} spk=${s.speaker}</span>`+
    `</div>`;
  }).join('');
  el.innerHTML = rows || '<em>No diarization loaded.</em>';
  el.querySelectorAll('button[data-i]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const i = parseInt(btn.getAttribute('data-i'),10);
      const sign = btn.getAttribute('data-d') === '+' ? 1 : -1;
      const delta = 0.05 * sign; // 50ms
      const seg = EAQ.state.diarSegments[i];
      const newStart = Math.max(0, seg.start + delta);
      if(Math.abs(newStart - seg.start) <= 0.5){ seg.start = newStart; }
      renderDiarList();
    });
  });
  renderSpeakerCards();
}

function renderSpeakerCards(){
  const container = qs('speakerCards');
  if(!container) return;

  const segments = Array.isArray(EAQ.state.diarSegments) ? EAQ.state.diarSegments : [];
  const seen = [];
  const seenSet = new Set();
  for(const seg of segments){
    const speakerId = seg && seg.speaker ? String(seg.speaker) : 'spk';
    if(!seenSet.has(speakerId)){
      seenSet.add(speakerId);
      seen.push(speakerId);
    }
  }
  if(!seen.length){
    container.innerHTML = '<em>No diarization loaded. Speaker attributes unavailable.</em>';
    EAQ.state.speakerProfiles = [];
    return;
  }

  const genderOptions = [
    { value: '', label: 'Select apparent gender', disabled: true },
    { value: 'male', label: 'Male' },
    { value: 'female', label: 'Female' },
    { value: 'nonbinary', label: 'Non-binary' },
    { value: 'unknown', label: 'Unknown' }
  ];
  const ageOptions = [
    { value: '', label: 'Select age band', disabled: true },
    { value: 'child', label: 'Child' },
    { value: 'teen', label: 'Teen' },
    { value: 'young_adult', label: 'Young Adult' },
    { value: 'adult', label: 'Adult' },
    { value: 'elderly', label: 'Elderly' },
    { value: 'unknown', label: 'Unknown' }
  ];
  const dialectOptions = [
    { value: '', label: 'Select dialect sub-region', disabled: true },
    { value: 'unknown', label: 'Unknown' },
    { value: 'levant', label: 'Levant' },
    { value: 'gulf', label: 'Gulf' },
    { value: 'egypt', label: 'Egypt' },
    { value: 'maghreb', label: 'Maghreb' },
    { value: 'mesopotamia', label: 'Mesopotamia' },
    { value: 'sudan', label: 'Sudan' },
    { value: 'arabian_peninsula', label: 'Arabian Peninsula' },
    { value: 'horn_of_africa', label: 'Horn of Africa' },
    { value: 'other', label: 'Other' }
  ];
  const allowedGenderVals = new Set(genderOptions.map(o=>o.value).filter(v=>v));
  const allowedAgeVals = new Set(ageOptions.map(o=>o.value).filter(v=>v));
  const allowedDialectVals = new Set(dialectOptions.map(o=>o.value).filter(v=>v));

  const normalizeValue = (val, fallback, allowed)=>{
    if(val==null) return fallback;
    const str = String(val).trim();
    if(!str) return fallback;
    const normalized = str.toLowerCase().replace(/[\s-]+/g,'_');
    if(allowed && !allowed.has(normalized)) return fallback;
    return normalized;
  };

  const existing = Array.isArray(EAQ.state.speakerProfiles) ? EAQ.state.speakerProfiles : [];
  const normalized = seen.map((speakerId, idx)=>{
    const found = existing.find((p)=> p && p.speaker_id === speakerId) || {};
    const display = String(found.display_label || `S${idx+1}`);
    const genderSel = normalizeValue(found.apparent_gender, 'unknown', allowedGenderVals);
    const ageSel = normalizeValue(found.apparent_age_band, 'unknown', allowedAgeVals);
    const dialectSel = normalizeValue(found.dialect_subregion, 'unknown', allowedDialectVals);
    return Object.assign({}, found, {
      speaker_id: String(speakerId),
      display_label: display,
      apparent_gender: genderSel,
      apparent_age_band: ageSel,
      dialect_subregion: dialectSel
    });
  });
  EAQ.state.speakerProfiles = normalized;

  function renderOptions(list, selected){
    return list.map((opt)=>{
      const attrs = [
        `value="${escapeHtml(opt.value)}"`
      ];
      if(opt.disabled){ attrs.push('disabled'); }
      const isSelected = opt.value ? opt.value === selected : !selected;
      if(isSelected){ attrs.push('selected'); }
      return `<option ${attrs.join(' ')}>${escapeHtml(opt.label)}</option>`;
    }).join('');
  }

  const cards = normalized.map((profile, idx)=>{
    const display = String(profile.display_label || `S${idx+1}`);
    const speakerId = String(profile.speaker_id || `spk${idx+1}`);
    const genderSel = normalizeValue(profile.apparent_gender, 'unknown', allowedGenderVals);
    const ageSel = normalizeValue(profile.apparent_age_band, 'unknown', allowedAgeVals);
    const dialectSel = normalizeValue(profile.dialect_subregion, 'unknown', allowedDialectVals);
    const genderOptionsHtml = renderOptions(genderOptions, genderSel);
    const ageOptionsHtml = renderOptions(ageOptions, ageSel);
    const dialectOptionsHtml = renderOptions(dialectOptions, dialectSel);
    return `<div class="notice" data-speaker-card data-speaker-id="${escapeHtml(speakerId)}" data-display-label="${escapeHtml(display)}" style="margin-bottom:1rem;">`+
      `<h4 style="margin:0 0 .5rem 0;">${escapeHtml(display)} <small style="font-weight:normal;color:var(--text-muted,inherit);">(Diar speaker: ${escapeHtml(speakerId)})</small></h4>`+
      `<label style="display:block;margin-bottom:.5rem;">Apparent gender <select name="apparent_gender">${genderOptionsHtml}</select></label>`+
      `<label style="display:block;margin-bottom:.5rem;">Apparent age band <select name="apparent_age_band">${ageOptionsHtml}</select></label>`+
      `<label style="display:block;margin-bottom:.5rem;">Dialect sub-region <select name="dialect_subregion">${dialectOptionsHtml}</select></label>`+
    `</div>`;
  }).join('');
  container.innerHTML = cards;
}

function emotionCuesToVTT(cues){
  const items = (cues||[]).map(c=> ({
    start: Math.max(0, +c.start || 0),
    end: Math.max(Math.max(0, +c.start || 0), +c.end || 0),
    text: (c.label ?? c.text ?? '').trim()
  }));
  return VTT.stringify(items);
}

function rebuildEmotionState(){
  const cues = (EAQ.state.emotionCues||[]).map(c=>{
    const start = Math.max(0, +c.start || 0);
    const end = Math.max(start, +c.end || 0);
    const label = (c.label ?? c.text ?? '').trim();
    return { start, end, label };
  });
  cues.sort((a,b)=> a.start - b.start || a.end - b.end);
  EAQ.state.emotionCues = cues;
  EAQ.state.emotionVTT = emotionCuesToVTT(cues);
  const box = qs('emotionVTT'); if(box) box.value = EAQ.state.emotionVTT;
}

function parseEmotionVTT(text){
  try{
    const cues = VTT.parse(text||'');
    return cues.map(c=>{
      const start = Math.max(0, c.start||0);
      const end = Math.max(start, Math.max(0, c.end||0));
      return { start, end, label: (c.text||'').trim() };
    });
  }catch{
    return [];
  }
}
