(function (global) {
  "use strict";

  // --- Storage keys & in-memory fallback ------------------------------------
  const RECORDS_KEY = "ea_stage2_irr_records";
  const SUMMARY_KEY = "ea_stage2_irr_summary";
  const memoryStore = { records: null, summary: null }; // records stored normalized

  // --- Environment guards ----------------------------------------------------
  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined" && localStorage !== null;
    } catch {
      return false;
    }
  }

  // --- Utils -----------------------------------------------------------------
  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  const ALLOCATOR_ALPHA = 2.0;
  const ALLOCATOR_HISTORY_KEY = "ea_stage2_allocator_history_v1";
  const ALLOCATOR_HISTORY_MAX = 100;
  let latestCoverageSnapshot = null;
  let latestCoverageAlerts = [];
  let coverageAlertsGeneratedAt = null;
  let activeCoverageHighlightKey = null;

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  function average(values) {
    const finite = (values || []).filter((v) => Number.isFinite(v));
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

  function toFinite(value) {
    if (value == null) return null;
    const num = typeof value === "string" ? parseFloat(value) : Number(value);
    return Number.isFinite(num) ? num : null;
  }

  // Normalize arbitrary metric shapes to a canonical metric object
  // Canonical keys: codeSwitchF1 [0..1], diarizationMae (sec), cueDeltaSec (sec), translationCompleteness [0..1]
  function sanitizeMetrics(metrics) {
    const src = metrics && typeof metrics === "object" ? metrics : {};
    const codeSwitchF1 =
      toFinite(src.codeSwitchF1 ?? src.codeswitch_f1 ?? src.code_switch_f1);
    const diarizationMae =
      toFinite(src.diarizationMae ?? src.diarization_mae ?? src.diarMae);
    const cueDeltaSec = toFinite(
      src.cueDeltaSec ?? src.cueDelta ?? src.cue_delta ?? src.cue_diff_sec ?? src.cueDeltaSec
    );
    const translationCompleteness = toFinite(
      src.translationCompleteness ??
        src.translation_completeness ??
        src.translationCompletenessRatio
    );
    return {
      ...(Number.isFinite(codeSwitchF1) ? { codeSwitchF1 } : {}),
      ...(Number.isFinite(diarizationMae) ? { diarizationMae } : {}),
      ...(Number.isFinite(cueDeltaSec) ? { cueDeltaSec } : {}),
      ...(Number.isFinite(translationCompleteness)
        ? { translationCompleteness }
        : {}),
    };
  }

  // --- Records model (normalized) -------------------------------------------
  // We store records as:
  // { clips: { [clipId]: { clipId, annotations: { [annotatorId]: { ...metrics, recordedAt } } } } }
  let cache = null;

  function normalizeRecords(records) {
    if (!records) {
      return { clips: {} };
    }
    // Legacy array form: [{clipId, annotatorId, metrics}, ...] or entries with .annotations map/array
    if (Array.isArray(records)) {
      const clips = {};
      records.forEach((entry) => {
        if (!entry || !entry.clipId) return;
        const clipId = entry.clipId;
        if (!clips[clipId]) clips[clipId] = { clipId, annotations: {} };

        if (entry.annotatorId) {
          clips[clipId].annotations[entry.annotatorId] =
            sanitizeMetrics(entry.metrics) || {};
        } else {
          // If it's an entry with a nested annotations list/map
          const items = Array.isArray(entry.annotations)
            ? entry.annotations
            : Object.entries(entry.annotations || {}).map(
                ([annotatorId, metrics]) => ({
                  annotatorId,
                  metrics,
                })
              );
          items.forEach((item) => {
            if (!item || !item.annotatorId) return;
            clips[clipId].annotations[item.annotatorId] =
              sanitizeMetrics(item.metrics) || {};
          });
        }
      });
      return { clips };
    }
    // Already structured
    if (records.clips && typeof records.clips === "object") {
      const clips = {};
      Object.keys(records.clips).forEach((clipId) => {
        const clip = records.clips[clipId];
        if (!clip) return;
        const annotations = Array.isArray(clip.annotations)
          ? clip.annotations.reduce((map, ann) => {
              if (!ann || !ann.annotatorId) return map;
              map[ann.annotatorId] = sanitizeMetrics(ann.metrics) || {};
              return map;
            }, {})
          : Object.keys(clip.annotations || {}).reduce((map, annotatorId) => {
              map[annotatorId] = sanitizeMetrics(
                clip.annotations[annotatorId]
              ) || {};
              return map;
            }, {});
        clips[clipId] = { clipId, annotations };
      });
      return { clips };
    }
    return { clips: {} };
  }

  function loadRecordsFromStorage() {
    if (!hasLocalStorage()) return null;
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("IRR: failed to load records from storage", err);
      return null;
    }
  }

  function ensureRecords() {
    if (cache) return cache;
    const stored = loadRecordsFromStorage();
    cache = normalizeRecords(stored || memoryStore.records);
    if (!cache || !cache.clips) cache = { clips: {} };
    return cache;
  }

  function persistRecords(records) {
    cache = normalizeRecords(records);
    memoryStore.records = clone(cache);
    if (hasLocalStorage()) {
      try {
        localStorage.setItem(RECORDS_KEY, JSON.stringify(cache));
      } catch (err) {
        console.warn("IRR: failed to persist records", err);
      }
    }
    // Also attach to global for debugging/legacy access
    global.__IRR_RECORDS__ = clone(cache);
    return cache;
  }

  // --- Public API: record annotation ----------------------------------------
  function recordAnnotation(annotatorId, clipId, metrics) {
    if (!clipId) return null;
    const id = annotatorId || "anonymous";
    const normalized = sanitizeMetrics(metrics);
    const records = ensureRecords();
    const clip = records.clips[clipId] || { clipId, annotations: {} };
    clip.annotations[id] = Object.assign({}, normalized, {
      recordedAt: Date.now(),
    });
    records.clips[clipId] = clip;
    persistRecords(records);
    const summary = computeIRRSummary(records);
    saveIRRSummary({ summary });
    return { annotatorId: id, clipId, metrics: normalized };
  }

  // --- IRR math --------------------------------------------------------------
  const DEFAULT_MAX_DIAR_SEC = 5; // seconds
  const DEFAULT_MAX_CUE_DELTA = 4; // seconds

  // Pairwise agreement proxy across metrics; returns alphas per metric and overall
  function computeAlpha(annotationsList, options) {
    const opts = options || {};
    const maxDiar = Number.isFinite(opts.maxDiarizationSeconds)
      ? opts.maxDiarizationSeconds
      : DEFAULT_MAX_DIAR_SEC;
    const maxCueDelta = Number.isFinite(opts.maxCueDeltaSec)
      ? opts.maxCueDeltaSec
      : DEFAULT_MAX_CUE_DELTA;

    // Accept either [{annotatorId, metrics}, ...] OR map { annotatorId: metrics }
    const annotations = Array.isArray(annotationsList)
      ? annotationsList.filter((e) => e && e.metrics)
      : Object.keys(annotationsList || {}).map((key) => ({
          annotatorId: key,
          metrics: annotationsList[key],
        }));

    const cleaned = annotations.filter((e) => e && e.metrics);
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

      // Code-switch F1: closer means better; use midpoint then clamp
      const f1a = Number(ma.codeSwitchF1);
      const f1b = Number(mb.codeSwitchF1);
      if (Number.isFinite(f1a) && Number.isFinite(f1b)) {
        codeSwitchScores.push(clamp01((f1a + f1b) / 2));
      }

      // Diarization MAE (sec): lower is better; invert by range
      const maeA = Number(ma.diarizationMae);
      const maeB = Number(mb.diarizationMae);
      if (Number.isFinite(maeA) && Number.isFinite(maeB)) {
        const invA = clamp01(1 - Math.min(Math.abs(maeA), maxDiar) / maxDiar);
        const invB = clamp01(1 - Math.min(Math.abs(maeB), maxDiar) / maxDiar);
        diarizationScores.push((invA + invB) / 2);
      }

      // Cue delta (sec): lower is better; invert by range
      const cueA = Number(
        ma.cueDeltaSec ?? ma.cueDelta ?? ma.cue_delta ?? ma.cue_diff_sec
      );
      const cueB = Number(
        mb.cueDeltaSec ?? mb.cueDelta ?? mb.cue_delta ?? mb.cue_diff_sec
      );
      if (Number.isFinite(cueA) && Number.isFinite(cueB)) {
        const scoreA = clamp01(1 - Math.min(Math.abs(cueA), maxCueDelta) / maxCueDelta);
        const scoreB = clamp01(1 - Math.min(Math.abs(cueB), maxCueDelta) / maxCueDelta);
        cueScores.push((scoreA + scoreB) / 2);
      }

      // Translation completeness [0..1]: closer is better; 1 - abs diff
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
      (v) => Number.isFinite(v)
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

  function computeIRRSummary(recordsInput) {
    const data = normalizeRecords(recordsInput != null ? recordsInput : ensureRecords());
    const clips = data.clips || {};
    const entries = Object.keys(clips)
      .map((clipId) => clips[clipId])
      .filter(Boolean);

    let clipCount = 0;
    const codeSwitchValues = [];
    const diarizationValues = [];
    const cueValues = [];
    const translationValues = [];

    entries.forEach((clip) => {
      const annotations = (clip && clip.annotations) || {};
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

    const codeSwitchAlpha =
      codeSwitchValues.length ? average(codeSwitchValues) : null;
    const diarizationAlpha =
      diarizationValues.length ? average(diarizationValues) : null;
    const cueAlpha = cueValues.length ? average(cueValues) : null;
    const translationAlpha =
      translationValues.length ? average(translationValues) : null;

    const components = [codeSwitchAlpha, diarizationAlpha, cueAlpha, translationAlpha].filter(
      (v) => Number.isFinite(v)
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
    const summary =
      opts.summary || computeIRRSummary(opts.records != null ? opts.records : undefined);

    // Persist to localStorage
    if (hasLocalStorage()) {
      try {
        localStorage.setItem(SUMMARY_KEY, JSON.stringify(summary));
      } catch (err) {
        console.warn("IRR: failed to persist summary", err);
      }
    }

    // Persist to memory & global
    memoryStore.summary = clone(summary);
    global.__IRR_SUMMARY__ = clone(summary);

    // Optional: write to disk if running in Node and path provided
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

  function formatCoverageLabel(value) {
    if (!value || value === 'unknown') return 'Unknown';
    const text = String(value)
      .trim()
      .replace(/[_\s]+/g, ' ')
      .toLowerCase();
    return text.replace(/\b([a-z])/g, (match, letter) => letter.toUpperCase());
  }

  function describeCoverageCell(cell) {
    if (!cell || typeof cell !== 'object') return 'Unknown';
    const parts = [
      formatCoverageLabel(cell.dialect_family),
      formatCoverageLabel(cell.subregion),
      formatCoverageLabel(cell.apparent_gender),
      formatCoverageLabel(cell.apparent_age_band),
    ];
    return parts.join(' • ');
  }

  function getCoverageStatus(pct) {
    if (!Number.isFinite(pct)) return 'low';
    if (pct >= 1) return 'met';
    if (pct >= 0.6) return 'partial';
    return 'low';
  }

  function formatCoveragePercent(pct) {
    if (!Number.isFinite(pct)) return null;
    const percent = Math.max(0, pct) * 100;
    const decimals = percent >= 100 ? 0 : percent >= 10 ? 1 : 2;
    return `${percent.toFixed(decimals)}%`;
  }

  function formatCoverageShortfall(deficit) {
    const value = Number(deficit);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.max(1, Math.ceil(value));
  }

  function formatAlertTimestamp(value) {
    if (!value) return 'Unknown time';
    try {
      const ts = new Date(value);
      if (Number.isNaN(ts.getTime())) return String(value);
      return ts.toLocaleString();
    } catch {
      return String(value);
    }
  }

  function getCoverageAlertsList() {
    return Array.isArray(latestCoverageAlerts) ? latestCoverageAlerts : [];
  }

  function hasRecentCoverageAlerts(thresholdHours = 24) {
    const alerts = getCoverageAlertsList();
    if (!alerts.length) return false;
    const now = Date.now();
    const limitMs = thresholdHours * 3_600_000;
    return alerts.some((alert) => {
      if (!alert || !alert.timestamp) return false;
      const time = Date.parse(alert.timestamp);
      if (!Number.isFinite(time)) return false;
      return now - time <= limitMs;
    });
  }

  function normalizeAllocatorCategory(value) {
    if (value == null) return "unknown";
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    const text = String(value).trim().toLowerCase();
    return text || "unknown";
  }

  function buildAllocatorCellKey(cell) {
    if (!cell || typeof cell !== "object") return "unknown:unknown:unknown:unknown";
    const family = normalizeAllocatorCategory(
      cell.dialect_family ?? cell.dialectFamily ?? cell.dialect_family_code ?? cell.dialect
    );
    const subregion = normalizeAllocatorCategory(
      cell.subregion ?? cell.dialect_subregion ?? cell.dialectSubregion ?? cell.dialect_region ?? cell.region
    );
    const gender = normalizeAllocatorCategory(
      cell.apparent_gender ?? cell.apparentGender ?? cell.gender ?? cell.gender_norm ?? cell.speaker_gender
    );
    const age = normalizeAllocatorCategory(
      cell.apparent_age_band ?? cell.apparentAgeBand ?? cell.age_band ?? cell.ageBand ?? cell.age ?? cell.age_group
    );
    return `${family}:${subregion}:${gender}:${age}`;
  }

  function computeAllocatorWeights(snapshot, options) {
    const alphaOption = options && Number.isFinite(options.alpha) ? Number(options.alpha) : ALLOCATOR_ALPHA;
    const alpha = alphaOption > 0 ? alphaOption : ALLOCATOR_ALPHA;
    const cells = Array.isArray(snapshot && snapshot.cells) ? snapshot.cells : [];
    const weightMap = new Map();
    let total = 0;

    cells.forEach((cell) => {
      if (!cell || typeof cell !== "object") return;
      let key = null;
      if (typeof cell.cell_key === "string" && cell.cell_key.trim()) {
        const candidate = cell.cell_key.trim().toLowerCase();
        if (candidate.includes(":")) {
          key = candidate;
        }
      }
      if (!key) {
        key = buildAllocatorCellKey(cell);
      }

      const target = Number(cell.target);
      if (!Number.isFinite(target) || target <= 0) return;
      const count = Number(cell.count);
      const normalizedCount = Number.isFinite(count) && count >= 0 ? count : 0;
      const pct = Math.max(0, Math.min(1, target > 0 ? normalizedCount / target : 0));
      let score = Math.pow(Math.max(0, 1 - pct), alpha);
      if (!Number.isFinite(score) || score <= 0) return;
      if (pct < 0.5) score *= 1.25;
      const deficit = Number(cell.deficit);
      if (Number.isFinite(deficit) && deficit >= 20) score *= 1.15;

      const existing = weightMap.get(key) || 0;
      weightMap.set(key, existing + score);
      total += score;
    });

    if (total <= 0) {
      weightMap.forEach((_, key) => weightMap.set(key, 0));
      return weightMap;
    }

    weightMap.forEach((value, key) => {
      weightMap.set(key, value / total);
    });

    return weightMap;
  }

  function parseAllocatorCellKey(cellKey) {
    if (typeof cellKey !== "string" || !cellKey) {
      return {
        dialect_family: "unknown",
        subregion: "unknown",
        apparent_gender: "unknown",
        apparent_age_band: "unknown",
      };
    }
    const parts = cellKey.split(":");
    return {
      dialect_family: normalizeAllocatorCategory(parts[0]),
      subregion: normalizeAllocatorCategory(parts[1]),
      apparent_gender: normalizeAllocatorCategory(parts[2]),
      apparent_age_band: normalizeAllocatorCategory(parts[3]),
    };
  }

  function describeAllocatorCellKey(cellKey) {
    const parsed = parseAllocatorCellKey(cellKey);
    return describeCoverageCell(parsed);
  }

  function loadAllocatorHistory() {
    if (!hasLocalStorage()) return [];
    try {
      const raw = localStorage.getItem(ALLOCATOR_HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry) => entry && typeof entry === "object" && typeof entry.cell === "string"
      );
    } catch {
      return [];
    }
  }

  function ensureAllocatorWidget(container) {
    if (!container) return null;
    let widget = container.querySelector('.allocator-widget');
    if (!widget) {
      widget = document.createElement('section');
      widget.className = 'allocator-widget';
      widget.innerHTML = `
        <div class="allocator-widget__header">
          <h3>Allocator</h3>
          <div class="allocator-widget__alpha">Alpha <span class="allocator-widget__alpha-value"></span></div>
          <button type="button" class="allocator-widget__recompute">Recompute weights</button>
        </div>
        <p class="allocator-widget__status"></p>
        <div class="allocator-widget__top">
          <h4>Top weighted cells</h4>
          <ol class="allocator-widget__top-list"></ol>
        </div>
        <div class="allocator-widget__history">
          <h4>Recent assignments (last 100)</h4>
          <div class="allocator-widget__histogram"></div>
        </div>
      `;
      container.appendChild(widget);
      const button = widget.querySelector('.allocator-widget__recompute');
      if (button && !button.dataset.bound) {
        button.dataset.bound = 'true';
        button.addEventListener('click', () => {
          renderAllocatorWidget(latestCoverageSnapshot, { loading: true });
          fetchCoverageSnapshot()
            .then((snapshot) => {
              if (snapshot && typeof snapshot === 'object') {
                renderCoverageSnapshot(snapshot);
                renderCoverageCompletenessTile(snapshot);
              } else {
                renderCoverageSnapshot(undefined);
                renderCoverageCompletenessTile(undefined);
              }
            })
            .catch(() => {
              renderAllocatorWidget(latestCoverageSnapshot, { error: true });
            });
        });
      }
    }
    return widget;
  }

  function renderAllocatorWidget(snapshot, options = {}) {
    const container = ensureCoverageContainer();
    if (!container) return;
    const widget = ensureAllocatorWidget(container);
    if (!widget) return;

    const alphaEl = widget.querySelector('.allocator-widget__alpha-value');
    if (alphaEl) {
      alphaEl.textContent = ALLOCATOR_ALPHA.toFixed(2);
    }

    const statusEl = widget.querySelector('.allocator-widget__status');
    const topList = widget.querySelector('.allocator-widget__top-list');
    const histogram = widget.querySelector('.allocator-widget__histogram');
    const recomputeBtn = widget.querySelector('.allocator-widget__recompute');

    const isLoading = snapshot === null || Boolean(options && options.loading);
    const isError = Boolean(options && options.error);
    const baseSnapshot =
      snapshot && typeof snapshot === 'object'
        ? snapshot
        : latestCoverageSnapshot && typeof latestCoverageSnapshot === 'object'
        ? latestCoverageSnapshot
        : null;

    if (recomputeBtn) {
      if (isLoading) {
        recomputeBtn.disabled = true;
        recomputeBtn.textContent = 'Recomputing…';
      } else {
        recomputeBtn.disabled = false;
        recomputeBtn.textContent = 'Recompute weights';
      }
    }

    const weights = baseSnapshot ? computeAllocatorWeights(baseSnapshot) : new Map();
    const weightEntries = Array.from(weights.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const history = loadAllocatorHistory();

    if (topList) {
      topList.innerHTML = '';
      if (weightEntries.length) {
        weightEntries.forEach(([key, weight]) => {
          const item = document.createElement('li');
          const label = document.createElement('span');
          label.textContent = describeAllocatorCellKey(key);
          const valueEl = document.createElement('span');
          valueEl.className = 'allocator-widget__top-weight';
          const percent = Math.max(0, weight) * 100;
          const decimals = percent >= 10 ? 1 : 2;
          valueEl.textContent = `${percent.toFixed(decimals)}%`;
          item.appendChild(label);
          item.appendChild(valueEl);
          topList.appendChild(item);
        });
      } else {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'allocator-widget__empty';
        emptyItem.textContent = baseSnapshot
          ? 'No weighted cells available.'
          : 'Weights unavailable.';
        topList.appendChild(emptyItem);
      }
    }

    if (histogram) {
      histogram.innerHTML = '';
      if (!history.length) {
        const empty = document.createElement('p');
        empty.className = 'allocator-widget__empty';
        empty.textContent = 'No recent assignments recorded.';
        histogram.appendChild(empty);
      } else {
        const counts = new Map();
        history.forEach((entry) => {
          const key = typeof entry.cell === 'string' ? entry.cell.toLowerCase() : 'unknown:unknown:unknown:unknown';
          counts.set(key, (counts.get(key) || 0) + 1);
        });
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const maxCount = sorted.length ? sorted[0][1] : 0;
        sorted.forEach(([key, count]) => {
          const row = document.createElement('div');
          row.className = 'allocator-widget__histogram-row';
          const label = document.createElement('span');
          label.textContent = describeAllocatorCellKey(key);
          const bar = document.createElement('div');
          bar.className = 'allocator-widget__histogram-bar';
          const fill = document.createElement('div');
          fill.className = 'allocator-widget__histogram-fill';
          const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
          fill.style.width = `${Math.max(0, Math.min(100, width))}%`;
          bar.appendChild(fill);
          const countEl = document.createElement('span');
          countEl.className = 'allocator-widget__histogram-count';
          countEl.textContent = String(count);
          row.appendChild(label);
          row.appendChild(bar);
          row.appendChild(countEl);
          histogram.appendChild(row);
        });
      }
    }

    if (statusEl) {
      let message = '';
      if (isLoading && !baseSnapshot) {
        message = 'Loading coverage snapshot…';
      } else if (!baseSnapshot) {
        message = isError ? 'Failed to refresh coverage snapshot.' : 'Coverage snapshot unavailable.';
      } else {
        const parts = [];
        if (isError) {
          parts.push('Failed to refresh coverage snapshot.');
        }
        if (baseSnapshot.generated_at) {
          try {
            parts.push(`Snapshot ${new Date(baseSnapshot.generated_at).toLocaleString()}`);
          } catch {
            parts.push(`Snapshot ${baseSnapshot.generated_at}`);
          }
        }
        parts.push(`${weights.size} weighted cells`);
        parts.push(`${history.length} recent assignments`);
        message = parts.join(' • ');
      }
      statusEl.textContent = message;
    }
  }

  function ensureCoverageContainer() {
    if (typeof document === 'undefined') return null;
    let container = document.getElementById('coverageSummary');
    if (!container) {
      container = document.createElement('section');
      container.id = 'coverageSummary';
      container.className = 'coverage-summary';
      if (document.body) {
        const tiles = document.getElementById(QA_TILE_CONTAINER_ID);
        if (tiles && tiles.parentNode === document.body) {
          document.body.insertBefore(container, tiles.nextSibling);
        } else {
          document.body.insertBefore(container, document.body.firstChild || null);
        }
      }
    }
    return container;
  }

  function injectCoverageStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('coverageSummaryStyles')) return;
    const style = document.createElement('style');
    style.id = 'coverageSummaryStyles';
    style.textContent = `
      .coverage-summary { max-width: 960px; margin: 1.5rem auto; padding: 1.25rem; background: var(--card, #fff); border-radius: 12px; border: 1px solid var(--border, #dcdcdc); box-shadow: 0 4px 24px rgba(0, 0, 0, 0.04); }
      .coverage-summary h2 { margin: 0 0 .75rem 0; font-size: 1.3rem; }
      .coverage-summary__meta { margin: 0 0 .75rem 0; color: var(--muted, #555); font-size: .85rem; }
      .coverage-summary__insight { margin: 0 0 1rem 0; font-size: .9rem; color: var(--muted, #555); }
      .coverage-summary__table { width: 100%; border-collapse: collapse; font-size: .95rem; }
      .coverage-summary__table th, .coverage-summary__table td { padding: .6rem .75rem; border: 1px solid var(--border, #e2e2e2); text-align: left; vertical-align: top; }
      .coverage-summary__table th { background: rgba(0,0,0,0.04); font-weight: 600; }
      .coverage-summary__count { display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; }
      .coverage-summary__count-value { display: inline-block; }
      .coverage-summary__row--met .coverage-summary__count-value { color: #2e7d32; }
      .coverage-summary__row--partial .coverage-summary__count-value { color: #f9a825; }
      .coverage-summary__row--low .coverage-summary__count-value { color: #d32f2f; }
      .coverage-summary__deficit-badge { display: inline-flex; align-items: center; gap: .25rem; padding: 0 .55rem; height: 1.35rem; border-radius: 999px; background: rgba(211, 47, 47, 0.12); color: #b71c1c; font-size: .75rem; font-weight: 600; }
      .coverage-summary__progress { position: relative; background: rgba(0,0,0,0.08); border-radius: 999px; height: 12px; overflow: hidden; }
      .coverage-summary__progress--compact { height: 8px; }
      .coverage-summary__progress-fill { height: 100%; border-radius: inherit; background: var(--accent, #2b7cff); transition: width .3s ease; }
      .coverage-summary__progress-fill--met { background: #2e7d32; }
      .coverage-summary__progress-fill--partial { background: #f9a825; }
      .coverage-summary__progress-fill--low { background: #d32f2f; }
      .coverage-summary__progress-meta { display: block; margin-top: .35rem; font-size: .78rem; color: var(--muted, #666); }
      .coverage-summary__empty { margin: 0; color: var(--muted, #666); }
      .coverage-summary__next-up { margin-top: 1.5rem; padding: 1rem 1.25rem; border-radius: 12px; border: 1px solid rgba(43, 124, 255, 0.18); background: rgba(43, 124, 255, 0.06); }
      .coverage-summary__next-up h3 { margin: 0 0 .65rem 0; font-size: 1rem; }
      .coverage-summary__next-up-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .85rem; }
      .coverage-summary__next-up-item { display: flex; flex-direction: column; gap: .35rem; }
      .coverage-summary__next-up-label { font-weight: 600; font-size: .95rem; }
      .coverage-summary__next-up-info { font-size: .82rem; color: var(--muted, #555); }
      .coverage-summary__next-up-empty { margin: 0; color: var(--muted, #555); }
      .coverage-alerts { margin: 0 0 1.25rem 0; padding: 1rem 1.25rem; border-radius: 12px; border: 1px solid rgba(211, 47, 47, 0.25); background: rgba(211, 47, 47, 0.08); display: flex; flex-direction: column; gap: .75rem; }
      .coverage-alerts__header { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; justify-content: space-between; }
      .coverage-alerts__title { margin: 0; font-size: 1rem; font-weight: 600; color: #b71c1c; display: inline-flex; align-items: center; gap: .5rem; }
      .coverage-alerts__count { display: inline-flex; align-items: center; justify-content: center; padding: 0 .6rem; height: 1.4rem; border-radius: 999px; background: #d32f2f; color: #fff; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
      .coverage-alerts__meta { font-size: .78rem; color: var(--muted, #666); margin-left: auto; }
      .coverage-alerts__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .6rem; }
      .coverage-alerts__item { border: 1px solid rgba(211, 47, 47, 0.25); background: #fff; border-radius: 12px; padding: .75rem .85rem; display: flex; flex-direction: column; align-items: flex-start; gap: .45rem; cursor: pointer; text-align: left; transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; font: inherit; color: inherit; appearance: none; -webkit-appearance: none; }
      .coverage-alerts__item:hover { border-color: #d32f2f; box-shadow: 0 8px 18px rgba(211, 47, 47, 0.18); transform: translateY(-1px); }
      .coverage-alerts__item:focus-visible { outline: 2px solid #d32f2f; outline-offset: 2px; }
      .coverage-alerts__item-cell { font-size: .95rem; font-weight: 600; color: #b71c1c; }
      .coverage-alerts__item-meta { display: flex; flex-wrap: wrap; gap: .5rem .9rem; font-size: .8rem; color: #7f1d1d; }
      .coverage-alerts__empty { margin: 0; font-size: .85rem; color: var(--muted, #555); }
      .coverage-summary__row--highlight { box-shadow: 0 0 0 3px rgba(211, 47, 47, 0.35) inset; }
      .qa-dashboard-tile__badge { display: inline-flex; align-items: center; justify-content: center; padding: 0 .55rem; height: 1.3rem; border-radius: 999px; background: #d32f2f; color: #fff; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
      .allocator-widget { margin-top: 1.5rem; padding: 1rem 1.25rem; border-radius: 12px; border: 1px solid var(--border, #dcdcdc); background: var(--card, #fff); display: flex; flex-direction: column; gap: .75rem; }
      .allocator-widget h3 { margin: 0; font-size: 1.05rem; }
      .allocator-widget h4 { margin: 0 0 .35rem 0; font-size: .9rem; color: var(--muted, #444); }
      .allocator-widget__header { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; justify-content: space-between; }
      .allocator-widget__alpha { font-size: .85rem; color: var(--muted, #555); display: inline-flex; align-items: center; gap: .35rem; }
      .allocator-widget__alpha-value { font-weight: 600; }
      .allocator-widget__recompute { border: 1px solid var(--border, #dcdcdc); background: var(--card, #fff); border-radius: 999px; padding: .4rem .9rem; font-size: .85rem; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
      .allocator-widget__recompute:hover:not(:disabled) { border-color: var(--accent, #2b7cff); color: var(--accent, #2b7cff); }
      .allocator-widget__recompute:disabled { opacity: .6; cursor: default; }
      .allocator-widget__status { margin: 0; font-size: .85rem; color: var(--muted, #555); }
      .allocator-widget__top-list { margin: 0; padding-left: 1.25rem; display: grid; gap: .35rem; font-size: .9rem; }
      .allocator-widget__top-list li { display: flex; justify-content: space-between; gap: .75rem; }
      .allocator-widget__top-weight { font-variant-numeric: tabular-nums; font-weight: 600; }
      .allocator-widget__histogram { display: flex; flex-direction: column; gap: .45rem; }
      .allocator-widget__histogram-row { display: grid; grid-template-columns: minmax(0, 1fr) auto min-content; align-items: center; gap: .6rem; font-size: .85rem; }
      .allocator-widget__histogram-bar { position: relative; height: 10px; border-radius: 999px; background: rgba(0,0,0,0.08); overflow: hidden; }
      .allocator-widget__histogram-fill { position: absolute; top: 0; left: 0; bottom: 0; background: var(--accent, #2b7cff); }
      .allocator-widget__histogram-count { font-variant-numeric: tabular-nums; font-weight: 600; }
      .allocator-widget__empty { margin: 0; font-size: .85rem; color: var(--muted, #666); }
    `;
    (document.head || document.body || document.documentElement).appendChild(style);
  }

  function applyCoverageHighlight(options = {}) {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('coverageSummary');
    if (!container) return;
    let targetRow = null;
    const rows = container.querySelectorAll('[data-cell-key]');
    rows.forEach((row) => {
      if (activeCoverageHighlightKey && row.dataset && row.dataset.cellKey === activeCoverageHighlightKey) {
        row.classList.add('coverage-summary__row--highlight');
        if (!targetRow) targetRow = row;
      } else {
        row.classList.remove('coverage-summary__row--highlight');
      }
    });
    if (options.scrollIntoView && targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function highlightCoverageCell(cellKey) {
    if (typeof cellKey !== 'string' || !cellKey) {
      activeCoverageHighlightKey = null;
      applyCoverageHighlight({ scrollIntoView: false });
      return;
    }
    if (activeCoverageHighlightKey === cellKey) {
      activeCoverageHighlightKey = null;
    } else {
      activeCoverageHighlightKey = cellKey;
    }
    applyCoverageHighlight({ scrollIntoView: activeCoverageHighlightKey !== null });
  }

  function renderCoverageSnapshot(snapshot) {
    const container = ensureCoverageContainer();
    if (!container) return;
    injectCoverageStyles();
    container.innerHTML = '';
    latestCoverageSnapshot = snapshot;

    const heading = document.createElement('h2');
    heading.textContent = 'Coverage snapshot';
    container.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'coverage-summary__meta';
    container.appendChild(meta);

    if (snapshot === null) {
      meta.textContent = 'Loading coverage snapshot…';
      renderAllocatorWidget(snapshot);
      return;
    }

    if (!snapshot || typeof snapshot !== 'object') {
      meta.textContent = 'Coverage snapshot not available.';
      renderAllocatorWidget(snapshot);
      return;
    }

    const generated = snapshot.generated_at ? new Date(snapshot.generated_at).toLocaleString() : null;
    const defaultTarget = toFinite(snapshot.default_target_per_cell);
    const metaParts = [];
    if (generated) metaParts.push(`Generated ${generated}`);
    if (defaultTarget != null) metaParts.push(`Default target per cell: ${Math.round(defaultTarget)}`);
    meta.textContent = metaParts.length ? metaParts.join(' • ') : 'Coverage snapshot by speaker profile attributes.';

    const alerts = getCoverageAlertsList();
    const alertsSection = document.createElement('section');
    alertsSection.className = 'coverage-alerts';
    const alertsHeader = document.createElement('div');
    alertsHeader.className = 'coverage-alerts__header';
    const alertsTitle = document.createElement('h3');
    alertsTitle.className = 'coverage-alerts__title';
    alertsTitle.textContent = 'Coverage alerts';
    if (alerts.length) {
      const countBadge = document.createElement('span');
      countBadge.className = 'coverage-alerts__count';
      countBadge.textContent = `${alerts.length} active`;
      alertsTitle.appendChild(countBadge);
    }
    alertsHeader.appendChild(alertsTitle);
    const alertsMeta = document.createElement('span');
    alertsMeta.className = 'coverage-alerts__meta';
    if (coverageAlertsGeneratedAt) {
      alertsMeta.textContent = `Updated ${formatAlertTimestamp(coverageAlertsGeneratedAt)}`;
    } else {
      alertsMeta.textContent = 'Updated recently';
    }
    alertsHeader.appendChild(alertsMeta);
    alertsSection.appendChild(alertsHeader);

    if (!alerts.length) {
      const emptyAlert = document.createElement('p');
      emptyAlert.className = 'coverage-alerts__empty';
      emptyAlert.textContent = 'No persistent low-coverage cells detected in the last 48 hours.';
      alertsSection.appendChild(emptyAlert);
    } else {
      const list = document.createElement('ul');
      list.className = 'coverage-alerts__list';
      alerts.slice(-50).forEach((alert) => {
        if (!alert || typeof alert !== 'object') return;
        const cellKey = typeof alert.cell === 'string' && alert.cell
          ? alert.cell
          : 'unknown:unknown:unknown:unknown';
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'coverage-alerts__item';
        button.dataset.cellKey = cellKey;
        button.title = 'Highlight in coverage table';
        button.addEventListener('click', () => highlightCoverageCell(cellKey));

        const label = document.createElement('span');
        label.className = 'coverage-alerts__item-cell';
        label.textContent = describeAllocatorCellKey(cellKey);
        button.appendChild(label);

        const metaLine = document.createElement('div');
        metaLine.className = 'coverage-alerts__item-meta';

        const timestamp = document.createElement('span');
        timestamp.textContent = formatAlertTimestamp(alert.timestamp);
        metaLine.appendChild(timestamp);

        const pctValue = toFinite(alert.pct_of_target);
        const pctText = pctValue != null ? formatCoveragePercent(pctValue) : null;
        if (pctText) {
          const pctSpan = document.createElement('span');
          pctSpan.textContent = `${pctText} of target`;
          metaLine.appendChild(pctSpan);
        }

        const staleValue = toFinite(alert.stale_hours);
        if (staleValue != null) {
          const staleSpan = document.createElement('span');
          staleSpan.textContent = `Stale ${staleValue.toFixed(1)}h`;
          metaLine.appendChild(staleSpan);
        }

        const deficitValue = toFinite(alert.deficit);
        if (deficitValue != null && deficitValue > 0) {
          const deficitSpan = document.createElement('span');
          deficitSpan.textContent = `Needs ${Math.max(1, Math.ceil(deficitValue))} more`;
          metaLine.appendChild(deficitSpan);
        }

        button.appendChild(metaLine);
        item.appendChild(button);
        list.appendChild(item);
      });
      alertsSection.appendChild(list);
    }

    container.appendChild(alertsSection);

    const cells = Array.isArray(snapshot.cells) ? snapshot.cells.slice() : [];
    if (!cells.length) {
      const empty = document.createElement('p');
      empty.className = 'coverage-summary__empty';
      empty.textContent = 'No coverage cells observed yet.';
      container.appendChild(empty);
      renderAllocatorWidget(snapshot);
      applyCoverageHighlight({ scrollIntoView: false });
      return;
    }

    cells.sort((a, b) => {
      const pctA = toFinite(a && a.pct_of_target) ?? 0;
      const pctB = toFinite(b && b.pct_of_target) ?? 0;
      if (pctA !== pctB) return pctA - pctB;
      const deficitA = toFinite(a && a.deficit) ?? 0;
      const deficitB = toFinite(b && b.deficit) ?? 0;
      if (deficitA !== deficitB) return deficitB - deficitA;
      return describeCoverageCell(a).localeCompare(describeCoverageCell(b));
    });

    const completenessRaw = toFinite(snapshot.coverage_completeness);
    if (completenessRaw != null) {
      const completeness = clamp01(completenessRaw);
      const insight = document.createElement('p');
      insight.className = 'coverage-summary__insight';
      const percentText = formatCoveragePercent(completeness) || '—';
      insight.textContent = `Overall coverage completeness: ${percentText} of target across ${cells.length} cells.`;
      container.appendChild(insight);
    }

    const table = document.createElement('table');
    table.className = 'coverage-summary__table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    [
      'Dialect family',
      'Subregion',
      'Gender',
      'Age band',
      'Count',
      'Target',
      'Progress toward target',
    ].forEach((label) => {
      const cell = document.createElement('th');
      cell.textContent = label;
      headerRow.appendChild(cell);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    cells.forEach((cell) => {
      const pctValue = toFinite(cell && cell.pct_of_target) ?? 0;
      const status = getCoverageStatus(pctValue);
      const tr = document.createElement('tr');
      tr.className = `coverage-summary__row coverage-summary__row--${status}`;
      const cellKey = buildAllocatorCellKey(cell);
      tr.dataset.cellKey = cellKey;

      [
        formatCoverageLabel(cell.dialect_family),
        formatCoverageLabel(cell.subregion),
        formatCoverageLabel(cell.apparent_gender),
        formatCoverageLabel(cell.apparent_age_band),
      ].forEach((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });

      const countCell = document.createElement('td');
      const countWrapper = document.createElement('span');
      countWrapper.className = 'coverage-summary__count';
      const countValue = document.createElement('span');
      countValue.className = 'coverage-summary__count-value';
      const countNumber = toFinite(cell && cell.count);
      countValue.textContent = Number.isFinite(countNumber) ? `${Math.round(countNumber)}` : '—';
      countWrapper.appendChild(countValue);
      const shortfall = formatCoverageShortfall(cell && cell.deficit);
      if (shortfall != null) {
        const badge = document.createElement('span');
        badge.className = 'coverage-summary__deficit-badge';
        badge.textContent = `Needs ${shortfall} more`;
        countWrapper.appendChild(badge);
      }
      countCell.appendChild(countWrapper);
      tr.appendChild(countCell);

      const targetCell = document.createElement('td');
      const targetNumber = toFinite(cell && cell.target);
      if (targetNumber != null) {
        const rounded = Math.round(targetNumber);
        targetCell.textContent = Math.abs(targetNumber - rounded) < 0.1 ? `${rounded}` : targetNumber.toFixed(1);
      } else {
        targetCell.textContent = '—';
      }
      tr.appendChild(targetCell);

      const progressCell = document.createElement('td');
      const progress = document.createElement('div');
      progress.className = 'coverage-summary__progress';
      const progressFill = document.createElement('div');
      progressFill.className = `coverage-summary__progress-fill coverage-summary__progress-fill--${status}`;
      const progressPercent = Math.max(0, Math.min(pctValue, 1)) * 100;
      progressFill.style.width = `${progressPercent.toFixed(1)}%`;
      progress.appendChild(progressFill);
      progressCell.appendChild(progress);

      const progressMeta = document.createElement('span');
      progressMeta.className = 'coverage-summary__progress-meta';
      const percentText = formatCoveragePercent(pctValue) || 'Target progress unavailable';
      if (shortfall != null) {
        progressMeta.textContent = `${percentText} of target • Needs ${shortfall} more`;
      } else if (pctValue >= 1) {
        progressMeta.textContent = `${percentText} of target`;
      } else {
        progressMeta.textContent = percentText;
      }
      progressCell.appendChild(progressMeta);

      tr.appendChild(progressCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    const nextUp = document.createElement('section');
    nextUp.className = 'coverage-summary__next-up';
    const nextHeading = document.createElement('h3');
    nextHeading.textContent = 'Next-Up (Top deficits)';
    nextUp.appendChild(nextHeading);

    const nextCandidatesSource = Array.isArray(snapshot.lowest_cells) && snapshot.lowest_cells.length
      ? snapshot.lowest_cells
      : cells;
    const nextCandidates = nextCandidatesSource
      .filter((item) => {
        const pct = toFinite(item && item.pct_of_target) ?? 0;
        const shortfallValue = formatCoverageShortfall(item && item.deficit);
        return pct < 0.5 && shortfallValue != null;
      })
      .sort((a, b) => {
        const deficitA = toFinite(a && a.deficit) ?? 0;
        const deficitB = toFinite(b && b.deficit) ?? 0;
        if (deficitA !== deficitB) return deficitB - deficitA;
        const pctA = toFinite(a && a.pct_of_target) ?? 0;
        const pctB = toFinite(b && b.pct_of_target) ?? 0;
        if (pctA !== pctB) return pctA - pctB;
        return describeCoverageCell(a).localeCompare(describeCoverageCell(b));
      })
      .slice(0, 10);

    if (!nextCandidates.length) {
      const empty = document.createElement('p');
      empty.className = 'coverage-summary__next-up-empty';
      empty.textContent = 'All observed cells are at least 50% of their targets — great work!';
      nextUp.appendChild(empty);
    } else {
      const list = document.createElement('ol');
      list.className = 'coverage-summary__next-up-list';
      nextCandidates.forEach((itemCell) => {
        const item = document.createElement('li');
        item.className = 'coverage-summary__next-up-item';

        const label = document.createElement('span');
        label.className = 'coverage-summary__next-up-label';
        label.textContent = describeCoverageCell(itemCell);
        item.appendChild(label);

        const info = document.createElement('span');
        info.className = 'coverage-summary__next-up-info';
        const pct = toFinite(itemCell && itemCell.pct_of_target) ?? 0;
        const percentText = formatCoveragePercent(pct) || 'Target progress unavailable';
        const shortfallValue = formatCoverageShortfall(itemCell && itemCell.deficit);
        info.textContent = shortfallValue != null ? `${percentText} of target • Needs ${shortfallValue} more` : percentText;
        item.appendChild(info);

        const progress = document.createElement('div');
        progress.className = 'coverage-summary__progress coverage-summary__progress--compact';
        const progressFill = document.createElement('div');
        const normalized = Math.max(0, Math.min(pct, 1));
        const status = getCoverageStatus(normalized);
        progressFill.className = `coverage-summary__progress-fill coverage-summary__progress-fill--${status}`;
        progressFill.style.width = `${(normalized * 100).toFixed(1)}%`;
        progress.appendChild(progressFill);
        item.appendChild(progress);

        list.appendChild(item);
      });
      nextUp.appendChild(list);
    }

    container.appendChild(nextUp);
    renderAllocatorWidget(snapshot);
    applyCoverageHighlight({ scrollIntoView: false });
  }

  const QA_TILE_CONTAINER_ID = 'qaDashboardTiles';
  const QA_TILE_PROVENANCE_ID = 'qaTileProvenanceComplete';
  const QA_TILE_COVERAGE_ID = 'qaTileCoverageCompleteness';

  function injectDashboardTilesStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('qaDashboardTilesStyles')) return;
    const style = document.createElement('style');
    style.id = 'qaDashboardTilesStyles';
    style.textContent = `
      .qa-dashboard-tiles { max-width: 960px; margin: 1.5rem auto 1rem; padding: 0 1rem 1.5rem; }
      .qa-dashboard-tiles__heading { margin: 0 0 1rem 0; font-size: 1.35rem; }
      .qa-dashboard-tiles__grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .qa-dashboard-tile { background: var(--card, #fff); border-radius: 12px; border: 1px solid var(--border, #dcdcdc); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05); padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.35rem; }
      .qa-dashboard-tile__label { margin: 0; font-size: .9rem; color: var(--muted, #555); }
      .qa-dashboard-tile__value { margin: 0; font-size: 2.25rem; font-weight: 600; color: var(--accent, #2b7cff); }
      .qa-dashboard-tile__caption { margin: 0; font-size: .8rem; color: var(--muted, #777); }
      @media (max-width: 540px) {
        .qa-dashboard-tiles { padding: 0 .75rem 1rem; }
        .qa-dashboard-tile__value { font-size: 1.9rem; }
      }
    `;
    (document.head || document.body || document.documentElement).appendChild(style);
  }

  function ensureDashboardTilesContainer() {
    if (typeof document === 'undefined') return null;
    let container = document.getElementById(QA_TILE_CONTAINER_ID);
    if (!container) {
      container = document.createElement('section');
      container.id = QA_TILE_CONTAINER_ID;
      container.className = 'qa-dashboard-tiles';

      const heading = document.createElement('h2');
      heading.className = 'qa-dashboard-tiles__heading';
      heading.textContent = 'QA Snapshot';
      container.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'qa-dashboard-tiles__grid';
      container.appendChild(grid);

      const coverage = document.getElementById('coverageSummary');
      if (coverage && coverage.parentNode) {
        coverage.parentNode.insertBefore(container, coverage);
      } else if (document.body) {
        document.body.insertBefore(container, document.body.firstChild || null);
      }
    }
    return container;
  }

  function extractProvenanceProportion(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const nested = summary.provenance_complete;
    if (nested && typeof nested === 'object') {
      const nestedProp = toFinite(nested.proportion);
      if (nestedProp != null) {
        return clamp01(nestedProp);
      }
      const nestedPct = toFinite(nested.percentage);
      if (nestedPct != null) {
        return clamp01(nestedPct / 100);
      }
    }
    const directProp = toFinite(summary.provenance_complete_proportion);
    if (directProp != null) {
      return clamp01(directProp);
    }
    const directPct = toFinite(summary.provenance_complete_percentage);
    if (directPct != null) {
      return clamp01(directPct / 100);
    }
    return null;
  }

  function getProvenanceCompleteCount(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const nested = summary.provenance_complete;
    if (nested && typeof nested === 'object') {
      const value = toFinite(nested.count);
      if (value != null) return Math.round(value);
    }
    const direct = toFinite(summary.provenance_complete_count);
    if (direct != null) return Math.round(direct);
    return null;
  }

  function getTotalClipCount(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const total = toFinite(
      summary.total_clips ??
        summary.clip_count ??
        summary.totalClips ??
        (summary.dataset && summary.dataset.total_clips)
    );
    if (total != null) return Math.round(total);
    return null;
  }

  function renderProvenanceTile(summary) {
    if (typeof document === 'undefined') return;
    injectDashboardTilesStyles();
    const container = ensureDashboardTilesContainer();
    if (!container) return;

    let grid = container.querySelector('.qa-dashboard-tiles__grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'qa-dashboard-tiles__grid';
      container.appendChild(grid);
    }

    let tile = document.getElementById(QA_TILE_PROVENANCE_ID);
    if (!tile) {
      tile = document.createElement('article');
      tile.id = QA_TILE_PROVENANCE_ID;
      tile.className = 'qa-dashboard-tile';

      const label = document.createElement('p');
      label.className = 'qa-dashboard-tile__label';
      tile.appendChild(label);

      const value = document.createElement('p');
      value.className = 'qa-dashboard-tile__value';
      tile.appendChild(value);

      const caption = document.createElement('p');
      caption.className = 'qa-dashboard-tile__caption';
      tile.appendChild(caption);

      grid.appendChild(tile);
    }

    const labelEl = tile.querySelector('.qa-dashboard-tile__label');
    const valueEl = tile.querySelector('.qa-dashboard-tile__value');
    const captionEl = tile.querySelector('.qa-dashboard-tile__caption');

    if (labelEl) {
      labelEl.textContent = '% clips with complete provenance';
    }

    if (summary === null) {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Loading training summary…';
      return;
    }

    if (!summary || typeof summary !== 'object') {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Training summary unavailable';
      return;
    }

    const proportion = extractProvenanceProportion(summary);
    if (Number.isFinite(proportion)) {
      const percentValue = proportion * 100;
      const decimals = percentValue >= 99.95 ? 0 : percentValue >= 10 ? 1 : 2;
      if (valueEl) valueEl.textContent = `${percentValue.toFixed(decimals)}%`;

      const completeCount = getProvenanceCompleteCount(summary);
      const totalCount = getTotalClipCount(summary);
      if (
        Number.isFinite(completeCount) &&
        Number.isFinite(totalCount) &&
        totalCount >= 0
      ) {
        if (captionEl) captionEl.textContent = `${completeCount} of ${totalCount} clips`;
      } else if (captionEl) {
        captionEl.textContent = '';
      }
    } else {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Provenance stats unavailable';
    }
  }

  function renderCoverageCompletenessTile(snapshot) {
    if (typeof document === 'undefined') return;
    injectDashboardTilesStyles();
    const container = ensureDashboardTilesContainer();
    if (!container) return;

    let grid = container.querySelector('.qa-dashboard-tiles__grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'qa-dashboard-tiles__grid';
      container.appendChild(grid);
    }

    let tile = document.getElementById(QA_TILE_COVERAGE_ID);
    if (!tile) {
      tile = document.createElement('article');
      tile.id = QA_TILE_COVERAGE_ID;
      tile.className = 'qa-dashboard-tile';

      const label = document.createElement('p');
      label.className = 'qa-dashboard-tile__label';
      tile.appendChild(label);

      const value = document.createElement('p');
      value.className = 'qa-dashboard-tile__value';
      tile.appendChild(value);

      const caption = document.createElement('p');
      caption.className = 'qa-dashboard-tile__caption';
      tile.appendChild(caption);

      grid.appendChild(tile);
    }

    const labelEl = tile.querySelector('.qa-dashboard-tile__label');
    const valueEl = tile.querySelector('.qa-dashboard-tile__value');
    const captionEl = tile.querySelector('.qa-dashboard-tile__caption');

    if (labelEl) {
      labelEl.textContent = 'Coverage completeness';
      if (hasRecentCoverageAlerts()) {
        labelEl.appendChild(document.createTextNode(' '));
        const badge = document.createElement('span');
        badge.className = 'qa-dashboard-tile__badge';
        badge.textContent = 'Alert';
        labelEl.appendChild(badge);
      }
    }

    if (snapshot === null) {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Loading coverage snapshot…';
      return;
    }

    if (!snapshot || typeof snapshot !== 'object') {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Coverage snapshot unavailable';
      return;
    }

    const completenessRaw = toFinite(snapshot.coverage_completeness);
    if (completenessRaw != null) {
      const completeness = clamp01(completenessRaw);
      const percentValue = completeness * 100;
      const decimals = percentValue >= 99.95 ? 0 : percentValue >= 10 ? 1 : 2;
      if (valueEl) valueEl.textContent = `${percentValue.toFixed(decimals)}%`;

      const cellsCount = Array.isArray(snapshot.cells) ? snapshot.cells.length : 0;
      const defaultTarget = toFinite(snapshot.default_target_per_cell);
      const captionParts = [];
      if (cellsCount) captionParts.push(`${cellsCount} cells`);
      if (defaultTarget != null) captionParts.push(`Default ${Math.round(defaultTarget)} clips`);
      if (captionEl) {
        captionEl.textContent =
          captionParts.length
            ? captionParts.join(' • ')
            : 'Average pct. of target across observed cells';
      }
    } else {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Coverage completeness unavailable';
    }
  }

  function fetchTrainingSummary() {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    return fetch('training_data_summary.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) return null;
        return response.json().catch(() => null);
      })
      .catch(() => null);
  }

  function updateCoverageAlerts(feed) {
    const alerts = Array.isArray(feed && feed.alerts) ? feed.alerts : [];
    latestCoverageAlerts = alerts
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const cellKey = typeof entry.cell === 'string' && entry.cell
          ? entry.cell
          : 'unknown:unknown:unknown:unknown';
        const pct = toFinite(entry.pct_of_target);
        const deficit = toFinite(entry.deficit);
        const stale = toFinite(entry.stale_hours);
        return {
          timestamp: entry.timestamp || null,
          cell: cellKey,
          pct_of_target: pct != null ? pct : null,
          deficit: deficit != null ? deficit : null,
          stale_hours: stale != null ? stale : null,
        };
      })
      .filter(Boolean);
    coverageAlertsGeneratedAt = feed && typeof feed.generated_at === 'string' ? feed.generated_at : null;
    renderCoverageSnapshot(latestCoverageSnapshot);
    renderCoverageCompletenessTile(latestCoverageSnapshot);
  }

  function fetchCoverageSnapshot() {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    return fetch('/api/coverage', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) return null;
        return response.json().catch(() => null);
      })
      .catch(() => null);
  }

  function fetchCoverageAlerts() {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    return fetch('/api/coverage/alerts', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) return null;
        return response.json().catch(() => null);
      })
      .catch(() => null);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
      renderProvenanceTile(null);
      renderCoverageCompletenessTile(null);
      renderCoverageSnapshot(null);
      fetchTrainingSummary()
        .then((summary) => {
          if (summary) {
            renderProvenanceTile(summary);
          } else {
            renderProvenanceTile(undefined);
          }
        })
        .catch(() => renderProvenanceTile(undefined));

      Promise.allSettled([fetchCoverageSnapshot(), fetchCoverageAlerts()])
        .then((results) => {
          const snapshotResult = results[0];
          const alertsResult = results[1];
          const snapshotValue = snapshotResult && snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
          const alertsValue = alertsResult && alertsResult.status === 'fulfilled' ? alertsResult.value : null;
          updateCoverageAlerts(alertsValue);

          if (snapshotValue) {
            renderCoverageSnapshot(snapshotValue);
            renderCoverageCompletenessTile(snapshotValue);
          } else if (snapshotResult && snapshotResult.status === 'fulfilled') {
            renderCoverageSnapshot(undefined);
            renderCoverageCompletenessTile(undefined);
          } else {
            renderCoverageSnapshot(undefined);
            renderCoverageCompletenessTile(undefined);
          }
        })
        .catch(() => {
          updateCoverageAlerts(null);
          renderCoverageSnapshot(undefined);
          renderCoverageCompletenessTile(undefined);
        });
    });
  }

  // --- Public API ------------------------------------------------------------
  const api = {
    recordAnnotation,
    computeAlpha,
    computeIRRSummary,
    saveIRRSummary,
    // Legacy/diagnostic helpers
    _loadRecords: () => clone(ensureRecords()),
    _saveRecords: (records) => persistRecords(records),
    _internal: {
      normalizeRecords,
      ensureRecords,
      sanitizeMetrics,
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.IRR = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
