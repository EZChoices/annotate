"use strict";
// ====== CONFIG ======
const STORAGE_KEY = "dd_meta_queue_v1";
const THEME_KEY = "dd_theme";
const BUNNY_BASE = window.BUNNY_BASE || ""; // e.g. "https://YOUR_PULL_ZONE.b-cdn.net/keep/" (optional)
const PLAYLIST_PATH = BUNNY_BASE ? `${BUNNY_BASE}playlist.json` : "/public/playlist.json";

// ====== GOLD META SCHEMA (post-triage) ======
let tags = {
  clip_id: null,
  src: null,
  topic: null,                                      // single
  speaker_count: null,                              // single
  code_switch: null,                                // yes/no
  code_switch_langs: [],                            // multi (if yes)
  emotion: [],                                      // multi
  environment: null,                                // single
  face_visible: null,                               // single
  lip_visible: null,                                // single
  gestures_visible: null,                           // single
  note: "",                                         // optional text
  flagged: false                                    // QC flag
};

// ====== STATE ======
let playlist = [];           // {id, src, title?}
let clipIdx = 0;             // index within playlist
let destroyHls = null;       // cleanup fn
let step = 0;                // current question index

const QUESTIONS = [
  { key: "topic", label: "Topic", type: "single", options: ["Daily life","Humor","Music","Education","Fashion/Beauty","Food","Sports","News","Religion","Politics","Other"] },
  { key: "speaker_count", label: "How many speakers?", type: "single", options: ["1","2","3+","Unknown"] },
  { key: "code_switch", label: "Code-switch present?", type: "single", options: ["Yes","No"], follow: {
      when: (val)=> val === "Yes",
      key: "code_switch_langs", label: "Which languages?", type: "multi", options: ["English","French","Kurdish","Armenian","Turkish","Persian","Other"]
    }
  },
  { key: "emotion", label: "Dominant emotions (select any)", type: "multi", options: ["Neutral","Happy","Excited","Angry","Sad","Sarcastic/Ironic","Intense","Loving/Kind","Anxious/Nervous","Other"] },
  { key: "environment", label: "Environment", type: "single", options: ["Indoor","Outdoor","Street","Music/Performance","Cafe/Restaurant","Home","Studio/Quiet","Vehicle","Other"] },
  { key: "face_visible", label: "Is a face visible?", type: "single", options: ["Yes","Partial","No"] },
  { key: "lip_visible", label: "Are lips visible?", type: "single", options: ["Yes","No"] },
  { key: "gestures_visible", label: "Are hand/arm gestures visible?", type: "single", options: ["Yes","No"] },
  { key: "note", label: "Optional note", type: "text" }
];

// ====== THEME ======
function applyTheme(theme){
  const t = theme || localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark':'light');
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.body.classList.toggle('dark', t === 'dark');
  localStorage.setItem(THEME_KEY, t);
}
function toggleTheme(){
  applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
}

// ====== STORAGE ======
function loadQueue(){ try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]"); }catch{ return []; } }
function saveQueue(q){ localStorage.setItem(STORAGE_KEY, JSON.stringify(q)); }
function enqueueCurrent(){
  const q = loadQueue();
  const payload = { ...tags, saved_at: new Date().toISOString() };
  // dedupe by clip_id: replace existing
  const i = q.findIndex(x=> x.clip_id === payload.clip_id);
  if(i>=0) q[i]=payload; else q.push(payload);
  saveQueue(q);
}

// ====== PLAYLIST ======
async function loadPlaylist(){
  try{
    const res = await fetch(PLAYLIST_PATH, {cache:'no-store'});
    if(!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    playlist = Array.isArray(data.clips)? data.clips : [];
  }catch(e){
    console.warn('Failed to load playlist:', PLAYLIST_PATH, e);
    playlist = [];
  }
}
function currentClip(){ return playlist[clipIdx] || null; }
function nextClipIdx(){ clipIdx = (clipIdx + 1) % Math.max(1, playlist.length); }

// ====== VIDEO ======
function attachVideo(src){
  const video = document.getElementById('video') || document.getElementById('videoPlayer');
  const err = document.getElementById('videoError');
  if(!video) return;
  if(destroyHls) { try{ destroyHls(); }catch{} destroyHls=null; }
  if(err){ err.classList.add('hide'); err.textContent=''; }
  destroyHls = window.HLSPlayer.attach(video, src, (e)=>{
    if(err){
      err.textContent = 'Video error – likely CORS/Hotlink protection on Bunny (401/403) or bad URL.';
      err.classList.remove('hide');
    }
  });
}

// ====== RENDER ======
function renderStep(){
  const qRoot = document.getElementById('questions');
  const bar = document.getElementById('barFill');
  const q = QUESTIONS[step];
  if(!qRoot||!q) return;
  const totalSteps = QUESTIONS.length + (tags.code_switch === 'Yes' ? 1 : 0);
  const progress = Math.round((step+1)/totalSteps*100);
  bar.style.width = progress + '%';

  let html = `<section class=\"card\">\n<h3 class=\"q-title\">${q.label}</h3>`;
  if(q.type === 'single'){
    html += `<div class=\"btns\">` + q.options.map(v=>{
      const sel = (tags[q.key] === v) ? 'selected' : '';
      return `<button class=\"btn ${sel}\" data-k=\"${q.key}\" data-v=\"${v}\">${v}</button>`;
    }).join('') + `</div>`;
  }
  if(q.type === 'multi'){
    html += `<div class=\"btns\">` + q.options.map(v=>{
      const chosen = (tags[q.key]||[]).includes(v) ? 'selected' : '';
      return `<button class=\"btn ${chosen}\" data-k=\"${q.key}\" data-v=\"${v}\">${v}</button>`;
    }).join('') + `</div>`;
  }
  if(q.type === 'text'){
    const val = (tags[q.key]||'').replace(/</g,'&lt;');
    html += `<textarea class=\"input-note\" id=\"noteInput\" rows=\"3\" placeholder=\"Optional\">${val}</textarea>`;
  }
  html += `</section>`;

  // Follow-up for code-switch languages
  if(q.key === 'code_switch' && tags.code_switch === 'Yes'){
    const f = q.follow;
    html += `<section class=\"card\">\n<h3 class=\"q-title\">${f.label}</h3><div class=\"btns\">` + f.options.map(v=>{
      const chosen = (tags[f.key]||[]).includes(v) ? 'selected' : '';
      return `<button class=\"btn ${chosen}\" data-k=\"${f.key}\" data-v=\"${v}\">${v}</button>`;
    }).join('') + `</div></section>`;
  }

  qRoot.innerHTML = html;
  attachHandlers();
}

function attachHandlers(){
  // option buttons
  document.querySelectorAll('.btn[data-k]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const k = btn.getAttribute('data-k');
      const v = btn.getAttribute('data-v');
      const q = QUESTIONS[step];
      if(!k) return;
      if((q && q.type === 'multi') || k === 'emotion' || k === 'code_switch_langs'){
        const arr = new Set(tags[k]||[]);
        if(arr.has(v)) arr.delete(v); else arr.add(v);
        tags[k] = Array.from(arr);
      } else {
        tags[k] = v;
      }
      enqueueCurrent();
      renderStep();
    });
  });
  // note
  const note = document.getElementById('noteInput');
  if(note){ note.addEventListener('input', ()=>{ tags.note = note.value.slice(0,300); enqueueCurrent(); }); }
}

function resetTagsForClip(clip){
  tags = { ...tags,
    clip_id: clip.id,
    src: clip.src,
    topic: null,
    speaker_count: null,
    code_switch: null,
    code_switch_langs: [],
    emotion: [],
    environment: null,
    face_visible: null,
    lip_visible: null,
    gestures_visible: null,
    note: "",
    flagged: false
  };
}

// ====== NAV ======
function nextStep(){ if(step < QUESTIONS.length-1) step++; renderStep(); }
function prevStep(){ if(step > 0) step--; renderStep(); }

async function loadClipAndStart(){
  const clip = currentClip();
  if(!clip){ return; }
  // Bunny swap: if BUNNY_BASE present & clip.id exists, build m3u8
  let src = (BUNNY_BASE && clip.id && !clip.src) ? `${BUNNY_BASE}${clip.id}/playlist.m3u8` : (clip.src || "");
  // If clip.src is relative, prepend BUNNY_BASE so remote clips resolve
  if(BUNNY_BASE && src && !src.startsWith('http') && !src.startsWith('/')){
    src = `${BUNNY_BASE}${src}`;
  }
  const clipIdEl = document.getElementById('clipId');
  if(clipIdEl) clipIdEl.textContent = clip.id || '–';
  attachVideo(src);
  resetTagsForClip({ id: clip.id, src });
  step = 0; renderStep(); enqueueCurrent();
}

// ====== ENTRY ======
async function initApp(){
  // theme
  applyTheme();

  // playlist
  await loadPlaylist();
  if(playlist.length === 0){
    const err = document.getElementById('videoError');
    if(err){
      err.textContent = 'No clips found in playlist.json';
      err.classList.remove('hide');
    }
    return;
  }

  await loadClipAndStart();

  // controls
  const back = document.getElementById('backBtn');
  const skip = document.getElementById('skipBtn');
  const flag = document.getElementById('flagBtn');
  const save = document.getElementById('saveNextBtn') || document.getElementById('submitBtn');
  const dark = document.getElementById('darkModeBtn');
  const pip = document.getElementById('pipBtn');

  if(back) back.addEventListener('click', ()=> prevStep());
  if(skip) skip.addEventListener('click', ()=> nextStep());
  if(flag) flag.addEventListener('click', ()=>{ tags.flagged = !tags.flagged; enqueueCurrent(); alert(tags.flagged ? '🚩 Flagged' : 'Flag removed'); });
  if(save) save.addEventListener('click', ()=>{
    // simple validation: required keys
    const required = ['topic','speaker_count','code_switch','environment','face_visible','lip_visible','gestures_visible'];
    const missing = required.filter(k=> !tags[k] || (Array.isArray(tags[k]) && tags[k].length===0));
    if(missing.length){
      alert('Missing: ' + missing.join(', '));
      return;
    }
    enqueueCurrent();
    nextClipIdx();
    loadClipAndStart();
  });
  if(dark) dark.addEventListener('click', toggleTheme);
  if(pip) pip.addEventListener('click', ()=> {
    const vid = document.getElementById('video') || document.getElementById('videoPlayer');
    if(vid) window.HLSPlayer.requestPiP(vid);
  });
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initApp);
}else{ initApp(); }
