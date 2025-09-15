"use strict";

// Simple static waveform renderer using WebAudio decode
const Wave = (function(){
  const api = {};
  let cvs, ctx, width, height, peaks = null, fullPeaks = null, viewStart = 0, viewEnd = 1;

  api.attach = function(canvas){
    cvs = canvas; ctx = cvs.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    width = Math.floor(cvs.clientWidth * dpr);
    height = Math.floor(cvs.clientHeight * dpr);
    cvs.width = width; cvs.height = height;
    api.render();
  };

  api.load = async function(url){
    try{
      const res = await fetch(url, {cache:'no-store'}); const buf = await res.arrayBuffer();
      const actx = new (window.AudioContext || window.webkitAudioContext)();
      const audio = await actx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      // compute at higher resolution for basic zooming
      fullPeaks = downsample(ch, Math.max(1, Math.floor(ch.length / Math.max(1,(width||300))/2)));
      peaks = fullPeaks;
      viewStart = 0; viewEnd = 1;
      api.render();
    }catch(e){ /* ignore */ }
  };

  function downsample(data, block){
    const out = new Float32Array(Math.ceil(data.length / block));
    for(let i=0;i<out.length;i++){
      let sum=0, start=i*block, end=Math.min((i+1)*block, data.length);
      for(let j=start;j<end;j++) sum = Math.max(sum, Math.abs(data[j]));
      out[i] = sum;
    }
    return out;
  }

  api.render = function(){
    if(!ctx) return;
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = '#888';
    ctx.fillRect(0, height/2-1, width, 2);
    if(!peaks) return;
    ctx.strokeStyle = '#2b7cff';
    ctx.beginPath();
    const startIdx = Math.floor((fullPeaks ? fullPeaks.length : peaks.length) * viewStart);
    const endIdx = Math.floor((fullPeaks ? fullPeaks.length : peaks.length) * viewEnd);
    const span = Math.max(1, endIdx - startIdx);
    for(let x=0;x<width;x++){
      const idx = startIdx + Math.floor(span * (x/width));
      const v = (fullPeaks || peaks)[Math.min(idx, (fullPeaks||peaks).length-1)] || 0;
      const y = (1 - v) * (height/2);
      ctx.moveTo(x, height/2 - y);
      ctx.lineTo(x, height/2 + y);
    }
    ctx.stroke();
  };

  api.setZoom = function(mult){
    // mult <1 zooms in, >1 zooms out relative to current window
    const center = (viewStart + viewEnd)/2;
    let half = (viewEnd - viewStart)/2;
    half = Math.max(0.01, Math.min(0.5, half * mult));
    viewStart = Math.max(0, center - half);
    viewEnd = Math.min(1, center + half);
    api.render();
  };

  api.scroll = function(delta){
    // delta in [-1,1] of full length
    const span = (viewEnd - viewStart);
    viewStart = Math.max(0, Math.min(1-span, viewStart + delta));
    viewEnd = viewStart + span;
    api.render();
  };

  api.timeAtX = function(x, duration){
    const ratio = Math.max(0, Math.min(1, x / Math.max(1,width)));
    const local = viewStart + ratio * (viewEnd - viewStart);
    return local * (duration||0);
  };

  return api;
})();
window.Wave = Wave;
