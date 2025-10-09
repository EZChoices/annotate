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
  let activeCoverageHighlightReason = 'default';
  let irrSummaryState = null;
  let irrTrendState = {};
  let doublePassState = null;
  let routingConfigState = null;
  const disagreementsState = {
    entries: [],
    cells: [],
    filter: 'all',
    selectedKey: null,
    status: 'idle',
    specialFilters: {},
  };
  const adjudicationState = {
    entries: [],
    status: 'idle',
    counts: { pending: 0, assigned: 0, locked: 0 },
    lastUpdated: null,
    meta: { configSha: null, snapshotAt: null },
    diffCache: new Map(),
  };
  const adjudicationUI = {
    initialized: false,
    container: null,
    metaLabel: null,
    filters: {
      status: null,
      cell: null,
      reason: null,
      search: null,
    },
    tableBody: null,
    tableWrapper: null,
    emptyMessage: null,
    pagination: {
      container: null,
      prev: null,
      next: null,
      info: null,
    },
    footer: {
      config: null,
      snapshot: null,
    },
    state: {
      status: new Set(),
      cell: 'all',
      reasons: new Set(),
      search: '',
      page: 1,
    },
  };
  const disagreementsUI = {
    overlay: null,
    panel: null,
    closeButton: null,
    filterSelect: null,
    summaryBody: null,
    summaryEmpty: null,
    list: null,
    listEmpty: null,
    hint: null,
  };

  const ROUTING_CONFIG_KEYS = [
    'p_base',
    'coverage_boost_threshold',
    'coverage_boost_factor',
    'qa_boost_f1_threshold',
    'qa_boost_cue_in_bounds_threshold',
    'qa_boost_factor',
    'p_max',
    'annotator_daily_cap',
  ];

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

  function normalizeProbability(value) {
    const numeric = toFinite(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric > 1) return clamp01(numeric / 100);
    if (numeric < 0) return 0;
    return clamp01(numeric);
  }

  function formatProbabilityPercent(value) {
    const normalized = normalizeProbability(value);
    if (normalized == null) return null;
    return formatPercentMetric(normalized);
  }

  function formatMultiplier(value) {
    const numeric = toFinite(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const decimals = numeric >= 10 ? 0 : numeric >= 2 ? 1 : 2;
    const text = numeric
      .toFixed(decimals)
      .replace(/\.0+$/, "")
      .replace(/0+$/, "")
      .replace(/\.$/, "");
    return `×${text}`;
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
      .coverage-summary__row--disagreement { box-shadow: 0 0 0 3px rgba(249, 168, 37, 0.4) inset; background: rgba(255, 249, 196, 0.6); }
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
      row.classList.remove('coverage-summary__row--highlight', 'coverage-summary__row--disagreement');
      if (
        activeCoverageHighlightKey &&
        row.dataset &&
        row.dataset.cellKey === activeCoverageHighlightKey
      ) {
        const highlightClass =
          activeCoverageHighlightReason === 'disagreement'
            ? 'coverage-summary__row--disagreement'
            : 'coverage-summary__row--highlight';
        row.classList.add(highlightClass);
        if (!targetRow) targetRow = row;
      }
    });
    if (options.scrollIntoView && targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function highlightCoverageCell(cellKey, options = {}) {
    const reason = options.reason || 'default';
    const shouldScroll = options.scrollIntoView !== false;
    const force = options.force === true;
    if (typeof cellKey !== 'string' || !cellKey) {
      activeCoverageHighlightKey = null;
      activeCoverageHighlightReason = 'default';
      applyCoverageHighlight({ scrollIntoView: false });
      return;
    }
    if (
      !force &&
      activeCoverageHighlightKey === cellKey &&
      activeCoverageHighlightReason === reason
    ) {
      activeCoverageHighlightKey = null;
      activeCoverageHighlightReason = 'default';
      applyCoverageHighlight({ scrollIntoView: false });
      return;
    }
    activeCoverageHighlightKey = cellKey;
    activeCoverageHighlightReason = reason;
    applyCoverageHighlight({ scrollIntoView: shouldScroll });
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
  const QA_TILE_ADJUDICATION_ID = 'qaTileAdjudication';
  const QA_TILE_IRR_ID = 'qaTileIRRAlpha';
  const QA_TILE_VOICE_TAG_ID = 'qaTileVoiceTagPresence';
  const QA_TILE_DOUBLE_PASS_ID = 'qaTileDoublePass';
  const QA_TILE_DISAGREEMENTS_ID = 'qaTileDisagreements';
  const QA_TILE_PROVENANCE_ID = 'qaTileProvenanceComplete';
  const QA_TILE_CODE_SWITCH_ID = 'qaTileCodeSwitchF1';
  const QA_TILE_DIARIZATION_ID = 'qaTileDiarizationMae';
  const QA_TILE_TRANSLATION_ID = 'qaTileTranslationCompleteness';
  const QA_TILE_COVERAGE_ID = 'qaTileCoverageCompleteness';

  const QA_TILE_LINKS = {
    [QA_TILE_ADJUDICATION_ID]: '#adjudication',
    [QA_TILE_IRR_ID]: '/stage2/qa-dashboard.html#irr',
    [QA_TILE_VOICE_TAG_ID]: '/stage2/qa-dashboard.html#voice-tag-irr',
    [QA_TILE_DOUBLE_PASS_ID]: '/stage2/qa-dashboard.html#double-pass',
    [QA_TILE_DISAGREEMENTS_ID]: '#',
    [QA_TILE_CODE_SWITCH_ID]: '/stage2/review.html?f1_lt=0.85',
    [QA_TILE_DIARIZATION_ID]: '/stage2/review.html?mae_gt=0.5',
    [QA_TILE_TRANSLATION_ID]: '/stage2/review.html?translation_lt=0.95',
    [QA_TILE_COVERAGE_ID]: '/stage2/qa-dashboard.html?coverage=low#coverageSummary',
  };

  const QA_MIN_CELL_ITEMS = 10;

  const QA_STATUS_CLASS_MAP = {
    green: 'qa-status-green',
    amber: 'qa-status-amber',
    red: 'qa-status-red',
    neutral: 'qa-status-neutral',
  };

  const QA_STATUS_LABELS = {
    green: 'On track',
    amber: 'Needs attention',
    red: 'Action needed',
    neutral: 'No data',
  };

  function injectDashboardTilesStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('qaDashboardTilesStyles')) return;
    const style = document.createElement('style');
    style.id = 'qaDashboardTilesStyles';
    style.textContent = `
      .qa-dashboard-tiles { max-width: 960px; margin: 1.5rem auto 1rem; padding: 0 1rem 1.5rem; }
      .qa-dashboard-tiles__heading { margin: 0 0 1rem 0; font-size: 1.35rem; }
      .qa-dashboard-tiles__grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .qa-dashboard-tile { background: var(--card, #fff); border-radius: 12px; border: 1px solid var(--border, #dcdcdc); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.05); padding: 1rem 1.2rem; display: flex; flex-direction: column; gap: 0.4rem; text-decoration: none; color: inherit; transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease; position: relative; }
      .qa-dashboard-tile:hover, .qa-dashboard-tile:focus-visible { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.08); border-color: rgba(43, 124, 255, 0.45); outline: none; }
      .qa-dashboard-tile__status { margin: 0; display: inline-flex; align-items: center; gap: .4rem; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; color: var(--muted, #777); }
      .qa-dashboard-tile__status-dot { width: .55rem; height: .55rem; border-radius: 999px; background: currentColor; box-shadow: 0 0 0 2px rgba(0,0,0,0.05); }
      .qa-dashboard-tile__status-text { margin: 0; }
      .qa-dashboard-tile__label { margin: 0; font-size: .9rem; color: var(--muted, #555); }
      .qa-dashboard-tile__value { margin: 0; font-size: 2.25rem; font-weight: 600; color: var(--accent, #2b7cff); }
      .qa-dashboard-tile__caption { margin: 0; font-size: .8rem; color: var(--muted, #777); }
      .qa-dashboard-tile__meta { margin: 0; font-size: .75rem; color: var(--muted, #777); }
      .qa-dashboard-tile__label .qa-dashboard-tile__badge { margin-left: .4rem; }
      .qa-dashboard-tile__sparkline { margin-top: .25rem; }
      .qa-dashboard-tile__sparkline svg { display: block; width: 100%; height: 38px; }
      .qa-dashboard-tile__sparkline-path { fill: none; stroke: var(--sparkline-color, #5c6bc0); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
      .qa-dashboard-tile__sparkline-area { fill: rgba(92, 107, 192, 0.18); stroke: none; }
      .qa-dashboard-tile__sparkline-empty { font-size: .75rem; color: var(--muted, #888); }
      .qa-dashboard-tile.qa-status-green { border-color: rgba(46, 125, 50, 0.35); box-shadow: 0 8px 22px rgba(46, 125, 50, 0.08); }
      .qa-dashboard-tile.qa-status-amber { border-color: rgba(249, 168, 37, 0.45); box-shadow: 0 8px 22px rgba(249, 168, 37, 0.08); }
      .qa-dashboard-tile.qa-status-red { border-color: rgba(211, 47, 47, 0.4); box-shadow: 0 8px 22px rgba(211, 47, 47, 0.08); }
      .qa-dashboard-tile.qa-status-green .qa-dashboard-tile__status, .qa-dashboard-tile.qa-status-green .qa-dashboard-tile__value { color: #2e7d32; }
      .qa-dashboard-tile.qa-status-amber .qa-dashboard-tile__status, .qa-dashboard-tile.qa-status-amber .qa-dashboard-tile__value { color: #f9a825; }
      .qa-dashboard-tile.qa-status-red .qa-dashboard-tile__status, .qa-dashboard-tile.qa-status-red .qa-dashboard-tile__value { color: #d32f2f; }
      .qa-dashboard-tile.qa-status-neutral .qa-dashboard-tile__status { color: var(--muted, #777); }
      .qa-dashboard-tile.qa-status-neutral .qa-dashboard-tile__value { color: var(--muted, #666); }
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

  function ensureMetricTile(id, options = {}) {
    if (typeof document === 'undefined') return null;
    injectDashboardTilesStyles();
    const container = ensureDashboardTilesContainer();
    if (!container) return null;

    let grid = container.querySelector('.qa-dashboard-tiles__grid');
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'qa-dashboard-tiles__grid';
      container.appendChild(grid);
    }

    let tile = document.getElementById(id);
    if (tile && tile.tagName && tile.tagName.toLowerCase() !== 'a') {
      tile.remove();
      tile = null;
    }

    if (!tile) {
      tile = document.createElement('a');
      tile.id = id;
      tile.className = 'qa-dashboard-tile qa-status-neutral';
      tile.href = options.href || QA_TILE_LINKS[id] || '#';

      const status = document.createElement('div');
      status.className = 'qa-dashboard-tile__status';
      const dot = document.createElement('span');
      dot.className = 'qa-dashboard-tile__status-dot';
      dot.setAttribute('aria-hidden', 'true');
      const statusText = document.createElement('span');
      statusText.className = 'qa-dashboard-tile__status-text';
      status.appendChild(dot);
      status.appendChild(statusText);
      tile.appendChild(status);

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

    if (options.href) tile.href = options.href;
    if (options.title) tile.title = options.title;

    return {
      tile,
      statusTextEl: tile.querySelector('.qa-dashboard-tile__status-text'),
      labelEl: tile.querySelector('.qa-dashboard-tile__label'),
      valueEl: tile.querySelector('.qa-dashboard-tile__value'),
      captionEl: tile.querySelector('.qa-dashboard-tile__caption'),
    };
  }

  function normalizeAdjudicationEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const assetId = entry.asset_id || entry.assetId || entry.clip_id;
        if (!assetId) return null;
        const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : 'pending';
        const reasons = Array.isArray(entry.reasons)
          ? entry.reasons.filter((reason) => typeof reason === 'string')
          : [];
        const cellRaw = entry.cell || entry.cell_key || entry.cellKey || null;
        const cell = normalizeCellKey(cellRaw);
        const queuedAt = typeof entry.queued_at === 'string' ? entry.queued_at : null;
        const lastSeenAt = typeof entry.last_seen_at === 'string' ? entry.last_seen_at : null;
        const assignee = typeof entry.assignee === 'string' ? entry.assignee : null;
        const passAnnotators = Array.isArray(entry.pass_annotators)
          ? entry.pass_annotators
              .map((annotator) => (annotator != null ? String(annotator).trim() : ''))
              .filter(Boolean)
          : [];
        return {
          assetId,
          status,
          reasons,
          cell,
          queuedAt,
          lastSeenAt,
          assignee,
          passAnnotators,
        };
      })
      .filter(Boolean);
  }

  function computeAdjudicationCounts(entries) {
    const counts = { pending: 0, assigned: 0, locked: 0 };
    (entries || []).forEach((entry) => {
      if (!entry || typeof entry.status !== 'string') return;
      const normalized = entry.status.toLowerCase();
      if (normalized === 'pending') counts.pending += 1;
      else if (normalized === 'assigned') counts.assigned += 1;
      else if (normalized === 'locked') counts.locked += 1;
    });
    return counts;
  }

  const ADJUDICATION_PAGE_SIZE = 50;
  const ADJUDICATION_STATUS_ORDER = ['pending', 'assigned', 'in_review', 'locked', 'resolved'];
  const ADJUDICATION_STATUS_LABELS = {
    pending: 'Pending',
    assigned: 'Assigned',
    in_review: 'In Review',
    locked: 'Locked',
    resolved: 'Resolved',
  };
  const ADJUDICATION_STATUS_CLASS_MAP = {
    pending: 'qa-adjudication__status--pending',
    assigned: 'qa-adjudication__status--assigned',
    in_review: 'qa-adjudication__status--in_review',
    locked: 'qa-adjudication__status--locked',
    resolved: 'qa-adjudication__status--resolved',
  };
  const ADJUDICATION_REASON_LABELS = {
    hasCS_disagreement: 'has-CS disagreement',
    voiceTag_disagreement: 'Voice-tag disagreement',
    low_F1_p1: 'Low F1 (pass 1)',
    low_CuesInBounds_p1: 'Cues out of bounds (p1)',
  };
  const ADJUDICATION_QUERY_KEYS = {
    status: 'aq_status',
    cell: 'aq_cell',
    reasons: 'aq_reason',
    search: 'aq_search',
    page: 'aq_page',
  };
  const ADJUDICATION_SESSION_KEY = 'ea_stage2_adjudication_opened';
  const adjudicationSession = { opened: null };
  const toastState = { counter: 0 };
  let adjudicationSearchTimer = null;
  let adjudicationErrorToast = null;
  let reviewerIdCache = null;

  function ensureToastContainer() {
    if (typeof document === 'undefined') return null;
    let container = document.getElementById('qaToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'qaToastContainer';
      container.className = 'qa-toast-container';
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-atomic', 'false');
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function dismissToast(toast) {
    if (!toast) return;
    if (toast.dataset && toast.dataset.toastTimer) {
      clearTimeout(Number(toast.dataset.toastTimer));
    }
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }

  function showToast(message, options = {}) {
    const container = ensureToastContainer();
    if (!container) return null;
    const toast = document.createElement('div');
    toast.className = 'qa-toast';
    toast.dataset.toastId = `toast-${toastState.counter += 1}`;
    if (options.variant === 'error') {
      toast.classList.add('qa-toast--error');
    }
    toast.setAttribute('role', 'status');

    const messageEl = document.createElement('p');
    messageEl.className = 'qa-toast__message';
    messageEl.textContent = message;
    toast.appendChild(messageEl);

    if (Array.isArray(options.actions) && options.actions.length) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'qa-toast__actions';
      options.actions.forEach((action) => {
        if (!action || !action.label) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'qa-toast__button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
          if (typeof action.onClick === 'function') {
            action.onClick();
          }
          dismissToast(toast);
        });
        actionsEl.appendChild(button);
      });
      toast.appendChild(actionsEl);
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'qa-toast__close';
    closeButton.setAttribute('aria-label', 'Dismiss notification');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => dismissToast(toast));
    toast.appendChild(closeButton);

    container.appendChild(toast);

    const duration = Number.isFinite(options.duration) ? Number(options.duration) : 6000;
    if (!options.sticky && duration > 0) {
      const timer = setTimeout(() => dismissToast(toast), duration);
      toast.dataset.toastTimer = timer;
    }

    return toast;
  }

  function normalizeAdjudicationMeta(raw) {
    if (!raw || typeof raw !== 'object') {
      return { configSha: null, snapshotAt: null };
    }
    const configSha =
      raw.config_sha ||
      raw.configSha ||
      (raw.config && (raw.config.sha || raw.config.version)) ||
      null;
    const snapshotAt =
      raw.snapshot_at ||
      raw.snapshotAt ||
      raw.generated_at ||
      raw.generatedAt ||
      raw.last_updated ||
      raw.lastUpdated ||
      raw.as_of ||
      null;
    return { configSha: configSha || null, snapshotAt: snapshotAt || null };
  }

  function formatAdjudicationStatus(status) {
    if (!status) return 'Unknown';
    const key = String(status).toLowerCase();
    return ADJUDICATION_STATUS_LABELS[key] || key.replace(/_/g, ' ');
  }

  function getAdjudicationStatusClass(status) {
    if (!status) return ADJUDICATION_STATUS_CLASS_MAP.pending;
    const key = String(status).toLowerCase();
    return ADJUDICATION_STATUS_CLASS_MAP[key] || ADJUDICATION_STATUS_CLASS_MAP.pending;
  }

  function formatAdjudicationAge(timestamp) {
    const parsed = parseTimestamp(timestamp);
    if (!Number.isFinite(parsed)) return '—';
    const diff = Date.now() - parsed;
    if (!Number.isFinite(diff) || diff < 0) return '—';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff >= day) {
      const days = Math.max(1, Math.floor(diff / day));
      return `${days} d`;
    }
    if (diff >= hour) {
      const hours = Math.max(1, Math.floor(diff / hour));
      return `${hours} h`;
    }
    const minutes = Math.max(1, Math.floor(diff / minute));
    return `${minutes} m`;
  }

  function formatUtcTimestamp(timestamp) {
    const parsed = parseTimestamp(timestamp);
    if (!Number.isFinite(parsed)) return null;
    const date = new Date(parsed);
    const pad = (value) => (value < 10 ? `0${value}` : String(value));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
      date.getUTCHours()
    )}:${pad(date.getUTCMinutes())} UTC`;
  }

  function formatReasonLabel(reason) {
    if (!reason) return '—';
    const key = String(reason);
    if (ADJUDICATION_REASON_LABELS[key]) return ADJUDICATION_REASON_LABELS[key];
    return key
      .split(/[_-]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function ensureAdjudicationDiffCache() {
    if (!(adjudicationState.diffCache instanceof Map)) {
      adjudicationState.diffCache = new Map();
    }
    return adjudicationState.diffCache;
  }

  function clearAdjudicationDiffCache() {
    const cache = ensureAdjudicationDiffCache();
    cache.clear();
  }

  function getAdjudicationOpenedSet() {
    if (adjudicationSession.opened instanceof Set) {
      return adjudicationSession.opened;
    }
    const set = new Set();
    try {
      const raw = sessionStorage.getItem(ADJUDICATION_SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            if (typeof item === 'string' && item) set.add(item);
          });
        } else if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach((key) => set.add(key));
        }
      }
    } catch {}
    adjudicationSession.opened = set;
    return set;
  }

  function persistAdjudicationOpenedSet() {
    const set = getAdjudicationOpenedSet();
    try {
      sessionStorage.setItem(ADJUDICATION_SESSION_KEY, JSON.stringify(Array.from(set)));
    } catch {}
  }

  function markAdjudicationAssetOpened(assetId) {
    if (!assetId) return;
    const set = getAdjudicationOpenedSet();
    if (!set.has(assetId)) {
      set.add(assetId);
      persistAdjudicationOpenedSet();
    }
  }

  function hasAdjudicationAssetOpened(assetId) {
    if (!assetId) return false;
    const set = getAdjudicationOpenedSet();
    return set.has(assetId);
  }

  function normalizeDiffPreviewData(raw) {
    if (!raw || typeof raw !== 'object') {
      return { csDelta: null, vtDelta: null, rttmDelta: null };
    }
    const cs = toFinite(
      raw.cs_delta ?? raw.csDelta ?? raw.codeswitch ?? raw.codeSwitch ?? raw.cs ?? raw.cs_mismatches
    );
    const vt = toFinite(
      raw.vt_delta ?? raw.vtDelta ?? raw.voice_tag ?? raw.voiceTag ?? raw.voice ?? raw.voice_tag_mismatches
    );
    const rttm = toFinite(
      raw.rttm_delta ?? raw.rttmDelta ?? raw.diarization ?? raw.turn_delta ?? raw.rttm ?? raw.rttm_mismatches
    );
    const sanitize = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
    return {
      csDelta: sanitize(cs),
      vtDelta: sanitize(vt),
      rttmDelta: sanitize(rttm),
    };
  }

  function fetchAdjudicationDiffPreview(assetId) {
    if (!assetId || typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    const url = `/api/adjudication/diff_preview?asset_id=${encodeURIComponent(assetId)}`;
    return fetch(url, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load diff preview');
        return response.json().catch(() => ({}));
      })
      .then((data) => normalizeDiffPreviewData(data))
      .catch(() => {
        throw new Error('diff_preview_failed');
      });
  }

  function updateDiffBadgeElement(row, role, cacheEntry) {
    if (!row) return;
    const badge = row.querySelector(`[data-role="diff-${role}"] .qa-adjudication__diff-badge-value`);
    if (!badge) return;
    if (!cacheEntry) {
      badge.textContent = '—';
      return;
    }
    if (cacheEntry.status === 'loading') {
      badge.textContent = '…';
      return;
    }
    if (cacheEntry.status === 'error') {
      badge.textContent = '!';
      return;
    }
    const value = cacheEntry.data ? cacheEntry.data[`${role}Delta`] : null;
    badge.textContent = Number.isFinite(value) ? String(value) : '0';
  }

  function updateRowDiffBadges(assetId) {
    if (!adjudicationUI.tableBody) return;
    const cache = ensureAdjudicationDiffCache();
    const cacheEntry = cache.get(assetId);
    const rows = Array.from(adjudicationUI.tableBody.querySelectorAll('tr[data-asset-id]')).filter(
      (row) => row.dataset.assetId === assetId
    );
    rows.forEach((row) => {
      updateDiffBadgeElement(row, 'cs', cacheEntry);
      updateDiffBadgeElement(row, 'vt', cacheEntry);
      updateDiffBadgeElement(row, 'rttm', cacheEntry);
    });
  }

  function ensureDiffPreview(assetId) {
    if (!assetId) return;
    const cache = ensureAdjudicationDiffCache();
    const existing = cache.get(assetId);
    if (existing) {
      if (existing.status === 'ready') {
        updateRowDiffBadges(assetId);
        return existing.promise || Promise.resolve(existing.data);
      }
      if (existing.status === 'loading') {
        return existing.promise;
      }
    }
    const entry = { status: 'loading', data: null, promise: null };
    cache.set(assetId, entry);
    updateRowDiffBadges(assetId);
    const promise = fetchAdjudicationDiffPreview(assetId)
      .then((data) => {
        entry.status = 'ready';
        entry.data = data;
        updateRowDiffBadges(assetId);
        return data;
      })
      .catch(() => {
        entry.status = 'error';
        entry.data = null;
        updateRowDiffBadges(assetId);
        return null;
      });
    entry.promise = promise;
    return promise;
  }

  function handleQueueRowPreview(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const row = target.closest('tr[data-asset-id]');
    if (!row) return;
    ensureDiffPreview(row.dataset.assetId);
  }

  function getReviewerId() {
    if (reviewerIdCache) return reviewerIdCache;
    const reviewerKey = 'ea_stage2_reviewer_id';
    try {
      const existing = localStorage.getItem(reviewerKey);
      if (existing) {
        reviewerIdCache = existing;
        return reviewerIdCache;
      }
    } catch {}
    try {
      const annotator = localStorage.getItem('ea_stage2_annotator_id');
      if (annotator) {
        localStorage.setItem(reviewerKey, annotator);
        reviewerIdCache = annotator;
        return reviewerIdCache;
      }
    } catch {}
    reviewerIdCache = 'reviewer';
    return reviewerIdCache;
  }

  function getAdjudicationEntry(assetId) {
    if (!assetId) return null;
    return (adjudicationState.entries || []).find((entry) => entry && entry.assetId === assetId) || null;
  }

  function findAdjudicationRow(assetId) {
    if (!adjudicationUI.tableBody) return null;
    const rows = adjudicationUI.tableBody.querySelectorAll('tr[data-asset-id]');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row && row.dataset.assetId === assetId) {
        return row;
      }
    }
    return null;
  }

  function readAdjudicationFiltersFromQuery() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search || '');
    const statusRaw = params.get(ADJUDICATION_QUERY_KEYS.status);
    const reasonsRaw = params.get(ADJUDICATION_QUERY_KEYS.reasons);
    const cellRaw = params.get(ADJUDICATION_QUERY_KEYS.cell);
    const searchRaw = params.get(ADJUDICATION_QUERY_KEYS.search);
    const pageRaw = params.get(ADJUDICATION_QUERY_KEYS.page);

    adjudicationUI.state.status = new Set();
    adjudicationUI.state.reasons = new Set();
    adjudicationUI.state.cell = cellRaw && cellRaw !== 'all' ? cellRaw : 'all';
    adjudicationUI.state.search = searchRaw ? searchRaw.trim() : '';

    if (statusRaw) {
      statusRaw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value && ADJUDICATION_STATUS_ORDER.includes(value))
        .forEach((value) => adjudicationUI.state.status.add(value));
    }

    if (reasonsRaw) {
      reasonsRaw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) => adjudicationUI.state.reasons.add(value));
    }

    const parsedPage = Number.parseInt(pageRaw, 10);
    adjudicationUI.state.page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  }

  function updateAdjudicationQueryParams() {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search || '');
    const statusValues = Array.from(adjudicationUI.state.status || []);
    const reasonValues = Array.from(adjudicationUI.state.reasons || []);
    const cellValue = adjudicationUI.state.cell && adjudicationUI.state.cell !== 'all'
      ? adjudicationUI.state.cell
      : null;
    const searchValue = adjudicationUI.state.search ? adjudicationUI.state.search.trim() : '';
    const pageValue = adjudicationUI.state.page > 1 ? String(adjudicationUI.state.page) : null;

    if (statusValues.length) params.set(ADJUDICATION_QUERY_KEYS.status, statusValues.join(','));
    else params.delete(ADJUDICATION_QUERY_KEYS.status);

    if (reasonValues.length) params.set(ADJUDICATION_QUERY_KEYS.reasons, reasonValues.join(','));
    else params.delete(ADJUDICATION_QUERY_KEYS.reasons);

    if (cellValue) params.set(ADJUDICATION_QUERY_KEYS.cell, cellValue);
    else params.delete(ADJUDICATION_QUERY_KEYS.cell);

    if (searchValue) params.set(ADJUDICATION_QUERY_KEYS.search, searchValue);
    else params.delete(ADJUDICATION_QUERY_KEYS.search);

    if (pageValue) params.set(ADJUDICATION_QUERY_KEYS.page, pageValue);
    else params.delete(ADJUDICATION_QUERY_KEYS.page);

    const query = params.toString();
    const hash = window.location.hash || '';
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${hash}`;
    window.history.replaceState(null, '', nextUrl);
  }

  function syncAdjudicationFilterInputs() {
    const { status, cell, reason, search } = adjudicationUI.filters;
    if (status) {
      Array.from(status.options || []).forEach((option) => {
        option.selected = adjudicationUI.state.status.has(option.value);
      });
    }
    if (cell) {
      cell.value = adjudicationUI.state.cell && cell.querySelector(`option[value="${adjudicationUI.state.cell}"]`)
        ? adjudicationUI.state.cell
        : 'all';
    }
    if (reason) {
      Array.from(reason.options || []).forEach((option) => {
        option.selected = adjudicationUI.state.reasons.has(option.value);
      });
    }
    if (search) {
      search.value = adjudicationUI.state.search || '';
    }
  }

  function updateAdjudicationFilterOptions() {
    const entries = adjudicationState.entries || [];
    const statusSelect = adjudicationUI.filters.status;
    if (statusSelect) {
      const counts = new Map();
      entries.forEach((entry) => {
        const status = entry.status || 'pending';
        counts.set(status, (counts.get(status) || 0) + 1);
      });
      statusSelect.innerHTML = '';
      ADJUDICATION_STATUS_ORDER.forEach((status) => {
        const option = document.createElement('option');
        option.value = status;
        const count = counts.get(status) || 0;
        option.textContent = count ? `${formatAdjudicationStatus(status)} (${count})` : formatAdjudicationStatus(status);
        statusSelect.appendChild(option);
      });
    }

    const cellSelect = adjudicationUI.filters.cell;
    if (cellSelect) {
      const cells = new Map();
      entries.forEach((entry) => {
        const key = entry.cell || 'unknown';
        if (!cells.has(key)) {
          cells.set(key, formatCellLabel(key));
        }
      });
      const currentValue = adjudicationUI.state.cell;
      if (currentValue && !cells.has(currentValue) && currentValue !== 'all') {
        cells.set(currentValue, formatCellLabel(currentValue));
      }
      const sortedCells = Array.from(cells.entries()).sort((a, b) => a[1].localeCompare(b[1]));
      cellSelect.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = 'all';
      allOption.textContent = 'All cells';
      cellSelect.appendChild(allOption);
      sortedCells.forEach(([key, label]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        cellSelect.appendChild(option);
      });
    }

    const reasonSelect = adjudicationUI.filters.reason;
    if (reasonSelect) {
      const reasonMap = new Map();
      entries.forEach((entry) => {
        (entry.reasons || []).forEach((reason) => {
          if (!reasonMap.has(reason)) {
            reasonMap.set(reason, formatReasonLabel(reason));
          }
        });
      });
      const currentReasons = Array.from(adjudicationUI.state.reasons);
      currentReasons.forEach((reason) => {
        if (!reasonMap.has(reason)) {
          reasonMap.set(reason, formatReasonLabel(reason));
        }
      });
      const sortedReasons = Array.from(reasonMap.entries()).sort((a, b) => a[1].localeCompare(b[1]));
      reasonSelect.innerHTML = '';
      sortedReasons.forEach(([key, label]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = label;
        reasonSelect.appendChild(option);
      });
    }
  }

  function getFilteredAdjudicationEntries() {
    const entries = adjudicationState.entries || [];
    const statusFilter = adjudicationUI.state.status;
    const cellFilter = adjudicationUI.state.cell;
    const reasonFilter = adjudicationUI.state.reasons;
    const searchTerm = adjudicationUI.state.search ? adjudicationUI.state.search.toLowerCase() : '';

    return entries.filter((entry) => {
      if (!entry) return false;
      if (statusFilter && statusFilter.size && !statusFilter.has(entry.status)) return false;
      if (cellFilter && cellFilter !== 'all' && entry.cell !== cellFilter) return false;
      if (reasonFilter && reasonFilter.size) {
        const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
        const hasAny = Array.from(reasonFilter).some((reason) => reasons.includes(reason));
        if (!hasAny) return false;
      }
      if (searchTerm) {
        const asset = entry.assetId ? entry.assetId.toLowerCase() : '';
        if (!asset.includes(searchTerm)) return false;
      }
      return true;
    });
  }

  function setAdjudicationPage(page) {
    const nextPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    if (nextPage === adjudicationUI.state.page) return;
    adjudicationUI.state.page = nextPage;
    updateAdjudicationQueryParams();
    renderAdjudicationQueue();
  }

  function updateAdjudicationFooter() {
    if (!adjudicationUI.footer) return;
    const meta = adjudicationState.meta || {};
    const config = adjudicationUI.footer.config;
    const snapshot = adjudicationUI.footer.snapshot;
    if (config) {
      config.textContent = `Config SHA: ${meta.configSha || '—'}`;
    }
    if (snapshot) {
      const formatted = meta.snapshotAt ? formatUtcTimestamp(meta.snapshotAt) : null;
      snapshot.textContent = `Snapshot: ${formatted || '—'}`;
    }
  }

  function buildDiffBadge(role, label) {
    const badge = document.createElement('span');
    badge.className = 'qa-adjudication__diff-badge';
    badge.dataset.role = `diff-${role}`;
    const labelEl = document.createElement('span');
    labelEl.className = 'qa-adjudication__diff-badge-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'qa-adjudication__diff-badge-value';
    valueEl.textContent = '—';
    badge.appendChild(labelEl);
    badge.appendChild(valueEl);
    return badge;
  }

  function buildAdjudicationRow(entry) {
    const row = document.createElement('tr');
    row.dataset.assetId = entry.assetId;

    const assetCell = document.createElement('td');
    assetCell.className = 'qa-adjudication__asset';
    assetCell.textContent = entry.assetId;
    row.appendChild(assetCell);

    const cellCell = document.createElement('td');
    cellCell.textContent = formatCellLabel(entry.cell);
    row.appendChild(cellCell);

    const reasonCell = document.createElement('td');
    const reasonWrap = document.createElement('div');
    reasonWrap.className = 'qa-adjudication__reasons';
    if (entry.reasons && entry.reasons.length) {
      entry.reasons.forEach((reason) => {
        const badge = document.createElement('span');
        badge.className = 'qa-adjudication__reason';
        badge.textContent = formatReasonLabel(reason);
        reasonWrap.appendChild(badge);
      });
    } else {
      const empty = document.createElement('span');
      empty.textContent = '—';
      reasonWrap.appendChild(empty);
    }
    reasonCell.appendChild(reasonWrap);
    row.appendChild(reasonCell);

    const passesCell = document.createElement('td');
    passesCell.className = 'qa-adjudication__passes';
    passesCell.textContent = entry.passAnnotators && entry.passAnnotators.length
      ? entry.passAnnotators.join(' / ')
      : '—';
    row.appendChild(passesCell);

    const ageCell = document.createElement('td');
    ageCell.textContent = formatAdjudicationAge(entry.queuedAt);
    row.appendChild(ageCell);

    const statusCell = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `qa-adjudication__status ${getAdjudicationStatusClass(entry.status)}`;
    statusBadge.textContent = formatAdjudicationStatus(entry.status);
    statusCell.appendChild(statusBadge);
    if (entry.assignee) {
      const assignee = document.createElement('span');
      assignee.className = 'qa-adjudication__assignee';
      assignee.textContent = `Assigned to ${entry.assignee}`;
      statusCell.appendChild(assignee);
    }
    row.appendChild(statusCell);

    const diffCell = document.createElement('td');
    const diffWrap = document.createElement('div');
    diffWrap.className = 'qa-adjudication__diff-badges';
    diffWrap.appendChild(buildDiffBadge('cs', 'CS Δ'));
    diffWrap.appendChild(buildDiffBadge('vt', 'VT Δ'));
    diffWrap.appendChild(buildDiffBadge('rttm', 'RTTM Δ'));
    diffCell.appendChild(diffWrap);
    row.appendChild(diffCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'qa-adjudication__actions';
    const assignButton = document.createElement('button');
    assignButton.type = 'button';
    assignButton.className = 'qa-adjudication__button qa-adjudication__button--primary';
    assignButton.dataset.role = 'adjudication-action';
    assignButton.dataset.action = 'assign';
    assignButton.textContent = 'Assign to me';

    const reviewerId = getReviewerId();
    const normalizedStatus = entry.status || 'pending';
    const lockedStatuses = new Set(['locked', 'resolved', 'in_review']);
    const alreadyMine = entry.assignee && reviewerId && entry.assignee === reviewerId;
    if (lockedStatuses.has(normalizedStatus) || alreadyMine) {
      assignButton.disabled = true;
    }

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'qa-adjudication__button qa-adjudication__button--subtle';
    openButton.dataset.role = 'adjudication-action';
    openButton.dataset.action = 'open';
    openButton.textContent = 'Open';

    const promoteButton = document.createElement('button');
    promoteButton.type = 'button';
    promoteButton.className = 'qa-adjudication__button qa-adjudication__button--subtle';
    promoteButton.dataset.role = 'adjudication-action';
    promoteButton.dataset.action = 'promote';
    promoteButton.textContent = 'Promote';
    const canPromote = normalizedStatus === 'assigned' && hasAdjudicationAssetOpened(entry.assetId);
    promoteButton.disabled = !canPromote;

    actionsCell.appendChild(assignButton);
    actionsCell.appendChild(openButton);
    actionsCell.appendChild(promoteButton);
    row.appendChild(actionsCell);

    const cache = ensureAdjudicationDiffCache().get(entry.assetId);
    updateDiffBadgeElement(row, 'cs', cache);
    updateDiffBadgeElement(row, 'vt', cache);
    updateDiffBadgeElement(row, 'rttm', cache);

    return row;
  }

  function renderAdjudicationQueue() {
    if (!adjudicationUI.initialized) return;
    updateAdjudicationFilterOptions();
    syncAdjudicationFilterInputs();
    updateAdjudicationFooter();

    const status = ensureAdjudicationStatus(adjudicationState);
    const entries = getFilteredAdjudicationEntries();
    const totalEntries = entries.length;
    const totalPages = totalEntries > 0 ? Math.ceil(totalEntries / ADJUDICATION_PAGE_SIZE) : 1;
    if (adjudicationUI.state.page > totalPages) {
      adjudicationUI.state.page = totalPages;
      updateAdjudicationQueryParams();
    }
    if (adjudicationUI.state.page < 1) adjudicationUI.state.page = 1;
    const page = adjudicationUI.state.page;
    const startIndex = (page - 1) * ADJUDICATION_PAGE_SIZE;
    const pageEntries = entries.slice(startIndex, startIndex + ADJUDICATION_PAGE_SIZE);

    if (adjudicationUI.tableWrapper) {
      adjudicationUI.tableWrapper.setAttribute('aria-busy', status === 'loading' ? 'true' : 'false');
    }

    if (adjudicationUI.tableBody) {
      adjudicationUI.tableBody.innerHTML = '';
      pageEntries.forEach((entry) => {
        adjudicationUI.tableBody.appendChild(buildAdjudicationRow(entry));
      });
    }

    if (adjudicationUI.emptyMessage) {
      if (pageEntries.length === 0) {
        if (status === 'loading' && !(adjudicationState.entries || []).length) {
          adjudicationUI.emptyMessage.textContent = 'Loading adjudication queue…';
        } else if (status === 'error') {
          adjudicationUI.emptyMessage.textContent = 'Unable to load adjudication queue.';
        } else {
          adjudicationUI.emptyMessage.textContent = 'No items match your filters.';
        }
        adjudicationUI.emptyMessage.classList.remove('hide');
      } else {
        adjudicationUI.emptyMessage.classList.add('hide');
      }
    }

    if (adjudicationUI.pagination.container) {
      if (totalEntries > 0) adjudicationUI.pagination.container.classList.remove('hide');
      else adjudicationUI.pagination.container.classList.add('hide');
    }

    if (adjudicationUI.pagination.prev) {
      adjudicationUI.pagination.prev.disabled = page <= 1;
    }
    if (adjudicationUI.pagination.next) {
      adjudicationUI.pagination.next.disabled = page >= totalPages || totalEntries === 0;
    }
    if (adjudicationUI.pagination.info) {
      if (totalEntries === 0) {
        if (status === 'loading' && !(adjudicationState.entries || []).length) {
          adjudicationUI.pagination.info.textContent = 'Loading…';
        } else {
          adjudicationUI.pagination.info.textContent = 'No results';
        }
      } else {
        const startDisplay = startIndex + 1;
        const endDisplay = startIndex + pageEntries.length;
        adjudicationUI.pagination.info.textContent = `Showing ${startDisplay}–${endDisplay} of ${totalEntries}`;
      }
    }

    if (adjudicationUI.metaLabel) {
      if (status === 'loading' && !(adjudicationState.entries || []).length) {
        adjudicationUI.metaLabel.textContent = 'Loading adjudication queue…';
      } else if (status === 'error') {
        adjudicationUI.metaLabel.textContent = 'Unable to load adjudication queue.';
      } else {
        const updated = adjudicationState.lastUpdated ? formatRelativeTimestamp(adjudicationState.lastUpdated) : '';
        adjudicationUI.metaLabel.textContent = updated || '';
      }
    }
  }

  function handleStatusFilterChange() {
    const select = adjudicationUI.filters.status;
    if (!select) return;
    adjudicationUI.state.status = new Set(Array.from(select.selectedOptions || []).map((option) => option.value));
    adjudicationUI.state.page = 1;
    updateAdjudicationQueryParams();
    renderAdjudicationQueue();
  }

  function handleCellFilterChange() {
    const select = adjudicationUI.filters.cell;
    if (!select) return;
    const value = select.value;
    adjudicationUI.state.cell = value && value !== 'all' ? value : 'all';
    adjudicationUI.state.page = 1;
    updateAdjudicationQueryParams();
    renderAdjudicationQueue();
  }

  function handleReasonFilterChange() {
    const select = adjudicationUI.filters.reason;
    if (!select) return;
    adjudicationUI.state.reasons = new Set(Array.from(select.selectedOptions || []).map((option) => option.value));
    adjudicationUI.state.page = 1;
    updateAdjudicationQueryParams();
    renderAdjudicationQueue();
  }

  function handleAdjudicationSearchInput() {
    if (!adjudicationUI.filters.search) return;
    const value = adjudicationUI.filters.search.value || '';
    if (adjudicationSearchTimer) clearTimeout(adjudicationSearchTimer);
    adjudicationSearchTimer = setTimeout(() => {
      adjudicationUI.state.search = value.trim();
      adjudicationUI.state.page = 1;
      updateAdjudicationQueryParams();
      renderAdjudicationQueue();
    }, 200);
  }

  function handleQueueActionClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('button[data-role="adjudication-action"]');
    if (!button) return;
    const row = button.closest('tr[data-asset-id]');
    if (!row) return;
    const assetId = row.dataset.assetId;
    if (!assetId) return;
    const action = button.dataset.action;
    if (action === 'assign') {
      handleAdjudicationAssign(assetId, button);
    } else if (action === 'open') {
      handleAdjudicationOpen(assetId, event);
    } else if (action === 'promote') {
      handleAdjudicationPromote(assetId, button);
    }
  }

  function handleAdjudicationAssign(assetId, button) {
    if (!assetId) return;
    let targetButton = button;
    if (!targetButton) {
      const row = findAdjudicationRow(assetId);
      if (row) {
        targetButton = row.querySelector('button[data-action="assign"]');
      }
    }
    if (!targetButton || targetButton.disabled) return;

    const entry = getAdjudicationEntry(assetId);
    if (!entry) return;

    const reviewer = getReviewerId();
    const originalText = targetButton.textContent;
    targetButton.disabled = true;
    targetButton.textContent = 'Assigning…';

    fetch('/api/adjudication/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: assetId, assignee: reviewer }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('assign_failed');
        return response.json().catch(() => ({}));
      })
      .then((data) => {
        const nextStatus = typeof data.status === 'string' ? data.status.toLowerCase() : 'assigned';
        entry.status = nextStatus;
        entry.assignee = data.assignee || reviewer;
        entry.lastSeenAt = data.last_seen_at || new Date().toISOString();
        adjudicationState.counts = computeAdjudicationCounts(adjudicationState.entries);
        adjudicationState.lastUpdated = new Date().toISOString();
        adjudicationState.status = 'ready';
        if (adjudicationErrorToast) {
          dismissToast(adjudicationErrorToast);
          adjudicationErrorToast = null;
        }
        renderAdjudicationTile(adjudicationState);
        renderAdjudicationQueue();
        renderIRRTile(irrSummaryState, irrTrendState);
        renderVoiceTagTile(irrSummaryState, irrTrendState);
      })
      .catch(() => {
        targetButton.disabled = false;
        targetButton.textContent = originalText;
        if (adjudicationErrorToast) dismissToast(adjudicationErrorToast);
        adjudicationErrorToast = showToast(`Unable to assign ${assetId}.`, {
          variant: 'error',
          actions: [
            {
              label: 'Retry',
              onClick: () => handleAdjudicationAssign(assetId),
            },
          ],
          duration: 0,
        });
      });
  }

  function handleAdjudicationOpen(assetId, event) {
    if (!assetId) return;
    markAdjudicationAssetOpened(assetId);
    renderAdjudicationQueue();
    const url = `/stage2/review.html?asset_id=${encodeURIComponent(assetId)}`;
    if (event && (event.metaKey || event.ctrlKey)) {
      window.open(url, '_blank', 'noopener');
    } else {
      window.location.href = url;
    }
  }

  function handleAdjudicationPromote(assetId, button) {
    if (!assetId) return;
    if (button && button.disabled) return;
    showToast('Promote flow will be available soon.', { duration: 4000 });
  }

  function initAdjudicationQueueUI() {
    if (adjudicationUI.initialized || typeof document === 'undefined') return;
    const container = document.getElementById('adjudication');
    if (!container) return;
    adjudicationUI.initialized = true;
    adjudicationUI.container = container;
    adjudicationUI.metaLabel = document.getElementById('qaAdjudicationMeta');
    adjudicationUI.filters.status = document.getElementById('qaAdjudicationStatusFilter');
    adjudicationUI.filters.cell = document.getElementById('qaAdjudicationCellFilter');
    adjudicationUI.filters.reason = document.getElementById('qaAdjudicationReasonFilter');
    adjudicationUI.filters.search = document.getElementById('qaAdjudicationSearch');
    adjudicationUI.tableBody = document.getElementById('qaAdjudicationTableBody');
    adjudicationUI.tableWrapper = document.getElementById('qaAdjudicationTableWrapper');
    adjudicationUI.emptyMessage = document.getElementById('qaAdjudicationEmpty');
    adjudicationUI.pagination.container = document.getElementById('qaAdjudicationPagination');
    adjudicationUI.pagination.prev = document.getElementById('qaAdjudicationPrev');
    adjudicationUI.pagination.next = document.getElementById('qaAdjudicationNext');
    adjudicationUI.pagination.info = document.getElementById('qaAdjudicationPageInfo');
    adjudicationUI.footer.config = document.getElementById('qaAdjudicationConfig');
    adjudicationUI.footer.snapshot = document.getElementById('qaAdjudicationSnapshot');

    readAdjudicationFiltersFromQuery();
    updateAdjudicationFilterOptions();
    syncAdjudicationFilterInputs();
    updateAdjudicationFooter();

    if (adjudicationUI.filters.status) {
      adjudicationUI.filters.status.addEventListener('change', handleStatusFilterChange);
    }
    if (adjudicationUI.filters.cell) {
      adjudicationUI.filters.cell.addEventListener('change', handleCellFilterChange);
    }
    if (adjudicationUI.filters.reason) {
      adjudicationUI.filters.reason.addEventListener('change', handleReasonFilterChange);
    }
    if (adjudicationUI.filters.search) {
      adjudicationUI.filters.search.addEventListener('input', handleAdjudicationSearchInput);
    }
    if (adjudicationUI.pagination.prev) {
      adjudicationUI.pagination.prev.addEventListener('click', () => {
        setAdjudicationPage(adjudicationUI.state.page - 1);
      });
    }
    if (adjudicationUI.pagination.next) {
      adjudicationUI.pagination.next.addEventListener('click', () => {
        setAdjudicationPage(adjudicationUI.state.page + 1);
      });
    }
    if (adjudicationUI.tableBody) {
      adjudicationUI.tableBody.addEventListener('click', handleQueueActionClick);
      adjudicationUI.tableBody.addEventListener('mouseover', handleQueueRowPreview);
      adjudicationUI.tableBody.addEventListener('focusin', handleQueueRowPreview);
    }

    renderAdjudicationQueue();
  }

  function adjudicationHasOpenQueue() {
    const counts = adjudicationState && adjudicationState.counts ? adjudicationState.counts : null;
    if (!counts) return false;
    return (Number(counts.pending) || 0) + (Number(counts.assigned) || 0) > 0;
  }

  function ensureAdjudicationStatus(state) {
    if (!state || typeof state !== 'object') return 'idle';
    return state.status || 'idle';
  }

  function ensureAdjudicationCounts(state) {
    if (!state || typeof state !== 'object' || !state.counts) {
      return { pending: 0, assigned: 0, locked: 0 };
    }
    const { pending = 0, assigned = 0, locked = 0 } = state.counts;
    return {
      pending: Number.isFinite(pending) ? pending : 0,
      assigned: Number.isFinite(assigned) ? assigned : 0,
      locked: Number.isFinite(locked) ? locked : 0,
    };
  }

  function applyTileStatus(elements, status, customLabel) {
    if (!elements || !elements.tile) return;
    const tile = elements.tile;
    const statuses = Object.values(QA_STATUS_CLASS_MAP);
    statuses.forEach((className) => tile.classList.remove(className));
    const className = QA_STATUS_CLASS_MAP[status] || QA_STATUS_CLASS_MAP.neutral;
    tile.classList.add(className);
    if (elements.statusTextEl) {
      elements.statusTextEl.textContent = customLabel || QA_STATUS_LABELS[status] || QA_STATUS_LABELS.neutral;
    }
    tile.setAttribute('data-qa-status', status || 'neutral');
  }

  function applyIrrQueueBadge(tileElements) {
    if (!tileElements || !tileElements.labelEl) return;
    const needsBadge = adjudicationHasOpenQueue();
    const labelEl = tileElements.labelEl;
    let badge = labelEl.querySelector('.qa-dashboard-tile__badge[data-role="adjudication-badge"]');
    if (needsBadge) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'qa-dashboard-tile__badge';
        badge.dataset.role = 'adjudication-badge';
        badge.textContent = 'Queue';
        badge.setAttribute('aria-label', 'Adjudication queue pending');
        badge.title = 'Pending adjudication items require attention';
        badge.style.backgroundColor = '#d32f2f';
        badge.style.color = '#fff';
        labelEl.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function determineStatus(value, thresholds, direction = 'higher') {
    if (!Number.isFinite(value)) return 'neutral';
    const { green, amber } = thresholds || {};
    if (direction === 'lower') {
      if (Number.isFinite(green) && value <= green) return 'green';
      if (Number.isFinite(amber) && value <= amber) return 'amber';
      return 'red';
    }
    if (Number.isFinite(green) && value >= green) return 'green';
    if (Number.isFinite(amber) && value >= amber) return 'amber';
    return 'red';
  }

  function formatPercentMetric(value) {
    if (!Number.isFinite(value)) return null;
    const percent = clamp01(value) * 100;
    const decimals = percent >= 99.95 ? 0 : percent >= 10 ? 1 : 2;
    return `${percent.toFixed(decimals)}%`;
  }

  function formatSecondsMetric(value) {
    if (!Number.isFinite(value)) return null;
    const normalized = Math.max(0, value);
    const decimals = normalized >= 10 ? 1 : normalized >= 1 ? 2 : 3;
    return `${normalized.toFixed(decimals)}s`;
  }

  function formatAlphaDisplay(value) {
    const numeric = toFinite(value);
    if (!Number.isFinite(numeric)) return '—';
    const clamped = clamp01(numeric);
    const decimals = clamped >= 0.995 ? 2 : clamped >= 0.1 ? 3 : 4;
    const text = clamped.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
    return text || clamped.toFixed(2);
  }

  function parseTimestamp(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e12) return value;
      if (value > 1e9) return value * 1000;
      if (value > 1e6) return value * 1000;
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const direct = Number(trimmed);
      if (Number.isFinite(direct)) {
        if (direct > 1e12) return direct;
        if (direct > 1e9) return direct * 1000;
        if (direct > 1e6) return direct * 1000;
        return direct;
      }
      const parsed = Date.parse(trimmed);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  function parseBooleanFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      if (value === 1) return true;
      if (value === 0) return false;
    }
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (!lower) return null;
      if (['true', '1', 'yes', 'y', 'present', 'pass'].includes(lower)) return true;
      if (['false', '0', 'no', 'n', 'absent', 'fail'].includes(lower)) return false;
    }
    return null;
  }

  function normalizeCellKey(cell) {
    if (!cell) return 'unknown';
    if (typeof cell === 'string') {
      const trimmed = cell.trim();
      return trimmed || 'unknown';
    }
    if (Array.isArray(cell)) {
      const parts = cell
        .map((part) => (part != null ? String(part).trim() : ''))
        .filter((part) => part);
      return parts.length ? parts.join(':') : 'unknown';
    }
    if (typeof cell === 'object') {
      const direct =
        cell.cell_key ||
        cell.cellKey ||
        cell.key ||
        cell.id ||
        cell.name ||
        (typeof cell.cell === 'string' ? cell.cell : null);
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
      const parts = ['language', 'domain', 'subset', 'bucket', 'label']
        .map((key) => (cell[key] != null ? String(cell[key]).trim() : ''))
        .filter(Boolean);
      if (parts.length) return parts.join(':');
    }
    return 'unknown';
  }

  function formatCellLabel(cellKey) {
    if (!cellKey) return 'Unknown cell';
    return String(cellKey)
      .split(':')
      .map((part) =>
        part
          .replace(/[_\-]+/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase())
          .trim()
      )
      .filter(Boolean)
      .join(' • ');
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function describeTrendSeries(series) {
    if (!Array.isArray(series) || !series.length) return '';
    return series
      .map((point) => {
        const valueText = formatAlphaDisplay(point.value);
        if (!point) return valueText;
        const label = point.label || (point.ts ? new Date(point.ts).toLocaleDateString() : '');
        return label ? `${label}: ${valueText}` : valueText;
      })
      .join('; ');
  }

  function renderSparkline(container, series, options = {}) {
    if (!container) return;
    container.innerHTML = '';
    const sanitized = Array.isArray(series)
      ? series
          .map((point, index) => {
            if (!point || typeof point !== 'object') return null;
            const value = toFinite(point.value ?? point.alpha ?? point.y ?? point.score);
            if (!Number.isFinite(value)) return null;
            const ts =
              point.ts != null
                ? parseTimestamp(point.ts)
                : parseTimestamp(point.date || point.day || point.timestamp);
            const label =
              point.label ||
              (ts != null
                ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : point.date || point.day || `Day ${index + 1}`);
            return {
              value,
              ts,
              label,
            };
          })
          .filter(Boolean)
      : [];

    if (!sanitized.length) {
      const empty = document.createElement('span');
      empty.className = 'qa-dashboard-tile__sparkline-empty';
      empty.textContent = options.emptyText || 'No trend data';
      container.appendChild(empty);
      return;
    }

    const width = options.width || 140;
    const height = options.height || 36;
    const paddingX = options.paddingX != null ? options.paddingX : 6;
    const paddingY = options.paddingY != null ? options.paddingY : 6;
    const values = sanitized.map((point) => point.value);
    const minValue = Math.min.apply(null, values);
    const maxValue = Math.max.apply(null, values);
    const range = maxValue - minValue || 1;
    const usableWidth = Math.max(1, width - paddingX * 2);
    const usableHeight = Math.max(1, height - paddingY * 2);
    const step = sanitized.length > 1 ? usableWidth / (sanitized.length - 1) : 0;

    const points = sanitized.map((point, index) => {
      const normalized = (point.value - minValue) / range;
      const x = paddingX + step * index;
      const y = height - paddingY - normalized * usableHeight;
      return { x, y, data: point };
    });

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    const ariaLabel = options.ariaLabel || 'Trend over time';
    svg.setAttribute('aria-label', ariaLabel);

    const desc = document.createElementNS(SVG_NS, 'desc');
    desc.textContent = options.description || describeTrendSeries(sanitized);
    svg.appendChild(desc);

    if (options.showArea !== false && points.length) {
      const areaPathParts = [`M${points[0].x} ${height - paddingY}`];
      points.forEach((point) => {
        areaPathParts.push(`L${point.x} ${point.y}`);
      });
      areaPathParts.push(`L${points[points.length - 1].x} ${height - paddingY} Z`);
      const areaPath = document.createElementNS(SVG_NS, 'path');
      areaPath.setAttribute('d', areaPathParts.join(' '));
      areaPath.classList.add('qa-dashboard-tile__sparkline-area');
      svg.appendChild(areaPath);
    }

    const pathParts = points.map((point, index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command}${point.x} ${point.y}`;
    });
    if (pathParts.length === 1) {
      pathParts.push(`L${points[0].x + Math.max(10, usableWidth)} ${points[0].y}`);
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathParts.join(' '));
    path.classList.add('qa-dashboard-tile__sparkline-path');
    svg.appendChild(path);

    points.forEach((point) => {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', point.x);
      circle.setAttribute('cy', point.y);
      circle.setAttribute('r', 1.8);
      circle.setAttribute('fill', 'currentColor');
      if (point.data) {
        const title = document.createElementNS(SVG_NS, 'title');
        const valueText = formatAlphaDisplay(point.data.value);
        title.textContent = point.data.label
          ? `${point.data.label}: α ${valueText}`
          : `α ${valueText}`;
        circle.appendChild(title);
      }
      svg.appendChild(circle);
    });

    container.appendChild(svg);
  }

  function ensureTileSparklineContainer(tileElements) {
    if (!tileElements || !tileElements.tile) return null;
    let container = tileElements.tile.querySelector('.qa-dashboard-tile__sparkline');
    if (!container) {
      container = document.createElement('div');
      container.className = 'qa-dashboard-tile__sparkline';
      if (tileElements.captionEl && tileElements.captionEl.parentNode) {
        tileElements.captionEl.parentNode.insertBefore(
          container,
          tileElements.captionEl
        );
      } else {
        tileElements.tile.appendChild(container);
      }
    }
    return container;
  }

  function ensureTileMetaElement(tileElements, className = 'qa-dashboard-tile__meta') {
    if (!tileElements || !tileElements.tile) return null;
    let element = tileElements.tile.querySelector(`.${className}`);
    if (!element) {
      element = document.createElement('p');
      element.className = className;
      tileElements.tile.appendChild(element);
    }
    return element;
  }

  function extractHasCSVotes(source, options = {}) {
    if (!source || typeof source !== 'object') return [];
    const visited = new Set();
    const votes = [];

    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }

      const valueCandidate =
        node.has_cs ??
        node.hasCS ??
        node.code_switch ??
        node.codeswitch ??
        node.has_cs_vote ??
        node.has_code_switch ??
        node.vote ??
        node.value;
      const parsedValue = parseBooleanFlag(valueCandidate);
      const passCandidate =
        node.pass ??
        node.pass_number ??
        node.passNumber ??
        node.round ??
        node.iteration ??
        node.stage ??
        node.qa_pass ??
        node.qa_pass_number ??
        node.pass_index;
      const annotatorCandidate =
        node.annotator_id ??
        node.annotatorId ??
        node.annotator ??
        node.worker_id ??
        node.workerId ??
        node.worker ??
        node.user ??
        node.user_id ??
        node.editor ??
        node.reviewer ??
        node.reviewer_id ??
        options.annotatorId ??
        null;

      if (parsedValue !== null) {
        const passNumeric = toFinite(passCandidate);
        votes.push({
          annotatorId: annotatorCandidate != null ? String(annotatorCandidate) : null,
          pass: Number.isFinite(passNumeric) ? Math.round(passNumeric) : null,
          value: parsedValue,
          raw: node,
        });
      }

      const nestedCandidates = [
        node.votes,
        node.passes,
        node.annotations,
        node.annotators,
        node.qa,
        node.metrics,
      ];
      nestedCandidates.forEach((candidate) => {
        if (candidate && typeof candidate === 'object') visit(candidate);
      });

      Object.keys(node).forEach((key) => {
        if (
          key === 'votes' ||
          key === 'passes' ||
          key === 'annotations' ||
          key === 'annotators' ||
          key === 'qa' ||
          key === 'metrics'
        ) {
          return;
        }
        const candidate = node[key];
        if (candidate && typeof candidate === 'object') visit(candidate);
      });
    }

    visit(source);

    const seen = new Set();
    return votes.filter((vote) => {
      if (vote.value == null) return false;
      const key = `${vote.annotatorId || 'unknown'}::${vote.pass != null ? vote.pass : 'na'}::${vote.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function deriveCellKeyFromSource(source, fallbackCellKey) {
    if (!source || typeof source !== 'object') return fallbackCellKey || 'unknown';
    const candidates = [
      source.cell,
      source.cell_key,
      source.cellKey,
      source.key,
      source.id,
      source.name,
      source.dataset_cell,
      source.datasetCell,
      source.cell_name,
      source.cellName,
      source.meta && (source.meta.cell || source.meta.cell_key || source.meta.cellKey),
      source.metadata && (source.metadata.cell || source.metadata.cell_key || source.metadata.cellKey),
      source.task && (source.task.cell || source.task.cell_key || source.task.cellKey),
      source.context && (source.context.cell || source.context.cell_key || source.context.cellKey),
      fallbackCellKey,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const normalized = normalizeCellKey(candidate);
      if (normalized && normalized !== 'unknown') return normalized;
    }
    return fallbackCellKey || 'unknown';
  }

  function normalizeDisagreementEntry(entry, fallbackCellKey) {
    if (!entry || typeof entry !== 'object') return null;
    const assetIdRaw =
      entry.assetId ||
      entry.asset_id ||
      entry.clip_id ||
      entry.clipId ||
      entry.id ||
      (entry.asset && (entry.asset.asset_id || entry.asset.id)) ||
      null;
    const timestamp = parseTimestamp(
      entry.timestamp ||
        entry.updated_at ||
        entry.updatedAt ||
        entry.reviewed_at ||
        entry.completed_at ||
        entry.created_at ||
        entry.createdAt ||
        (entry.meta && entry.meta.timestamp)
    );
    const cellKey = deriveCellKeyFromSource(entry, fallbackCellKey);

    const collectedVotes = [];
    [entry, entry.qa, entry.annotations, entry.passes, entry.votes, entry.metrics, entry.details].forEach(
      (candidate) => {
        if (!candidate) return;
        const votes = extractHasCSVotes(candidate);
        if (votes && votes.length) collectedVotes.push(...votes);
      }
    );

    const forceInclude = parseBooleanFlag(entry.forceInclude ?? entry.force_include);
    const seenVotes = new Map();
    const normalizedVotes = collectedVotes
      .filter((vote) => typeof vote === 'object' && typeof vote.value === 'boolean')
      .map((vote) => {
        const annotatorId = vote.annotatorId ? String(vote.annotatorId) : 'unknown';
        const pass = Number.isFinite(vote.pass) ? Math.round(vote.pass) : null;
        const key = `${annotatorId}::${pass != null ? pass : 'na'}`;
        if (seenVotes.has(key)) return null;
        seenVotes.set(key, true);
        const providedLabel =
          typeof vote.label === 'string' && vote.label.trim() ? vote.label.trim() : null;
        return {
          annotatorId,
          pass,
          value: !!vote.value,
          label: providedLabel || (vote.value ? 'Yes' : 'No'),
          raw: vote.raw || vote,
        };
      })
      .filter(Boolean);

    if (!normalizedVotes.length) return null;
    const distinctValues = new Set(normalizedVotes.map((vote) => vote.value));
    if (!forceInclude && (normalizedVotes.length < 2 || distinctValues.size < 2)) return null;

    normalizedVotes.sort((a, b) => {
      if (a.pass != null && b.pass != null && a.pass !== b.pass) return a.pass - b.pass;
      if (a.annotatorId && b.annotatorId) return a.annotatorId.localeCompare(b.annotatorId);
      return 0;
    });

    const assetLabel =
      entry.asset_label ||
      entry.assetLabel ||
      entry.clip_name ||
      entry.clip ||
      entry.title ||
      (assetIdRaw != null ? String(assetIdRaw) : 'Unknown asset');

    const keyBase = `${cellKey || 'unknown'}::${assetIdRaw || ''}`.trim();
    const stableKey = keyBase && keyBase !== '::'
      ? keyBase
      : `${cellKey || 'unknown'}::${timestamp != null ? `ts-${timestamp}` : `rand-${Math.random().toString(36).slice(2)}`}`;

    const result = {
      key: stableKey,
      assetId: assetIdRaw != null ? String(assetIdRaw) : null,
      assetLabel,
      cellKey: cellKey || 'unknown',
      cellLabel: formatCellLabel(cellKey || 'unknown'),
      votes: normalizedVotes,
      timestamp: timestamp ?? null,
    };
    const filterKey = entry.filterKey || entry.filter_key;
    if (filterKey) result.filterKey = String(filterKey);
    if (forceInclude) result.forceInclude = true;
    const cueStart = toFinite(entry.cueStart ?? entry.cue_start ?? entry.start);
    if (Number.isFinite(cueStart)) result.cueStart = cueStart;
    const cueEnd = toFinite(entry.cueEnd ?? entry.cue_end ?? entry.end);
    if (Number.isFinite(cueEnd)) result.cueEnd = cueEnd;
    return result;
  }

  function normalizeDisagreementEntries(collection, fallbackCellKey) {
    if (!collection) return [];
    const list = Array.isArray(collection)
      ? collection
      : typeof collection === 'object'
        ? Object.values(collection)
        : [];
    return list
      .map((item) => normalizeDisagreementEntry(item, fallbackCellKey))
      .filter(Boolean);
  }

  function dedupeDisagreements(list) {
    const map = new Map();
    (list || []).forEach((entry) => {
      if (!entry || !entry.key) return;
      if (!map.has(entry.key)) {
        map.set(entry.key, entry);
      }
    });
    return Array.from(map.values());
  }

  function computeDisagreementsFromAssets(assets, defaultCellKey) {
    if (!Array.isArray(assets)) return [];
    const results = [];
    assets.forEach((asset) => {
      if (!asset || typeof asset !== 'object') return;
      const cellKey = deriveCellKeyFromSource(asset, defaultCellKey);
      const assetClone = Object.assign({}, asset);
      if (assetClone && !assetClone.asset_id && assetClone.id) {
        assetClone.asset_id = assetClone.id;
      }
      if (cellKey && !assetClone.cell) {
        assetClone.cell = cellKey;
      }
      const normalized = normalizeDisagreementEntry(assetClone, cellKey);
      if (normalized) results.push(normalized);
    });
    return results;
  }

  function computeDoublePassFromAssets(assets) {
    if (!Array.isArray(assets)) return null;
    const normalized = [];
    assets.forEach((asset) => {
      if (!asset || typeof asset !== 'object') return;
      const assetId =
        asset.assetId ||
        asset.asset_id ||
        asset.clip_id ||
        asset.clipId ||
        asset.id ||
        (asset.asset && (asset.asset.asset_id || asset.asset.id)) ||
        null;
      const timestamp = parseTimestamp(
        asset.timestamp ||
          asset.updated_at ||
          asset.updatedAt ||
          asset.completed_at ||
          asset.completedAt ||
          asset.reviewed_at ||
          (asset.meta && asset.meta.timestamp)
      );
      const passCountCandidates = [
        toFinite(asset.pass_count),
        toFinite(asset.passCount),
        toFinite(asset.double_pass_count),
        toFinite(asset.doublePassCount),
      ];
      let passCount = null;
      passCountCandidates.forEach((candidate) => {
        if (Number.isFinite(candidate)) {
          const rounded = Math.max(0, Math.round(candidate));
          passCount = passCount == null ? rounded : Math.max(passCount, rounded);
        }
      });
      const passesArray = Array.isArray(asset.passes)
        ? asset.passes
        : asset.passes && typeof asset.passes === 'object'
          ? Object.values(asset.passes)
          : [];
      if (passesArray.length) {
        passCount = passCount == null ? passesArray.length : Math.max(passCount, passesArray.length);
      }
      const votes = extractHasCSVotes(asset);
      if (votes.length) {
        passCount = passCount == null ? votes.length : Math.max(passCount, votes.length);
      }
      const cellKey = deriveCellKeyFromSource(asset, null);
      const assetClone = Object.assign({}, asset);
      if (!assetClone.asset_id && assetId) assetClone.asset_id = assetId;
      if (cellKey && !assetClone.cell) assetClone.cell = cellKey;
      normalized.push({
        assetId: assetId ? String(assetId) : null,
        timestamp: timestamp ?? 0,
        passCount: Number.isFinite(passCount) ? Math.max(0, Math.round(passCount)) : votes.length,
        cellKey,
        source: assetClone,
      });
    });
    if (!normalized.length) return null;
    normalized.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const sampleSize = Math.min(200, normalized.length);
    const windowAssets = normalized.slice(0, sampleSize);
    const doublePassCount = windowAssets.filter((item) => item.passCount >= 2).length;
    const disagreements = dedupeDisagreements(
      windowAssets
        .map((item) => normalizeDisagreementEntry(item.source, item.cellKey))
        .filter(Boolean)
    );
    return {
      ratio: sampleSize ? doublePassCount / sampleSize : null,
      sampleSize,
      doublePassCount,
      totalCount: normalized.length,
      disagreements,
    };
  }

  function normalizeIrrTrend(raw) {
    if (!raw) return {};

    function normalizeSeries(series) {
      if (!Array.isArray(series)) return [];
      const normalized = series
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const value = toFinite(
            entry.alpha ??
              entry.alpha_global ??
              entry.value ??
              entry.krippendorff_alpha ??
              entry.score ??
              entry.y
          );
          if (!Number.isFinite(value)) return null;
          const ts = parseTimestamp(entry.ts ?? entry.timestamp ?? entry.date ?? entry.day);
          const label =
            entry.label ||
            (ts != null
              ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : entry.date || entry.day || '');
          return { value, ts, label };
        })
        .filter(Boolean);
      normalized.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const start = Math.max(0, normalized.length - 7);
      return normalized.slice(start);
    }

    if (Array.isArray(raw)) {
      return { hasCS: normalizeSeries(raw) };
    }

    const result = {};
    const source =
      raw && typeof raw === 'object'
        ? raw
        : Array.isArray(raw && raw.trend)
          ? { hasCS: raw.trend }
          : {};
    Object.keys(source || {}).forEach((key) => {
      const series = source[key];
      if (Array.isArray(series)) {
        result[key] = normalizeSeries(series);
      }
    });
    return result;
  }

  function normalizeIrrMetric(key, source) {
    if (!source || typeof source !== 'object') return null;
    const alpha = toFinite(
      source.alpha_global ??
        source.alpha ??
        source.global_alpha ??
        source.krippendorff_alpha ??
        source.krippendorffAlpha ??
        source.value
    );
    const nItems = toFinite(
      source.n_items ??
        source.nItems ??
        source.n_items_global ??
        source.items ??
        source.count ??
        source.sample_size ??
        source.sampleSize ??
        source.n
    );
    const cellSources = [];
    if (Array.isArray(source.by_cell)) cellSources.push(...source.by_cell);
    if (Array.isArray(source.cells)) cellSources.push(...source.cells);

    const cells = cellSources
      .map((cell) => {
        if (!cell || typeof cell !== 'object') return null;
        const cellKey = deriveCellKeyFromSource(cell, null);
        if (!cellKey) return null;
        const alphaValue = toFinite(
          cell.alpha ?? cell.value ?? cell.krippendorff_alpha ?? cell.krippendorffAlpha
        );
        const itemsValue = toFinite(
          cell.n_items ??
            cell.nItems ??
            cell.items ??
            cell.count ??
            cell.sample_size ??
            cell.sampleSize ??
            cell.n
        );
        return {
          key: cellKey,
          label: formatCellLabel(cell.label || cellKey),
          alpha: Number.isFinite(alphaValue) ? alphaValue : null,
          nItems: Number.isFinite(itemsValue) ? Math.round(itemsValue) : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));

    const missingVoiceTags = Array.isArray(source.missing_voice_tags || source.missingVoiceTags)
      ? source.missing_voice_tags || source.missingVoiceTags
      : [];

    return {
      key,
      alpha: Number.isFinite(alpha) ? alpha : null,
      nItems: Number.isFinite(nItems) ? Math.round(nItems) : null,
      cells,
      missingVoiceTags,
      source,
    };
  }

  function normalizeIrrData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const generatedAt = parseTimestamp(
      raw.generated_at ||
        raw.generatedAt ||
        raw.updated_at ||
        raw.updatedAt ||
        raw.timestamp ||
        raw.refreshed_at ||
        raw.refreshedAt
    );
    const metrics = {};
    const metricSources = [];
    const hasCSMetric = raw.hasCS || raw.has_cs;
    if (hasCSMetric && typeof hasCSMetric === 'object') {
      metricSources.push(['hasCS', hasCSMetric]);
    }
    const voiceTagMetric = raw.voiceTag_presence || raw.voice_tag_presence || raw.voiceTagPresence;
    if (voiceTagMetric && typeof voiceTagMetric === 'object') {
      metricSources.push(['voiceTag_presence', voiceTagMetric]);
    }
    if (!metricSources.length) {
      metricSources.push(['hasCS', raw]);
    }

    metricSources.forEach(([key, source]) => {
      const normalized = normalizeIrrMetric(key, source);
      if (normalized) metrics[key] = normalized;
    });

    const defaultMetricKey = metrics.hasCS ? 'hasCS' : Object.keys(metrics)[0] || null;
    const defaultMetric = defaultMetricKey ? metrics[defaultMetricKey] : null;

    const cellMap = new Map();
    if (defaultMetric && Array.isArray(defaultMetric.cells)) {
      defaultMetric.cells.forEach((cell) => {
        if (!cell || !cell.key) return;
        cellMap.set(cell.key, {
          key: cell.key,
          label: cell.label,
          alpha: Number.isFinite(cell.alpha) ? cell.alpha : null,
          nItems: Number.isFinite(cell.nItems) ? cell.nItems : null,
        });
      });
    }

    const disagreements = [];
    disagreements.push(...normalizeDisagreementEntries(raw.disagreements || raw.mismatches, null));
    if (Array.isArray(raw.assets)) {
      disagreements.push(...computeDisagreementsFromAssets(raw.assets, null));
    }
    if (raw.assets && typeof raw.assets === 'object' && !Array.isArray(raw.assets)) {
      disagreements.push(...computeDisagreementsFromAssets(Object.values(raw.assets), null));
    }
    if (Array.isArray(raw.assets_with_disagreement)) {
      disagreements.push(...normalizeDisagreementEntries(raw.assets_with_disagreement, null));
    }
    Object.values(metrics).forEach((metric) => {
      if (!metric || !metric.source) return;
      const metricSource = metric.source;
      if (Array.isArray(metricSource.disagreements)) {
        disagreements.push(...normalizeDisagreementEntries(metricSource.disagreements, null));
      }
      if (Array.isArray(metricSource.mismatches)) {
        disagreements.push(...normalizeDisagreementEntries(metricSource.mismatches, null));
      }
      if (Array.isArray(metricSource.cells)) {
        metricSource.cells.forEach((cell) => {
          const key = deriveCellKeyFromSource(cell, null);
          if (!key) return;
          if (!cellMap.has(key)) {
            cellMap.set(key, {
              key,
              label: formatCellLabel(cell.label || key),
              alpha: null,
              nItems: null,
            });
          }
        });
      }
    });

    const voiceTagMissingEntries = metrics.voiceTag_presence
      ? normalizeVoiceTagMissingEntries(metrics.voiceTag_presence.missingVoiceTags)
      : [];
    if (metrics.voiceTag_presence) {
      metrics.voiceTag_presence.missingEntries = voiceTagMissingEntries;
    }

    return {
      generatedAt,
      metrics,
      defaultMetricKey,
      cells: Array.from(cellMap.values()).sort((a, b) => a.label.localeCompare(b.label)),
      disagreements: dedupeDisagreements(disagreements),
      voiceTagMissingEntries,
    };
  }

  function summarizeCueText(text) {
    if (!text) return '';
    const trimmed = String(text).trim();
    if (!trimmed) return '';
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  }

  function normalizeVoiceTagMissingEntries(list) {
    if (!Array.isArray(list) || !list.length) return [];
    return list
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null;
        const cellKey =
          (typeof item.cell === 'string' && item.cell.trim()) || deriveCellKeyFromSource(item, null) || 'unknown';
        const assetIdRaw = item.asset_id ?? item.assetId ?? null;
        const assetLabel =
          item.asset_label || item.assetLabel || (assetIdRaw != null ? String(assetIdRaw) : 'Unknown asset');
        const start = toFinite(item.start ?? item.cueStart ?? item.begin);
        const end = toFinite(item.end ?? item.cueEnd ?? item.finish);
        const pass1 = item.pass_1 || item.pass1 || {};
        const pass2 = item.pass_2 || item.pass2 || {};
        const voteEntries = [
          {
            annotatorId: pass1.annotator_id ?? pass1.annotatorId ?? null,
            pass: 1,
            value: false,
            label: pass1.text ? `No tag — "${summarizeCueText(pass1.text)}"` : 'No tag',
            raw: pass1,
          },
          {
            annotatorId: pass2.annotator_id ?? pass2.annotatorId ?? null,
            pass: 2,
            value: false,
            label: pass2.text ? `No tag — "${summarizeCueText(pass2.text)}"` : 'No tag',
            raw: pass2,
          },
        ];
        const rawEntry = {
          asset_id: assetIdRaw,
          assetLabel,
          cell: cellKey,
          filterKey: 'voiceTagMissing',
          forceInclude: true,
          cueStart: start,
          cueEnd: end,
          votes: voteEntries,
        };
        const normalized = normalizeDisagreementEntry(rawEntry, cellKey);
        if (!normalized) return null;
        const uniqueKey = `${normalized.key}::voiceTagMissing::${index}`;
        normalized.key = uniqueKey;
        normalized.filterKey = 'voiceTagMissing';
        if (Number.isFinite(start)) normalized.cueStart = start;
        if (Number.isFinite(end)) normalized.cueEnd = end;
        return normalized;
      })
      .filter(Boolean);
  }

  function normalizeDisagreementsFeed(raw) {
    if (!raw) return { entries: [], cells: [] };
    const entries = [];
    const cellMap = new Map();

    function mergeCells(list) {
      list.forEach((cell) => {
        if (!cell || typeof cell !== 'object') return;
        const key = deriveCellKeyFromSource(cell, null);
        if (!key) return;
        const alphaValue = toFinite(
          cell.alpha ?? cell.value ?? cell.krippendorff_alpha ?? cell.krippendorffAlpha
        );
        const itemsValue = toFinite(cell.n_items ?? cell.count ?? cell.items ?? cell.n);
        const existing = cellMap.get(key) || {};
        cellMap.set(key, {
          key,
          label: formatCellLabel(cell.label || existing.label || key),
          alpha: Number.isFinite(alphaValue) ? alphaValue : existing.alpha ?? null,
          nItems: Number.isFinite(itemsValue) ? Math.round(itemsValue) : existing.nItems ?? null,
        });
        entries.push(...normalizeDisagreementEntries(cell.disagreements || cell.mismatches, key));
      });
    }

    if (Array.isArray(raw)) {
      entries.push(...normalizeDisagreementEntries(raw, null));
    } else if (typeof raw === 'object') {
      if (Array.isArray(raw.disagreements)) {
        entries.push(...normalizeDisagreementEntries(raw.disagreements, null));
      }
      if (Array.isArray(raw.assets)) {
        entries.push(...computeDisagreementsFromAssets(raw.assets, null));
      }
      if (Array.isArray(raw.items)) {
        entries.push(...normalizeDisagreementEntries(raw.items, null));
      }
      if (Array.isArray(raw.cells)) {
        mergeCells(raw.cells);
      }
    }

    const cells = Array.from(cellMap.values()).sort((a, b) => a.label.localeCompare(b.label));

    return { entries: dedupeDisagreements(entries), cells };
  }

  function normalizeDoublePassData(raw) {
    if (!raw) return null;
    if (Array.isArray(raw)) {
      return computeDoublePassFromAssets(raw);
    }
    if (typeof raw !== 'object') return null;

    const results = {
      ratio: null,
      sampleSize: null,
      doublePassCount: null,
      totalCount: null,
      disagreements: [],
    };

    if (Array.isArray(raw.assets)) {
      const fromAssets = computeDoublePassFromAssets(raw.assets);
      if (fromAssets) {
        results.ratio = fromAssets.ratio;
        results.sampleSize = fromAssets.sampleSize;
        results.doublePassCount = fromAssets.doublePassCount;
        results.totalCount = fromAssets.totalCount;
        results.disagreements = fromAssets.disagreements || [];
      }
    }

    const windowCandidate =
      raw.last_200 || raw.last200 || raw.window_200 || raw.window200 || raw.window;
    if (windowCandidate && typeof windowCandidate === 'object') {
      const ratioCandidate = toFinite(
        windowCandidate.ratio ||
          windowCandidate.percentage ||
          windowCandidate.percent ||
          windowCandidate.value ||
          windowCandidate.alpha
      );
      const sampleCandidate = toFinite(
        windowCandidate.sample_size ||
          windowCandidate.sampleSize ||
          windowCandidate.total ||
          windowCandidate.count ||
          windowCandidate.window
      );
      const doublePassCandidate = toFinite(
        windowCandidate.double_pass_count ||
          windowCandidate.doublePassCount ||
          windowCandidate.double_pass ||
          windowCandidate.doublePass
      );
      if (Number.isFinite(ratioCandidate)) {
        results.ratio = ratioCandidate > 1 ? ratioCandidate / 100 : ratioCandidate;
      }
      if (Number.isFinite(sampleCandidate)) {
        results.sampleSize = Math.round(sampleCandidate);
      }
      if (Number.isFinite(doublePassCandidate)) {
        results.doublePassCount = Math.round(doublePassCandidate);
      }
      if (Array.isArray(windowCandidate.disagreements)) {
        results.disagreements = normalizeDisagreementEntries(windowCandidate.disagreements, null);
      }
    }

    const ratioCandidate = toFinite(
      raw.ratio || raw.percentage || raw.percent || raw.double_pass_pct || raw.doublePassPct
    );
    if (results.ratio == null && Number.isFinite(ratioCandidate)) {
      results.ratio = ratioCandidate > 1 ? ratioCandidate / 100 : ratioCandidate;
    }
    const sampleCandidate = toFinite(
      raw.sample_size || raw.sampleSize || raw.count || raw.total || raw.window_size
    );
    if (results.sampleSize == null && Number.isFinite(sampleCandidate)) {
      results.sampleSize = Math.round(sampleCandidate);
    }
    const doublePassCandidate = toFinite(
      raw.double_pass_count || raw.doublePassCount || raw.double_pass || raw.doublePass
    );
    if (results.doublePassCount == null && Number.isFinite(doublePassCandidate)) {
      results.doublePassCount = Math.round(doublePassCandidate);
    }
    if (Array.isArray(raw.disagreements)) {
      results.disagreements = normalizeDisagreementEntries(raw.disagreements, null);
    }
    if (Array.isArray(raw.assets_with_disagreement)) {
      results.disagreements = results.disagreements.concat(
        normalizeDisagreementEntries(raw.assets_with_disagreement, null)
      );
    }

    if (results.sampleSize && results.doublePassCount != null && results.ratio == null) {
      results.ratio = results.sampleSize
        ? clamp01(results.doublePassCount / results.sampleSize)
        : null;
    }
    if (results.totalCount == null) {
      const totalCandidate = toFinite(raw.total || raw.total_count || raw.asset_count);
      if (Number.isFinite(totalCandidate)) {
        results.totalCount = Math.round(totalCandidate);
      }
    }

    results.disagreements = dedupeDisagreements(results.disagreements);
    return results;
  }

  function getValueAtPath(source, path) {
    if (!source || typeof source !== 'object') return undefined;
    return path.reduce((acc, key) => {
      if (!acc || typeof acc !== 'object') return undefined;
      return acc[key];
    }, source);
  }

  function findMetricByPatterns(source, patterns) {
    if (!source || typeof source !== 'object') return null;
    const stack = [source];
    const visited = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== 'object') continue;
      if (visited.has(current)) continue;
      visited.add(current);
      const entries = Array.isArray(current)
        ? current.map((value, index) => [String(index), value])
        : Object.entries(current);
      for (const [key, value] of entries) {
        if (value && typeof value === 'object') {
          stack.push(value);
        }
        if (typeof key !== 'string') continue;
        const keyLc = key.toLowerCase();
        const matches = patterns.some((pattern) => pattern.every((piece) => keyLc.includes(piece)));
        if (!matches) continue;
        if (value != null && typeof value === 'object' && 'value' in value) {
          const nested = toFinite(value.value);
          if (Number.isFinite(nested)) return nested;
        }
        const candidate = toFinite(value);
        if (Number.isFinite(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  function getMetricFromSummary(summary, options = {}) {
    if (!summary || typeof summary !== 'object') return null;
    const paths = Array.isArray(options.paths) ? options.paths : [];
    for (const path of paths) {
      const raw = getValueAtPath(summary, path);
      const number = toFinite(raw);
      if (Number.isFinite(number)) return number;
      if (raw && typeof raw === 'object') {
        const nestedValue = toFinite(raw.value ?? raw.average ?? raw.mean);
        if (Number.isFinite(nestedValue)) return nestedValue;
      }
    }
    const patterns = Array.isArray(options.patterns) ? options.patterns : [];
    if (patterns.length) {
      const found = findMetricByPatterns(summary, patterns);
      if (Number.isFinite(found)) return found;
    }
    return null;
  }

  function normalizeRatioValue(value) {
    if (!Number.isFinite(value)) return null;
    if (value > 1 && value <= 100) {
      return clamp01(value / 100);
    }
    return clamp01(value);
  }

  function extractCodeSwitchF1(summary) {
    const value = getMetricFromSummary(summary, {
      paths: [
        ['metrics', 'codeSwitchF1'],
        ['metrics', 'code_switch_f1'],
        ['metrics', 'codeswitch_f1'],
        ['codeSwitchF1'],
        ['code_switch_f1'],
        ['codeswitch_f1'],
        ['qa', 'codeSwitchF1'],
        ['qa', 'code_switch_f1'],
        ['qa', 'codeswitch_f1'],
      ],
      patterns: [
        ['codeswitch', 'f1'],
        ['code_switch', 'f1'],
        ['cs', 'f1'],
      ],
    });
    if (!Number.isFinite(value)) return null;
    return normalizeRatioValue(value);
  }

  function extractDiarizationMae(summary) {
    const value = getMetricFromSummary(summary, {
      paths: [
        ['metrics', 'diarizationMae'],
        ['metrics', 'diarization_mae'],
        ['diarizationMae'],
        ['diarization_mae'],
        ['qa', 'diarizationMae'],
        ['qa', 'diarization_mae'],
      ],
      patterns: [
        ['diar', 'mae'],
        ['diarization', 'mae'],
        ['speaker', 'mae'],
      ],
    });
    if (!Number.isFinite(value)) return null;
    const seconds = value > 10 && value < 1000 ? value / 1000 : value;
    return Math.max(0, seconds);
  }

  function extractTranslationCompleteness(summary) {
    const value = getMetricFromSummary(summary, {
      paths: [
        ['metrics', 'translationCompleteness'],
        ['metrics', 'translation_completeness'],
        ['translationCompleteness'],
        ['translation_completeness'],
        ['qa', 'translationCompleteness'],
        ['qa', 'translation_completeness'],
      ],
      patterns: [
        ['translation', 'completeness'],
        ['translation', 'complete'],
      ],
    });
    if (!Number.isFinite(value)) return null;
    return normalizeRatioValue(value);
  }

  function renderCodeSwitchTile(summary) {
    const tile = ensureMetricTile(QA_TILE_CODE_SWITCH_ID, {
      href: QA_TILE_LINKS[QA_TILE_CODE_SWITCH_ID],
      title: 'Review clips with code-switch F1 below target',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Code-switch F1';

    if (summary === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading QA metrics…';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!summary || typeof summary !== 'object') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'QA metrics unavailable';
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const value = extractCodeSwitchF1(summary);
    if (Number.isFinite(value)) {
      if (tile.valueEl) tile.valueEl.textContent = formatPercentMetric(value) || '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Goal ≥ 0.90 average F1';
      const status = determineStatus(value, { green: 0.9, amber: 0.85 }, 'higher');
      applyTileStatus(tile, status);
    } else {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Code-switch F1 not recorded yet';
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function renderDiarizationTile(summary) {
    const tile = ensureMetricTile(QA_TILE_DIARIZATION_ID, {
      href: QA_TILE_LINKS[QA_TILE_DIARIZATION_ID],
      title: 'Review clips with high diarization error',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Diarization MAE';

    if (summary === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading QA metrics…';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!summary || typeof summary !== 'object') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'QA metrics unavailable';
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const value = extractDiarizationMae(summary);
    if (Number.isFinite(value)) {
      if (tile.valueEl) tile.valueEl.textContent = formatSecondsMetric(value) || '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Goal ≤ 0.30s mean absolute error';
      const status = determineStatus(value, { green: 0.3, amber: 0.5 }, 'lower');
      applyTileStatus(tile, status);
    } else {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Diarization QA not enabled';
      applyTileStatus(tile, 'neutral', 'Not tracked');
    }
  }

  function renderTranslationTile(summary) {
    const tile = ensureMetricTile(QA_TILE_TRANSLATION_ID, {
      href: QA_TILE_LINKS[QA_TILE_TRANSLATION_ID],
      title: 'Review clips with incomplete translations',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Translation completeness';

    if (summary === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading QA metrics…';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!summary || typeof summary !== 'object') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'QA metrics unavailable';
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const value = extractTranslationCompleteness(summary);
    if (Number.isFinite(value)) {
      if (tile.valueEl) tile.valueEl.textContent = formatPercentMetric(value) || '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Goal ≥ 0.99 fully translated';
      const status = determineStatus(value, { green: 0.99, amber: 0.95 }, 'higher');
      applyTileStatus(tile, status);
    } else {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Translation completeness not recorded yet';
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function formatRelativeTimestamp(timestamp) {
    if (!Number.isFinite(timestamp)) return null;
    const now = Date.now();
    const diff = now - timestamp;
    if (!Number.isFinite(diff)) return new Date(timestamp).toLocaleString();
    if (diff < 60 * 1000) return 'Updated just now';
    if (diff < 60 * 60 * 1000) {
      const minutes = Math.max(1, Math.round(diff / (60 * 1000)));
      return `Updated ${minutes} min ago`;
    }
    if (diff < 24 * 60 * 60 * 1000) {
      const hours = Math.max(1, Math.round(diff / (60 * 60 * 1000)));
      return `Updated ${hours} hr ago`;
    }
    const date = new Date(timestamp);
    return `Updated ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  const IRR_TILE_BASE_TOOLTIP =
    'Krippendorff α thresholds: ≥0.67 good, 0.60–0.67 caution, <0.60 investigate.';

  function normalizeRoutingConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source =
      raw && typeof raw === 'object' && raw.routing && typeof raw.routing === 'object'
        ? raw.routing
        : raw;
    if (!source || typeof source !== 'object') return null;
    const normalized = {};
    ROUTING_CONFIG_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        normalized[key] = source[key];
      }
    });
    return Object.keys(normalized).length ? normalized : null;
  }

  function buildRoutingTooltip(config) {
    const base = IRR_TILE_BASE_TOOLTIP;
    if (!config || typeof config !== 'object') return base;

    const sections = [];
    const baseProbText = formatProbabilityPercent(config.p_base);
    const maxProbText = formatProbabilityPercent(config.p_max);
    if (baseProbText || maxProbText) {
      const parts = [];
      if (baseProbText) parts.push(`base ${baseProbText}`);
      if (maxProbText) parts.push(`cap ${maxProbText}`);
      if (parts.length) sections.push(`Double-pass routing: ${parts.join(', ')}`);
    }

    const coverageThresholdText = formatProbabilityPercent(config.coverage_boost_threshold);
    const coverageFactorText = formatMultiplier(config.coverage_boost_factor);
    if (coverageThresholdText) {
      if (coverageFactorText) {
        sections.push(`Coverage below ${coverageThresholdText} ${coverageFactorText}`);
      } else {
        sections.push(`Coverage below ${coverageThresholdText} increases probability`);
      }
    }

    const qaConditions = [];
    const f1Threshold = normalizeProbability(config.qa_boost_f1_threshold);
    if (Number.isFinite(f1Threshold)) {
      qaConditions.push(`F1 < ${f1Threshold.toFixed(2)}`);
    }
    const cuesThresholdText = formatProbabilityPercent(config.qa_boost_cue_in_bounds_threshold);
    if (cuesThresholdText) qaConditions.push(`cues < ${cuesThresholdText}`);
    if (qaConditions.length) {
      const qaFactorText = formatMultiplier(config.qa_boost_factor);
      sections.push(
        `QA boost when ${qaConditions.join(' or ')}${qaFactorText ? ` ${qaFactorText}` : ''}`
      );
    }

    const capText = formatProbabilityPercent(config.annotator_daily_cap);
    if (capText) {
      sections.push(`Annotator daily cap ${capText}`);
    }

    if (!sections.length) return base;
    return `${base}\n\n${sections.join('; ')}.`;
  }

  function renderAdjudicationTile(state) {
    const tile = ensureMetricTile(QA_TILE_ADJUDICATION_ID, {
      href: QA_TILE_LINKS[QA_TILE_ADJUDICATION_ID],
      title: 'Review adjudication queue',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Adjudication';
    const metaEl = ensureTileMetaElement(tile);

    const status = ensureAdjudicationStatus(state);
    if (status === 'loading') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading adjudication queue…';
      if (metaEl) metaEl.textContent = '';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (status === 'error') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Unable to load adjudication queue';
      if (metaEl) metaEl.textContent = 'Try refreshing the dashboard';
      applyTileStatus(tile, 'red', 'Action needed');
      return;
    }

    const counts = ensureAdjudicationCounts(state);
    const pending = counts.pending;
    const assigned = counts.assigned;
    const locked = counts.locked;
    if (tile.valueEl) tile.valueEl.textContent = String(pending);
    if (tile.captionEl) tile.captionEl.textContent = `Assigned ${assigned} • Locked ${locked}`;

    if (metaEl) {
      const updated = state && state.lastUpdated ? formatRelativeTimestamp(state.lastUpdated) : null;
      metaEl.textContent = updated ? `Updated ${updated}` : '';
    }

    if (pending + assigned > 0) {
      applyTileStatus(tile, 'red', 'Action needed');
    } else if (locked > 0) {
      applyTileStatus(tile, 'green', 'Queue clear');
    } else {
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function applyIrrTileTooltip(tileElements) {
    if (!tileElements || !tileElements.tile) return;
    const tooltip = buildRoutingTooltip(routingConfigState);
    tileElements.tile.title = tooltip || IRR_TILE_BASE_TOOLTIP;
  }

  function renderIRRTile(summary, trendByMetric) {
    const tile = ensureMetricTile(QA_TILE_IRR_ID, {
      href: QA_TILE_LINKS[QA_TILE_IRR_ID],
      title: IRR_TILE_BASE_TOOLTIP,
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Krippendorff α (global)';
    tile.tile.setAttribute('data-qa-irr', 'true');
    applyIrrTileTooltip(tile);
    applyIrrQueueBadge(tile);

    const sparklineContainer = ensureTileSparklineContainer(tile);
    const metaEl = ensureTileMetaElement(tile);

    if (summary === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading inter-rater reliability…';
      if (metaEl) metaEl.textContent = '';
      if (sparklineContainer) renderSparkline(sparklineContainer, [], { emptyText: 'Loading…' });
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!summary || typeof summary !== 'object') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'IRR data unavailable';
      if (metaEl) metaEl.textContent = '';
      if (sparklineContainer) renderSparkline(sparklineContainer, [], { emptyText: 'No trend data' });
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const metric = summary && summary.metrics ? summary.metrics.hasCS : null;
    const alphaValue = metric && Number.isFinite(metric.alpha) ? metric.alpha : null;
    if (tile.valueEl) tile.valueEl.textContent = alphaValue != null ? formatAlphaDisplay(alphaValue) : '—';
    const cellCount = metric && Array.isArray(metric.cells) ? metric.cells.length : 0;
    if (tile.captionEl) {
      tile.captionEl.textContent = cellCount ? `Across ${cellCount} cells` : 'Trend over last 7 days';
    }
    const metaParts = [];
    if (summary.generatedAt != null) {
      const relative = formatRelativeTimestamp(summary.generatedAt);
      if (relative) metaParts.push(relative);
    }
    if (metaParts.length && metaEl) {
      metaEl.textContent = metaParts.join(' • ');
    } else if (metaEl) {
      metaEl.textContent = '';
    }

    if (sparklineContainer) {
      const series = trendByMetric && Array.isArray(trendByMetric.hasCS)
        ? trendByMetric.hasCS
        : Array.isArray(trendByMetric)
          ? trendByMetric
          : [];
      renderSparkline(sparklineContainer, series, {
        ariaLabel: 'Krippendorff alpha trend',
        emptyText: 'No trend data',
      });
    }

    if (alphaValue != null) {
      const status = determineStatus(alphaValue, { green: 0.67, amber: 0.6 }, 'higher');
      applyTileStatus(tile, status);
    } else {
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function renderVoiceTagTile(summary, trendByMetric) {
    const tile = ensureMetricTile(QA_TILE_VOICE_TAG_ID, {
      href: QA_TILE_LINKS[QA_TILE_VOICE_TAG_ID],
      title: IRR_TILE_BASE_TOOLTIP,
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'IRR VoiceTag (Presence)';
    tile.tile.setAttribute('data-qa-irr-voice-tag', 'true');
    applyIrrQueueBadge(tile);

    const sparklineContainer = ensureTileSparklineContainer(tile);
    const metaEl = ensureTileMetaElement(tile);

    if (summary === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading voice-tag reliability…';
      if (metaEl) metaEl.textContent = '';
      if (sparklineContainer) renderSparkline(sparklineContainer, [], { emptyText: 'Loading…' });
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    const metric = summary && summary.metrics ? summary.metrics.voiceTag_presence : null;
    if (!summary || typeof summary !== 'object' || !metric) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Voice-tag presence IRR unavailable';
      if (metaEl) metaEl.textContent = '';
      if (sparklineContainer) renderSparkline(sparklineContainer, [], { emptyText: 'No trend data' });
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const alphaValue = Number.isFinite(metric.alpha) ? metric.alpha : null;
    if (tile.valueEl) tile.valueEl.textContent = alphaValue != null ? formatAlphaDisplay(alphaValue) : '—';
    const cellCount = Array.isArray(metric.cells) ? metric.cells.length : 0;
    if (tile.captionEl) {
      tile.captionEl.textContent = cellCount ? `Across ${cellCount} cells` : 'Trend over last 7 days';
    }

    const metaParts = [];
    if (summary.generatedAt != null) {
      const relative = formatRelativeTimestamp(summary.generatedAt);
      if (relative) metaParts.push(relative);
    }
    if (metaEl) metaEl.textContent = metaParts.length ? metaParts.join(' • ') : '';

    if (sparklineContainer) {
      const series = trendByMetric && Array.isArray(trendByMetric.voiceTag_presence)
        ? trendByMetric.voiceTag_presence
        : [];
      renderSparkline(sparklineContainer, series, {
        ariaLabel: 'Voice-tag presence alpha trend',
        emptyText: 'No trend data',
      });
    }

    if (alphaValue != null) {
      const status = determineStatus(alphaValue, { green: 0.67, amber: 0.6 }, 'higher');
      applyTileStatus(tile, status);
    } else {
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function renderDoublePassTile(stats) {
    const tile = ensureMetricTile(QA_TILE_DOUBLE_PASS_ID, {
      href: QA_TILE_LINKS[QA_TILE_DOUBLE_PASS_ID],
      title: 'Last 200 assets with at least two passes',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'Double-pass coverage';
    const metaEl = ensureTileMetaElement(tile);

    if (stats === null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Calculating double-pass coverage…';
      if (metaEl) metaEl.textContent = '';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!stats || typeof stats !== 'object' || stats.ratio == null) {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl)
        tile.captionEl.textContent = 'Double-pass coverage unavailable';
      if (metaEl) metaEl.textContent = '';
      applyTileStatus(tile, 'neutral', 'No data');
      return;
    }

    const percentText = formatPercentMetric(stats.ratio) || '—';
    if (tile.valueEl) tile.valueEl.textContent = percentText;
    const sampleSize = Number.isFinite(stats.sampleSize) ? Math.round(stats.sampleSize) : null;
    const doublePassCount = Number.isFinite(stats.doublePassCount)
      ? Math.round(stats.doublePassCount)
      : null;
    if (tile.captionEl) {
      tile.captionEl.textContent = sampleSize
        ? `Last ${sampleSize} assets`
        : 'Recent double-pass window';
    }
    if (metaEl) {
      metaEl.textContent = doublePassCount != null ? `${doublePassCount} assets double-passed` : '';
    }
    const status = determineStatus(stats.ratio, { green: 0.15, amber: 0.1 }, 'higher');
    applyTileStatus(tile, status);
  }

  function getDisagreementFilterLabel() {
    if (!disagreementsState || !disagreementsState.filter || disagreementsState.filter === 'all') {
      return 'All cells';
    }
    const special = getSpecialFilterInfo(disagreementsState.filter);
    if (special && special.label) return special.label;
    const match = (disagreementsState.cells || []).find(
      (cell) => cell && cell.key === disagreementsState.filter
    );
    if (match) return match.label || formatCellLabel(match.key);
    return formatCellLabel(disagreementsState.filter);
  }

  function renderDisagreementsTile(state) {
    const tile = ensureMetricTile(QA_TILE_DISAGREEMENTS_ID, {
      href: QA_TILE_LINKS[QA_TILE_DISAGREEMENTS_ID],
      title: 'Review assets with hasCS disagreements',
    });
    if (!tile) return;
    if (tile.labelEl) tile.labelEl.textContent = 'hasCS disagreements';
    tile.tile.setAttribute('role', 'button');
    tile.tile.setAttribute('aria-haspopup', 'dialog');
    tile.tile.setAttribute('data-qa-disagreements', 'true');
    if (!tile.tile.dataset.disagreementsListenerAttached) {
      tile.tile.addEventListener('click', (event) => {
        event.preventDefault();
        openDisagreementsPanel();
      });
      tile.tile.dataset.disagreementsListenerAttached = 'true';
    }

    const metaEl = ensureTileMetaElement(tile);
    const status = state ? state.status : 'loading';
    const entriesForFilter = getEntriesForFilter(disagreementsState.filter || 'all');
    const count = Array.isArray(entriesForFilter) ? entriesForFilter.length : 0;

    if (status === 'loading') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Loading disagreements…';
      if (metaEl) metaEl.textContent = '';
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (status === 'error') {
      if (tile.valueEl) tile.valueEl.textContent = '—';
      if (tile.captionEl) tile.captionEl.textContent = 'Failed to load disagreements';
      if (metaEl) metaEl.textContent = 'Try refreshing the dashboard';
      applyTileStatus(tile, 'red', 'Action needed');
      return;
    }

    if (tile.valueEl) tile.valueEl.textContent = String(count);
    if (tile.captionEl) tile.captionEl.textContent = 'Click to review details';
    if (metaEl) metaEl.textContent = `Filter: ${getDisagreementFilterLabel()}`;

    const isSpecialFilter = disagreementsState.filter && getSpecialFilterInfo(disagreementsState.filter);
    if (isSpecialFilter) {
      applyTileStatus(tile, 'neutral', 'Custom filter');
    } else if (count <= 0) {
      applyTileStatus(tile, 'green', 'On track');
    } else if (count < 5) {
      applyTileStatus(tile, 'amber', 'Needs attention');
    } else {
      applyTileStatus(tile, 'red', 'Action needed');
    }
  }

  function updateDisagreementsCells(cells) {
    if (!Array.isArray(cells) || !cells.length) return false;
    const map = new Map((disagreementsState.cells || []).map((cell) => [cell.key, cell]));
    let changed = false;
    cells.forEach((cell) => {
      if (!cell || !cell.key) return;
      const existing = map.get(cell.key) || {};
      const next = {
        key: cell.key,
        label: cell.label || existing.label || formatCellLabel(cell.key),
        alpha: Number.isFinite(cell.alpha) ? cell.alpha : existing.alpha ?? null,
        nItems: Number.isFinite(cell.nItems) ? Math.round(cell.nItems) : existing.nItems ?? null,
      };
      const serializedExisting = JSON.stringify(existing);
      const serializedNext = JSON.stringify(next);
      if (serializedExisting !== serializedNext) {
        changed = true;
        map.set(cell.key, next);
      }
    });
    if (changed) {
      disagreementsState.cells = Array.from(map.values()).sort((a, b) =>
        a.label.localeCompare(b.label)
      );
    }
    return changed;
  }

  function updateDisagreementsEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return false;
    const map = new Map((disagreementsState.entries || []).map((entry) => [entry.key, entry]));
    let changed = false;
    entries.forEach((entry) => {
      if (!entry || !entry.key) return;
      const existing = map.get(entry.key);
      const serializedExisting = existing ? JSON.stringify(existing) : null;
      const serializedNext = JSON.stringify(entry);
      if (serializedExisting !== serializedNext) {
        changed = true;
        map.set(entry.key, entry);
      }
    });
    if (changed) {
      disagreementsState.entries = Array.from(map.values()).sort((a, b) => {
        if (Number.isFinite(b.timestamp) && Number.isFinite(a.timestamp) && b.timestamp !== a.timestamp) {
          return b.timestamp - a.timestamp;
        }
        return (a.assetLabel || '').localeCompare(b.assetLabel || '');
      });
    }
    return changed;
  }

  function setSpecialFilterEntries(key, label, entries) {
    if (!key) return false;
    const normalizedKey = String(key);
    const existing = disagreementsState.specialFilters || {};
    if (!entries || !entries.length) {
      if (existing[normalizedKey]) {
        delete existing[normalizedKey];
        disagreementsState.specialFilters = existing;
        if (disagreementsState.filter === normalizedKey) {
          disagreementsState.filter = 'all';
        }
        return true;
      }
      return false;
    }
    existing[normalizedKey] = {
      label: label || formatCellLabel(normalizedKey),
      entries: entries.slice(),
    };
    disagreementsState.specialFilters = existing;
    return true;
  }

  function getSpecialFilterInfo(key) {
    if (!key) return null;
    return disagreementsState.specialFilters
      ? disagreementsState.specialFilters[String(key)] || null
      : null;
  }

  function getEntriesForFilter(filterValue) {
    if (!filterValue || filterValue === 'all') {
      return disagreementsState.entries || [];
    }
    const special = getSpecialFilterInfo(filterValue);
    if (special && Array.isArray(special.entries)) {
      return special.entries;
    }
    return (disagreementsState.entries || []).filter(
      (entry) => entry && entry.cellKey === filterValue
    );
  }

  function refreshDisagreementsUI() {
    renderDisagreementsTile(disagreementsState);
    renderDisagreementsPanel();
  }

  function buildReviewUrl(entry) {
    if (!entry) return '/stage2/review.html';
    const params = new URLSearchParams();
    if (entry.assetId) params.set('asset', entry.assetId);
    if (entry.cellKey) params.set('cell', entry.cellKey);
    const annotators = Array.isArray(entry.votes)
      ? entry.votes
          .map((vote) => {
            if (!vote) return null;
            const annotator = vote.annotatorId ? String(vote.annotatorId) : 'unknown';
            const pass = Number.isFinite(vote.pass) ? Math.round(vote.pass) : null;
            return pass != null ? `${annotator}:p${pass}` : annotator;
          })
          .filter(Boolean)
      : [];
    if (annotators.length) params.set('annotators', annotators.join(','));
    const passes = Array.isArray(entry.votes)
      ? entry.votes
          .map((vote) => (Number.isFinite(vote.pass) ? Math.round(vote.pass) : null))
          .filter((value, index, self) => value != null && self.indexOf(value) === index)
      : [];
    if (passes.length) params.set('passes', passes.join(','));
    params.set('mode', 'side-by-side');
    params.set('focus', 'hasCS');
    return `/stage2/review.html?${params.toString()}`;
  }

  function ensureDisagreementsPanel() {
    if (typeof document === 'undefined') return disagreementsUI;
    if (disagreementsUI.panel) return disagreementsUI;
    disagreementsUI.overlay = document.getElementById('qaDisagreementsOverlay');
    disagreementsUI.panel = document.getElementById('qaDisagreementsPanel');
    disagreementsUI.closeButton = document.getElementById('qaDisagreementsClose');
    disagreementsUI.filterSelect = document.getElementById('qaDisagreementsCellFilter');
    disagreementsUI.summaryBody = document.getElementById('qaDisagreementsSummary');
    disagreementsUI.summaryEmpty = document.getElementById('qaDisagreementsSummaryEmpty');
    disagreementsUI.summaryEmptyDefault = disagreementsUI.summaryEmpty
      ? disagreementsUI.summaryEmpty.textContent
      : '';
    disagreementsUI.list = document.getElementById('qaDisagreementsList');
    disagreementsUI.listEmpty = document.getElementById('qaDisagreementsEmpty');
    disagreementsUI.hint = document.querySelector('.qa-disagreements-panel__hint');
    disagreementsUI.hintDefault = disagreementsUI.hint ? disagreementsUI.hint.textContent : '';

    if (disagreementsUI.filterSelect) {
      disagreementsUI.filterSelect.addEventListener('change', (event) => {
        disagreementsState.filter = event.target.value || 'all';
        renderDisagreementsTile(disagreementsState);
        renderDisagreementsPanel();
      });
    }
    if (disagreementsUI.closeButton) {
      disagreementsUI.closeButton.addEventListener('click', () => closeDisagreementsPanel());
    }
    if (disagreementsUI.overlay) {
      disagreementsUI.overlay.addEventListener('click', () => closeDisagreementsPanel());
    }
    if (disagreementsUI.panel) {
      disagreementsUI.panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeDisagreementsPanel();
        }
      });
    }

    return disagreementsUI;
  }

  function updateDisagreementsStatusFromEntries() {
    if (disagreementsState.status === 'error') return;
    disagreementsState.status = disagreementsState.entries && disagreementsState.entries.length
      ? 'ready'
      : 'empty';
  }

  function toggleDisagreementSelection(entry) {
    if (!entry) {
      disagreementsState.selectedKey = null;
      highlightCoverageCell(null);
      renderDisagreementsPanel();
      return;
    }
    if (disagreementsState.selectedKey === entry.key) {
      disagreementsState.selectedKey = null;
      highlightCoverageCell(null);
    } else {
      disagreementsState.selectedKey = entry.key;
      highlightCoverageCell(entry.cellKey, { reason: 'disagreement' });
    }
    renderDisagreementsPanel();
  }

  function renderDisagreementsPanel() {
    const ui = ensureDisagreementsPanel();
    if (!ui.panel) return;

    if (ui.hint) {
      if (disagreementsState.status === 'loading') {
        ui.hint.textContent = 'Loading disagreements…';
      } else if (disagreementsState.status === 'error' && !disagreementsState.entries.length) {
        ui.hint.textContent = 'Unable to load disagreements. Try refreshing later.';
      } else {
        ui.hint.textContent =
          ui.hintDefault ||
          'Select an asset to highlight its coverage cell and open review links side-by-side.';
      }
    }

    const cellMap = new Map();
    (disagreementsState.cells || []).forEach((cell) => {
      if (cell && cell.key) cellMap.set(cell.key, cell);
    });
    (disagreementsState.entries || []).forEach((entry) => {
      if (entry && entry.cellKey && !cellMap.has(entry.cellKey)) {
        cellMap.set(entry.cellKey, {
          key: entry.cellKey,
          label: formatCellLabel(entry.cellLabel || entry.cellKey),
          alpha: null,
          nItems: null,
        });
      }
    });

    const cellOptions = Array.from(cellMap.values()).sort((a, b) =>
      (a.label || '').localeCompare(b.label || '')
    );
    const specialOptions = Object.keys(disagreementsState.specialFilters || {})
      .map((key) => ({
        key,
        label:
          disagreementsState.specialFilters[key] && disagreementsState.specialFilters[key].label
            ? disagreementsState.specialFilters[key].label
            : formatCellLabel(key),
      }))
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

    if (ui.filterSelect) {
      const previous = disagreementsState.filter || 'all';
      const select = ui.filterSelect;
      select.innerHTML = '';
      const allOption = document.createElement('option');
      allOption.value = 'all';
      allOption.textContent = 'All cells';
      select.appendChild(allOption);
      let hasSelection = previous === 'all';
      cellOptions.forEach((cell) => {
        const option = document.createElement('option');
        option.value = cell.key;
        option.textContent = cell.label || formatCellLabel(cell.key);
        if (cell.key === previous) hasSelection = true;
        select.appendChild(option);
      });
      specialOptions.forEach((optionInfo) => {
        const option = document.createElement('option');
        option.value = optionInfo.key;
        option.textContent = optionInfo.label;
        option.dataset.special = 'true';
        if (optionInfo.key === previous) hasSelection = true;
        select.appendChild(option);
      });
      if (!hasSelection) {
        disagreementsState.filter = 'all';
      }
      select.value = disagreementsState.filter || 'all';
    }

    const summaryTable = ui.summaryBody ? ui.summaryBody.closest('table') : null;
    if (ui.summaryBody) ui.summaryBody.innerHTML = '';
    const filterValue = disagreementsState.filter || 'all';
    const isSpecialFilter = filterValue !== 'all' && !!getSpecialFilterInfo(filterValue);
    if (!cellOptions.length || isSpecialFilter) {
      if (summaryTable) summaryTable.classList.add('hide');
      if (ui.summaryEmpty) {
        ui.summaryEmpty.textContent = isSpecialFilter
          ? 'Summary not available for this filter.'
          : disagreementsUI.summaryEmptyDefault || 'No cells to display.';
        ui.summaryEmpty.classList.remove('hide');
      }
    } else {
      if (summaryTable) summaryTable.classList.remove('hide');
      if (ui.summaryEmpty) ui.summaryEmpty.classList.add('hide');
      const counts = (disagreementsState.entries || []).reduce((acc, entry) => {
        if (!entry || !entry.cellKey) return acc;
        acc[entry.cellKey] = (acc[entry.cellKey] || 0) + 1;
        return acc;
      }, {});
      cellOptions.forEach((cell) => {
        if (!ui.summaryBody) return;
        const row = document.createElement('tr');
        const name = document.createElement('th');
        name.scope = 'row';
        name.textContent = cell.label || formatCellLabel(cell.key);
        const alphaCell = document.createElement('td');
        if (Number.isFinite(cell.alpha)) {
          alphaCell.textContent = formatAlphaDisplay(cell.alpha);
        } else if (Number.isFinite(cell.nItems) && cell.nItems < QA_MIN_CELL_ITEMS) {
          alphaCell.textContent = 'n<10';
        } else {
          alphaCell.textContent = '—';
        }
        const itemsCell = document.createElement('td');
        itemsCell.textContent = Number.isFinite(cell.nItems) ? Math.round(cell.nItems) : '—';
        const disagreementsCell = document.createElement('td');
        disagreementsCell.textContent = counts[cell.key] || 0;
        row.appendChild(name);
        row.appendChild(alphaCell);
        row.appendChild(itemsCell);
        row.appendChild(disagreementsCell);
        ui.summaryBody.appendChild(row);
      });
    }

    if (ui.list) ui.list.innerHTML = '';
    const filteredEntries = getEntriesForFilter(filterValue);

    const stillSelected = filteredEntries.some(
      (entry) => entry && entry.key === disagreementsState.selectedKey
    );
    if (!stillSelected && disagreementsState.selectedKey) {
      disagreementsState.selectedKey = null;
      highlightCoverageCell(null);
    }

    if (!filteredEntries.length) {
      if (ui.listEmpty) ui.listEmpty.classList.remove('hide');
      if (ui.list) ui.list.classList.add('hide');
      return;
    }

    if (ui.listEmpty) ui.listEmpty.classList.add('hide');
    if (ui.list) ui.list.classList.remove('hide');

    filteredEntries.forEach((entry) => {
      if (!entry || !ui.list) return;
      const item = document.createElement('li');
      item.className = 'qa-disagreements-list__item';
      if (entry.key === disagreementsState.selectedKey) {
        item.classList.add('is-selected');
      }
      item.dataset.assetId = entry.assetId || '';
      item.dataset.cellKey = entry.cellKey || '';

      const meta = document.createElement('div');
      meta.className = 'qa-disagreements-list__meta';
      const asset = document.createElement('span');
      asset.className = 'qa-disagreements-list__asset';
      asset.textContent = entry.assetLabel || entry.assetId || 'Unknown asset';
      meta.appendChild(asset);
      if (entry.cellLabel || entry.cellKey) {
        const cell = document.createElement('span');
        cell.textContent = entry.cellLabel || formatCellLabel(entry.cellKey);
        meta.appendChild(cell);
      }
      if (Number.isFinite(entry.cueStart)) {
        const cue = document.createElement('span');
        cue.textContent = `Cue @ ${formatSecondsMetric(entry.cueStart)}`;
        meta.appendChild(cue);
      }
      if (Number.isFinite(entry.timestamp)) {
        const time = document.createElement('span');
        const label = formatRelativeTimestamp(entry.timestamp);
        time.textContent = label || new Date(entry.timestamp).toLocaleString();
        meta.appendChild(time);
      }
      item.appendChild(meta);

      const votesWrapper = document.createElement('div');
      votesWrapper.className = 'qa-disagreements-list__votes';
      (entry.votes || []).forEach((vote) => {
        if (!vote) return;
        const voteRow = document.createElement('div');
        voteRow.className = 'qa-disagreements-list__vote';
        const label = document.createElement('span');
        label.className = 'qa-disagreements-list__vote-label';
        const annotator = vote.annotatorId ? String(vote.annotatorId) : 'Annotator';
        label.textContent = vote.pass != null ? `${annotator} (Pass ${vote.pass})` : annotator;
        const value = document.createElement('span');
        value.textContent = vote.label || (vote.value ? 'Yes' : 'No');
        voteRow.appendChild(label);
        voteRow.appendChild(document.createTextNode(': '));
        voteRow.appendChild(value);
        votesWrapper.appendChild(voteRow);
      });
      item.appendChild(votesWrapper);

      const actions = document.createElement('div');
      actions.className = 'qa-disagreements-list__actions';
      const reviewLink = document.createElement('a');
      reviewLink.className = 'qa-disagreements-list__review';
      reviewLink.href = buildReviewUrl(entry);
      reviewLink.target = '_blank';
      reviewLink.rel = 'noopener noreferrer';
      reviewLink.textContent = 'Open in review';
      actions.appendChild(reviewLink);
      item.appendChild(actions);

      item.addEventListener('click', (event) => {
        if (event.target && event.target.closest && event.target.closest('a')) return;
        event.preventDefault();
        toggleDisagreementSelection(entry);
      });

      ui.list.appendChild(item);
    });
  }

  function openDisagreementsPanel() {
    const ui = ensureDisagreementsPanel();
    if (!ui.panel) return;
    if (ui.overlay) {
      ui.overlay.classList.remove('hide');
      ui.overlay.setAttribute('aria-hidden', 'false');
    }
    ui.panel.classList.remove('hide');
    ui.panel.setAttribute('aria-hidden', 'false');
    renderDisagreementsPanel();
    if (ui.closeButton) {
      try {
        ui.closeButton.focus();
      } catch {}
    }
  }

  function closeDisagreementsPanel() {
    const ui = ensureDisagreementsPanel();
    if (!ui.panel) return;
    if (ui.overlay) {
      ui.overlay.classList.add('hide');
      ui.overlay.setAttribute('aria-hidden', 'true');
    }
    ui.panel.classList.add('hide');
    ui.panel.setAttribute('aria-hidden', 'true');
    disagreementsState.selectedKey = null;
    highlightCoverageCell(null);
    renderDisagreementsPanel();
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
    const tile = ensureMetricTile(QA_TILE_COVERAGE_ID, {
      href: QA_TILE_LINKS[QA_TILE_COVERAGE_ID],
      title: 'Jump to coverage summary',
    });
    if (!tile) return;

    const { labelEl, valueEl, captionEl } = tile;

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
      applyTileStatus(tile, 'neutral', 'Loading…');
      return;
    }

    if (!snapshot || typeof snapshot !== 'object') {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Coverage snapshot unavailable';
      applyTileStatus(tile, 'neutral', 'No data');
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
      const status = determineStatus(completeness, { green: 0.8, amber: 0.6 }, 'higher');
      applyTileStatus(tile, status);
    } else {
      if (valueEl) valueEl.textContent = '—';
      if (captionEl) captionEl.textContent = 'Coverage completeness unavailable';
      applyTileStatus(tile, 'neutral', 'No data');
    }
  }

  function fetchJsonFromCandidates(urls) {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    const queue = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (!queue.length) return Promise.resolve(null);
    const attempt = (index) => {
      if (index >= queue.length) return Promise.resolve(null);
      const url = queue[index];
      return fetch(url, { cache: 'no-store' })
        .then((response) => {
          if (!response || !response.ok) throw new Error('Request failed');
          return response.json().catch(() => null);
        })
        .then((data) => {
          if (data == null) return attempt(index + 1);
          return data;
        })
        .catch(() => attempt(index + 1));
    };
    return attempt(0);
  }

  function fetchTrainingSummary() {
    return fetchJsonFromCandidates(['training_data_summary.json']);
  }

  function fetchIRRSummary() {
    return fetchJsonFromCandidates([
      '/api/irr',
      '/api/coverage/irr',
      '/data/irr/irr.json',
    ]);
  }

  function fetchIRRTrend() {
    return fetchJsonFromCandidates([
      '/api/irr/trend',
      '/data/irr/irr_trend.json',
    ]);
  }

  function fetchRoutingConfig() {
    return fetchJsonFromCandidates(['/api/config', '/config/routing.json']);
  }

  function fetchDisagreementsFeed() {
    return fetchJsonFromCandidates([
      '/api/irr/disagreements',
      '/data/irr/disagreements.json',
    ]);
  }

  function fetchDoublePassFeed() {
    return fetchJsonFromCandidates([
      '/api/stage2/double_pass',
      '/api/irr/double_pass',
      '/api/coverage/double_pass',
      '/data/irr/double_pass.json',
      '/data/stage2_output/index.json',
      '/stage2_output/index.json',
    ]);
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

  function fetchAdjudicationQueue() {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    return fetch('/api/adjudication/queue', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) return null;
        return response.json().catch(() => null);
      })
      .catch(() => null);
  }

  function refreshAdjudicationQueue() {
    adjudicationState.status = 'loading';
    renderAdjudicationTile(adjudicationState);
    renderAdjudicationQueue();
    return fetchAdjudicationQueue()
      .then((data) => {
        let items = [];
        let metaSource = {};
        if (Array.isArray(data)) {
          items = data;
          metaSource = {};
        } else if (data && typeof data === 'object') {
          if (Array.isArray(data.items)) {
            items = data.items;
          } else if (Array.isArray(data.queue)) {
            items = data.queue;
          }
          metaSource = data;
        }
        adjudicationState.entries = normalizeAdjudicationEntries(items);
        adjudicationState.counts = computeAdjudicationCounts(adjudicationState.entries);
        adjudicationState.meta = normalizeAdjudicationMeta(metaSource);
        adjudicationState.status = 'ready';
        adjudicationState.lastUpdated = new Date().toISOString();
        clearAdjudicationDiffCache();
        if (adjudicationErrorToast) {
          dismissToast(adjudicationErrorToast);
          adjudicationErrorToast = null;
        }
        renderAdjudicationTile(adjudicationState);
        renderAdjudicationQueue();
        renderIRRTile(irrSummaryState, irrTrendState);
        renderVoiceTagTile(irrSummaryState, irrTrendState);
      })
      .catch(() => {
        adjudicationState.status = 'error';
        adjudicationState.counts = computeAdjudicationCounts(adjudicationState.entries);
        adjudicationState.meta = { configSha: null, snapshotAt: null };
        renderAdjudicationTile(adjudicationState);
        renderAdjudicationQueue();
        renderIRRTile(irrSummaryState, irrTrendState);
        renderVoiceTagTile(irrSummaryState, irrTrendState);
        if (adjudicationErrorToast) dismissToast(adjudicationErrorToast);
        adjudicationErrorToast = showToast('Unable to load adjudication queue.', {
          variant: 'error',
          actions: [
            {
              label: 'Retry',
              onClick: () => refreshAdjudicationQueue(),
            },
          ],
          duration: 0,
        });
      });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
      ensureDisagreementsPanel();
      disagreementsState.status = 'loading';
      adjudicationState.status = 'loading';
      initAdjudicationQueueUI();
      adjudicationState.entries = [];
      adjudicationState.counts = { pending: 0, assigned: 0, locked: 0 };
      adjudicationState.lastUpdated = null;
      renderAdjudicationTile(adjudicationState);
      renderIRRTile(null, {});
      renderVoiceTagTile(null, {});
      renderDoublePassTile(null);
      renderDisagreementsTile(disagreementsState);
      renderDisagreementsPanel();
      renderCodeSwitchTile(null);
      renderDiarizationTile(null);
      renderTranslationTile(null);
      renderProvenanceTile(null);
      renderCoverageCompletenessTile(null);
      renderCoverageSnapshot(null);
      renderAdjudicationQueue();

      refreshAdjudicationQueue();

      fetchTrainingSummary()
        .then((summary) => {
          if (summary) {
            renderCodeSwitchTile(summary);
            renderDiarizationTile(summary);
            renderTranslationTile(summary);
            renderProvenanceTile(summary);
          } else {
            renderCodeSwitchTile(undefined);
            renderDiarizationTile(undefined);
            renderTranslationTile(undefined);
            renderProvenanceTile(undefined);
          }
        })
        .catch(() => {
          renderCodeSwitchTile(undefined);
          renderDiarizationTile(undefined);
          renderTranslationTile(undefined);
          renderProvenanceTile(undefined);
        });

      fetchRoutingConfig()
        .then((data) => {
          routingConfigState = normalizeRoutingConfig(data);
          renderIRRTile(irrSummaryState, irrTrendState);
          renderVoiceTagTile(irrSummaryState, irrTrendState);
        })
        .catch(() => {
          routingConfigState = null;
          renderIRRTile(irrSummaryState, irrTrendState);
          renderVoiceTagTile(irrSummaryState, irrTrendState);
        });

      fetchIRRSummary()
        .then((data) => {
          if (data) {
            const normalized = normalizeIrrData(data);
            irrSummaryState = normalized;
            if (normalized) {
              updateDisagreementsCells(normalized.cells || []);
              if (normalized.disagreements && normalized.disagreements.length) {
                updateDisagreementsEntries(normalized.disagreements);
              }
              setSpecialFilterEntries(
                'voiceTagMissing',
                'Cues lacking tags (multi-speaker only)',
                normalized.voiceTagMissingEntries || []
              );
              updateDisagreementsStatusFromEntries();
            } else {
              irrSummaryState = undefined;
              updateDisagreementsStatusFromEntries();
              setSpecialFilterEntries('voiceTagMissing', null, []);
            }
            renderIRRTile(irrSummaryState, irrTrendState);
            renderVoiceTagTile(irrSummaryState, irrTrendState);
            refreshDisagreementsUI();
          } else {
            irrSummaryState = undefined;
            updateDisagreementsStatusFromEntries();
            setSpecialFilterEntries('voiceTagMissing', null, []);
            renderIRRTile(undefined, irrTrendState);
            renderVoiceTagTile(undefined, irrTrendState);
            refreshDisagreementsUI();
          }
        })
        .catch(() => {
          irrSummaryState = undefined;
          if (!disagreementsState.entries.length) {
            disagreementsState.status = 'error';
          }
          setSpecialFilterEntries('voiceTagMissing', null, []);
          renderIRRTile(undefined, irrTrendState);
          renderVoiceTagTile(undefined, irrTrendState);
          refreshDisagreementsUI();
        });

      fetchIRRTrend()
        .then((data) => {
          irrTrendState = normalizeIrrTrend(data) || {};
          renderIRRTile(irrSummaryState, irrTrendState);
          renderVoiceTagTile(irrSummaryState, irrTrendState);
        })
        .catch(() => {
          irrTrendState = {};
          renderIRRTile(irrSummaryState, irrTrendState);
          renderVoiceTagTile(irrSummaryState, irrTrendState);
        });

      fetchDoublePassFeed()
        .then((data) => {
          const stats = data ? normalizeDoublePassData(data) : null;
          doublePassState = stats;
          if (stats) {
            if (stats.disagreements && stats.disagreements.length) {
              updateDisagreementsEntries(stats.disagreements);
              updateDisagreementsStatusFromEntries();
            }
            renderDoublePassTile(stats);
          } else {
            renderDoublePassTile(undefined);
          }
          refreshDisagreementsUI();
        })
        .catch(() => {
          doublePassState = undefined;
          renderDoublePassTile(undefined);
        });

      fetchDisagreementsFeed()
        .then((data) => {
          if (data) {
            const normalized = normalizeDisagreementsFeed(data);
            if (normalized) {
              updateDisagreementsCells(normalized.cells || []);
              if (normalized.entries && normalized.entries.length) {
                updateDisagreementsEntries(normalized.entries);
              }
              updateDisagreementsStatusFromEntries();
              refreshDisagreementsUI();
            }
          }
        })
        .catch(() => {
          if (!disagreementsState.entries.length) {
            disagreementsState.status = 'error';
            refreshDisagreementsUI();
          }
        });

      Promise.allSettled([fetchCoverageSnapshot(), fetchCoverageAlerts()])
        .then((results) => {
          const snapshotResult = results[0];
          const alertsResult = results[1];
          const snapshotValue =
            snapshotResult && snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
          const alertsValue =
            alertsResult && alertsResult.status === 'fulfilled' ? alertsResult.value : null;
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
