"use strict";

// Basic Stage 2 flow controller with offline queue and simple VTT editors.

const EAQ = {
  SPEC: {
    maxCacheMB: 300,
    cueMin: 0.6,
    cueMax: 6.0,
    csMinSec: 0.4,
    backoffMs: [1000,2000,5000,10000,30000]
  },
  state: {
    annotator: null,
    manifest: null,
    idx: 0,
    transcriptVTT: '',
    translationVTT: '',
    codeSwitchVTT: ''
  }
};

function getAnnotatorId(){
  try{
    const k = 'ea_stage2_annotator_id';
    let v = localStorage.getItem(k);
    if(!v){ v = Math.random().toString(36).slice(2,10); localStorage.setItem(k,v); }
    return v;
  }catch{ return 'anonymous'; }
}

function qs(id){ return document.getElementById(id); }
function show(id){ ['screen_welcome','screen_transcript','screen_translation','screen_codeswitch','screen_review'].forEach(x=> qs(x).classList.toggle('hide', x!==id)); }

async function loadManifest(){
  const annot = encodeURIComponent(EAQ.state.annotator);
  const url = `/api/tasks?stage=2&annotator_id=${annot}`;
  const res = await fetch(url, {cache:'no-store'});
  if(!res.ok) throw new Error('tasks fetch');
  EAQ.state.manifest = await res.json();
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
  a.src = it.media && it.media.audio_proxy_url ? it.media.audio_proxy_url : '/public/sample.mp4';
  a.play().catch(()=>{});
}

function basicValidation(){
  const errs = [];
  if(!EAQ.state.transcriptVTT.trim()) errs.push('Transcript VTT is empty');
  if(!EAQ.state.translationVTT.trim()) errs.push('Translation VTT is empty');
  // simple parse check: must contain WEBVTT header
  if(!/^WEBVTT/m.test(EAQ.state.transcriptVTT)) errs.push('Transcript VTT missing WEBVTT');
  if(!/^WEBVTT/m.test(EAQ.state.translationVTT)) errs.push('Translation VTT missing WEBVTT');
  // code-switch optional; if provided, must have WEBVTT
  if(EAQ.state.codeSwitchVTT.trim() && !/^WEBVTT/m.test(EAQ.state.codeSwitchVTT)) errs.push('Code-switch VTT missing WEBVTT');
  return errs;
}

async function enqueueAndSync(){
  const it = currentItem(); if(!it) return;
  const payload = {
    asset_id: it.asset_id,
    files: {
      diarization_rttm: null,
      transcript_vtt: EAQ.state.transcriptVTT,
      transcript_ctm: null,
      translation_vtt: EAQ.state.translationVTT,
      code_switch_vtt: EAQ.state.codeSwitchVTT || '',
      code_switch_spans_json: ''
    },
    summary: {
      contains_code_switch: !!EAQ.state.codeSwitchVTT.trim(),
      code_switch_languages: [],
      cs_total_duration_sec: 0,
      non_arabic_token_ratio_est: 0
    },
    qa: {
      annotator_id: EAQ.state.annotator,
      second_annotator_id: null,
      adjudicator_id: null,
      gold_check: 'pass',
      time_spent_sec: 0
    },
    client_meta: { device: navigator.userAgent }
  };

  await EAIDB.enqueue(payload);
  trySyncWithBackoff();
}

async function trySyncOnce(){
  const items = await EAIDB.peekBatch(10);
  if(items.length===0) return true;
  try{
    const res = await fetch('/api/annotations/batch', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(items)});
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
      loadAudio();
      prefetchNext();
      show('screen_transcript');
    }catch{
      qs('downloadStatus').textContent = 'Failed to load tasks. Using offline queue.';
    }
  });

  qs('transcriptNext').addEventListener('click', ()=>{
    EAQ.state.transcriptVTT = qs('transcriptVTT').value;
    show('screen_translation');
  });
  qs('translationNext').addEventListener('click', ()=>{
    EAQ.state.translationVTT = qs('translationVTT').value;
    show('screen_codeswitch');
  });
  qs('csNext').addEventListener('click', ()=>{
    EAQ.state.codeSwitchVTT = qs('codeSwitchVTT').value;
    const errs = basicValidation();
    const el = qs('errorsList');
    el.textContent = errs.length ? ('Errors: ' + errs.join(', ')) : 'Looks good.';
    show('screen_review');
  });
  qs('submitBtn').addEventListener('click', async ()=>{
    await enqueueAndSync();
    EAQ.state.idx = (EAQ.state.idx + 1) % Math.max(1, EAQ.state.manifest.items.length);
    qs('transcriptVTT').value = '';
    qs('translationVTT').value = '';
    qs('codeSwitchVTT').value = '';
    loadAudio();
    prefetchNext();
    show('screen_transcript');
  });
}

window.addEventListener('load', ()=>{
  EAQ.state.annotator = getAnnotatorId();
  bindUI();
  window.addEventListener('online', ()=>{ trySyncWithBackoff(); });
});

