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
    `;
    (document.head || document.body || document.documentElement).appendChild(style);
  }

  function renderCoverageSnapshot(snapshot) {
    const container = ensureCoverageContainer();
    if (!container) return;
    injectCoverageStyles();
    container.innerHTML = '';

    const heading = document.createElement('h2');
    heading.textContent = 'Coverage snapshot';
    container.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'coverage-summary__meta';
    container.appendChild(meta);

    if (snapshot === null) {
      meta.textContent = 'Loading coverage snapshot…';
      return;
    }

    if (!snapshot || typeof snapshot !== 'object') {
      meta.textContent = 'Coverage snapshot not available.';
      return;
    }

    const generated = snapshot.generated_at ? new Date(snapshot.generated_at).toLocaleString() : null;
    const defaultTarget = toFinite(snapshot.default_target_per_cell);
    const metaParts = [];
    if (generated) metaParts.push(`Generated ${generated}`);
    if (defaultTarget != null) metaParts.push(`Default target per cell: ${Math.round(defaultTarget)}`);
    meta.textContent = metaParts.length ? metaParts.join(' • ') : 'Coverage snapshot by speaker profile attributes.';

    const cells = Array.isArray(snapshot.cells) ? snapshot.cells.slice() : [];
    if (!cells.length) {
      const empty = document.createElement('p');
      empty.className = 'coverage-summary__empty';
      empty.textContent = 'No coverage cells observed yet.';
      container.appendChild(empty);
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

  function fetchCoverageSnapshot() {
    if (typeof fetch !== 'function') {
      return Promise.resolve(null);
    }
    return fetch('coverage_snapshot.json', { cache: 'no-store' })
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

      fetchCoverageSnapshot()
        .then((snapshot) => {
          if (snapshot) {
            renderCoverageSnapshot(snapshot);
            renderCoverageCompletenessTile(snapshot);
          } else {
            renderCoverageSnapshot(undefined);
            renderCoverageCompletenessTile(undefined);
          }
        })
        .catch(() => {
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
