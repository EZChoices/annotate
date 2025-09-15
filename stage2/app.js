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
    codeSwitchVTT: '',
    transcriptCues: [],
    translationCues: [],
    codeSwitchCues: [],
    eventsCues: [],
    diarSegments: []
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
function show(id){ ['screen_welcome','screen_transcript','screen_translation','screen_codeswitch','screen_pii','screen_diar','screen_review'].forEach(x=> qs(x).classList.toggle('hide', x!==id)); }

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
  const wave = qs('wave'); if(wave){ Wave.attach(wave); Wave.load(a.src); }
  const tl = qs('timeline');
  if(tl){
    const attachTl = ()=> Timeline.attach(tl, a.duration||0, EAQ.state.transcriptCues, (cues)=>{ EAQ.state.transcriptCues = VTT.normalize(cues); qs('transcriptVTT').value = VTT.stringify(EAQ.state.transcriptCues); alignTranslationToTranscript(); });
    if(isFinite(a.duration) && a.duration>0){ attachTl(); }
    else { a.addEventListener('loadedmetadata', attachTl, { once:true }); }
  }
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
      await loadPrefillForCurrent();
      prefetchNext();
      show('screen_transcript');
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
    show('screen_pii');
  });
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
    loadAudio();
    await loadPrefillForCurrent();
    prefetchNext();
    show('screen_transcript');
  });
}

window.addEventListener('load', ()=>{
  EAQ.state.annotator = getAnnotatorId();
  bindUI();
  window.addEventListener('online', ()=>{ trySyncWithBackoff(); });
  // Bind basic editing controls
  const a = qs('audio');
  qs('rewindBtn').addEventListener('click', ()=>{ if(a) a.currentTime = Math.max(0, a.currentTime - 3); });
  qs('splitBtn').addEventListener('click', ()=>{
    if(!a) return; const t = a.currentTime; const cues = EAQ.state.transcriptCues.length ? EAQ.state.transcriptCues : VTT.parse(qs('transcriptVTT').value);
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
  function endPress(){ if(!a || pressStart==null || !pressLang) return; const end = a.currentTime; if(end-pressStart >= EAQ.SPEC.csMinSec){ EAQ.state.codeSwitchCues.push({ start: pressStart, end, text: pressLang }); EAQ.state.codeSwitchCues = VTT.normalize(EAQ.state.codeSwitchCues); qs('codeSwitchVTT').value = VTT.stringify(EAQ.state.codeSwitchCues); } pressStart=null; pressLang=null; }
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
    const cues = EAQ.state.codeSwitchCues; if(!cues.length) return; cues[cues.length-1].start = Math.max(0, cues[cues.length-1].start - 0.2); qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(cues));
  });
  qs('nudgePlus').addEventListener('click', ()=>{
    const cues = EAQ.state.codeSwitchCues; if(!cues.length) return; cues[cues.length-1].end = cues[cues.length-1].end + 0.2; qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(cues));
  });
  qs('csUndo').addEventListener('click', ()=>{ EAQ.state.codeSwitchCues.pop(); qs('codeSwitchVTT').value = VTT.stringify(VTT.normalize(EAQ.state.codeSwitchCues)); });
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
});

// Prefill loader and alignment helpers
async function loadPrefillForCurrent(){
  const it = currentItem(); if(!it) return;
  // Transcript
  if(it.prefill && it.prefill.transcript_vtt_url){
    try{ const t = await fetch(it.prefill.transcript_vtt_url).then(r=> r.text()); EAQ.state.transcriptVTT = t; qs('transcriptVTT').value = t; EAQ.state.transcriptCues = VTT.normalize(VTT.parse(t)); } catch{}
  }
  // Translation
  if(it.prefill && it.prefill.translation_vtt_url){
    try{ const t = await fetch(it.prefill.translation_vtt_url).then(r=> r.text()); EAQ.state.translationVTT = t; qs('translationVTT').value = t; EAQ.state.translationCues = VTT.normalize(VTT.parse(t)); } catch{}
  }
  // Align counts
  alignTranslationToTranscript();
  // Diarization prefill (RTTM)
  if(it.prefill && it.prefill.diarization_rttm_url){
    try{ const t = await fetch(it.prefill.diarization_rttm_url).then(r=> r.text()); EAQ.state.diarSegments = parseRTTM(t); renderDiarList(); } catch{ EAQ.state.diarSegments = []; renderDiarList(); }
  } else { EAQ.state.diarSegments = []; renderDiarList(); }
}

function alignTranslationToTranscript(){
  const tr = EAQ.state.transcriptCues || [];
  let tl = EAQ.state.translationCues || [];
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
}
