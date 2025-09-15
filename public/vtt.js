"use strict";

// Minimal WebVTT utilities: parse and serialize cues
const VTT = {
  parse(text){
    const out = [];
    const lines = (text||'').replace(/\r/g,'').split('\n');
    let i = 0;
    // skip WEBVTT header
    if(lines[i] && /^WEBVTT/i.test(lines[i])) i++;
    // skip optional header info until blank line
    while(i < lines.length && lines[i].trim() !== '') i++;
    // now parse cues
    function tsToSec(ts){
      const m = ts.trim().match(/(?:(\d+):)?(\d{2}):(\d{2}\.\d{3})/);
      if(!m) return null;
      const h = parseInt(m[1]||'0',10), mm = parseInt(m[2],10), s = parseFloat(m[3]);
      return h*3600 + mm*60 + s;
    }
    function secToTs(sec){
      const h = Math.floor(sec/3600);
      const m = Math.floor((sec%3600)/60);
      const s = (sec%60).toFixed(3);
      const mm = String(m).padStart(2,'0');
      const ss = String(s).padStart(6,'0');
      if(h>0) return `${h}:${mm}:${ss}`; else return `00:${mm}:${ss}`;
    }
    while(i < lines.length){
      // skip blank lines and cue ids (optional)
      while(i < lines.length && lines[i].trim()==='') i++;
      if(i>=lines.length) break;
      // optional cue id line
      if(lines[i] && !lines[i].includes('-->') && lines[i+1] && lines[i+1].includes('-->')) i++;
      const timing = lines[i++]||'';
      const parts = timing.split('-->');
      if(parts.length<2) { continue; }
      const start = tsToSec(parts[0]);
      const end = tsToSec(parts[1]);
      const textLines = [];
      while(i < lines.length && lines[i].trim() !== ''){
        textLines.push(lines[i++]);
      }
      out.push({ start, end, text: textLines.join('\n') });
    }
    return out;
  },
  stringify(cues){
    function secToTs(sec){
      const h = Math.floor(sec/3600);
      const m = Math.floor((sec%3600)/60);
      const s = (sec%60).toFixed(3);
      const hh = String(h).padStart(2,'0');
      const mm = String(m).padStart(2,'0');
      const ss = String(s).padStart(6,'0');
      return `${hh}:${mm}:${ss}`;
    }
    let out = 'WEBVTT\n\n';
    (cues||[]).forEach(c=>{
      out += `${secToTs(c.start)} --> ${secToTs(c.end)}\n${(c.text||'').trim()}\n\n`;
    });
    return out;
  },
  normalize(cues){
    // sort by start, clamp negatives, ensure no overlaps by slight push
    const eps = 0.001;
    const a = (cues||[]).map(c=> ({ start: Math.max(0, c.start||0), end: Math.max(0, c.end||0), text: c.text||'' }));
    a.sort((x,y)=> x.start - y.start || x.end - y.end);
    for(let i=0;i<a.length;i++){
      if(a[i].end < a[i].start) a[i].end = a[i].start + 0.001;
      if(i>0 && a[i].start < a[i-1].end) a[i].start = a[i-1].end + eps;
    }
    return a;
  }
};
window.VTT = VTT;

