"use strict";

// Simple transcript timeline with draggable boundaries
const Timeline = (function(){
  const api = {};
  let root, duration = 0, cues = [], onChange = null, overlays = { cs: [], events: [] };

  function pct(t){ return `${Math.max(0, Math.min(1, duration? (t/duration):0)) * 100}%`; }

  function render(){
    if(!root) return;
    root.innerHTML = '';
    root.classList.add('tl');
    const frag = document.createDocumentFragment();
    for(let i=0;i<cues.length;i++){
      const c = cues[i];
      const seg = document.createElement('div');
      seg.className = 'tl-seg';
      seg.style.left = pct(c.start);
      seg.style.width = `calc(${pct(c.end)} - ${pct(c.start)})`;
      const h = document.createElement('div'); h.className='tl-handle'; h.dataset.index = String(i);
      seg.appendChild(h);
      frag.appendChild(seg);
    }
    root.appendChild(frag);
    // overlays: code-switch (blue), events (orange)
    function paintOverlay(list, cls){
      (list||[]).forEach(o=>{
        const seg = document.createElement('div');
        seg.className = `tl-seg ${cls}`;
        seg.style.left = pct(o.start);
        seg.style.width = `calc(${pct(o.end)} - ${pct(o.start)})`;
        seg.style.background = cls === 'cs' ? 'rgba(43,124,255,0.25)' : 'rgba(230,140,30,0.25)';
        seg.style.borderColor = cls === 'cs' ? 'var(--accent)' : '#e68c1e';
        root.appendChild(seg);
      });
    }
    paintOverlay(overlays.cs, 'cs');
    paintOverlay(overlays.events, 'evt');
  }

  function onPointerDown(e){
    const h = e.target.closest('.tl-handle'); if(!h) return;
    const idx = parseInt(h.dataset.index||'0',10);
    const rect = root.getBoundingClientRect();
    const startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    e.preventDefault();
    function move(ev){
      const x = (ev.clientX || (ev.touches && ev.touches[0].clientX) || 0) - rect.left;
      const t = Math.max(0, Math.min(duration, (x/rect.width) * duration));
      // drag boundary between cue idx and idx+1 if exists, otherwise adjust end of last
      if(idx < cues.length){
        if(idx < cues.length-1){
          const left = cues[idx];
          const right = cues[idx+1];
          const minLen = 0.6;
          const nt = Math.max(left.start+minLen, Math.min(right.end-minLen, t));
          left.end = nt; right.start = nt;
        } else {
          const left = cues[idx];
          left.end = Math.max(left.start+0.6, Math.min(duration, t));
        }
        if(onChange) onChange(cues);
        render();
      }
    }
    function up(){ document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.addEventListener('touchmove', move); document.addEventListener('touchend', up);
  }

  api.attach = function(el, dur, curCues, onChangeCb){ root = el; duration = dur||0; cues = (curCues||[]).map(c=> ({...c})); onChange = onChangeCb; root.addEventListener('mousedown', onPointerDown); root.addEventListener('touchstart', onPointerDown, {passive:false}); render(); };
  api.update = function(dur, curCues){ duration = dur||duration; cues = (curCues||cues).map(c=> ({...c})); render(); };
  api.setOverlays = function(cs, evt){ overlays.cs = (cs||[]); overlays.events = (evt||[]); render(); };

  return api;
})();
window.Timeline = Timeline;
