(function (global) {
  "use strict";

  const STORAGE_KEY = "stage2_irr_records";
  const SUMMARY_STORAGE_KEY = "stage2_irr_summary";
  const DEFAULT_MAX_DIAR_SEC = 5;
  const DEFAULT_MAX_CUE_DELTA = 4;

  const hasLocalStorage = (function () {
    try {
      return typeof localStorage !== "undefined";
    } catch (err) {
      return false;
    }
  })();

  let cache = null;

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  function loadRecordsFromStorage() {
    if (!hasLocalStorage) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("IRR: failed to load records", err);
      return null;
    }
  }

  function persistRecords(records) {
    cache = records;
    if (hasLocalStorage) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      } catch (err) {
        console.warn("IRR: failed to persist records", err);
      }
    }
    return records;
  }

  function ensureRecords() {
    if (cache) {
      return cache;
    }
    const stored = loadRecordsFromStorage();
    cache = normalizeRecords(stored);
    return cache;
  }

  function normalizeRecords(records) {
    if (!records) {
      return { clips: {} };
    }
    if (Array.isArray(records)) {
      const clips = {};
      records.forEach((entry) => {
        if (!entry || !entry.clipId) return;
        const annotations = {};
        const items = Array.isArray(entry.annotations)
          ? entry.annotations
          : Object.entries(entry.annotations || {}).map(([annotatorId, metrics]) => ({
              annotatorId,
              metrics,
            }));
        items.forEach((item) => {
          if (!item || !item.annotatorId) return;
          annotations[item.annotatorId] = clone(item.metrics) || {};
        });
        clips[entry.clipId] = { clipId: entry.clipId, annotations };
      });
      return { clips };
    }
    if (records.clips) {
      return {
        clips: Object.keys(records.clips).reduce((acc, clipId) => {
          const clip = records.clips[clipId];
          if (!clip) return acc;
          const annotations = Array.isArray(clip.annotations)
            ? clip.annotations.reduce((map, ann) => {
                if (!ann || !ann.annotatorId) return map;
                map[ann.annotatorId] = clone(ann.metrics) || {};
                return map;
              }, {})
            : Object.keys(clip.annotations || {}).reduce((map, annotatorId) => {
                map[annotatorId] = clone(clip.annotations[annotatorId]) || {};
                return map;
              }, {});
          acc[clipId] = { clipId, annotations };
          return acc;
        }, {}),
      };
    }
    return { clips: {} };
  }

  function recordAnnotation(annotatorId, clipId, metrics) {
    if (!annotatorId || !clipId || !metrics || typeof metrics !== "object") {
      return;
    }
    const records = ensureRecords();
    const clip = records.clips[clipId] || { clipId, annotations: {} };
    clip.annotations[annotatorId] = Object.assign({}, metrics, {
      recordedAt: Date.now(),
    });
    records.clips[clipId] = clip;
    persistRecords(records);
  }

  function average(values) {
    const finite = values.filter((v) => Number.isFinite(v));
    if (!finite.length) return null;
    const sum = finite.reduce((acc, v) => acc + v, 0);
    return sum / finite.length;
  }

  function buildPairs(list) {
    const pairs = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        pairs.push([list[i], list[j]]);
      }
    }
    return pairs;
  }

  function computeAlpha(records, options) {
    const opts = options || {};
    const maxDiar = Number.isFinite(opts.maxDiarizationSeconds)
      ? opts.maxDiarizationSeconds
      : DEFAULT_MAX_DIAR_SEC;
    const maxCueDelta = Number.isFinite(opts.maxCueDeltaSec)
      ? opts.maxCueDeltaSec
      : DEFAULT_MAX_CUE_DELTA;

    const annotations = Array.isArray(records)
      ? records.filter((entry) => entry && entry.metrics)
      : Object.keys(records || {}).map((key) => {
          const entry = records[key];
          if (!entry) return null;
          return { annotatorId: key, metrics: entry };
        });

    const cleaned = annotations.filter((entry) => entry && entry.metrics);
    if (cleaned.length < 2) {
      return {
        codeSwitchAlpha: null,
        diarizationAlpha: null,
        cueAlpha: null,
        translationAlpha: null,
        overallAlpha: null,
      };
    }

    const pairs = buildPairs(cleaned);

    const codeSwitchScores = [];
    const diarizationScores = [];
    const cueScores = [];
    const translationScores = [];

    pairs.forEach(([a, b]) => {
      const ma = a.metrics || {};
      const mb = b.metrics || {};

      const f1a = Number(ma.codeSwitchF1);
      const f1b = Number(mb.codeSwitchF1);
      if (Number.isFinite(f1a) && Number.isFinite(f1b)) {
        codeSwitchScores.push(clamp01((f1a + f1b) / 2));
      }

      const maeA = Number(ma.diarizationMae);
      const maeB = Number(mb.diarizationMae);
      if (Number.isFinite(maeA) && Number.isFinite(maeB)) {
        const invA = clamp01(1 - Math.min(Math.abs(maeA), maxDiar) / maxDiar);
        const invB = clamp01(1 - Math.min(Math.abs(maeB), maxDiar) / maxDiar);
        diarizationScores.push((invA + invB) / 2);
      }

      const cueA = Number(ma.cueDeltaSec);
      const cueB = Number(mb.cueDeltaSec);
      if (Number.isFinite(cueA) && Number.isFinite(cueB)) {
        const scoreA = clamp01(1 - Math.min(Math.abs(cueA), maxCueDelta) / maxCueDelta);
        const scoreB = clamp01(1 - Math.min(Math.abs(cueB), maxCueDelta) / maxCueDelta);
        cueScores.push((scoreA + scoreB) / 2);
      }

      const transA = Number(ma.translationCompleteness);
      const transB = Number(mb.translationCompleteness);
      if (Number.isFinite(transA) && Number.isFinite(transB)) {
        const diff = Math.abs(transA - transB);
        translationScores.push(clamp01(1 - diff));
      }
    });

    const codeSwitchAlpha = average(codeSwitchScores);
    const diarizationAlpha = average(diarizationScores);
    const cueAlpha = average(cueScores);
    const translationAlpha = average(translationScores);

    const components = [codeSwitchAlpha, diarizationAlpha, cueAlpha, translationAlpha].filter(
      (value) => Number.isFinite(value)
    );
    const overallAlpha = components.length ? average(components) : null;

    return {
      codeSwitchAlpha: codeSwitchAlpha != null ? clamp01(codeSwitchAlpha) : null,
      diarizationAlpha: diarizationAlpha != null ? clamp01(diarizationAlpha) : null,
      cueAlpha: cueAlpha != null ? clamp01(cueAlpha) : null,
      translationAlpha: translationAlpha != null ? clamp01(translationAlpha) : null,
      overallAlpha: overallAlpha != null ? clamp01(overallAlpha) : null,
    };
  }

  function computeIRRSummary(records) {
    const data = normalizeRecords(records != null ? records : ensureRecords());
    const clips = data.clips || {};
    const entries = Object.keys(clips).map((clipId) => clips[clipId]).filter(Boolean);

    let clipCount = 0;
    const codeSwitchValues = [];
    const diarizationValues = [];
    const cueValues = [];
    const translationValues = [];

    entries.forEach((clip) => {
      const annotations = clip && clip.annotations ? clip.annotations : {};
      const annList = Object.keys(annotations).map((annotatorId) => ({
        annotatorId,
        metrics: annotations[annotatorId],
      }));
      if (annList.length < 2) return;
      clipCount += 1;
      const alpha = computeAlpha(annList);
      if (alpha.codeSwitchAlpha != null) codeSwitchValues.push(alpha.codeSwitchAlpha);
      if (alpha.diarizationAlpha != null) diarizationValues.push(alpha.diarizationAlpha);
      if (alpha.cueAlpha != null) cueValues.push(alpha.cueAlpha);
      if (alpha.translationAlpha != null) translationValues.push(alpha.translationAlpha);
    });

    const codeSwitchAlpha = codeSwitchValues.length ? average(codeSwitchValues) : null;
    const diarizationAlpha = diarizationValues.length ? average(diarizationValues) : null;
    const cueAlpha = cueValues.length ? average(cueValues) : null;
    const translationAlpha = translationValues.length ? average(translationValues) : null;

    const components = [codeSwitchAlpha, diarizationAlpha, cueAlpha, translationAlpha].filter((value) =>
      Number.isFinite(value)
    );
    const overallAlpha = components.length ? average(components) : null;

    return {
      generatedAt: new Date().toISOString(),
      clipsEvaluated: clipCount,
      codeSwitchAlpha: codeSwitchAlpha != null ? clamp01(codeSwitchAlpha) : null,
      diarizationAlpha: diarizationAlpha != null ? clamp01(diarizationAlpha) : null,
      cueAlpha: cueAlpha != null ? clamp01(cueAlpha) : null,
      translationAlpha: translationAlpha != null ? clamp01(translationAlpha) : null,
      overallAlpha: overallAlpha != null ? clamp01(overallAlpha) : null,
    };
  }

  function saveIRRSummary(options) {
    const opts = options || {};
    const summary = computeIRRSummary(opts.records);
    if (hasLocalStorage) {
      try {
        localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(summary));
      } catch (err) {
        console.warn("IRR: failed to persist summary", err);
      }
    }
    if (opts.path) {
      try {
        const fs = require("fs");
        const path = require("path");
        const targetPath = path.resolve(opts.path);
        fs.writeFileSync(targetPath, JSON.stringify(summary, null, 2));
      } catch (err) {
        console.warn("IRR: unable to write summary to disk", err);
      }
    }
    return summary;
  }

  const api = {
    recordAnnotation,
    computeAlpha,
    computeIRRSummary,
    saveIRRSummary,
    _internal: {
      normalizeRecords,
      ensureRecords,
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.IRR = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
