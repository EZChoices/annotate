const PASS_NUMS = [1, 2];
const DIFF_TABS = ['cs', 'vt', 'rttm'];
const DRIFT_RESYNC_INTERVAL_MS = 3000;
const VOICE_TAG_TOLERANCE = 0.12;
const DIAR_BOUNDARY_TOLERANCE = 0.25;
const CUE_ROW_HEIGHT = 88;
const CS_COLORS = {
  ara: { label: 'AR', color: '#f97316', background: 'rgba(249, 115, 22, 0.28)' },
  eng: { label: 'EN', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.28)' },
  fra: { label: 'FR', color: '#c084fc', background: 'rgba(192, 132, 252, 0.28)' },
  other: { label: 'Other', color: '#34d399', background: 'rgba(52, 211, 153, 0.28)' },
};

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
    passes: {
      1: createPassState(),
      2: createPassState(),
    },
    diffs: { cs: [], vt: [], rttm: [] },
    diffTimeline: [],
    activeTab: 'cs',
    activeDiff: null,
    highlightedCues: { 1: -1, 2: -1 },
    clipDuration: null,
    zoom: 1,
    canPromote: false,
    playback: {
      playing: false,
      offset: 0,
      lastSync: 0,
    },
  },
  virtualizers: {},
  elements: {},

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
    this.elements.rewindButton?.addEventListener('click', () => {
      const audio = this.elements.audios[1];
      if (!audio) return;
      audio.currentTime = Math.max(0, (audio.currentTime || 0) - 3);
      this.syncRight(true);
      this.updateTimecode(audio.currentTime || 0);
      this.updateHighlights(audio.currentTime || 0);
    });
    this.elements.zoomIn?.addEventListener('click', () => this.setZoom(this.state.zoom * 0.75));
    this.elements.zoomOut?.addEventListener('click', () => this.setZoom(this.state.zoom * 1.25));
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
      if (event.key === '[') {
        event.preventDefault();
        this.stepDiff(-1);
      } else if (event.key === ']') {
        event.preventDefault();
        this.stepDiff(1);
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
        });
        audio.addEventListener('play', () => this.handleMasterPlay());
        audio.addEventListener('pause', () => this.handleMasterPause());
        audio.addEventListener('seeked', () => {
          this.syncRight(true);
          this.updateHighlights(audio.currentTime || 0);
        });
      }
    });
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
        this.state.canPromote = true;
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
      })
      .catch((err) => {
        console.error('Review bootstrap failed', err);
        this.setMessage('Failed to load review data.');
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
      this.virtualizers[passNumber] = this.createVirtualizer(passNumber, cues);
    });
  },

  createVirtualizer(passNumber, cues) {
    const container = this.elements.cueLists[passNumber];
    if (!container) return null;
    container.innerHTML = '';
    const spacer = document.createElement('div');
    spacer.className = 'cue-list__spacer';
    spacer.style.height = `${Math.max(1, cues.length * CUE_ROW_HEIGHT)}px`;
    const viewport = document.createElement('div');
    viewport.className = 'cue-list__viewport';
    container.appendChild(spacer);
    container.appendChild(viewport);
    const state = {
      cues,
      container,
      viewport,
      spacer,
      start: 0,
      end: 0,
      raf: null,
    };
    const render = () => {
      state.raf = null;
      const scrollTop = container.scrollTop || 0;
      const height = container.clientHeight || 1;
      const start = Math.max(0, Math.floor(scrollTop / CUE_ROW_HEIGHT) - 4);
      const end = Math.min(cues.length, Math.ceil((scrollTop + height) / CUE_ROW_HEIGHT) + 4);
      if (start === state.start && end === state.end && !state.dirty) {
        return;
      }
      state.start = start;
      state.end = end;
      state.dirty = false;
      viewport.style.transform = `translateY(${start * CUE_ROW_HEIGHT}px)`;
      viewport.innerHTML = '';
      for (let i = start; i < end; i += 1) {
        const cue = cues[i];
        if (!cue) continue;
        const row = document.createElement('div');
        row.className = 'cue-row';
        if (this.state.highlightedCues[passNumber] === i) {
          row.classList.add('is-highlighted');
        }
        const time = document.createElement('div');
        time.className = 'cue-time';
        time.textContent = `${formatTimecode(cue.start)} → ${formatTimecode(cue.end)}`;
        const text = document.createElement('div');
        text.className = 'cue-text';
        const transcript = document.createElement('div');
        transcript.textContent = cue.text || '';
        text.appendChild(transcript);
        const translationText = this.getTranslationText(passNumber, cue);
        if (translationText) {
          const translation = document.createElement('div');
          translation.className = 'cue-text__translation';
          translation.textContent = translationText;
          text.appendChild(translation);
        }
        row.appendChild(time);
        row.appendChild(text);
        viewport.appendChild(row);
      }
    };
    const schedule = () => {
      if (state.raf != null) return;
      state.raf = window.requestAnimationFrame(render);
    };
    container.addEventListener('scroll', schedule);
    schedule();
    return {
      ...state,
      schedule,
      render,
      setDirty: () => {
        state.dirty = true;
        schedule();
      },
      scrollToIndex: (index) => {
        if (!Number.isFinite(index) || index < 0) return;
        const top = index * CUE_ROW_HEIGHT - (container.clientHeight || 0) / 2;
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      },
    };
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
        merged.push({ ...diff, type, index });
      });
    });
    merged.sort((a, b) => a.time - b.time);
    this.state.diffTimeline = merged;
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
    diffs.forEach((diff, index) => {
      const item = document.createElement('li');
      item.className = 'diff-item';
      if (this.state.activeDiff && this.state.activeDiff.type === type && this.state.activeDiff.index === index) {
        item.classList.add('is-active');
      }
      item.dataset.index = index;
      item.dataset.type = type;
      const time = document.createElement('span');
      time.className = 'diff-item__time';
      time.textContent = formatTimecode(diff.time);
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
    this.state.activeDiff = { type, index };
    this.seek(diff.time);
    this.renderDiffs();
  },

  stepDiff(step) {
    if (!this.state.diffTimeline.length) return;
    const currentIndex = this.state.activeDiff
      ? this.state.diffTimeline.findIndex(
          (entry) => entry.type === this.state.activeDiff.type && entry.index === this.state.activeDiff.index,
        )
      : -1;
    let next = currentIndex + step;
    const total = this.state.diffTimeline.length;
    if (next < 0) next = total - 1;
    if (next >= total) next = 0;
    const target = this.state.diffTimeline[next];
    if (!target) return;
    this.state.activeTab = target.type;
    this.state.activeDiff = { type: target.type, index: target.index };
    this.renderDiffs();
    this.seek(target.time);
  },

  seek(time) {
    const audio = this.elements.audios[1];
    if (!audio) return;
    audio.currentTime = Math.max(0, time);
    this.syncRight(true);
    this.updateTimecode(audio.currentTime || 0);
    this.updateHighlights(audio.currentTime || 0);
    PASS_NUMS.forEach((passNumber) => {
      const virt = this.virtualizers[passNumber];
      const cues = this.state.passes[passNumber].transcriptCues || [];
      const index = findCueIndexAtTime(cues, time);
      if (index >= 0 && virt) {
        virt.scrollToIndex(index);
      }
    });
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
  },

  renderTracks(passNumber) {
    const duration = this.state.clipDuration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const csTrack = this.elements.csTracks[passNumber];
    const diarTrack = this.elements.diarTracks[passNumber];
    const pass = this.state.passes[passNumber];
    if (csTrack) {
      csTrack.innerHTML = '';
      (pass.codeSwitchSpans || []).forEach((span) => {
        const startRatio = Math.max(0, Math.min(1, span.start / duration));
        const endRatio = Math.max(0, Math.min(1, span.end / duration));
        const width = Math.max(0.5, (endRatio - startRatio) * 100);
        const block = document.createElement('div');
        const key = toLanguageKey(span);
        const spec = CS_COLORS[key] || CS_COLORS.other;
        block.style.position = 'absolute';
        block.style.left = `${startRatio * 100}%`;
        block.style.width = `${width}%`;
        block.style.top = '0';
        block.style.bottom = '0';
        block.style.background = spec.background;
        block.title = spec.label || key.toUpperCase();
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
