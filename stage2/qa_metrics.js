(function(global){
  const STORAGE_KEY = 'qa_history_v1';
  const REPORT_KEY = 'qa_report';
  const DEFAULT_TOLERANCE_MS = 300;
  const DEFAULT_BOUNDARY_PENALTY = 5; // seconds
  const TARGET_CUE_MEAN_SEC = 2.5;
  const TARGET_CUE_RANGE = [2, 3];

  function clamp01(v){
    if(!Number.isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
  }

  function toNumber(value){
    if(value == null) return NaN;
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return Number.isFinite(num) ? num : NaN;
  }

  function toMs(value){
    const num = toNumber(value);
    if(!Number.isFinite(num)) return NaN;
    return num;
  }

  function normalizeSpans(spans){
    if(!Array.isArray(spans)) return [];
    return spans
      .map((span)=>{
        if(!span) return null;
        const start = toMs(span.start);
        const end = toMs(span.end);
        if(!Number.isFinite(start) || !Number.isFinite(end)) return null;
        if(end <= start) return null;
        return { start, end, lang: span.lang || span.language || null };
      })
      .filter(Boolean)
      .sort((a, b)=> a.start - b.start || a.end - b.end);
  }

  function spansOverlap(pred, gold, tolerance){
    if(!pred || !gold) return false;
    const tol = Number.isFinite(tolerance) ? Math.max(0, tolerance) : DEFAULT_TOLERANCE_MS;
    const overlaps = !(pred.end < gold.start || pred.start > gold.end);
    if(overlaps) return true;
    if(pred.start <= gold.end + tol && pred.end >= gold.start - tol) return true;
    return false;
  }

  function scoreCodeSwitchF1(predSpans, goldSpans, toleranceMs){
    const preds = normalizeSpans(predSpans);
    const golds = normalizeSpans(goldSpans);
    const tol = Number.isFinite(toleranceMs) ? toleranceMs : DEFAULT_TOLERANCE_MS;
    if(!golds.length && !preds.length){
      return { precision: 1, recall: 1, f1: 1, matches: [] };
    }
    const matches = [];
    const usedPred = new Set();
    golds.forEach((gold)=>{
      let best = null;
      let bestIdx = -1;
      let bestScore = Infinity;
      preds.forEach((pred, idx)=>{
        if(usedPred.has(idx)) return;
        if(!spansOverlap(pred, gold, tol)) return;
        const score = Math.abs(pred.start - gold.start) + Math.abs(pred.end - gold.end);
        if(score < bestScore){
          bestScore = score;
          best = pred;
          bestIdx = idx;
        }
      });
      if(best && bestIdx >= 0){
        usedPred.add(bestIdx);
        matches.push({ gold, pred: best, deltaStart: best.start - gold.start, deltaEnd: best.end - gold.end });
      }
    });
    const tp = matches.length;
    const fp = Math.max(0, preds.length - tp);
    const fn = Math.max(0, golds.length - tp);
    const precision = tp + fp === 0 ? (tp === 0 ? 1 : 0) : tp / (tp + fp);
    const recall = tp + fn === 0 ? (tp === 0 ? 1 : 0) : tp / (tp + fn);
    const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { precision, recall, f1, tp, fp, fn, matches, preds, golds };
  }

  function parseRttm(input){
    if(!input) return [];
    if(Array.isArray(input)){
      return input
        .map((seg)=>{
          if(!seg) return null;
          const start = toNumber(seg.start);
          const end = seg.end != null ? toNumber(seg.end) : (seg.duration != null ? toNumber(seg.duration) + toNumber(seg.start) : NaN);
          const speaker = seg.speaker || seg.spk || seg.label || seg.speaker_id || null;
          if(!Number.isFinite(start)) return null;
          let segmentEnd = end;
          if(!Number.isFinite(segmentEnd) && Number.isFinite(seg.duration)){
            segmentEnd = start + toNumber(seg.duration);
          }
          if(!Number.isFinite(segmentEnd) || segmentEnd <= start) return null;
          return { start, end: segmentEnd, speaker };
        })
        .filter(Boolean)
        .sort((a,b)=> a.start - b.start || a.end - b.end);
    }
    const text = String(input || '').trim();
    if(!text) return [];
    const segments = [];
    text.split(/\r?\n+/).forEach((line)=>{
      const trimmed = line.trim();
      if(!trimmed || trimmed.startsWith('#')) return;
      const parts = trimmed.split(/\s+/);
      if(parts.length < 5) return;
      const type = parts[0].toUpperCase();
      if(type !== 'SPEAKER') return;
      const start = toNumber(parts[3]);
      const dur = toNumber(parts[4]);
      const speaker = parts[7] || null;
      if(!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) return;
      segments.push({ start, end: start + dur, speaker });
    });
    return segments.sort((a,b)=> a.start - b.start || a.end - b.end);
  }

  function boundariesFromSegments(segments){
    const normalized = parseRttm(segments);
    if(!normalized.length) return [];
    const boundaries = [];
    normalized.sort((a,b)=> a.start - b.start || a.end - b.end);
    for(let i=1; i<normalized.length; i+=1){
      const boundary = toNumber(normalized[i].start);
      if(Number.isFinite(boundary)){
        boundaries.push(boundary);
      }
    }
    return boundaries.sort((a,b)=> a - b);
  }

  function scoreDiarizationMAE(predRTTM, goldRTTM, options){
    const penalty = options && Number.isFinite(options.penalty) ? options.penalty : DEFAULT_BOUNDARY_PENALTY;
    const predBoundaries = boundariesFromSegments(predRTTM);
    const goldBoundaries = boundariesFromSegments(goldRTTM);
    if(!goldBoundaries.length && !predBoundaries.length){
      return { mae: 0, matches: [], predBoundaries, goldBoundaries };
    }
    if(!goldBoundaries.length){
      const mae = predBoundaries.length ? penalty : 0;
      return { mae, matches: [], predBoundaries, goldBoundaries };
    }
    const usedPred = new Set();
    const deltas = [];
    goldBoundaries.forEach((gold)=>{
      let bestIdx = -1;
      let bestDiff = Infinity;
      predBoundaries.forEach((pred, idx)=>{
        if(usedPred.has(idx)) return;
        const diff = Math.abs(pred - gold);
        if(diff < bestDiff){
          bestDiff = diff;
          bestIdx = idx;
        }
      });
      if(bestIdx >= 0){
        usedPred.add(bestIdx);
        deltas.push(bestDiff);
      } else {
        deltas.push(penalty);
      }
    });
    predBoundaries.forEach((pred, idx)=>{
      if(usedPred.has(idx)) return;
      deltas.push(penalty);
    });
    const mae = deltas.length ? (deltas.reduce((sum, d)=> sum + Math.abs(d), 0) / deltas.length) : 0;
    return { mae, matches: deltas, predBoundaries, goldBoundaries };
  }

  function parseTimestamp(ts){
    if(typeof ts !== 'string') return NaN;
    const value = ts.trim();
    if(!value) return NaN;
    const cleaned = value.replace(',', '.');
    const parts = cleaned.split(':');
    if(parts.length === 1){
      return parseFloat(parts[0]) || 0;
    }
    let seconds = 0;
    let multiplier = 1;
    for(let i = parts.length - 1; i >= 0; i -= 1){
      const num = parseFloat(parts[i]);
      if(!Number.isFinite(num)) return NaN;
      seconds += num * multiplier;
      multiplier *= 60;
    }
    return seconds;
  }

  function parseVttCues(input){
    if(!input) return [];
    if(Array.isArray(input)){
      return input
        .map((cue)=>{
          if(!cue) return null;
          const start = toNumber(cue.start != null ? cue.start : cue.startTime || cue.start_seconds);
          const end = toNumber(cue.end != null ? cue.end : cue.endTime || cue.end_seconds);
          const text = cue.text != null ? String(cue.text) : '';
          if(!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
          return { start, end, text };
        })
        .filter(Boolean);
    }
    const text = String(input || '');
    if(!text.trim()) return [];
    const cues = [];
    const blocks = text.replace(/\r/g, '').split(/\n\n+/);
    blocks.forEach((block)=>{
      const lines = block.trim().split(/\n+/).filter(Boolean);
      if(!lines.length) return;
      let timeIdx = lines.findIndex((line)=> line.includes('-->'));
      if(timeIdx === -1){
        timeIdx = 0;
      }
      const timeLine = lines[timeIdx];
      const timeParts = timeLine.split('-->');
      if(timeParts.length < 2) return;
      const start = parseTimestamp(timeParts[0]);
      const end = parseTimestamp(timeParts[1]);
      if(!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const textLines = lines.slice(timeIdx + 1);
      const cueText = textLines.join('\n');
      cues.push({ start, end, text: cueText });
    });
    return cues;
  }

  function computeDurations(cues){
    if(!Array.isArray(cues) || !cues.length) return [];
    return cues.map((cue)=> Math.max(0, toNumber(cue.end) - toNumber(cue.start))).filter((dur)=> Number.isFinite(dur) && dur > 0);
  }

  function average(values){
    const list = values.filter((v)=> Number.isFinite(v));
    if(!list.length) return 0;
    const sum = list.reduce((acc, v)=> acc + v, 0);
    return sum / list.length;
  }

  function stddev(values){
    const list = values.filter((v)=> Number.isFinite(v));
    if(list.length <= 1) return 0;
    const mean = average(list);
    const variance = list.reduce((acc, v)=> acc + Math.pow(v - mean, 2), 0) / list.length;
    return Math.sqrt(variance);
  }

  function countCharacters(cues){
    if(!Array.isArray(cues)) return 0;
    return cues.reduce((acc, cue)=>{
      const text = cue && cue.text ? String(cue.text) : '';
      return acc + text.replace(/\s+/g, '').length;
    }, 0);
  }

  function countTokens(cues){
    if(!Array.isArray(cues)) return 0;
    return cues.reduce((acc, cue)=>{
      const text = cue && cue.text ? String(cue.text).trim() : '';
      if(!text) return acc;
      return acc + text.split(/\s+/).length;
    }, 0);
  }

  function scoreCueStats(transcriptVTT, translationVTT){
    const transcriptCues = parseVttCues(transcriptVTT);
    const translationCues = parseVttCues(translationVTT);
    const durations = computeDurations(transcriptCues);
    const avgLength = average(durations);
    const std = stddev(durations);
    const diff = avgLength - TARGET_CUE_MEAN_SEC;
    const withinRange = avgLength >= TARGET_CUE_RANGE[0] && avgLength <= TARGET_CUE_RANGE[1];
    const sourceChars = countCharacters(transcriptCues);
    const translatedChars = countCharacters(translationCues);
    const completeness = sourceChars > 0 ? translatedChars / sourceChars : (translatedChars > 0 ? 1 : 0);
    return {
      avgCueLengthSec: avgLength,
      stdCueLengthSec: std,
      targetDiffSec: diff,
      withinTargetRange: withinRange,
      sourceCharCount: sourceChars,
      translationCharCount: translatedChars,
      translationCompleteness: completeness
    };
  }

  function scoreTranslationStats(translationVTT, referenceVTT){
    const translationCues = parseVttCues(translationVTT);
    const referenceCues = parseVttCues(referenceVTT);
    const translationTokens = countTokens(translationCues);
    const referenceTokens = countTokens(referenceCues);
    const completeness = referenceTokens > 0 ? translationTokens / referenceTokens : (translationTokens > 0 ? 1 : 0);
    const correctness = referenceTokens > 0 ? 1 - Math.min(1, Math.abs(translationTokens - referenceTokens) / Math.max(referenceTokens, 1)) : 1;
    return {
      completeness,
      correctness,
      translationTokens,
      referenceTokens,
      cueCount: translationCues.length
    };
  }

  function normalizeThresholds(options){
    const defaults = {
      codeswitchF1: 0.75,
      codeswitchToleranceMs: DEFAULT_TOLERANCE_MS,
      diarizationMAE: 0.5,
      diarizationPenaltySec: DEFAULT_BOUNDARY_PENALTY,
      cueTargetDiff: 0.75,
      translationCompleteness: 0.85,
      translationCorrectness: 0.75
    };
    return Object.assign({}, defaults, options || {});
  }

  function computeScoreFromDiff(diff, tolerance){
    if(!Number.isFinite(diff)) return 0;
    const limit = Math.max(tolerance || 1, 0.001);
    const normalized = Math.max(0, 1 - Math.min(1, Math.abs(diff) / limit));
    return normalized;
  }

  function computeQAResult(pred, gold, options){
    const thresholds = normalizeThresholds(options && options.thresholds);
    const predicted = pred || {};
    const goldData = gold || {};

    const predSpans = predicted.codeSwitchSpans || predicted.code_switch_spans || predicted.spans || [];
    const goldSpans = goldData.codeSwitchSpans || goldData.code_switch_spans || goldData.spans || [];
    const codeswitch = scoreCodeSwitchF1(predSpans, goldSpans, thresholds.codeswitchToleranceMs);

    const predDiar = predicted.diarization || predicted.diarization_rttm || predicted.diarSegments || predicted.rttm || [];
    const goldDiar = goldData.diarization || goldData.diarization_rttm || goldData.rttm || [];
    const diarization = scoreDiarizationMAE(predDiar, goldDiar, { penalty: thresholds.diarizationPenaltySec });

    const transcriptVTT = predicted.transcript || predicted.transcript_vtt || predicted.transcriptVTT || '';
    const translationVTT = predicted.translation || predicted.translation_vtt || predicted.translationVTT || '';
    const goldTranscript = goldData.transcript || goldData.transcript_vtt || goldData.transcriptVTT || goldData.source_transcript_vtt || '';
    const goldTranslation = goldData.translation || goldData.translation_vtt || goldData.translationVTT || '';

    const cueStats = scoreCueStats(transcriptVTT, translationVTT);
    const translationStats = scoreTranslationStats(translationVTT, goldTranslation || goldTranscript);

    const accuracyScore = clamp01(codeswitch.f1);
    const diarScore = 1 - Math.min(1, (diarization.mae || 0) / Math.max(thresholds.diarizationMAE, 0.0001));
    const cueScore = computeScoreFromDiff(cueStats.targetDiffSec, thresholds.cueTargetDiff);
    const translationScore = clamp01((translationStats.completeness + translationStats.correctness) / 2);
    const consistencyScore = average([diarScore, cueScore, translationScore].filter((v)=> Number.isFinite(v)));
    const overallScore = average([accuracyScore, diarScore, cueScore, translationScore].filter((v)=> Number.isFinite(v)));

    const checks = [];
    if(normalizeSpans(goldSpans).length){
      checks.push(codeswitch.f1 >= thresholds.codeswitchF1);
    }
    if(boundariesFromSegments(goldDiar).length){
      checks.push((diarization.mae || 0) <= thresholds.diarizationMAE);
    }
    if(parseVttCues(transcriptVTT).length){
      checks.push(Math.abs(cueStats.targetDiffSec || 0) <= thresholds.cueTargetDiff);
    }
    if(parseVttCues(goldTranslation || '').length || parseVttCues(goldTranscript || '').length){
      checks.push((translationStats.completeness || 0) >= thresholds.translationCompleteness);
      checks.push((translationStats.correctness || 0) >= thresholds.translationCorrectness);
    }

    const pass = checks.length ? checks.every(Boolean) : true;

    return {
      pass,
      thresholds,
      accuracyScore,
      consistencyScore,
      cueScore,
      translationScore,
      overallScore,
      codeswitch,
      diarization,
      cues: cueStats,
      translation: translationStats
    };
  }

  function loadHistory(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return { entries: [] };
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.entries)){
        return parsed;
      }
      return { entries: [] };
    }catch(err){
      console.warn('QAMetrics: failed to load history', err);
      return { entries: [] };
    }
  }

  function saveHistory(history){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }catch(err){
      console.warn('QAMetrics: failed to save history', err);
    }
  }

  function recordResult(clipId, payload){
    if(!clipId) return null;
    const history = loadHistory();
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const filtered = entries.filter((entry)=> entry.clipId !== clipId);
    const now = Date.now();
    const data = Object.assign({ clipId, ts: now }, payload || {});
    filtered.push(data);
    filtered.sort((a,b)=> (a.ts || 0) - (b.ts || 0));
    const trimmed = filtered.slice(-100);
    const updated = { entries: trimmed };
    saveHistory(updated);
    return updated;
  }

  function findInManifest(manifest, clipId){
    if(!manifest || !Array.isArray(manifest.items)) return null;
    return manifest.items.find((item)=>{
      const id = item.asset_id || item.id || item.clip_id || item.clipId;
      return id === clipId;
    }) || null;
  }

  function aggregateEntries(entries){
    const summary = {
      totalGoldClips: 0,
      reviewedClips: 0,
      passCount: 0,
      averageCodeSwitchF1: 0,
      averageDiarizationMAE: 0,
      averageCueLengthSec: 0,
      averageCueDiffSec: 0,
      translationCompletenessAvg: 0,
      translationCorrectnessAvg: 0,
      overallScore: 0
    };
    if(!entries.length){
      return summary;
    }
    const metrics = entries.map((entry)=> entry.metrics || entry.result || {});
    const qaPayloads = entries.map((entry)=> entry.qa || {});
    const codeswitchValues = metrics.map((m)=> m.codeswitch && Number.isFinite(m.codeswitch.f1) ? m.codeswitch.f1 : null).filter((v)=> v != null);
    const diarValues = metrics.map((m)=> m.diarization && Number.isFinite(m.diarization.mae) ? m.diarization.mae : null).filter((v)=> v != null);
    const cueValues = metrics.map((m)=> m.cues && Number.isFinite(m.cues.avgCueLengthSec) ? m.cues.avgCueLengthSec : null).filter((v)=> v != null);
    const cueDiffValues = metrics.map((m)=> m.cues && Number.isFinite(m.cues.targetDiffSec) ? m.cues.targetDiffSec : null).filter((v)=> v != null);
    const translationCompletenessValues = metrics.map((m)=> m.translation && Number.isFinite(m.translation.completeness) ? m.translation.completeness : null).filter((v)=> v != null);
    const translationCorrectnessValues = metrics.map((m)=> m.translation && Number.isFinite(m.translation.correctness) ? m.translation.correctness : null).filter((v)=> v != null);
    const translationCharRatioValues = entries.map((entry)=>{
      const qa = entry.qa || {};
      if(Number.isFinite(qa.translation_char_ratio)) return qa.translation_char_ratio;
      const cues = (entry.metrics && entry.metrics.cues) ? entry.metrics.cues : null;
      return cues && Number.isFinite(cues.translationCompleteness) ? cues.translationCompleteness : null;
    }).filter((v)=> v != null);
    const overallValues = metrics.map((m)=> Number.isFinite(m.overallScore) ? m.overallScore : (Number.isFinite(m.translationScore) ? m.translationScore : null)).filter((v)=> v != null);

    summary.totalGoldClips = entries.filter((entry)=> !!(entry.qa && entry.qa.gold_target)).length;
    summary.reviewedClips = entries.length;
    summary.passCount = entries.filter((entry)=> entry.qa && entry.qa.gold_check === 'pass').length;
    summary.averageCodeSwitchF1 = codeswitchValues.length ? average(codeswitchValues) : 0;
    summary.averageDiarizationMAE = diarValues.length ? average(diarValues) : 0;
    summary.averageCueLengthSec = cueValues.length ? average(cueValues) : 0;
    summary.averageCueDiffSec = cueDiffValues.length ? average(cueDiffValues) : 0;
    summary.translationCompletenessAvg = translationCompletenessValues.length ? average(translationCompletenessValues) : 0;
    summary.translationCorrectnessAvg = translationCorrectnessValues.length ? average(translationCorrectnessValues) : 0;
    summary.translationCharRatioAvg = translationCharRatioValues.length ? average(translationCharRatioValues) : 0;
    summary.overallScore = overallValues.length ? average(overallValues) : 0;
    summary.passRate = summary.reviewedClips ? summary.passCount / summary.reviewedClips : 0;

    const timeSpentValues = qaPayloads.map((qa)=> Number.isFinite(qa.time_spent_sec) ? qa.time_spent_sec : null).filter((v)=> v != null);
    summary.averageTimeSpentSec = timeSpentValues.length ? average(timeSpentValues) : 0;
    return summary;
  }

  function aggregateByAnnotator(entries){
    const perAnnotator = new Map();
    entries.forEach((entry)=>{
      const qaPayload = entry.qa || {};
      const annotator = qaPayload.annotator_id || qaPayload.annotator || 'anonymous';
      if(!perAnnotator.has(annotator)){
        perAnnotator.set(annotator, []);
      }
      perAnnotator.get(annotator).push(entry);
    });
    return Array.from(perAnnotator.entries()).map(([annotator, list])=>{
      const summary = aggregateEntries(list);
      return Object.assign({ annotator_id: annotator }, summary, { clips: list.length });
    });
  }

  function generateReport(options){
    const opts = options || {};
    const history = loadHistory();
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const manifest = opts.manifest || null;

    const summary = aggregateEntries(entries);
    const perAnnotator = aggregateByAnnotator(entries);

    const clips = entries.map((entry)=>{
      const qaPayload = entry.qa || {};
      const clipId = entry.clipId;
      const manifestInfo = findInManifest(manifest, clipId) || entry.clip || entry.item || {};
      const title = manifestInfo.title || manifestInfo.clip_title || manifestInfo.display || clipId || 'Unknown clip';
      const language = manifestInfo.language || manifestInfo.locale || qaPayload.language || 'unknown';
      const metrics = entry.metrics || entry.result || {};
      return {
        clipId,
        title,
        language,
        qaStatus: qaPayload.gold_check || (metrics.pass ? 'pass' : 'fail'),
        goldTarget: !!qaPayload.gold_target,
        timeSpentSec: qaPayload.time_spent_sec || null,
        metrics: {
          codeswitch_f1: qaPayload.codeswitch_f1 != null ? qaPayload.codeswitch_f1 : (metrics.codeswitch ? metrics.codeswitch.f1 : null),
          diarization_mae: qaPayload.diarization_mae != null ? qaPayload.diarization_mae : (metrics.diarization ? metrics.diarization.mae : null),
          cue_avg_length_sec: metrics.cues ? metrics.cues.avgCueLengthSec : null,
          cue_diff_sec: metrics.cues ? metrics.cues.targetDiffSec : null,
          translation_completeness: qaPayload.translation_completeness != null ? qaPayload.translation_completeness : (metrics.translation ? metrics.translation.completeness : null),
          translation_char_ratio: qaPayload.translation_char_ratio != null ? qaPayload.translation_char_ratio : (metrics.cues ? metrics.cues.translationCompleteness : null),
          translation_correctness: metrics.translation ? metrics.translation.correctness : null
        },
        scores: {
          accuracy: metrics.accuracyScore,
          consistency: metrics.consistencyScore,
          cue: metrics.cueScore,
          translation: metrics.translationScore,
          overall: metrics.overallScore
        }
      };
    });

    const report = {
      generatedAt: new Date().toISOString(),
      annotator: opts.annotator || (perAnnotator[0] && perAnnotator[0].annotator_id) || 'anonymous',
      summary,
      perAnnotator,
      clips
    };

    try{
      localStorage.setItem(REPORT_KEY, JSON.stringify(report));
    }catch(err){
      console.warn('QAMetrics: unable to persist report', err);
    }

    return report;
  }

  global.QAMetrics = {
    scoreCodeSwitchF1,
    scoreDiarizationMAE,
    scoreCueStats,
    scoreTranslationStats,
    computeQAResult,
    recordResult,
    generateReport,
    _internal: {
      parseVttCues,
      parseRttm,
      loadHistory,
      saveHistory
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
