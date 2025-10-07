(function(global){
  "use strict";

  const RECORDS_KEY = "ea_stage2_irr_records";
  const SUMMARY_KEY = "irr_summary.json";
  const memoryStore = { records: [], summary: null };

  function hasLocalStorage(){
    try{
      return typeof localStorage !== "undefined" && localStorage !== null;
    }catch{
      return false;
    }
  }

  function loadRecords(){
    if(hasLocalStorage()){
      try{
        const raw = localStorage.getItem(RECORDS_KEY);
        if(raw){
          const parsed = JSON.parse(raw);
          if(Array.isArray(parsed)){
            return parsed;
          }
        }
      }catch(err){
        console.warn("IRR: failed to load records from storage", err);
      }
    }
    const mem = global.__IRR_RECORDS__;
    if(Array.isArray(mem)){
      return mem.slice();
    }
    return memoryStore.records.slice();
  }

  function saveRecords(records){
    const safe = Array.isArray(records) ? records.filter(Boolean) : [];
    if(hasLocalStorage()){
      try{
        localStorage.setItem(RECORDS_KEY, JSON.stringify(safe));
      }catch(err){
        console.warn("IRR: failed to persist records", err);
      }
    }
    memoryStore.records = safe.slice();
    global.__IRR_RECORDS__ = memoryStore.records;
  }

  function toFinite(value){
    if(value == null) return null;
    const num = typeof value === "string" ? parseFloat(value) : Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function sanitizeMetrics(metrics){
    const src = metrics && typeof metrics === "object" ? metrics : {};
    return {
      codeSwitchF1: toFinite(src.codeSwitchF1 ?? src.codeswitch_f1 ?? src.code_switch_f1),
      diarizationMae: toFinite(src.diarizationMae ?? src.diarization_mae ?? src.diarMae),
      cueDelta: toFinite(src.cueDelta ?? src.cue_diff_sec ?? src.cueDeltaSec),
      translationCompleteness: toFinite(
        src.translationCompleteness ??
        src.translation_completeness ??
        src.translationCompletenessRatio
      )
    };
  }

  function recordAnnotation(annotatorId, clipId, metrics){
    if(!clipId){ return null; }
    const id = annotatorId || "anonymous";
    const normalized = sanitizeMetrics(metrics);
    const records = loadRecords();
    const timestamp = new Date().toISOString();
    const payload = {
      annotatorId: id,
      clipId,
      metrics: normalized,
      recordedAt: timestamp
    };
    const idx = records.findIndex((entry)=> entry && entry.clipId === clipId && entry.annotatorId === id);
    if(idx >= 0){
      records[idx] = payload;
    } else {
      records.push(payload);
    }
    saveRecords(records);
    const summary = computeIRRSummary(records);
    saveIRRSummary(summary);
    return payload;
  }

  function computeAlpha(values){
    const arr = Array.isArray(values) ? values.map(Number).filter((v)=> Number.isFinite(v)) : [];
    if(arr.length < 2){ return null; }
    let agreementSum = 0;
    let pairs = 0;
    for(let i=0;i<arr.length;i++){
      for(let j=i+1;j<arr.length;j++){
        const a = arr[i];
        const b = arr[j];
        const diff = Math.abs(a - b);
        const agreement = Math.max(0, Math.min(1, 1 - diff));
        agreementSum += agreement;
        pairs++;
      }
    }
    if(pairs === 0){ return null; }
    return Number((agreementSum / pairs).toFixed(4));
  }

  function normalizeMae(value){
    const num = toFinite(value);
    if(!Number.isFinite(num)){ return null; }
    const range = 2; // seconds
    const normalized = 1 - Math.min(Math.abs(num) / range, 1);
    return Math.max(0, Math.min(1, normalized));
  }

  function normalizeCueDelta(value){
    const num = toFinite(value);
    if(!Number.isFinite(num)){ return null; }
    const range = 1.5; // seconds
    const normalized = 1 - Math.min(Math.abs(num) / range, 1);
    return Math.max(0, Math.min(1, normalized));
  }

  function computeAverage(values){
    if(!values || !values.length){ return null; }
    const total = values.reduce((acc, v)=> acc + v, 0);
    return Number((total / values.length).toFixed(4));
  }

  function computeIRRSummary(recordsInput){
    const records = Array.isArray(recordsInput) ? recordsInput.filter(Boolean) : loadRecords();
    const byClip = new Map();
    records.forEach((entry)=>{
      if(!entry || !entry.clipId){ return; }
      if(!byClip.has(entry.clipId)){ byClip.set(entry.clipId, []); }
      byClip.get(entry.clipId).push(entry);
    });

    const codeSwitchScores = [];
    const diarizationScores = [];
    const cueScores = [];
    const translationScores = [];
    let clipCount = 0;

    byClip.forEach((entries)=>{
      const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
      if(list.length < 2){ return; }
      clipCount++;
      const codeValues = list
        .map((entry)=>{
          const value = entry.metrics ? entry.metrics.codeSwitchF1 : null;
          if(!Number.isFinite(value)){ return null; }
          return Math.max(0, Math.min(1, value));
        })
        .filter((v)=> Number.isFinite(v));
      if(codeValues.length >= 2){
        const alpha = computeAlpha(codeValues);
        if(Number.isFinite(alpha)){ codeSwitchScores.push(alpha); }
      }

      const diarValues = list
        .map((entry)=> normalizeMae(entry.metrics ? entry.metrics.diarizationMae : null))
        .filter((v)=> Number.isFinite(v));
      if(diarValues.length >= 2){
        const alpha = computeAlpha(diarValues);
        if(Number.isFinite(alpha)){ diarizationScores.push(alpha); }
      }

      const cueValues = list
        .map((entry)=> normalizeCueDelta(entry.metrics ? entry.metrics.cueDelta : null))
        .filter((v)=> Number.isFinite(v));
      if(cueValues.length >= 2){
        const alpha = computeAlpha(cueValues);
        if(Number.isFinite(alpha)){ cueScores.push(alpha); }
      }

      const translationValues = list
        .map((entry)=>{
          const value = entry.metrics ? entry.metrics.translationCompleteness : null;
          if(!Number.isFinite(value)){ return null; }
          return Math.max(0, Math.min(1, value));
        })
        .filter((v)=> Number.isFinite(v));
      if(translationValues.length >= 2){
        const alpha = computeAlpha(translationValues);
        if(Number.isFinite(alpha)){ translationScores.push(alpha); }
      }
    });

    const summary = {
      generatedAt: new Date().toISOString(),
      clipCount,
      codeSwitchAlpha: computeAverage(codeSwitchScores),
      diarizationAlpha: computeAverage(diarizationScores),
      cueAlpha: computeAverage(cueScores),
      translationAlpha: computeAverage(translationScores),
      overallAlpha: null
    };

    const overallValues = [
      summary.codeSwitchAlpha,
      summary.diarizationAlpha,
      summary.cueAlpha,
      summary.translationAlpha
    ].filter((v)=> Number.isFinite(v));
    summary.overallAlpha = computeAverage(overallValues);
    return summary;
  }

  function saveIRRSummary(summaryInput){
    const summary = summaryInput || computeIRRSummary();
    if(!summary){ return null; }
    const serialized = JSON.stringify(summary);
    if(hasLocalStorage()){
      try{
        localStorage.setItem(SUMMARY_KEY, serialized);
      }catch(err){
        console.warn("IRR: failed to persist summary", err);
      }
    }
    memoryStore.summary = summary;
    global.__IRR_SUMMARY__ = summary;
    return summary;
  }

  const api = {
    recordAnnotation,
    computeAlpha,
    computeIRRSummary,
    saveIRRSummary,
    _loadRecords: loadRecords,
    _saveRecords: saveRecords
  };

  global.IRR = api;
  if(typeof module !== "undefined" && module.exports){
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
