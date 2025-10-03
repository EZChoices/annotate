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
    startedAt: 0
  }
};

const SPEAKER_GENDERS = ['male','female','nonbinary','unknown'];
const SPEAKER_AGE_BANDS = ['child','teen','young_adult','adult','elderly','unknown'];
const SPEAKER_DIALECTS = ['Levantine','Iraqi','Gulf','Yemeni','Egyptian','Maghrebi','MSA','Mixed','Other','Unknown'];

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

function show(id){
  ['screen_welcome','screen_transcript','screen_translation','screen_codeswitch','screen_speaker','screen_emotion','screen_pii','screen_diar','screen_review']
    .forEach(x=> qs(x).classList.toggle('hide', x!==id));
}

async function loadManifest(){
  const annot = encodeURIComponent(EAQ.state.annotator);
  const url = `/api/tasks?stage=2&annotator_id=${annot}`;
  const res = await fetch(url, {cache:'no-store'});
  if(!res.ok) throw new Error('tasks fetch');
  EAQ.state.manifest = await res.json();
  return EAQ.state.manifest;
}

function currentItem(){
  const m = EAQ.state.manifest; if(!m||!m.items) return null; return m.items[EAQ.state.idx]||null;
}

async function prefetchNext(){
  try{
    const it = EAQ.state.manifest.items[EAQ.state.idx+1];
    if(it && it.media && it.media.audio_proxy_url){ fetch(it.media.audio_proxy_url).catch(()=>{}); }
  }catch{}
}

function loadAudio(){
  const it = currentItem(); if(!it) return;
  const a = qs('audio'); if(!a) return;
  EAQ.audio = a;
  a.src = it.media && it.media.audio_proxy_url ? it.media.audio_proxy_url : '/public/sample.mp4';
  a.play().catch(()=>{});
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

async function enqueueAndSync(){
  const it = currentItem(); if(!it) return;
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
      time_spent_sec: Math.max(0, Math.round((Date.now() - (EAQ.state.startedAt||Date.now()))/1000))
    },
    client_meta: { device: navigator.userAgent }
  };

  await EAIDB.enqueue(payload);
  trySyncWithBackoff();
  try{
    if('serviceWorker' in navigator && 'SyncManager' in window){
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('ea-sync');
    }
  }catch{}
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
    EAQ.state.transcriptVTT = qs('transcriptVTT').value;
    EAQ.state.transcriptCues = VTT.normalize(VTT.parse(EAQ.state.transcriptVTT));
    show('screen_translation');
  });

  qs('translationNext').addEventListener('click', ()=>{
    EAQ.state.translationVTT = qs('translationVTT').value;
    EAQ.state.translationCues = VTT.normalize(VTT.parse(EAQ.state.translationVTT));
    show('screen_codeswitch');
  });

  qs('csNext').addEventListener('click', ()=>{
    EAQ.state.codeSwitchVTT = qs('codeSwitchVTT').value;
    EAQ.state.codeSwitchCues = VTT.normalize(VTT.parse(EAQ.state.codeSwitchVTT));
    const errs = basicValidation();
    const el = qs('errorsList');
    el.textContent = errs.length ? ('Errors: ' + errs.join(', ')) : 'Looks good.';
    show('screen_speaker');
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
  const diarNext = qs('diarNext'); if(diarNext) diarNext.addEventListener('click', ()=>{ show('screen_review'); });

  qs('submitBtn').addEventListener('click', async ()=>{
    await enqueueAndSync();
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
    const t = a.currentTime;
    const cues = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : VTT.parse(qs('transcriptVTT').value);
    for(let i=0;i<cues.length;i++){
      const c = cues[i];
      if(t > c.start && t < c.end && (t - c.start) >= EAQ.SPEC.cueMin && (c.end - t) >= EAQ.SPEC.cueMin){
        const left = { start:c.start, end:t, text:c.text };
        const right = { start:t, end:c.end, text:c.text };
        cues.splice(i,1,left,right);
        EAQ.state.transcriptCues = VTT.normalize(cues);
        qs('transcriptVTT').value = VTT.stringify(EAQ.state.transcriptCues);
        break;
      }
    }
  });
  qs('mergeBtn').addEventListener('click', ()=>{
    const cues = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : VTT.parse(qs('transcriptVTT').value);
    for(let i=0;i<cues.length-1;i++){
      const cur = cues[i], nxt = cues[i+1];
      if(Math.abs(cur.end - nxt.start) < 0.25){
        const merged = { start: cur.start, end: nxt.end, text: `${cur.text}\n${nxt.text}`.trim() };
        cues.splice(i,2,merged);
        EAQ.state.transcriptCues = VTT.normalize(cues);
        qs('transcriptVTT').value = VTT.stringify(EAQ.state.transcriptCues);
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
  qs('translationVTT').value = VTT.stringify(tl);
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
