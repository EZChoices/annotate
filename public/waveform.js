"use strict";

// Simple static waveform renderer using WebAudio decode
const Wave = (function(){
  const api = {};
  let cvs, ctx, width, height, peaks = null;

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
      peaks = downsample(ch, Math.max(1, Math.floor(ch.length / (width||300))));
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
    for(let x=0;x<Math.min(width, peaks.length);x++){
      const v = peaks[x];
      const y = (1 - v) * (height/2);
      ctx.moveTo(x, height/2 - y);
      ctx.lineTo(x, height/2 + y);
    }
    ctx.stroke();
  };

  return api;
})();
window.Wave = Wave;

