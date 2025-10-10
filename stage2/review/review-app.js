const PASS_NUMS = [1, 2];
const DIFF_TABS = ['cs', 'vt', 'rttm'];
const DRIFT_RESYNC_INTERVAL_MS = 3000;
const VOICE_TAG_TOLERANCE = 0.12;
const DIAR_BOUNDARY_TOLERANCE = 0.25;
const CUE_ROW_HEIGHT = 88;
const CUE_VIRTUAL_OVERSCAN = 6;
const MERGED_CUE_ESTIMATED_HEIGHT = 184;
const MERGED_CUE_MIN_HEIGHT = 112;
const MERGED_CUE_OVERSCAN_PX = 800;
const DIFF_PLAYBACK_INTERVAL = {
  playback: 60,
  scrub: 120,
};
const REVIEW_DRAFT_DB = 'stage2ReviewDrafts';
const REVIEW_DRAFT_STORE = 'drafts';
const REVIEW_DRAFT_VERSION = 1;
const CS_COLORS = {
  ara: { label: 'AR', color: '#f97316', background: 'rgba(249, 115, 22, 0.28)' },
  eng: { label: 'EN', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.28)' },
  fra: { label: 'FR', color: '#c084fc', background: 'rgba(192, 132, 252, 0.28)' },
  other: { label: 'Other', color: '#34d399', background: 'rgba(52, 211, 153, 0.28)' },
};
const MERGED_LANGUAGE_SET = new Set(['eng', 'fra', 'other']);

function formatTimecode(seconds) {
  if (!Number.isFinite(seconds)) return '00:00.000';
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = secs.toFixed(3).padStart(6, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseCodeSwitchSpans(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((span) => ({
        start: Number(span && span.start) || 0,
        end: Number(span && span.end) || 0,
        lang: typeof span?.lang === 'string' ? span.lang.toLowerCase() : span?.label || span?.language || 'other',
      }))
      .filter((span) => span.end > span.start);
  }
  const parsed = safeJsonParse(raw);
  if (parsed && Array.isArray(parsed.spans)) {
    return parseCodeSwitchSpans(parsed.spans);
  }
  return [];
}

function parseRttm(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 9 || parts[0] !== 'SPEAKER') return null;
      const start = Number(parts[3]);
      const dur = Number(parts[4]);
      const speaker = parts[7] || 'S';
      if (!Number.isFinite(start) || !Number.isFinite(dur)) return null;
      return { start, end: start + dur, speaker };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function inferVoiceTag(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return /voice\s*tag|\bvt\b|\[vt]/i.test(text) || normalized.includes('voice tag');
}

function extractVoiceTagCues(cues) {
  return cues
    .map((cue, index) => ({
      index,
      start: Number(cue.start) || 0,
      end: Number(cue.end) || 0,
      hasVoiceTag: inferVoiceTag(cue.text || ''),
    }))
    .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end));
}

function fetchText(url) {
  return fetch(url, { cache: 'no-store' }).then((res) => {
    if (!res.ok) return null;
    return res.text();
  });
}

function fetchJson(url) {
  return fetch(url, { cache: 'no-store' }).then((res) => {
    if (!res.ok) return null;
    return res.json();
  });
}

function getReviewerId() {
  if (typeof window === 'undefined') {
    return 'reviewer';
  }
  const key = 'ea_stage2_reviewer_id';
  try {
    const existing = window.localStorage?.getItem(key);
    if (existing) {
      return existing;
    }
  } catch {}
  try {
    const annotator = window.localStorage?.getItem('ea_stage2_annotator_id');
    if (annotator) {
      window.localStorage?.setItem(key, annotator);
      return annotator;
    }
  } catch {}
  return 'reviewer';
}

function normalizeMergedLanguage(span) {
  const key = toLanguageKey(span);
  return MERGED_LANGUAGE_SET.has(key) ? key : 'other';
}

const ReviewDraftStore = {
  dbPromise: null,

  async open() {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return null;
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }
    this.dbPromise = new Promise((resolve) => {
      const request = window.indexedDB.open(REVIEW_DRAFT_DB, REVIEW_DRAFT_VERSION);
      request.onerror = () => {
        console.warn('ReviewDraftStore: failed to open IndexedDB', request.error);
        resolve(null);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REVIEW_DRAFT_STORE)) {
          db.createObjectStore(REVIEW_DRAFT_STORE, { keyPath: 'assetId' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          console.info('ReviewDraftStore: database version changed, closing connection');
        };
        resolve(db);
      };
    });
    return this.dbPromise;
  },

  async get(assetId) {
    if (!assetId) return null;
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(REVIEW_DRAFT_STORE, 'readonly');
      const store = tx.objectStore(REVIEW_DRAFT_STORE);
      const request = store.get(assetId);
      request.onerror = () => {
        console.warn('ReviewDraftStore: failed to read draft', request.error);
        resolve(null);
      };
      request.onsuccess = () => {
        resolve(request.result || null);
      };
    });
  },

  async set(assetId, payload) {
    if (!assetId) return false;
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(REVIEW_DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(REVIEW_DRAFT_STORE);
      const request = store.put({ assetId, ...payload });
      request.onerror = () => {
        console.warn('ReviewDraftStore: failed to save draft', request.error);
        resolve(false);
      };
      request.onsuccess = () => resolve(true);
    });
  },

  async delete(assetId) {
    if (!assetId) return false;
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(REVIEW_DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(REVIEW_DRAFT_STORE);
      const request = store.delete(assetId);
      request.onerror = () => {
        console.warn('ReviewDraftStore: failed to delete draft', request.error);
        resolve(false);
      };
      request.onsuccess = () => resolve(true);
    });
  },
};

function toLanguageKey(span) {
  if (!span) return 'other';
  const lang = typeof span.lang === 'string' ? span.lang.toLowerCase() : span.language || span.label;
  if (!lang) return 'other';
  if (CS_COLORS[lang]) return lang;
  if (/eng?/.test(lang)) return 'eng';
  if (/fra|fr/.test(lang)) return 'fra';
  if (/ara|ar/.test(lang)) return 'ara';
  return 'other';
}

function normalizeSpeakerId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = /^s?(\d{1,3})$/i.exec(text);
  if (numeric) {
    return `S${Number(numeric[1])}`;
  }
  const embedded = /(\d{1,3})/.exec(text);
  if (embedded) {
    return `S${Number(embedded[1])}`;
  }
  return text.toUpperCase();
}

function computeIoU(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  const inter = Math.max(0, end - start);
  if (inter <= 0) return 0;
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

function computeCodeSwitchDiff(spansA, spansB) {
  const matchesB = new Set();
  const diffs = [];
  spansA.forEach((spanA) => {
    let best = null;
    let bestIdx = -1;
    spansB.forEach((spanB, idx) => {
      const iou = computeIoU(spanA, spanB);
      if (iou >= 0.5 && (best == null || iou > best)) {
        best = iou;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      matchesB.add(bestIdx);
      const spanB = spansB[bestIdx];
      if (toLanguageKey(spanA) !== toLanguageKey(spanB)) {
        const mid = (Math.max(spanA.start, spanB.start) + Math.min(spanA.end, spanB.end)) / 2;
        diffs.push({
          type: 'cs',
          time: mid,
          label: `${toLanguageKey(spanA).toUpperCase()} vs ${toLanguageKey(spanB).toUpperCase()}`,
        });
      }
    } else {
      const mid = (spanA.start + spanA.end) / 2;
      diffs.push({ type: 'cs', time: mid, label: 'Missing in Pass 2' });
    }
  });
  spansB.forEach((spanB, idx) => {
    if (!matchesB.has(idx)) {
      const mid = (spanB.start + spanB.end) / 2;
      diffs.push({ type: 'cs', time: mid, label: 'Missing in Pass 1' });
    }
  });
  return diffs.sort((a, b) => a.time - b.time);
}

function alignVoiceCues(cuesA, cuesB) {
  let i = 0;
  let j = 0;
  const pairs = [];
  while (i < cuesA.length && j < cuesB.length) {
    const cueA = cuesA[i];
    const cueB = cuesB[j];
    const startDelta = cueA.start - cueB.start;
    if (Math.abs(startDelta) <= VOICE_TAG_TOLERANCE) {
      pairs.push({ cueA, cueB });
      i += 1;
      j += 1;
      continue;
    }
    if (startDelta < 0) {
      pairs.push({ cueA, cueB: null });
      i += 1;
    } else {
      pairs.push({ cueA: null, cueB });
      j += 1;
    }
  }
  while (i < cuesA.length) {
    pairs.push({ cueA: cuesA[i], cueB: null });
    i += 1;
  }
  while (j < cuesB.length) {
    pairs.push({ cueA: null, cueB: cuesB[j] });
    j += 1;
  }
  return pairs;
}

function computeVoiceTagDiff(cuesA, cuesB) {
  const pairs = alignVoiceCues(extractVoiceTagCues(cuesA), extractVoiceTagCues(cuesB));
  const diffs = [];
  pairs.forEach(({ cueA, cueB }) => {
    if (cueA && cueB) {
      if (cueA.hasVoiceTag !== cueB.hasVoiceTag) {
        const time = (Math.max(cueA.start, cueB.start) + Math.min(cueA.end, cueB.end)) / 2;
        diffs.push({
          type: 'vt',
          time,
          label: cueA.hasVoiceTag ? 'Voice tag only in Pass 1' : 'Voice tag only in Pass 2',
        });
      }
    } else if (cueA && cueA.hasVoiceTag) {
      const time = (cueA.start + cueA.end) / 2;
      diffs.push({ type: 'vt', time, label: 'Voice tag missing in Pass 2' });
    } else if (cueB && cueB.hasVoiceTag) {
      const time = (cueB.start + cueB.end) / 2;
      diffs.push({ type: 'vt', time, label: 'Voice tag missing in Pass 1' });
    }
  });
  return diffs.sort((a, b) => a.time - b.time);
}

function computeDiarizationDiff(segmentsA, segmentsB) {
  let i = 0;
  let j = 0;
  const diffs = [];
  while (i < segmentsA.length && j < segmentsB.length) {
    const segA = segmentsA[i];
    const segB = segmentsB[j];
    const overlapStart = Math.max(segA.start, segB.start);
    const overlapEnd = Math.min(segA.end, segB.end);
    if (overlapEnd <= overlapStart) {
      if (segA.end < segB.start) {
        i += 1;
      } else {
        j += 1;
      }
      continue;
    }
    if (Math.abs(segA.start - segB.start) >= DIAR_BOUNDARY_TOLERANCE) {
      const time = Math.min(segA.start, segB.start) + Math.abs(segA.start - segB.start) / 2;
      diffs.push({ type: 'rttm', time, label: 'Start boundary mismatch' });
    }
    if (Math.abs(segA.end - segB.end) >= DIAR_BOUNDARY_TOLERANCE) {
      const time = Math.min(segA.end, segB.end) + Math.abs(segA.end - segB.end) / 2;
      diffs.push({ type: 'rttm', time, label: 'End boundary mismatch' });
    }
    if (segA.end < segB.end - 1e-3) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return diffs.sort((a, b) => a.time - b.time);
}

function findCueIndexAtTime(cues, time) {
  if (!Array.isArray(cues) || !cues.length) return -1;
  let left = 0;
  let right = cues.length - 1;
  let best = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const cue = cues[mid];
    if (!cue) break;
    if (time >= cue.start && time <= cue.end) {
      return mid;
    }
    if (time < cue.start) {
      right = mid - 1;
    } else {
      best = mid;
      left = mid + 1;
    }
  }
  return best;
}

function createPassState() {
  return {
    annotatorId: null,
    audioUrl: null,
    transcriptCues: [],
    translationCues: [],
    codeSwitchSpans: [],
    diarizationSegments: [],
    voiceTagCues: [],
    waveformReady: false,
  };
}

function resolveAudioUrl(meta, assetId, passNumber) {
  if (meta) {
    const passes = meta.passes || meta.double_pass || meta.doublePass || null;
    if (passes) {
      const key = `pass_${passNumber}`;
      const config = passes[key] || passes[passNumber - 1] || null;
      if (config) {
        const url =
          config.audio_url ||
          config.audioUrl ||
          config.media_url ||
          config.mediaUrl ||
          config.audio_path ||
          config.audioPath;
        if (typeof url === 'string' && url) return url;
      }
    }
    const generic =
      meta[`pass_${passNumber}_audio_url`] ||
      meta[`pass${passNumber}AudioUrl`] ||
      meta.audio_url ||
      meta.audioUrl ||
      meta.media_url ||
      meta.mediaUrl;
    if (typeof generic === 'string' && generic) return generic;
  }
  return `/data/stage2_output/${encodeURIComponent(assetId)}/pass_${passNumber}/audio.mp3`;
}

function normalizeAnnotator(meta, passNumber) {
  if (!meta) return null;
  const assignments = Array.isArray(meta.assignments) ? meta.assignments : [];
  const found = assignments.find((entry) => Number(entry?.pass_number ?? entry?.passNumber) === passNumber);
  if (found && found.annotator_id) return found.annotator_id;
  const key = `pass_${passNumber}_annotator`;
  if (meta[key]) return meta[key];
  return null;
}

function getCell(meta) {
  if (!meta) return null;
  return meta.cell || meta.assigned_cell || meta.assignedCell || null;
}

function getStatus(meta) {
  if (!meta) return 'pending';
  return meta.review_status || meta.reviewStatus || meta.status || 'pending';
}

function fetchPassData(base, passNumber) {
  const prefix = `${base}/pass_${passNumber}`;
  return Promise.all([
    fetchText(`${prefix}/transcript.vtt`),
    fetchText(`${prefix}/translation.vtt`),
    fetchText(`${prefix}/code_switch_spans.json`),
    fetchText(`${prefix}/diarization.rttm`),
    fetchText(`${prefix}/emotion.vtt`),
    fetchText(`${prefix}/events.vtt`),
  ]).then(([transcript, translation, codeSwitch, diar, emotion, events]) => {
    const transcriptCues = transcript && window.VTT ? window.VTT.parse(transcript) : [];
    const translationCues = translation && window.VTT ? window.VTT.parse(translation) : [];
    const codeSwitchSpans = parseCodeSwitchSpans(codeSwitch);
    const diarizationSegments = parseRttm(diar);
    const emotionCues = emotion && window.VTT ? window.VTT.parse(emotion) : [];
    const eventCues = events && window.VTT ? window.VTT.parse(events) : [];
    return {
      transcriptCues,
      translationCues,
      codeSwitchSpans,
      diarizationSegments,
      emotionCues,
      eventCues,
    };
  });
}

const ReviewPage = {
  state: {
    assetId: null,
    itemMeta: null,
    cell: null,
    status: null,
    adjudicatorId: null,
    passes: {
      1: createPassState(),
      2: createPassState(),
    },
    diffs: { cs: [], vt: [], rttm: [] },
    diffTimeline: [],
    activeTab: 'cs',
    selection: {
      diff: null,
      span: null,
    },
    highlightedCues: { 1: -1, 2: -1 },
    clipDuration: null,
    zoom: 1,
    canPromote: false,
    promote: {
      busy: false,
      locked: false,
      disabledReason: 'Enable edit to promote.',
    },
    playback: {
      playing: false,
      offset: 0,
      lastSync: 0,
    },
    diffPlayback: {
      active: null,
      rafId: null,
      timeoutId: null,
      pendingTime: null,
      pendingMode: 'playback',
      lastRender: 0,
    },
    modal: {
      cleanup: null,
    },
    review: {
      editingEnabled: false,
      merged: null,
      selectedCue: -1,
      validationErrors: [],
      localDraft: false,
      lastDraftSavedAt: null,
    },
  },
  virtualizers: {},
  mergedVirtualizer: null,
  elements: {},
  toasts: new Set(),

  init() {
    this.elements = {
      assetId: document.getElementById('reviewAssetId'),
      cell: document.getElementById('reviewCell'),
      status: document.getElementById('reviewStatus'),
      assign: document.getElementById('reviewAssign'),
      assignment: document.getElementById('reviewAssignment'),
      message: document.getElementById('reviewMessage'),
      empty: document.getElementById('reviewEmpty'),
      diffList: document.getElementById('diffList'),
      diffTabs: document.querySelectorAll('.rail-tab'),
      playButton: document.getElementById('controlPlay'),
      rewindButton: document.getElementById('controlRewind'),
      timecode: document.getElementById('controlTime'),
      toggleEdit: document.getElementById('toggleEdit'),
      promoteButton: document.getElementById('promoteMerged'),
      mergedOverlay: document.getElementById('mergedOverlay'),
      mergedCueList: document.getElementById('mergedCueList'),
      mergedValidation: document.getElementById('mergedValidation'),
      copyAllPass2: document.getElementById('copyAllPass2'),
      voiceTagSelect: document.getElementById('voiceTagSelect'),
      mergedCsTrack: document.getElementById('mergedCsTrack'),
      modalRoot: document.getElementById('modalRoot'),
      toastContainer: document.getElementById('reviewToasts'),
      zoomIn: document.getElementById('zoomIn'),
      zoomOut: document.getElementById('zoomOut'),
      audios: {
        1: document.getElementById('audio1'),
        2: document.getElementById('audio2'),
      },
      waveforms: {
        1: document.getElementById('waveform1'),
        2: document.getElementById('waveform2'),
      },
      csTracks: {
        1: document.getElementById('csTrack1'),
        2: document.getElementById('csTrack2'),
      },
      diarTracks: {
        1: document.getElementById('diarTrack1'),
        2: document.getElementById('diarTrack2'),
      },
      cueLists: {
        1: document.getElementById('cueList1'),
        2: document.getElementById('cueList2'),
      },
      annotators: {
        1: document.getElementById('pass1Annotator'),
        2: document.getElementById('pass2Annotator'),
      },
    };
    if (this.elements.voiceTagSelect) {
      this.elements.voiceTagSelect.disabled = true;
    }
    this.updateCopyAllPass2Button();
    this.updatePromoteButton();
    this.state.adjudicatorId = getReviewerId();
    this.bindEvents();
    this.bootstrap();
  },

  bindEvents() {
    this.elements.playButton?.addEventListener('click', () => {
      if (this.state.playback.playing) {
        this.pause();
      } else {
        this.play();
      }
    });
    this.elements.toggleEdit?.addEventListener('click', () => {
      this.toggleEditing();
    });
    this.elements.promoteButton?.addEventListener('click', () => {
      this.handlePromoteClick();
    });
    this.elements.voiceTagSelect?.addEventListener('change', (event) => {
      this.handleVoiceTagChange(event.target.value || '');
    });
    this.elements.rewindButton?.addEventListener('click', () => {
      const audio = this.elements.audios[1];
      if (!audio) return;
      audio.currentTime = Math.max(0, (audio.currentTime || 0) - 3);
      this.syncRight(true);
      this.updateTimecode(audio.currentTime || 0);
      this.updateHighlights(audio.currentTime || 0);
      this.requestDiffPlaybackUpdate(audio.currentTime || 0, 'scrub');
    });
    this.elements.zoomIn?.addEventListener('click', () => this.setZoom(this.state.zoom * 0.75));
    this.elements.zoomOut?.addEventListener('click', () => this.setZoom(this.state.zoom * 1.25));
    this.elements.copyAllPass2?.addEventListener('click', () => {
      this.handleBulkCopyAllFromPass(2);
    });
    this.elements.diffTabs?.forEach((tab) => {
      tab.addEventListener('click', () => {
        const type = tab.dataset.tab;
        if (!type || !DIFF_TABS.includes(type)) return;
        this.setActiveTab(type);
      });
    });
    this.elements.diffList?.addEventListener('click', (event) => {
      const item = event.target.closest('.diff-item');
      if (!item) return;
      const type = item.dataset.type;
      const index = Number(item.dataset.index);
      if (!type || !Number.isFinite(index)) return;
      this.selectDiff(type, index);
    });
    document.addEventListener('keydown', (event) => {
      const isSave = event.key && event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey);
      if (isSave) {
        event.preventDefault();
        this.handleDraftSaveShortcut();
        return;
      }

      if (this.isEditableTarget(event.target)) {
        return;
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        this.handleDiffHotkey(event.key === '[' ? -1 : 1);
        return;
      }

      if (
        (event.key === '1' || event.key === '2') &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const passNumber = Number(event.key);
        if (PASS_NUMS.includes(passNumber)) {
          event.preventDefault();
          this.handleCopyHotkey(passNumber);
        }
        return;
      }

      if ((event.key === 'v' || event.key === 'V') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        this.handleVoiceTagHotkey();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        this.handleEscapeHotkey();
      }
    });
    PASS_NUMS.forEach((passNumber) => {
      const audio = this.elements.audios[passNumber];
      if (!audio) return;
      audio.addEventListener('loadedmetadata', () => {
        if (passNumber === 1 && Number.isFinite(audio.duration)) {
          this.state.clipDuration = audio.duration;
          this.renderTracks(1);
          this.renderTracks(2);
        }
      });
      if (passNumber === 1) {
        audio.addEventListener('timeupdate', () => {
          const time = audio.currentTime || 0;
          this.updateTimecode(time);
          this.syncRight();
          this.updateHighlights(time);
          this.requestDiffPlaybackUpdate(time, 'playback');
        });
        audio.addEventListener('play', () => this.handleMasterPlay());
        audio.addEventListener('pause', () => this.handleMasterPause());
        audio.addEventListener('seeked', () => {
          this.syncRight(true);
          this.updateHighlights(audio.currentTime || 0);
          this.requestDiffPlaybackUpdate(audio.currentTime || 0, 'scrub');
        });
      }
    });
  },

  isEditableTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return Boolean(target.isContentEditable);
  },

  pauseAndSync() {
    if (this.state.playback.playing) {
      this.pause();
      this.syncRight(true);
    }
  },

  handleDiffHotkey(step) {
    this.pauseAndSync();
    this.stepDiff(step);
  },

  async handleCopyHotkey(passNumber) {
    if (!this.state.review.editingEnabled) return;
    this.ensureMergedInitialized();
    const pass = this.state.passes[passNumber];
    if (!pass) return;
    const spanSelection = this.state.selection.span;
    if (spanSelection && spanSelection.passNumber === passNumber && Number.isFinite(spanSelection.index)) {
      const span = pass.codeSwitchSpans?.[spanSelection.index];
      if (span) {
        const time = ((Number(span.start) || 0) + (Number(span.end) || 0)) / 2 || Number(span.start) || 0;
        this.pauseAndSync();
        this.seek(Math.max(0, time));
        await this.copySingleCodeSwitchSpan(passNumber, span);
        return;
      }
    }
    const cueIndex = this.state.highlightedCues?.[passNumber];
    if (!Number.isFinite(cueIndex) || cueIndex < 0) return;
    const cue = pass.transcriptCues?.[cueIndex];
    if (!cue) return;
    const mid = ((Number(cue.start) || 0) + (Number(cue.end) || 0)) / 2;
    this.pauseAndSync();
    this.seek(Math.max(0, mid));
    this.copyCueToMerged(passNumber, cueIndex);
  },

  async handleVoiceTagHotkey() {
    if (!this.state.review.editingEnabled) return;
    this.ensureMergedInitialized();
    const merged = this.state.review.merged;
    if (!merged || !Array.isArray(merged.transcriptCues) || !merged.transcriptCues.length) return;
    let index = this.state.review.selectedCue;
    const audio = this.elements.audios[1];
    const currentTime = audio ? audio.currentTime || 0 : 0;
    if (!Number.isFinite(index) || index < 0) {
      index = findCueIndexAtTime(merged.transcriptCues, currentTime);
    }
    if (!Number.isFinite(index) || index < 0) {
      index = 0;
    }
    const cue = merged.transcriptCues[index];
    if (!cue) return;
    this.pauseAndSync();
    this.seek(Math.max(0, Number(cue.start) || 0));
    this.state.review.selectedCue = index;
    this.renderMergedCues();
    const currentTag = this.extractVoiceTagValue(cue.text || '');
    const selection = await this.promptVoiceTagSelection(currentTag);
    if (selection === null) {
      return;
    }
    this.handleVoiceTagChange(selection);
  },

  handleEscapeHotkey() {
    this.clearSelection();
    this.dismissActiveModal();
  },

  async handleDraftSaveShortcut() {
    const saved = await this.saveLocalDraft();
    if (saved && this.elements.message) {
      this.setMessage('Local draft saved to this browser.');
    }
  },

  dismissActiveModal() {
    if (typeof this.state.modal?.cleanup === 'function') {
      const cleanup = this.state.modal.cleanup;
      this.state.modal.cleanup = null;
      cleanup(null);
    }
  },

  clearSelection() {
    if (this.state.selection.diff) {
      this.state.selection.diff = null;
      this.renderDiffs();
    }
    if (this.state.selection.span) {
      this.state.selection.span = null;
      PASS_NUMS.forEach((passNumber) => this.renderTracks(passNumber));
    }
  },

  setSpanSelection(passNumber, index) {
    if (!PASS_NUMS.includes(passNumber)) return;
    if (!Number.isFinite(index) || index < 0) {
      this.state.selection.span = null;
    } else {
      const current = this.state.selection.span;
      if (current && current.passNumber === passNumber && current.index === index) {
        this.state.selection.span = null;
      } else {
        this.state.selection.span = { passNumber, index };
      }
    }
    PASS_NUMS.forEach((num) => this.renderTracks(num));
  },

  getVoiceTagOptions() {
    const set = new Set();
    PASS_NUMS.forEach((passNumber) => {
      (this.state.passes[passNumber]?.diarizationSegments || []).forEach((segment) => {
        const normalized = normalizeSpeakerId(segment?.speaker);
        if (normalized) set.add(normalized);
      });
    });
    (this.state.review.merged?.transcriptCues || []).forEach((cue) => {
      const tag = this.extractVoiceTagValue(cue.text || '');
      if (tag) set.add(tag);
    });
    if (!set.size) {
      for (let i = 1; i <= 8; i += 1) {
        set.add(`S${i}`);
      }
    }
    return Array.from(set).sort((a, b) => {
      const matchA = /^S(\d+)$/.exec(a);
      const matchB = /^S(\d+)$/.exec(b);
      if (matchA && matchB) {
        return Number(matchA[1]) - Number(matchB[1]);
      }
      if (matchA) return -1;
      if (matchB) return 1;
      return a.localeCompare(b);
    });
  },

  promptVoiceTagSelection(currentValue) {
    return new Promise((resolve) => {
      const root = this.elements.modalRoot;
      if (!root) {
        resolve(currentValue || '');
        return;
      }
      root.innerHTML = '';
      root.hidden = false;
      const content = document.createElement('div');
      content.className = 'review-modal__content';
      const heading = document.createElement('h2');
      heading.className = 'review-modal__title';
      heading.textContent = 'Select speaker tag';
      const body = document.createElement('div');
      body.className = 'review-modal__body';
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.flexDirection = 'column';
      label.style.gap = '8px';
      label.textContent = 'Speaker';
      const select = document.createElement('select');
      select.style.padding = '8px';
      select.style.fontSize = '14px';
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = 'None';
      select.appendChild(noneOption);
      this.getVoiceTagOptions().forEach((optionValue) => {
        const opt = document.createElement('option');
        opt.value = optionValue;
        opt.textContent = optionValue;
        select.appendChild(opt);
      });
      select.value = currentValue || '';
      label.appendChild(select);
      body.appendChild(label);
      const actions = document.createElement('div');
      actions.className = 'review-modal__actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'review-modal__button';
      cancel.textContent = 'Cancel';
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'review-modal__button';
      apply.style.background = 'rgba(56, 189, 248, 0.35)';
      apply.style.borderColor = 'rgba(56, 189, 248, 0.45)';
      apply.textContent = 'Apply';
      actions.appendChild(cancel);
      actions.appendChild(apply);
      content.appendChild(heading);
      content.appendChild(body);
      content.appendChild(actions);
      root.appendChild(content);

      const cleanup = (value) => {
        root.hidden = true;
        root.innerHTML = '';
        document.removeEventListener('keydown', onKeyDown);
        this.state.modal.cleanup = null;
        resolve(value);
      };
      this.state.modal.cleanup = cleanup;

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          cleanup(select.value || '');
        }
      };
      document.addEventListener('keydown', onKeyDown);
      root.addEventListener(
        'click',
        (event) => {
          if (event.target === root) {
            cleanup(null);
          }
        },
        { once: true },
      );

      cancel.addEventListener('click', () => cleanup(null));
      apply.addEventListener('click', () => cleanup(select.value || ''));
      window.setTimeout(() => select.focus(), 0);
    });
  },

  async saveLocalDraft() {
    if (!this.state.assetId) return false;
    this.ensureMergedInitialized();
    const errors = this.validateMergedState();
    this.renderMergedValidation();
    if (errors.length) {
      return false;
    }
    const payload = {
      merged: this.serializeMergedState(),
      updatedAt: Date.now(),
    };
    const ok = await ReviewDraftStore.set(this.state.assetId, payload);
    if (ok) {
      this.state.review.localDraft = true;
      this.state.review.lastDraftSavedAt = payload.updatedAt;
      this.renderMergedValidation();
    }
    return ok;
  },

  serializeMergedState() {
    const merged = this.state.review.merged || { transcriptCues: [], codeSwitchSpans: [] };
    const cues = Array.isArray(merged.transcriptCues)
      ? merged.transcriptCues.map((cue) => ({
          start: Number(cue.start) || 0,
          end: Number(cue.end) || 0,
          text: cue.text || '',
        }))
      : [];
    const spans = Array.isArray(merged.codeSwitchSpans)
      ? merged.codeSwitchSpans.map((span) => ({
          start: Number(span.start) || 0,
          end: Number(span.end) || 0,
          lang: normalizeMergedLanguage(span),
        }))
      : [];
    return { transcriptCues: cues, codeSwitchSpans: spans };
  },

  async checkForLocalDraft() {
    if (!this.state.assetId) return;
    const existing = await ReviewDraftStore.get(this.state.assetId);
    if (!existing || !existing.merged) return;
    const choice = await this.showChoiceModal({
      title: 'Restore local draft?',
      body: 'We found a saved draft for this asset on this browser. Restore it?',
      actions: [
        { label: 'Restore draft', value: 'restore', primary: true },
        { label: 'Discard draft', value: 'discard' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (choice === 'restore') {
      this.applyMergedDraft(existing);
    } else if (choice === 'discard') {
      await ReviewDraftStore.delete(this.state.assetId);
      this.state.review.localDraft = false;
      this.state.review.lastDraftSavedAt = null;
      this.renderMergedValidation();
    }
  },

  applyMergedDraft(record) {
    if (!record || !record.merged) return;
    const merged = {
      transcriptCues: Array.isArray(record.merged.transcriptCues)
        ? record.merged.transcriptCues.map((cue) => ({
            start: Number(cue.start) || 0,
            end: Number(cue.end) || 0,
            text: cue.text || '',
          }))
        : [],
      codeSwitchSpans: Array.isArray(record.merged.codeSwitchSpans)
        ? record.merged.codeSwitchSpans.map((span) => ({
            start: Number(span.start) || 0,
            end: Number(span.end) || 0,
            lang: normalizeMergedLanguage(span),
          }))
        : [],
    };
    this.state.review.merged = merged;
    this.state.review.selectedCue = merged.transcriptCues.length ? 0 : -1;
    this.state.review.localDraft = true;
    this.state.review.lastDraftSavedAt = record.updatedAt || Date.now();
    this.setEditingEnabled(true);
    this.normalizeMergedCues();
    this.normalizeMergedSpans();
    this.validateMergedState();
    this.renderMergedEditor();
  },

  markReviewOpened() {
    if (!this.state.assetId) return;
    if (typeof window === 'undefined' || !window.sessionStorage) return;
    try {
      window.sessionStorage.setItem(`hasOpenedReview:${this.state.assetId}`, 'true');
    } catch {}
  },

  formatDraftTimestamp(timestamp) {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  },

  bootstrap() {
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get('asset_id') || params.get('asset');
    if (!assetId) {
      this.setMessage('Missing asset_id parameter.');
      return;
    }
    this.state.assetId = assetId;
    this.setMessage('Loading passes…');
    const base = `/data/stage2_output/${encodeURIComponent(assetId)}`;
    Promise.all([fetchJson(`${base}/item_meta.json`), fetchPassData(base, 1), fetchPassData(base, 2)])
      .then(([itemMeta, pass1, pass2]) => {
        if (!pass1 || !pass2) {
          this.setMessage('Failed to load double pass data.');
          return;
        }
        this.state.itemMeta = itemMeta || null;
        this.state.cell = getCell(itemMeta) || '—';
        this.state.status = getStatus(itemMeta);
        const statusKey = typeof this.state.status === 'string' ? this.state.status.toLowerCase() : '';
        const adjudicationStatus =
          typeof itemMeta?.adjudication?.status === 'string'
            ? itemMeta.adjudication.status.toLowerCase()
            : '';
        const statusEligible = statusKey === 'assigned' || statusKey === 'in_review';
        const adjudicationEligible = adjudicationStatus !== 'locked' && adjudicationStatus !== 'resolved';
        this.state.canPromote = statusEligible && adjudicationEligible;
        if (!statusEligible) {
          this.state.promote.locked = true;
          this.state.promote.disabledReason = 'Asset status is not promotable.';
        } else if (!adjudicationEligible) {
          this.state.promote.locked = true;
          this.state.promote.disabledReason = 'Adjudication already resolved.';
        } else {
          this.state.promote.locked = false;
          this.state.promote.disabledReason = 'Enable edit to promote.';
        }
        this.updatePromoteButton();
        this.state.passes[1] = {
          ...createPassState(),
          ...pass1,
          audioUrl: resolveAudioUrl(itemMeta, assetId, 1),
          annotatorId: normalizeAnnotator(itemMeta, 1),
        };
        this.state.passes[2] = {
          ...createPassState(),
          ...pass2,
          audioUrl: resolveAudioUrl(itemMeta, assetId, 2),
          annotatorId: normalizeAnnotator(itemMeta, 2),
        };
        const first1 = this.state.passes[1].transcriptCues?.[0]?.start ?? 0;
        const first2 = this.state.passes[2].transcriptCues?.[0]?.start ?? 0;
        const offset = Number.isFinite(first2 - first1) ? first2 - first1 : 0;
        this.state.playback.offset = offset;
        PASS_NUMS.forEach((passNumber) => {
          const audio = this.elements.audios[passNumber];
          if (audio) {
            audio.src = this.state.passes[passNumber].audioUrl;
          }
        });
        this.renderMeta();
        this.prepareVirtualizers();
        this.computeDiffs();
        this.renderDiffs();
        this.updateHighlights(0);
        this.setMessage('');
        this.hideOverlay();
        this.markReviewOpened();
        this.checkForLocalDraft();
        this.updateCopyAllPass2Button();
        this.updatePromoteButton();
      })
      .catch((err) => {
        console.error('Review bootstrap failed', err);
        this.setMessage('Failed to load review data.');
        this.state.canPromote = false;
        this.state.promote.locked = true;
        this.state.promote.disabledReason = 'Unable to load review data.';
        this.updatePromoteButton();
      });
  },

  setMessage(message) {
    if (this.elements.message) this.elements.message.textContent = message || '';
  },

  hideOverlay() {
    if (this.elements.empty) {
      this.elements.empty.classList.add('is-hidden');
    }
  },

  renderMeta() {
    if (this.elements.assetId) this.elements.assetId.textContent = this.state.assetId || '—';
    if (this.elements.cell) this.elements.cell.textContent = this.state.cell || '—';
    if (this.elements.status) this.elements.status.textContent = this.state.status || 'pending';
    PASS_NUMS.forEach((passNumber) => {
      const annotator = this.state.passes[passNumber].annotatorId || 'Unknown annotator';
      if (this.elements.annotators[passNumber]) {
        this.elements.annotators[passNumber].textContent = annotator;
      }
    });
  },

  prepareVirtualizers() {
    PASS_NUMS.forEach((passNumber) => {
      const cues = this.state.passes[passNumber].transcriptCues || [];
      const existing = this.virtualizers[passNumber];
      if (existing?.destroy) {
        existing.destroy();
      }
      this.virtualizers[passNumber] = this.createPassVirtualizer(passNumber, () =>
        this.state.passes[passNumber].transcriptCues || [],
      );
    });
  },

  createPassVirtualizer(passNumber, getItems) {
    const container = this.elements.cueLists[passNumber];
    if (!container) return null;
    container.innerHTML = '';
    const scroller = document.createElement('div');
    scroller.className = 'cue-list__scroller';
    const spacer = document.createElement('div');
    spacer.className = 'cue-list__spacer';
    const viewport = document.createElement('div');
    viewport.className = 'cue-list__viewport';
    viewport.style.display = 'flex';
    viewport.style.flexDirection = 'column';
    scroller.appendChild(spacer);
    scroller.appendChild(viewport);
    container.appendChild(scroller);

    const state = {
      raf: null,
      dirty: true,
      start: 0,
      end: 0,
      items: [],
      rows: new Map(),
    };

    const getCue = (index) => state.items[index];

    const renderRow = (index, cue, existing) => {
      if (!cue) return null;
      let row = existing || null;
      if (!row) {
        row = document.createElement('div');
        row.className = 'cue-row';
        row.dataset.index = String(index);
        const time = document.createElement('div');
        time.className = 'cue-time';
        const text = document.createElement('div');
        text.className = 'cue-text';
        const transcript = document.createElement('div');
        transcript.className = 'cue-text__transcript';
        text.appendChild(transcript);
        const translation = document.createElement('div');
        translation.className = 'cue-text__translation';
        text.appendChild(translation);
        const actions = document.createElement('div');
        actions.className = 'cue-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'cue-copy-button';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const idx = Number(row?.dataset.index);
          if (Number.isFinite(idx)) {
            this.copyCueToMerged(passNumber, idx);
          }
        });
        actions.appendChild(copyBtn);
        row.appendChild(time);
        row.appendChild(text);
        row.appendChild(actions);
        row._refs = { time, transcript, translation, actions };
      }
      row.dataset.index = String(index);
      const refs = row._refs;
      if (refs) {
        refs.time.textContent = `${formatTimecode(cue.start)} → ${formatTimecode(cue.end)}`;
        refs.transcript.textContent = cue.text || '';
        const translationText = this.getTranslationText(passNumber, cue);
        refs.translation.textContent = translationText || '';
        refs.translation.style.display = translationText ? 'block' : 'none';
        refs.actions.style.display = this.state.review?.editingEnabled ? 'flex' : 'none';
      }
      row.classList.toggle('is-highlighted', this.state.highlightedCues[passNumber] === index);
      return row;
    };

    const render = () => {
      state.raf = null;
      state.items = getItems() || [];
      const count = state.items.length;
      spacer.style.height = `${Math.max(1, count * CUE_ROW_HEIGHT)}px`;
      const scrollTop = container.scrollTop || 0;
      const height = container.clientHeight || 1;
      const start = Math.max(0, Math.floor(scrollTop / CUE_ROW_HEIGHT) - CUE_VIRTUAL_OVERSCAN);
      const end = Math.min(
        count,
        Math.ceil((scrollTop + height) / CUE_ROW_HEIGHT) + CUE_VIRTUAL_OVERSCAN,
      );
      if (!state.dirty && start === state.start && end === state.end) {
        return;
      }
      state.start = start;
      state.end = Math.min(count, Math.max(start + 1, end));
      state.dirty = false;
      viewport.style.transform = `translateY(${start * CUE_ROW_HEIGHT}px)`;
      const prev = state.rows;
      const next = new Map();
      const fragment = document.createDocumentFragment();
      for (let index = start; index < state.end; index += 1) {
        const cue = getCue(index);
        if (!cue) continue;
        let row = prev.get(index) || null;
        if (row) {
          prev.delete(index);
        }
        row = renderRow(index, cue, row);
        if (!row) continue;
        fragment.appendChild(row);
        next.set(index, row);
      }
      prev.forEach((row) => {
        row.remove();
      });
      viewport.replaceChildren(fragment);
      state.rows = next;
    };

    const schedule = () => {
      if (state.raf != null) return;
      state.raf = window.requestAnimationFrame(render);
    };

    container.addEventListener('scroll', schedule);
    schedule();

    return {
      setDirty: () => {
        state.dirty = true;
        schedule();
      },
      sync: () => {
        state.dirty = true;
        schedule();
      },
      scrollToIndex: (index) => {
        if (!Number.isFinite(index) || index < 0) return;
        const top = index * CUE_ROW_HEIGHT - (container.clientHeight || 0) / 2;
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      },
      destroy: () => {
        if (state.raf != null) {
          window.cancelAnimationFrame(state.raf);
        }
        container.removeEventListener('scroll', schedule);
        state.rows.forEach((row) => row.remove());
        state.rows.clear();
      },
    };
  },

  createMergedVirtualizer(getItems) {
    const container = this.elements.mergedCueList;
    if (!container) return null;
    container.innerHTML = '';
    container.classList.add('merged-cue-list--virtualized');
    const scroller = document.createElement('div');
    scroller.className = 'merged-cue-list__scroller';
    const spacer = document.createElement('div');
    spacer.className = 'merged-cue-list__spacer';
    const viewport = document.createElement('div');
    viewport.className = 'merged-cue-list__viewport';
    scroller.appendChild(spacer);
    scroller.appendChild(viewport);
    container.appendChild(scroller);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            entries.forEach((entry) => {
              const index = Number(entry.target.dataset.index);
              if (!Number.isFinite(index)) return;
              const height = entry.contentRect?.height;
              if (Number.isFinite(height) && height > 0) {
                updateHeight(index, height);
              }
            });
          })
        : null;

    const state = {
      raf: null,
      dirty: true,
      start: 0,
      end: 0,
      items: [],
      count: 0,
      rows: new Map(),
      heights: [],
      offsets: [],
      totalHeight: 1,
    };

    const refreshItems = () => {
      state.items = getItems() || [];
      const nextCount = state.items.length;
      if (nextCount !== state.count) {
        const nextHeights = new Array(nextCount);
        for (let i = 0; i < nextCount; i += 1) {
          nextHeights[i] = state.heights[i] || MERGED_CUE_ESTIMATED_HEIGHT;
        }
        state.heights = nextHeights;
        state.count = nextCount;
        rebuildOffsets();
      } else if (!state.offsets.length && nextCount > 0) {
        rebuildOffsets();
      }
    };

    const rebuildOffsets = () => {
      const { count } = state;
      state.offsets = new Array(count);
      let total = 0;
      for (let i = 0; i < count; i += 1) {
        const height = Math.max(MERGED_CUE_MIN_HEIGHT, state.heights[i] || MERGED_CUE_ESTIMATED_HEIGHT);
        state.heights[i] = height;
        state.offsets[i] = total;
        total += height;
      }
      state.totalHeight = total;
      spacer.style.height = `${Math.max(1, total)}px`;
    };

    const updateHeight = (index, measured) => {
      if (!Number.isFinite(index) || index < 0 || index >= state.count) return;
      const height = Math.max(MERGED_CUE_MIN_HEIGHT, measured);
      const current = state.heights[index] || MERGED_CUE_ESTIMATED_HEIGHT;
      if (Math.abs(height - current) < 1) {
        return;
      }
      const delta = height - current;
      state.heights[index] = height;
      for (let i = index + 1; i < state.offsets.length; i += 1) {
        state.offsets[i] += delta;
      }
      state.totalHeight += delta;
      spacer.style.height = `${Math.max(1, state.totalHeight)}px`;
      state.dirty = true;
      schedule();
    };

    const findStartIndex = (value) => {
      let low = 0;
      let high = state.count;
      while (low < high) {
        const mid = (low + high) >> 1;
        const end = (state.offsets[mid] || 0) + (state.heights[mid] || MERGED_CUE_ESTIMATED_HEIGHT);
        if (end <= value) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };

    const findEndIndex = (value) => {
      let low = 0;
      let high = state.count;
      while (low < high) {
        const mid = (low + high) >> 1;
        if ((state.offsets[mid] || 0) < value) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return low;
    };

    const renderRow = (index, cue, existing) => {
      if (!cue) return null;
      let row = existing || null;
      if (!row) {
        row = document.createElement('div');
        row.className = 'merged-cue';
        row.dataset.index = String(index);
        const meta = document.createElement('div');
        meta.className = 'merged-cue__meta';
        const timing = document.createElement('div');
        const duration = document.createElement('div');
        const controls = document.createElement('div');
        controls.className = 'merged-cue__controls';
        const makeButton = (label, action) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'merged-cue__button';
          button.textContent = label;
          button.dataset.action = action;
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const idx = Number(row?.dataset.index);
            if (Number.isFinite(idx)) {
              this.handleMergedCueAction(action, idx);
            }
          });
          return button;
        };
        controls.appendChild(makeButton('Split', 'split'));
        controls.appendChild(makeButton('Merge ←', 'merge-prev'));
        controls.appendChild(makeButton('Merge →', 'merge-next'));
        controls.appendChild(makeButton('Start −0.2s', 'nudge-start--0.2'));
        controls.appendChild(makeButton('Start +0.2s', 'nudge-start-0.2'));
        controls.appendChild(makeButton('End −0.2s', 'nudge-end--0.2'));
        controls.appendChild(makeButton('End +0.2s', 'nudge-end-0.2'));
        meta.appendChild(timing);
        meta.appendChild(duration);
        meta.appendChild(controls);
        const textarea = document.createElement('textarea');
        textarea.className = 'merged-cue__textarea';
        textarea.addEventListener('input', (event) => {
          const idx = Number(row?.dataset.index);
          if (!Number.isFinite(idx)) return;
          this.updateMergedCueText(idx, event.target.value);
        });
        textarea.addEventListener('focus', () => {
          const idx = Number(row?.dataset.index);
          if (Number.isFinite(idx)) {
            this.selectMergedCue(idx);
          }
        });
        row.addEventListener('click', (event) => {
          if (event.target.closest('button') || event.target.closest('textarea')) {
            return;
          }
          const idx = Number(row?.dataset.index);
          if (Number.isFinite(idx)) {
            this.selectMergedCue(idx);
          }
        });
        row.appendChild(meta);
        row.appendChild(textarea);
        row._refs = { timing, duration, textarea };
      }
      row.dataset.index = String(index);
      row.classList.toggle('is-selected', this.state.review.selectedCue === index);
      const refs = row._refs;
      if (refs) {
        const start = Number(cue.start) || 0;
        const end = Number(cue.end) || 0;
        refs.timing.textContent = `${formatTimecode(start)} → ${formatTimecode(end)}`;
        const duration = Math.max(0, end - start);
        refs.duration.textContent = `Duration: ${duration.toFixed(3)}s`;
        if (document.activeElement !== refs.textarea || Number(row.dataset.index) !== index) {
          if (refs.textarea.value !== (cue.text || '')) {
            refs.textarea.value = cue.text || '';
          }
        }
        refs.textarea.disabled = !this.state.review?.editingEnabled;
      }
      return row;
    };

    const render = () => {
      state.raf = null;
      refreshItems();
      if (!state.count) {
        viewport.replaceChildren();
        spacer.style.height = '1px';
        state.rows.forEach((row) => {
          if (resizeObserver && row._observing) {
            resizeObserver.unobserve(row);
            row._observing = false;
          }
          row.remove();
        });
        state.rows.clear();
        return;
      }
      const scrollTop = container.scrollTop || 0;
      const clientHeight = container.clientHeight || 1;
      const startPx = Math.max(0, scrollTop - MERGED_CUE_OVERSCAN_PX);
      const endPx = scrollTop + clientHeight + MERGED_CUE_OVERSCAN_PX;
      const start = Math.min(state.count - 1, findStartIndex(startPx));
      let end = Math.max(start + 1, findEndIndex(endPx));
      end = Math.min(state.count, end);
      if (!state.dirty && start === state.start && end === state.end) {
        return;
      }
      state.start = start;
      state.end = end;
      state.dirty = false;
      viewport.style.transform = `translateY(${state.offsets[start] || 0}px)`;
      const prev = state.rows;
      const next = new Map();
      const fragment = document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        const cue = state.items[index];
        if (!cue) continue;
        let row = prev.get(index) || null;
        if (row) {
          prev.delete(index);
        }
        row = renderRow(index, cue, row);
        if (!row) continue;
        fragment.appendChild(row);
        next.set(index, row);
        if (resizeObserver && !row._observing) {
          resizeObserver.observe(row);
          row._observing = true;
        }
        const measured = row.getBoundingClientRect?.().height;
        if (Number.isFinite(measured) && measured > 0) {
          updateHeight(index, measured);
        }
      }
      prev.forEach((row) => {
        if (resizeObserver && row._observing) {
          resizeObserver.unobserve(row);
          row._observing = false;
        }
        row.remove();
      });
      state.rows = next;
      viewport.replaceChildren(fragment);
    };

    const schedule = () => {
      if (state.raf != null) return;
      state.raf = window.requestAnimationFrame(render);
    };

    container.addEventListener('scroll', schedule);
    schedule();

    return {
      setDirty: () => {
        state.dirty = true;
        schedule();
      },
      sync: () => {
        refreshItems();
        rebuildOffsets();
        state.dirty = true;
        schedule();
      },
      scrollToIndex: (index) => {
        refreshItems();
        if (!Number.isFinite(index) || index < 0 || index >= state.count) return;
        const target = state.offsets[index] || 0;
        const top = target - (container.clientHeight || 0) / 2;
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      },
      destroy: () => {
        if (state.raf != null) {
          window.cancelAnimationFrame(state.raf);
        }
        container.removeEventListener('scroll', schedule);
        if (resizeObserver) {
          state.rows.forEach((row) => {
            if (row._observing) {
              resizeObserver.unobserve(row);
            }
          });
        }
        state.rows.forEach((row) => row.remove());
        state.rows.clear();
      },
    };
  },

  ensureMergedInitialized() {
    if (this.state.review.merged) return;
    const pass1 = this.state.passes[1];
    const transcriptCues = (pass1.transcriptCues || []).map((cue) => ({
      start: Number(cue.start) || 0,
      end: Number(cue.end) || 0,
      text: cue.text || '',
    }));
    const codeSwitchSpans = (pass1.codeSwitchSpans || []).map((span) => ({
      start: Number(span.start) || 0,
      end: Number(span.end) || 0,
      lang: normalizeMergedLanguage(span),
    }));
    this.state.review.merged = {
      transcriptCues,
      codeSwitchSpans,
    };
    this.state.review.selectedCue = transcriptCues.length ? 0 : -1;
    this.normalizeMergedCues();
    this.normalizeMergedSpans();
    this.validateMergedState();
    this.updateCopyAllPass2Button();
  },

  toggleEditing() {
    this.setEditingEnabled(!this.state.review.editingEnabled);
  },

  setEditingEnabled(enabled) {
    const next = Boolean(enabled);
    const prev = this.state.review.editingEnabled;
    if (prev === next) {
      if (next) {
        this.ensureMergedInitialized();
        this.renderMergedEditor();
      } else {
        this.setMergedOverlayVisible(false);
      }
      return;
    }
    this.state.review.editingEnabled = next;
    if (next) {
      this.ensureMergedInitialized();
    } else {
      this.state.selection.span = null;
    }
    if (this.elements.toggleEdit) {
      this.elements.toggleEdit.textContent = next ? 'Disable Edit' : 'Enable Edit';
    }
    if (this.elements.voiceTagSelect) {
      this.elements.voiceTagSelect.disabled = !next;
    }
    this.setMergedOverlayVisible(next);
    PASS_NUMS.forEach((passNumber) => {
      const virt = this.virtualizers[passNumber];
      if (virt) virt.setDirty();
      this.renderTracks(passNumber);
    });
    if (next) {
      this.renderMergedEditor();
    }
    this.updateCopyAllPass2Button();
    this.updatePromoteButton();
  },

  setMergedOverlayVisible(visible) {
    if (this.elements.mergedOverlay) {
      this.elements.mergedOverlay.hidden = !visible;
    }
  },

  renderMergedEditor() {
    if (!this.state.review.editingEnabled) {
      this.setMergedOverlayVisible(false);
      return;
    }
    this.setMergedOverlayVisible(true);
    this.renderMergedValidation();
    this.renderMergedCues();
    this.renderMergedCodeSwitch();
    this.updateCopyAllPass2Button();
    if (this.elements.voiceTagSelect) {
      const index = this.state.review.selectedCue;
      const cue = this.state.review.merged?.transcriptCues?.[index] || null;
      const tag = cue ? this.extractVoiceTagValue(cue.text || '') : '';
      this.elements.voiceTagSelect.value = tag || '';
      this.elements.voiceTagSelect.disabled = !cue;
    }
  },

  renderMergedValidation() {
    const el = this.elements.mergedValidation;
    if (!el) return;
    const errors = this.state.review.validationErrors || [];
    if (!errors.length) {
      el.classList.remove('has-errors');
      const messages = ['All cues valid.'];
      if (this.state.review.localDraft) {
        const timestamp = this.formatDraftTimestamp(this.state.review.lastDraftSavedAt);
        if (timestamp) {
          messages.push(`Draft saved at ${timestamp}.`);
        } else {
          messages.push('Local draft pending save.');
        }
      }
      el.textContent = messages.join(' ');
    } else {
      el.classList.add('has-errors');
      el.textContent = errors.join(' | ');
    }
    this.updatePromoteButton();
  },

  updatePromoteButton() {
    const button = this.elements.promoteButton;
    if (!button) return;
    const promoteState = this.state.promote || {};
    const busy = Boolean(promoteState.busy);
    const locked = Boolean(promoteState.locked);
    const errors = this.state.review.validationErrors || [];
    const editing = Boolean(this.state.review.editingEnabled);
    let disabled = false;
    let reason = '';
    if (!this.state.canPromote || locked) {
      disabled = true;
      reason = promoteState.disabledReason || 'Promotion unavailable for this asset.';
    } else if (!editing) {
      disabled = true;
      reason = 'Enable editing before promoting.';
    } else if (errors.length) {
      disabled = true;
      reason = 'Resolve validation issues before promoting.';
    }
    if (busy) {
      disabled = true;
    }
    button.disabled = disabled;
    if (busy) {
      button.innerHTML =
        '<span class="review-button__spinner" aria-hidden="true"></span><span class="review-button__label">Promoting…</span>';
      button.setAttribute('aria-busy', 'true');
    } else {
      button.innerHTML = '<span class="review-button__label">Promote merged</span>';
      button.removeAttribute('aria-busy');
    }
    if (disabled && reason) {
      button.title = reason;
    } else {
      button.removeAttribute('title');
    }
  },

  setPromoteBusy(busy) {
    this.state.promote.busy = Boolean(busy);
    this.updatePromoteButton();
  },

  lockPromote(reason) {
    this.state.promote.locked = true;
    if (reason) {
      this.state.promote.disabledReason = reason;
    }
    this.state.canPromote = false;
    this.updatePromoteButton();
  },

  async handlePromoteClick() {
    if (this.state.promote.busy || !this.state.assetId) return;
    if (!this.state.review.editingEnabled) {
      this.showToast('Enable editing before promoting the merged layer.', { variant: 'error' });
      return;
    }
    this.ensureMergedInitialized();
    const errors = this.validateMergedState();
    this.renderMergedValidation();
    if (errors.length) {
      await this.showValidationModal(errors);
      return;
    }
    if (!this.state.canPromote || this.state.promote.locked) {
      if (this.state.promote.disabledReason) {
        this.showToast(this.state.promote.disabledReason, { variant: 'error', duration: 6000 });
      }
      return;
    }
    this.setPromoteBusy(true);
    const payload = {
      asset_id: this.state.assetId,
      adjudicator_id: this.state.adjudicatorId || getReviewerId(),
    };
    let response;
    try {
      response = await fetch('/api/adjudication/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('Promote request failed', err);
      this.setPromoteBusy(false);
      this.showToast('Unable to promote merged layer. Check your connection and try again.', {
        variant: 'error',
        duration: 6000,
      });
      return;
    }
    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data?.detail || data?.message || '';
      } catch {
        try {
          detail = await response.text();
        } catch {}
      }
      if (!detail) {
        detail = response.status === 409 ? 'This asset is no longer promotable.' : 'Unable to promote merged layer.';
      }
      if (response.status === 409 || response.status === 404) {
        this.lockPromote(detail);
      } else if (detail) {
        this.state.promote.disabledReason = detail;
        this.updatePromoteButton();
      }
      this.setPromoteBusy(false);
      this.showToast(detail, { variant: 'error', duration: 6000 });
      return;
    }
    await response.json().catch(() => ({}));
    this.setPromoteBusy(false);
    this.lockPromote('This asset has been promoted.');
    this.showToast('Merged layer promoted successfully.', { variant: 'success', duration: 2000 });
    try {
      window.sessionStorage?.setItem(`hasOpenedReview:${this.state.assetId}`, 'true');
    } catch {}
    window.setTimeout(() => {
      window.location.href = '/stage2/qa-dashboard.html?status=locked';
    }, 600);
  },

  showValidationModal(errors) {
    const list = Array.isArray(errors) ? errors : [];
    if (!list.length) return Promise.resolve();
    const root = this.elements.modalRoot;
    if (!root) {
      window.alert(list.join('\n'));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      root.innerHTML = '';
      root.hidden = false;
      const content = document.createElement('div');
      content.className = 'review-modal__content';
      const title = document.createElement('h2');
      title.className = 'review-modal__title';
      title.textContent = 'Resolve validation issues';
      const body = document.createElement('div');
      body.className = 'review-modal__body';
      const listEl = document.createElement('ul');
      listEl.style.paddingLeft = '20px';
      listEl.style.margin = '0';
      list.forEach((message) => {
        const item = document.createElement('li');
        item.textContent = message;
        listEl.appendChild(item);
      });
      body.appendChild(listEl);
      const actions = document.createElement('div');
      actions.className = 'review-modal__actions';
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'review-modal__button';
      closeButton.textContent = 'Close';
      actions.appendChild(closeButton);
      content.appendChild(title);
      content.appendChild(body);
      content.appendChild(actions);
      root.appendChild(content);

      const cleanup = () => {
        root.hidden = true;
        root.innerHTML = '';
        document.removeEventListener('keydown', onKeyDown);
        this.state.modal.cleanup = null;
        resolve();
      };
      this.state.modal.cleanup = cleanup;

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup();
        }
      };
      document.addEventListener('keydown', onKeyDown);
      root.addEventListener(
        'click',
        (event) => {
          if (event.target === root) {
            cleanup();
          }
        },
        { once: true },
      );
      closeButton.addEventListener('click', cleanup);
    });
  },

  dismissToast(toast) {
    if (!toast) return;
    const timer = toast.dataset ? Number(toast.dataset.timer || 0) : 0;
    if (timer) window.clearTimeout(timer);
    toast.remove();
    this.toasts.delete(toast);
  },

  showToast(message, options = {}) {
    const container = this.elements.toastContainer;
    if (!container || !message) return null;
    const variant = options.variant || 'info';
    const duration = Number.isFinite(options.duration) ? Number(options.duration) : 4000;
    const toast = document.createElement('div');
    toast.className = 'review-toast';
    if (variant === 'success') toast.classList.add('review-toast--success');
    else if (variant === 'error') toast.classList.add('review-toast--error');
    const icon = document.createElement('span');
    icon.className = 'review-toast__icon';
    icon.textContent = variant === 'success' ? '✓' : variant === 'error' ? '⚠️' : 'ℹ️';
    const body = document.createElement('div');
    body.className = 'review-toast__message';
    body.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'review-toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', () => this.dismissToast(toast));
    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(close);
    container.appendChild(toast);
    this.toasts.add(toast);
    if (duration > 0) {
      const timer = window.setTimeout(() => this.dismissToast(toast), duration);
      toast.dataset.timer = String(timer);
    }
    return toast;
  },

  renderMergedCues() {
    const container = this.elements.mergedCueList;
    if (!container) return;
    const merged = this.state.review.merged;
    const cues = Array.isArray(merged?.transcriptCues) ? merged.transcriptCues : [];
    if (!cues.length) {
      if (this.mergedVirtualizer?.destroy) {
        this.mergedVirtualizer.destroy();
      }
      this.mergedVirtualizer = null;
      container.classList.remove('merged-cue-list--virtualized');
      container.innerHTML = '';
      const empty = document.createElement('div');
      empty.style.color = 'var(--review-muted)';
      empty.textContent = 'No cues available in merged layer.';
      container.appendChild(empty);
      return;
    }
    if (!this.mergedVirtualizer) {
      this.mergedVirtualizer = this.createMergedVirtualizer(() =>
        this.state.review.merged?.transcriptCues || [],
      );
    } else {
      this.mergedVirtualizer.sync();
    }
    this.mergedVirtualizer.setDirty();
  },

  handleMergedCueAction(action, index) {
    if (!Number.isFinite(index) || index < 0) return;
    switch (action) {
      case 'split':
        this.splitMergedCue(index);
        break;
      case 'merge-prev':
        this.mergeMergedCue(index, 'prev');
        break;
      case 'merge-next':
        this.mergeMergedCue(index, 'next');
        break;
      case 'nudge-start--0.2':
        this.nudgeMergedCue(index, 'start', -0.2);
        break;
      case 'nudge-start-0.2':
        this.nudgeMergedCue(index, 'start', 0.2);
        break;
      case 'nudge-end--0.2':
        this.nudgeMergedCue(index, 'end', -0.2);
        break;
      case 'nudge-end-0.2':
        this.nudgeMergedCue(index, 'end', 0.2);
        break;
      default:
        break;
    }
  },

  renderMergedCodeSwitch() {
    const track = this.elements.mergedCsTrack;
    if (!track) return;
    track.innerHTML = '';
    const merged = this.state.review.merged;
    if (!merged) return;
    const spans = merged.codeSwitchSpans || [];
    const duration = this.state.clipDuration;
    if (!spans.length || !Number.isFinite(duration) || duration <= 0) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--review-muted)';
      empty.style.padding = '12px';
      empty.textContent = 'No code switch spans in merged layer.';
      track.appendChild(empty);
      return;
    }
    spans.forEach((span) => {
      const block = document.createElement('div');
      block.className = 'cs-block';
      const startRatio = Math.max(0, Math.min(1, span.start / duration));
      const endRatio = Math.max(0, Math.min(1, span.end / duration));
      block.style.position = 'absolute';
      block.style.top = '0';
      block.style.bottom = '0';
      block.style.left = `${startRatio * 100}%`;
      block.style.width = `${Math.max(0.5, (endRatio - startRatio) * 100)}%`;
      const key = normalizeMergedLanguage(span);
      const spec = CS_COLORS[key] || CS_COLORS.other;
      block.style.background = spec.background;
      block.style.color = spec.color || '#f8fafc';
      block.textContent = spec.label || key.toUpperCase();
      track.appendChild(block);
    });
  },

  updateCopyAllPass2Button() {
    const button = this.elements.copyAllPass2;
    if (!button) return;
    const editing = Boolean(this.state.review?.editingEnabled);
    const spans = this.state.passes?.[2]?.codeSwitchSpans || [];
    const hasSpans = Array.isArray(spans) && spans.length > 0;
    button.disabled = !editing || !hasSpans;
    if (!editing) {
      button.title = 'Enable edit mode to copy code switch spans.';
    } else if (!hasSpans) {
      button.title = 'Pass 2 has no code switch spans to copy.';
    } else {
      button.title = 'Copy all code switch spans from Pass 2.';
    }
  },

  updateMergedCueText(index, text) {
    if (!this.state.review.merged?.transcriptCues) return;
    const cue = this.state.review.merged.transcriptCues[index];
    if (!cue) return;
    cue.text = text;
    this.validateMergedState();
    this.renderMergedValidation();
    if (this.mergedVirtualizer) {
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(() => this.mergedVirtualizer?.setDirty());
      } else {
        this.mergedVirtualizer.setDirty();
      }
    }
  },

  selectMergedCue(index) {
    if (!this.state.review.merged) return;
    this.state.review.selectedCue = index;
    this.renderMergedEditor();
    if (this.mergedVirtualizer && Number.isFinite(index) && index >= 0) {
      this.mergedVirtualizer.scrollToIndex(index);
    }
  },

  splitMergedCue(index) {
    const merged = this.state.review.merged;
    if (!merged) return;
    const cues = merged.transcriptCues || [];
    const cue = cues[index];
    if (!cue) return;
    const midpoint = (Number(cue.start) + Number(cue.end)) / 2;
    const response = window.prompt('Split cue at time (seconds):', midpoint.toFixed(3));
    const value = Number(response);
    if (!Number.isFinite(value)) return;
    const splitTime = Math.max(cue.start + 0.05, Math.min(cue.end - 0.05, value));
    if (!(splitTime > cue.start && splitTime < cue.end)) return;
    const adjusted = Number(splitTime.toFixed(3));
    const first = { ...cue, end: adjusted };
    const second = { ...cue, start: adjusted };
    cues.splice(index, 1, first, second);
    this.state.review.selectedCue = index;
    this.updateMergedAfterCueChange();
  },

  mergeMergedCue(index, direction) {
    const merged = this.state.review.merged;
    if (!merged) return;
    const cues = merged.transcriptCues || [];
    const cue = cues[index];
    if (!cue) return;
    const neighborIndex = direction === 'prev' ? index - 1 : index + 1;
    const neighbor = cues[neighborIndex];
    if (!neighbor) return;
    const primaryIndex = direction === 'prev' ? neighborIndex : index;
    const primary = cues[primaryIndex];
    const secondary = direction === 'prev' ? cue : neighbor;
    primary.start = Math.min(primary.start, secondary.start);
    primary.end = Math.max(primary.end, secondary.end);
    const textA = primary.text || '';
    const textB = secondary.text || '';
    primary.text = [textA, textB].filter(Boolean).join('\n').trim();
    cues.splice(direction === 'prev' ? index : neighborIndex, 1);
    this.state.review.selectedCue = primaryIndex;
    this.updateMergedAfterCueChange();
  },

  nudgeMergedCue(index, edge, delta) {
    const merged = this.state.review.merged;
    if (!merged) return;
    const cues = merged.transcriptCues || [];
    const cue = cues[index];
    if (!cue) return;
    const next = { start: cue.start, end: cue.end };
    if (edge === 'start') {
      const prevEnd = index > 0 ? cues[index - 1].end : 0;
      const minStart = prevEnd != null ? prevEnd + 0.01 : 0;
      const maxStart = next.end - 0.1;
      next.start = Math.max(minStart, Math.min(maxStart, next.start + delta));
    } else {
      const nextStart = index < cues.length - 1 ? cues[index + 1].start : Number.isFinite(this.state.clipDuration) ? this.state.clipDuration : next.end + delta;
      const maxEnd = nextStart != null ? nextStart - 0.01 : next.end + delta;
      const minEnd = next.start + 0.1;
      next.end = Math.max(minEnd, Math.min(maxEnd, next.end + delta));
    }
    cue.start = Number(next.start.toFixed(3));
    cue.end = Number(next.end.toFixed(3));
    if (cue.end <= cue.start) {
      cue.end = cue.start + 0.1;
    }
    this.state.review.selectedCue = index;
    this.updateMergedAfterCueChange();
  },

  copyCueToMerged(passNumber, cueIndex) {
    if (!this.state.review.editingEnabled) return;
    this.ensureMergedInitialized();
    const source = this.state.passes[passNumber]?.transcriptCues?.[cueIndex];
    if (!source) return;
    const merged = this.state.review.merged;
    const cues = merged.transcriptCues;
    const candidate = {
      start: Number(source.start) || 0,
      end: Number(source.end) || 0,
      text: source.text || '',
    };
    const mid = (candidate.start + candidate.end) / 2;
    const targetIndex = findCueIndexAtTime(cues, mid);
    if (targetIndex >= 0) {
      cues.splice(targetIndex, 1, candidate);
      this.state.review.selectedCue = targetIndex;
    } else {
      cues.push(candidate);
      this.normalizeMergedCues();
      const idx = findCueIndexAtTime(cues, mid);
      this.state.review.selectedCue = idx >= 0 ? idx : cues.length - 1;
    }
    this.updateMergedAfterCueChange();
  },

  async handleSpanCopyMenu(passNumber, span) {
    if (!this.state.review.editingEnabled) return;
    const choice = await this.showChoiceModal({
      title: 'Copy code switch span',
      body: 'Choose how to copy this span into the merged layer.',
      actions: [
        { label: 'Copy span only', value: 'single', primary: true },
        { label: 'Copy entire pass', value: 'all' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (choice === 'all') {
      await this.copyAllCodeSwitchSpans(passNumber);
    } else if (choice === 'single') {
      await this.copySingleCodeSwitchSpan(passNumber, span);
    }
  },

  async copyAllCodeSwitchSpans(passNumber) {
    if (!this.state.review.editingEnabled) return;
    if (passNumber === 2) {
      await this.handleBulkCopyAllFromPass(passNumber);
      return;
    }
    this.ensureMergedInitialized();
    const spans = (this.state.passes[passNumber]?.codeSwitchSpans || []).map((span) => ({
      start: Number(span.start) || 0,
      end: Number(span.end) || 0,
      lang: normalizeMergedLanguage(span),
    }));
    this.state.review.merged.codeSwitchSpans = spans;
    this.normalizeMergedSpans();
    this.validateMergedState();
    this.state.review.lastDraftSavedAt = null;
    this.renderMergedCodeSwitch();
    this.renderMergedValidation();
    this.updateCopyAllPass2Button();
  },

  async handleBulkCopyAllFromPass(passNumber) {
    this.ensureMergedInitialized();
    const pass = this.state.passes[passNumber];
    if (!pass || !Array.isArray(pass.codeSwitchSpans) || !pass.codeSwitchSpans.length) {
      this.showToast('No code switch spans available to copy from Pass 2.', { variant: 'info', duration: 3000 });
      return;
    }
    const dryRun = this.performBulkCopyDryRun(passNumber);
    if (!dryRun || !dryRun.operations.length) {
      this.showToast('No code switch spans available to copy from Pass 2.', { variant: 'info', duration: 3000 });
      return;
    }
    const summaryText = this.formatBulkCopySummary(dryRun);
    const confirmation = await this.showChoiceModal({
      title: 'Copy Pass 2 code switch spans',
      body: `${summaryText}. Apply these changes?`,
      actions: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Apply changes', value: 'confirm', primary: true },
      ],
    });
    if (confirmation !== 'confirm') {
      return;
    }
    const updatedSpans = await this.applyBulkCopyOperations(dryRun);
    if (!updatedSpans) {
      return;
    }
    const merged = this.state.review.merged;
    if (!merged) return;
    merged.codeSwitchSpans = updatedSpans;
    this.normalizeMergedSpans();
    this.validateMergedState();
    this.state.review.lastDraftSavedAt = null;
    this.renderMergedCodeSwitch();
    this.renderMergedValidation();
    this.computeDiffs();
    this.renderDiffs();
    this.updateCopyAllPass2Button();
    this.showToast('Copied code switch spans from Pass 2.', { variant: 'success', duration: 2500 });
  },

  performBulkCopyDryRun(passNumber) {
    const merged = this.state.review.merged;
    const pass = this.state.passes[passNumber];
    if (!merged || !pass) return null;
    const spans = Array.isArray(pass.codeSwitchSpans) ? pass.codeSwitchSpans : [];
    const operations = [];
    const counts = {
      inserts: 0,
      replacements: 0,
      conflicts: 0,
      reasons: { overlap: 0, 'too-short': 0 },
    };
    let working = this.normalizeSpanList(merged.codeSwitchSpans);
    spans.forEach((rawSpan, index) => {
      let candidate = this.cleanSpan(rawSpan);
      if (passNumber === 2) {
        candidate = this.cleanSpan(this.snapSpanToSilence(candidate));
      }
      const duration = candidate.end - candidate.start;
      const overlaps = this.getSpanOverlaps(candidate, working);
      let type = 'insert';
      let reason = null;
      if (duration < 0.4 - 1e-6) {
        type = 'conflict';
        reason = 'too-short';
      } else if (!overlaps.length) {
        type = 'insert';
      } else {
        const fullyOverlapsAll = overlaps.every(
          (existing) => candidate.start <= existing.start && candidate.end >= existing.end,
        );
        if (fullyOverlapsAll) {
          type = 'replace';
        } else {
          type = 'conflict';
          reason = 'overlap';
        }
      }
      operations.push({
        index,
        passNumber,
        type,
        reason,
        candidate,
        source: this.cleanSpan(rawSpan),
      });
      if (type === 'insert') {
        counts.inserts += 1;
        working.push({ ...candidate });
        working = this.normalizeSpanList(working);
      } else if (type === 'replace') {
        counts.replacements += 1;
        working = working.filter((existing) => existing.end <= candidate.start || existing.start >= candidate.end);
        working.push({ ...candidate });
        working = this.normalizeSpanList(working);
      } else if (type === 'conflict') {
        counts.conflicts += 1;
        if (reason) {
          counts.reasons[reason] = (counts.reasons[reason] || 0) + 1;
        }
      }
    });
    return { operations, counts, total: spans.length };
  },

  formatCount(count, singular, plural = null) {
    const label = count === 1 ? singular : plural || `${singular}s`;
    return `${count} ${label}`;
  },

  formatBulkCopySummary(result) {
    if (!result) return '';
    const { counts } = result;
    const parts = [];
    parts.push(this.formatCount(counts.inserts, 'insert'));
    parts.push(this.formatCount(counts.replacements, 'replacement'));
    if (counts.conflicts) {
      const reasonParts = [];
      if (counts.reasons.overlap) {
        reasonParts.push(this.formatCount(counts.reasons.overlap, 'overlap', 'overlaps'));
      }
      if (counts.reasons['too-short']) {
        reasonParts.push(this.formatCount(counts.reasons['too-short'], 'too short', 'too short'));
      }
      parts.push(`${this.formatCount(counts.conflicts, 'conflict')} (${reasonParts.join(', ')})`);
    } else {
      parts.push('No conflicts');
    }
    return parts.join(', ');
  },

  async applyBulkCopyOperations(dryRun) {
    const merged = this.state.review.merged;
    if (!merged || !dryRun) return null;
    let working = this.normalizeSpanList(merged.codeSwitchSpans);
    const decisions = {};
    for (const op of dryRun.operations) {
      const candidate = this.cleanSpan(op.candidate);
      if (op.type === 'insert') {
        const spanToInsert = this.expandSpanToMinimum(candidate);
        working.push(spanToInsert);
        working = this.normalizeSpanList(working);
        continue;
      }
      if (op.type === 'replace') {
        const spanToInsert = this.expandSpanToMinimum(candidate);
        let overlaps = this.getSpanOverlaps(spanToInsert, working);
        working = working.filter((existing) => !overlaps.includes(existing));
        working.push(spanToInsert);
        working = this.normalizeSpanList(working);
        continue;
      }
      if (op.type !== 'conflict') {
        continue;
      }
      const reasonKey = op.reason || 'overlap';
      let action = decisions[reasonKey] || null;
      if (!action) {
        const decision = await this.showBulkConflictModal(op, reasonKey);
        if (!decision || !decision.value) {
          return null;
        }
        action = decision.value;
        if (decision.applyToAll) {
          decisions[reasonKey] = action;
        }
      }
      if (action === 'keep') {
        continue;
      }
      let targetSpan = candidate;
      if (action === 'merge') {
        const overlaps = this.getSpanOverlaps(candidate, working);
        let unionStart = candidate.start;
        let unionEnd = candidate.end;
        overlaps.forEach((existing) => {
          unionStart = Math.min(unionStart, existing.start);
          unionEnd = Math.max(unionEnd, existing.end);
        });
        targetSpan = { ...candidate, start: unionStart, end: unionEnd };
      }
      targetSpan = this.expandSpanToMinimum(targetSpan);
      const overlaps = this.getSpanOverlaps(targetSpan, working);
      working = working.filter((existing) => !overlaps.includes(existing));
      working.push(targetSpan);
      working = this.normalizeSpanList(working);
    }
    return working;
  },

  async copySingleCodeSwitchSpan(passNumber, span) {
    if (!span) return;
    this.ensureMergedInitialized();
    let candidate = {
      start: Number(span.start) || 0,
      end: Number(span.end) || 0,
      lang: normalizeMergedLanguage(span),
    };
    if (passNumber === 2) {
      candidate = this.snapSpanToSilence(candidate);
    }
    const ensured = await this.ensureSpanMinimumDuration(candidate);
    if (!ensured) return;
    const resolved = await this.resolveSpanConflicts(ensured);
    if (!resolved) return;
    this.insertMergedSpan(resolved);
  },

  insertMergedSpan(span) {
    const merged = this.state.review.merged;
    if (!merged) return;
    merged.codeSwitchSpans.push({
      start: Number(span.start) || 0,
      end: Number(span.end) || 0,
      lang: normalizeMergedLanguage(span),
    });
    this.normalizeMergedSpans();
    this.validateMergedState();
    this.state.review.lastDraftSavedAt = null;
    this.renderMergedCodeSwitch();
    this.renderMergedValidation();
  },

  snapSpanToSilence(span) {
    const boundaries = this.getSilenceBoundaries();
    const snapped = { ...span };
    const startSnap = this.snapTimeToBoundary(span.start, boundaries);
    const endSnap = this.snapTimeToBoundary(span.end, boundaries);
    if (startSnap != null) snapped.start = startSnap;
    if (endSnap != null) snapped.end = endSnap;
    if (snapped.end <= snapped.start) {
      snapped.end = snapped.start + Math.max(0.1, span.end - span.start);
    }
    return snapped;
  },

  expandSpanToMinimum(span, minDuration = 0.4) {
    const duration = span.end - span.start;
    if (duration >= minDuration) {
      return this.cleanSpan(span);
    }
    const mid = (span.start + span.end) / 2;
    let start = mid - minDuration / 2;
    let end = mid + minDuration / 2;
    if (start < 0) {
      end += -start;
      start = 0;
    }
    if (Number.isFinite(this.state.clipDuration) && end > this.state.clipDuration) {
      const diff = end - this.state.clipDuration;
      end = this.state.clipDuration;
      start = Math.max(0, start - diff);
    }
    return this.cleanSpan({ ...span, start, end });
  },

  getSpanOverlaps(target, spans) {
    if (!target) return [];
    const list = Array.isArray(spans) ? spans : [];
    return list.filter((existing) => existing.end > target.start && existing.start < target.end);
  },

  snapTimeToBoundary(value, boundaries, tolerance = 0.12) {
    let best = null;
    boundaries.forEach((boundary) => {
      const delta = Math.abs(boundary - value);
      if (delta <= tolerance && (!best || delta < best.delta)) {
        best = { value: boundary, delta };
      }
    });
    return best ? Number(best.value.toFixed(3)) : value;
  },

  getSilenceBoundaries() {
    const set = new Set();
    PASS_NUMS.forEach((passNumber) => {
      (this.state.passes[passNumber]?.transcriptCues || []).forEach((cue) => {
        set.add(Number(cue.start) || 0);
        set.add(Number(cue.end) || 0);
      });
    });
    (this.state.review.merged?.transcriptCues || []).forEach((cue) => {
      set.add(Number(cue.start) || 0);
      set.add(Number(cue.end) || 0);
    });
    const arr = Array.from(set).filter((value) => Number.isFinite(value));
    arr.sort((a, b) => a - b);
    return arr;
  },

  async ensureSpanMinimumDuration(span) {
    const duration = span.end - span.start;
    if (duration >= 0.4) {
      return span;
    }
    const choice = await this.showChoiceModal({
      title: 'Span too short',
      body: `The copied span would be ${duration.toFixed(3)}s. Expand to the minimum 0.4s?`,
      actions: [
        { label: 'Expand to 0.4s', value: 'expand', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (choice === 'expand') {
      const mid = (span.start + span.end) / 2;
      const half = 0.2;
      let start = mid - half;
      let end = mid + half;
      if (start < 0) {
        end += -start;
        start = 0;
      }
      if (Number.isFinite(this.state.clipDuration) && end > this.state.clipDuration) {
        const diff = end - this.state.clipDuration;
        end = this.state.clipDuration;
        start = Math.max(0, start - diff);
      }
      return { ...span, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    }
    if (choice === 'cancel') {
      return null;
    }
    return span;
  },

  async resolveSpanConflicts(candidate) {
    const merged = this.state.review.merged;
    if (!merged) return candidate;
    const spans = merged.codeSwitchSpans || [];
    const overlaps = spans.filter((existing) => existing.end > candidate.start && existing.start < candidate.end);
    if (!overlaps.length) {
      return candidate;
    }
    const choice = await this.showChoiceModal({
      title: 'Overlap detected',
      body: 'The copied span overlaps existing merged spans. Choose how to resolve the conflict.',
      actions: [
        { label: 'Keep existing', value: 'keep' },
        { label: 'Replace', value: 'replace', primary: true },
        { label: 'Merge (union)', value: 'merge' },
      ],
    });
    if (choice === 'keep' || !choice) {
      return null;
    }
    if (choice === 'replace') {
      merged.codeSwitchSpans = spans.filter((existing) => !overlaps.includes(existing));
      return candidate;
    }
    if (choice === 'merge') {
      const unionStart = Math.min(candidate.start, ...overlaps.map((span) => span.start));
      const unionEnd = Math.max(candidate.end, ...overlaps.map((span) => span.end));
      merged.codeSwitchSpans = spans.filter((existing) => !overlaps.includes(existing));
      return { ...candidate, start: unionStart, end: unionEnd };
    }
    return candidate;
  },

  cleanSpan(span) {
    if (!span) {
      return { start: 0, end: 0, lang: 'other' };
    }
    const start = Number(span.start) || 0;
    const end = Number(span.end) || 0;
    return {
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      lang: normalizeMergedLanguage(span),
    };
  },

  normalizeSpanList(spans) {
    const list = Array.isArray(spans) ? spans : [];
    const cleaned = list
      .map((span) => this.cleanSpan(span))
      .filter((span) => span.end > span.start);
    cleaned.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const result = [];
    cleaned.forEach((span) => {
      const last = result[result.length - 1];
      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
        last.lang = span.lang;
      } else {
        result.push({ ...span });
      }
    });
    return result;
  },

  normalizeMergedCues() {
    const merged = this.state.review.merged;
    if (!merged) return;
    const cues = merged.transcriptCues || [];
    cues.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    cues.forEach((cue) => {
      cue.start = Number((Number(cue.start) || 0).toFixed(3));
      cue.end = Number((Number(cue.end) || 0).toFixed(3));
      cue.text = cue.text || '';
    });
  },

  normalizeMergedSpans() {
    const merged = this.state.review.merged;
    if (!merged) return;
    merged.codeSwitchSpans = this.normalizeSpanList(merged.codeSwitchSpans);
  },

  updateMergedAfterCueChange() {
    this.normalizeMergedCues();
    this.validateMergedState();
    this.state.review.lastDraftSavedAt = null;
    this.renderMergedEditor();
  },

  validateMergedState() {
    const merged = this.state.review.merged;
    if (!merged) {
      this.state.review.validationErrors = [];
      return [];
    }
    const errors = [];
    const cues = Array.isArray(merged.transcriptCues) ? merged.transcriptCues : [];
    let prevEnd = null;
    cues.forEach((cue, index) => {
      const start = Number(cue.start) || 0;
      const end = Number(cue.end) || 0;
      const duration = end - start;
      if (end <= start) {
        errors.push(`Cue ${index + 1} has invalid timing.`);
      }
      if (duration < 0.6 || duration > 6.0) {
        errors.push(`Cue ${index + 1} duration ${duration.toFixed(2)}s is out of bounds.`);
      }
      if (prevEnd != null) {
        if (start < prevEnd - 1e-3) {
          errors.push(`Cue ${index + 1} overlaps previous cue.`);
        }
        const gap = start - prevEnd;
        if (gap > 0.5) {
          errors.push(`Gap before cue ${index + 1} exceeds 0.5s.`);
        }
      }
      prevEnd = end;
    });

    const spans = Array.isArray(merged.codeSwitchSpans) ? [...merged.codeSwitchSpans] : [];
    spans.sort((a, b) => (a.start - b.start) || (a.end - b.end));
    let spanPrevEnd = null;
    spans.forEach((span, index) => {
      const start = Number(span.start) || 0;
      const end = Number(span.end) || 0;
      const duration = end - start;
      if (end <= start) {
        errors.push(`Code switch span ${index + 1} has invalid timing.`);
      }
      if (duration < 0.4) {
        errors.push(`Code switch span ${index + 1} is shorter than 0.4s.`);
      }
      if (spanPrevEnd != null && start < spanPrevEnd - 1e-3) {
        errors.push(`Code switch span ${index + 1} overlaps previous span.`);
      }
      const langKey = typeof span.lang === 'string' ? span.lang.toLowerCase() : '';
      if (!MERGED_LANGUAGE_SET.has(langKey)) {
        const label = span.lang || langKey || 'unknown';
        errors.push(`Code switch span ${index + 1} has unsupported language "${label}".`);
      }
      spanPrevEnd = end;
    });

    this.state.review.validationErrors = errors;
    return errors;
  },

  extractVoiceTagValue(text) {
    if (!text) return '';
    const match = /^<v\s+S(\d+)>/i.exec(text.trim());
    if (match) {
      return `S${match[1]}`;
    }
    return '';
  },

  handleVoiceTagChange(value) {
    if (!this.state.review.editingEnabled) return;
    const merged = this.state.review.merged;
    if (!merged) return;
    const index = this.state.review.selectedCue;
    if (index < 0) return;
    const cue = merged.transcriptCues?.[index];
    if (!cue) return;
    const cleaned = (cue.text || '').replace(/^<v\s+S\d+>\s*/i, '');
    if (!value) {
      cue.text = cleaned.trimStart();
    } else {
      cue.text = `<v ${value}> ${cleaned.trimStart()}`.trim();
    }
    this.renderMergedCues();
    if (this.elements.voiceTagSelect) {
      this.elements.voiceTagSelect.value = value || '';
    }
    this.state.review.lastDraftSavedAt = null;
    this.renderMergedValidation();
  },

  showChoiceModal({ title, body, actions } = {}) {
    return new Promise((resolve) => {
      const root = this.elements.modalRoot;
      if (!root) {
        resolve(null);
        return;
      }
      root.innerHTML = '';
      root.hidden = false;
      const content = document.createElement('div');
      content.className = 'review-modal__content';
      const heading = document.createElement('h2');
      heading.className = 'review-modal__title';
      heading.textContent = title || 'Select an option';
      const message = document.createElement('div');
      message.className = 'review-modal__body';
      message.textContent = body || '';
      const actionsEl = document.createElement('div');
      actionsEl.className = 'review-modal__actions';
      content.appendChild(heading);
      content.appendChild(message);
      content.appendChild(actionsEl);
      root.appendChild(content);
      const cleanup = (value) => {
        root.hidden = true;
        root.innerHTML = '';
        document.removeEventListener('keydown', onKeyDown);
        this.state.modal.cleanup = null;
        resolve(value);
      };
      this.state.modal.cleanup = cleanup;
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
        }
      };
      document.addEventListener('keydown', onKeyDown);
      root.addEventListener(
        'click',
        (event) => {
          if (event.target === root) {
            cleanup(null);
          }
        },
        { once: true },
      );
      const list = Array.isArray(actions) && actions.length ? actions : [{ label: 'Close', value: null }];
      list.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'review-modal__button';
        if (action.primary) {
          button.style.background = 'rgba(56, 189, 248, 0.35)';
          button.style.borderColor = 'rgba(56, 189, 248, 0.45)';
        }
        button.textContent = action.label || 'Select';
        button.addEventListener('click', () => cleanup(action.value));
        actionsEl.appendChild(button);
      });
    });
  },

  showBulkConflictModal(conflict, reasonKey) {
    return new Promise((resolve) => {
      const root = this.elements.modalRoot;
      if (!root) {
        resolve(null);
        return;
      }
      const candidate = this.cleanSpan(conflict?.candidate);
      root.innerHTML = '';
      root.hidden = false;
      const content = document.createElement('div');
      content.className = 'review-modal__content';
      const heading = document.createElement('h2');
      heading.className = 'review-modal__title';
      heading.textContent = 'Resolve conflict';
      const body = document.createElement('div');
      body.className = 'review-modal__body';
      const spanInfo = document.createElement('p');
      const duration = Math.max(0, candidate.end - candidate.start).toFixed(3);
      spanInfo.textContent = `Pass ${conflict.passNumber || 2} span ${conflict.index + 1}: ${formatTimecode(
        candidate.start,
      )} → ${formatTimecode(candidate.end)} (${duration}s).`;
      const reasonText =
        reasonKey === 'too-short'
          ? 'After snapping to silence, this span is shorter than the required 0.4s minimum.'
          : 'This span overlaps existing merged spans without fully replacing them.';
      const reasonParagraph = document.createElement('p');
      reasonParagraph.textContent = reasonText;
      const guidance = document.createElement('p');
      guidance.textContent =
        'Choose how to proceed. “Replace” removes overlapping merged spans, while “Merge” unions them. Both options enforce the 0.4s minimum duration.';
      body.appendChild(spanInfo);
      body.appendChild(reasonParagraph);
      body.appendChild(guidance);
      const checkboxLabel = document.createElement('label');
      checkboxLabel.style.display = 'flex';
      checkboxLabel.style.alignItems = 'center';
      checkboxLabel.style.gap = '8px';
      checkboxLabel.style.marginTop = '12px';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const labelText =
        reasonKey === 'too-short' ? 'Apply to all too-short conflicts' : 'Apply to all overlap conflicts';
      const checkboxText = document.createElement('span');
      checkboxText.textContent = labelText;
      checkboxLabel.appendChild(checkbox);
      checkboxLabel.appendChild(checkboxText);
      body.appendChild(checkboxLabel);
      const actionsEl = document.createElement('div');
      actionsEl.className = 'review-modal__actions';
      const actions = [
        { label: 'Keep existing', value: 'keep' },
        { label: 'Replace', value: 'replace', primary: true },
        { label: 'Merge (union)', value: 'merge' },
      ];
      content.appendChild(heading);
      content.appendChild(body);
      content.appendChild(actionsEl);
      root.appendChild(content);
      const cleanup = (value) => {
        root.hidden = true;
        root.innerHTML = '';
        document.removeEventListener('keydown', onKeyDown);
        this.state.modal.cleanup = null;
        resolve(value);
      };
      this.state.modal.cleanup = cleanup;
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
        }
      };
      document.addEventListener('keydown', onKeyDown);
      root.addEventListener(
        'click',
        (event) => {
          if (event.target === root) {
            cleanup(null);
          }
        },
        { once: true },
      );
      actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'review-modal__button';
        if (action.primary) {
          button.style.background = 'rgba(56, 189, 248, 0.35)';
          button.style.borderColor = 'rgba(56, 189, 248, 0.45)';
        }
        button.textContent = action.label;
        button.addEventListener('click', () =>
          cleanup({ value: action.value, applyToAll: checkbox.checked }),
        );
        actionsEl.appendChild(button);
      });
    });
  },

  computeDiffs() {
    const pass1 = this.state.passes[1];
    const pass2 = this.state.passes[2];
    const diffs = {
      cs: computeCodeSwitchDiff(pass1.codeSwitchSpans || [], pass2.codeSwitchSpans || []),
      vt: computeVoiceTagDiff(pass1.transcriptCues || [], pass2.transcriptCues || []),
      rttm: computeDiarizationDiff(pass1.diarizationSegments || [], pass2.diarizationSegments || []),
    };
    this.state.diffs = diffs;
    const merged = [];
    DIFF_TABS.forEach((type) => {
      (diffs[type] || []).forEach((diff, index) => {
        merged.push({ ...diff, type, index, t: diff.time });
      });
    });
    merged.sort((a, b) => a.time - b.time);
    this.state.diffTimeline = merged;
    this.state.selection.diff = null;
    const audio = this.elements.audios?.[1];
    const currentTime = audio ? audio.currentTime || 0 : 0;
    this.requestDiffPlaybackUpdate(currentTime, 'scrub');
  },

  renderDiffs() {
    const list = this.elements.diffList;
    if (!list) return;
    const type = this.state.activeTab;
    const diffs = this.state.diffs[type] || [];
    list.innerHTML = '';
    if (!diffs.length) {
      const empty = document.createElement('li');
      empty.className = 'diff-item diff-item--empty';
      empty.textContent = 'No differences';
      list.appendChild(empty);
    }
    const active = this.state.selection.diff;
    diffs.forEach((diff, index) => {
      const item = document.createElement('li');
      item.className = 'diff-item';
      if (active && active.type === type && active.index === index) {
        item.classList.add('is-active');
      }
      item.dataset.index = index;
      item.dataset.type = type;
      const time = document.createElement('span');
      time.className = 'diff-item__time';
      const diffTime = Number.isFinite(diff.time) ? diff.time : diff.t;
      time.textContent = formatTimecode(diffTime);
      const label = document.createElement('span');
      label.className = 'diff-item__label';
      label.textContent = diff.label || 'Difference';
      item.appendChild(time);
      item.appendChild(label);
      list.appendChild(item);
    });
    this.elements.diffTabs?.forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.tab === type);
    });
    this.updateDiffListPlaybackHighlight();
  },

  requestDiffPlaybackUpdate(time, mode = 'playback') {
    const playback = this.state.diffPlayback;
    if (!playback) return;
    const sanitized = Number.isFinite(time) ? time : 0;
    playback.pendingTime = sanitized;
    playback.pendingMode = mode === 'scrub' ? 'scrub' : 'playback';

    const schedule = () => {
      playback.rafId = window.requestAnimationFrame(() => {
        playback.rafId = null;
        const now = performance.now();
        const minInterval = DIFF_PLAYBACK_INTERVAL[playback.pendingMode] || DIFF_PLAYBACK_INTERVAL.playback;
        const sinceLast = now - (playback.lastRender || 0);
        if (sinceLast < minInterval) {
          const delay = Math.max(0, minInterval - sinceLast);
          playback.timeoutId = window.setTimeout(() => {
            playback.timeoutId = null;
            schedule();
          }, delay);
          return;
        }
        if (playback.timeoutId != null) {
          window.clearTimeout(playback.timeoutId);
          playback.timeoutId = null;
        }
        playback.lastRender = now;
        const target = playback.pendingTime ?? sanitized;
        playback.pendingTime = null;
        this.applyDiffPlaybackState(target);
      });
    };

    if (playback.timeoutId != null) {
      window.clearTimeout(playback.timeoutId);
      playback.timeoutId = null;
    }
    if (playback.rafId != null) {
      return;
    }
    schedule();
  },

  applyDiffPlaybackState(time) {
    const timeline = this.state.diffTimeline || [];
    if (!timeline.length) {
      if (this.state.diffPlayback.active) {
        this.state.diffPlayback.active = null;
        this.updateDiffListPlaybackHighlight();
      }
      return;
    }
    const normalized = Number.isFinite(time) ? time : 0;
    const getTime = (entry) => {
      const value = Number.isFinite(entry.time) ? entry.time : Number(entry.t);
      return Number.isFinite(value) ? value : 0;
    };
    let beforeIndex = -1;
    for (let i = 0; i < timeline.length; i += 1) {
      if (getTime(timeline[i]) <= normalized) {
        beforeIndex = i;
      } else {
        break;
      }
    }
    let candidateIndex = beforeIndex;
    if (candidateIndex < 0) {
      candidateIndex = 0;
    } else if (candidateIndex < timeline.length - 1) {
      const beforeTime = getTime(timeline[candidateIndex]);
      const afterTime = getTime(timeline[candidateIndex + 1]);
      if (Math.abs(afterTime - normalized) < Math.abs(normalized - beforeTime)) {
        candidateIndex += 1;
      }
    }
    if (candidateIndex >= timeline.length) {
      candidateIndex = timeline.length - 1;
    }
    const candidate = timeline[candidateIndex] || null;
    const nextActive = candidate ? { type: candidate.type, index: candidate.index } : null;
    const prevActive = this.state.diffPlayback.active;
    const changed = !prevActive
      ? !!nextActive
      : !nextActive || prevActive.type !== nextActive.type || prevActive.index !== nextActive.index;
    this.state.diffPlayback.active = nextActive;
    if (changed) {
      this.updateDiffListPlaybackHighlight();
    }
  },

  updateDiffListPlaybackHighlight() {
    const list = this.elements.diffList;
    if (!list) return;
    const playback = this.state.diffPlayback.active;
    list.querySelectorAll('.diff-item').forEach((item) => {
      const type = item.dataset.type;
      const index = Number(item.dataset.index);
      if (!type || !Number.isFinite(index)) {
        item.classList.remove('is-playing');
        return;
      }
      const isActive = playback && playback.type === type && playback.index === index;
      item.classList.toggle('is-playing', Boolean(isActive));
    });
  },

  setActiveTab(type) {
    if (!DIFF_TABS.includes(type)) return;
    this.state.activeTab = type;
    this.renderDiffs();
  },

  selectDiff(type, index) {
    const diffs = this.state.diffs[type] || [];
    const diff = diffs[index];
    if (!diff) return;
    this.state.activeTab = type;
    this.state.selection.diff = { type, index };
    const targetTime = Number.isFinite(diff.time) ? diff.time : diff.t;
    if (Number.isFinite(targetTime)) {
      this.seek(targetTime);
    }
    this.renderDiffs();
  },

  stepDiff(step) {
    if (!this.state.diffTimeline.length) return;
    const active = this.state.selection.diff;
    const currentIndex = active
      ? this.state.diffTimeline.findIndex((entry) => entry.type === active.type && entry.index === active.index)
      : -1;
    let next = currentIndex + step;
    const total = this.state.diffTimeline.length;
    if (next < 0) next = total - 1;
    if (next >= total) next = 0;
    const target = this.state.diffTimeline[next];
    if (!target) return;
    this.state.activeTab = target.type;
    this.state.selection.diff = { type: target.type, index: target.index };
    this.renderDiffs();
    const time = Number.isFinite(target.time) ? target.time : target.t;
    if (Number.isFinite(time)) {
      this.seek(time);
    }
  },

  seek(time) {
    const audio = this.elements.audios[1];
    if (!audio) return;
    audio.currentTime = Math.max(0, time);
    this.syncRight(true);
    this.updateTimecode(audio.currentTime || 0);
    this.updateHighlights(audio.currentTime || 0);
    this.requestDiffPlaybackUpdate(audio.currentTime || 0, 'scrub');
    PASS_NUMS.forEach((passNumber) => {
      const virt = this.virtualizers[passNumber];
      const cues = this.state.passes[passNumber].transcriptCues || [];
      const index = findCueIndexAtTime(cues, time);
      if (index >= 0 && virt) {
        virt.scrollToIndex(index);
      }
    });
    if (this.mergedVirtualizer) {
      const merged = this.state.review.merged?.transcriptCues || [];
      const index = findCueIndexAtTime(merged, time);
      if (index >= 0) {
        this.mergedVirtualizer.scrollToIndex(index);
      }
    }
  },

  updateTimecode(time) {
    if (this.elements.timecode) {
      this.elements.timecode.textContent = formatTimecode(time);
    }
  },

  updateHighlights(time) {
    PASS_NUMS.forEach((passNumber) => {
      const cues = this.state.passes[passNumber].transcriptCues || [];
      const index = findCueIndexAtTime(cues, time);
      this.state.highlightedCues[passNumber] = index;
      const virt = this.virtualizers[passNumber];
      if (virt) {
        virt.setDirty();
      }
    });
  },

  getTranslationText(passNumber, cue) {
    if (!cue) return '';
    const translations = this.state.passes[passNumber].translationCues || [];
    const target = (Number(cue.start) + Number(cue.end)) / 2;
    const index = findCueIndexAtTime(translations, target);
    if (index >= 0 && translations[index]) {
      return translations[index].text || '';
    }
    return '';
  },

  setZoom(value) {
    const next = Math.max(0.25, Math.min(4, value));
    this.state.zoom = next;
    // Placeholder: update waveforms if available
    this.renderTracks(1);
    this.renderTracks(2);
    const audio = this.elements.audios[1];
    if (audio) {
      this.requestDiffPlaybackUpdate(audio.currentTime || 0, 'scrub');
    }
  },

  renderTracks(passNumber) {
    const duration = this.state.clipDuration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const csTrack = this.elements.csTracks[passNumber];
    const diarTrack = this.elements.diarTracks[passNumber];
    const pass = this.state.passes[passNumber];
    if (csTrack) {
      const isEditing = !!this.state.review?.editingEnabled;
      csTrack.innerHTML = '';
      csTrack.classList.toggle('is-interactive', isEditing);
      (pass.codeSwitchSpans || []).forEach((span, spanIndex) => {
        const startRatio = Math.max(0, Math.min(1, span.start / duration));
        const endRatio = Math.max(0, Math.min(1, span.end / duration));
        const width = Math.max(0.5, (endRatio - startRatio) * 100);
        const block = document.createElement('div');
        block.className = 'cs-block';
        const key = toLanguageKey(span);
        const spec = CS_COLORS[key] || CS_COLORS.other;
        block.style.position = 'absolute';
        block.style.left = `${startRatio * 100}%`;
        block.style.width = `${width}%`;
        block.style.top = '0';
        block.style.bottom = '0';
        block.style.background = spec.background;
        block.title = spec.label || key.toUpperCase();
        if (
          this.state.selection.span &&
          this.state.selection.span.passNumber === passNumber &&
          this.state.selection.span.index === spanIndex
        ) {
          block.classList.add('is-selected');
        }
        if (isEditing) {
          const label = document.createElement('div');
          label.textContent = spec.label || key.toUpperCase();
          label.style.padding = '4px 6px';
          label.style.fontSize = '11px';
          label.style.fontWeight = '600';
          label.style.color = spec.color || '#e2e8f0';
          block.appendChild(label);
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'cs-block__copy';
          copyBtn.textContent = 'Copy';
          copyBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.handleSpanCopyMenu(passNumber, span);
          });
          block.appendChild(copyBtn);
          block.addEventListener('click', (event) => {
            event.preventDefault();
            this.setSpanSelection(passNumber, spanIndex);
          });
        }
        csTrack.appendChild(block);
      });
    }
    if (diarTrack) {
      diarTrack.innerHTML = '';
      (pass.diarizationSegments || []).forEach((segment) => {
        const startRatio = Math.max(0, Math.min(1, segment.start / duration));
        const endRatio = Math.max(0, Math.min(1, segment.end / duration));
        const width = Math.max(0.5, (endRatio - startRatio) * 100);
        const block = document.createElement('div');
        block.style.position = 'absolute';
        block.style.left = `${startRatio * 100}%`;
        block.style.width = `${width}%`;
        block.style.top = '0';
        block.style.bottom = '0';
        block.style.background = 'rgba(148, 163, 184, 0.35)';
        block.style.color = '#0f172a';
        block.style.fontSize = '12px';
        block.style.display = 'flex';
        block.style.alignItems = 'center';
        block.style.justifyContent = 'center';
        block.style.fontWeight = '600';
        block.textContent = segment.speaker || 'S';
        diarTrack.appendChild(block);
      });
    }
  },

  play() {
    const master = this.elements.audios[1];
    const secondary = this.elements.audios[2];
    if (!master) return;
    master.play().catch((err) => console.warn('Pass1 play failed', err));
    if (secondary) {
      secondary.muted = true;
      secondary.play().catch(() => {});
    }
    this.state.playback.playing = true;
    this.state.playback.lastSync = performance.now();
    if (this.elements.playButton) this.elements.playButton.textContent = 'Pause';
  },

  pause() {
    const master = this.elements.audios[1];
    const secondary = this.elements.audios[2];
    if (master) master.pause();
    if (secondary) secondary.pause();
    this.state.playback.playing = false;
    if (this.elements.playButton) this.elements.playButton.textContent = 'Play';
  },

  handleMasterPlay() {
    this.state.playback.playing = true;
    this.state.playback.lastSync = performance.now();
    const secondary = this.elements.audios[2];
    if (secondary && secondary.paused) {
      secondary.muted = true;
      secondary.currentTime = (this.elements.audios[1]?.currentTime || 0) + this.state.playback.offset;
      secondary.play().catch(() => {});
    }
    if (this.elements.playButton) this.elements.playButton.textContent = 'Pause';
  },

  handleMasterPause() {
    this.state.playback.playing = false;
    const secondary = this.elements.audios[2];
    if (secondary) secondary.pause();
    if (this.elements.playButton) this.elements.playButton.textContent = 'Play';
  },

  syncRight(force = false) {
    const master = this.elements.audios[1];
    const secondary = this.elements.audios[2];
    if (!master || !secondary) return;
    const now = performance.now();
    if (!force && now - this.state.playback.lastSync < DRIFT_RESYNC_INTERVAL_MS) {
      return;
    }
    this.state.playback.lastSync = now;
    const target = Math.max(0, (master.currentTime || 0) + this.state.playback.offset);
    secondary.currentTime = target;
    if (this.state.playback.playing && secondary.paused) {
      secondary.play().catch(() => {});
    }
  },
};

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => ReviewPage.init());
}

window.Stage2ReviewShell = ReviewPage;
