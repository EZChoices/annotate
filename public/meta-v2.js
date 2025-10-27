"use strict";

const tags = {
  accent_notes: [],
  emotion: [],
  notes: "",
  flagged: false,
};

const metaState = {
  dirty: false,
  lastError: null,
  annotator: null,
  buildSha: null,
};

function cloneTags() {
  return JSON.parse(JSON.stringify(tags));
}

function updateSaveBadge(status) {
  const badge = document.getElementById("saveBadge");
  if (!badge) return;
  const map = {
    saving: "Saving.",
    saved: "Saved",
    error: "Error",
  };
  const normalized = map[status] ? status : "saved";
  badge.textContent = map[normalized];
  badge.dataset.status = normalized;
}

function synchronizeMetaState() {
  if (typeof window === "undefined") return;
  window.__META_STATE = Object.assign(window.__META_STATE || {}, {
    metaState,
    getAnnot,
    setBuildSha,
    updateSaveBadge,
    onQueueResult,
    onQueueError,
  });
}

function setBuildSha(sha) {
  const value = sha || (window.__BUILD && window.__BUILD.sha) || "dev";
  metaState.buildSha = value;
  const span = document.getElementById("buildSha");
  if (span) {
    span.textContent = value;
  }
  synchronizeMetaState();
  return value;
}

function getAnnot() {
  const key = "dd_annotator_id";
  let id = "anonymous";
  try {
    id = localStorage.getItem(key) || "";
    if (!id) {
      id = `annot_${Math.random().toString(16).slice(2, 10)}`;
      localStorage.setItem(key, id);
    }
  } catch {
    id = "anonymous";
  }
  metaState.annotator = id;
  const span = document.getElementById("annotId");
  if (span) {
    span.textContent = id;
  }
  synchronizeMetaState();
  return id;
}

function onQueueResult(status) {
  if (status === "synced") {
    metaState.dirty = false;
    metaState.lastError = null;
    updateSaveBadge("saved");
  } else if (status === "queued") {
    metaState.dirty = true;
    metaState.lastError = null;
    updateSaveBadge("saving");
  }
}

function onQueueError(err) {
  metaState.lastError = err;
  updateSaveBadge("error");
}

function buildRecord(reason) {
  return {
    annotator: metaState.annotator || getAnnot(),
    build: metaState.buildSha || setBuildSha(),
    tags: cloneTags(),
    updatedAt: new Date().toISOString(),
    reason: reason || "change",
  };
}

function queueMetaUpdate(reason) {
  metaState.dirty = true;
  metaState.lastError = null;
  updateSaveBadge("saving");
  const record = buildRecord(reason);
  if (typeof window !== "undefined" && typeof window.__META_ENQUEUE === "function") {
    return window.__META_ENQUEUE(record).catch((err) => {
      onQueueError(err);
      throw err;
    });
  }
  return fetch(`/api/submit?annotator=${encodeURIComponent(record.annotator)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`submit failed: ${res.status}`);
      }
      onQueueResult("synced");
      return "synced";
    })
    .catch((err) => {
      onQueueError(err);
      throw err;
    });
}

function setTag(key, value, btn) {
  tags[key] = value;
  document.querySelectorAll(`[data-set-tag="${key}"]`).forEach((b) => {
    b.classList.toggle("selected", b === btn);
  });
  queueMetaUpdate(`set:${key}`).catch(() => {});
}

function toggleAccent(value, btn) {
  const set = new Set(tags.accent_notes || []);
  if (set.has(value)) {
    set.delete(value);
    btn.classList.remove("selected");
  } else {
    set.add(value);
    btn.classList.add("selected");
  }
  tags.accent_notes = Array.from(set);
  queueMetaUpdate("accent").catch(() => {});
}

function toggleEmotion(value, btn) {
  const set = new Set(tags.emotion || []);
  if (set.has(value)) {
    set.delete(value);
    btn.classList.remove("selected");
  } else {
    set.add(value);
    btn.classList.add("selected");
  }
  tags.emotion = Array.from(set);
  queueMetaUpdate("emotion").catch(() => {});
}

function handleTextInput(key, value) {
  tags[key] = value;
  queueMetaUpdate(`text:${key}`).catch(() => {});
}

async function submitAnnotation() {
  try {
    const status = await queueMetaUpdate("submit");
    const message =
      status === "synced"
        ? "Annotation submitted"
        : "Annotation saved locally; it will sync when you are online.";
    alert(message);

    const video = document.getElementById("videoPlayer");
    loadSampleVideo(video);
    resetSelections();
    updateSaveBadge("saved");
  } catch {
    alert("Failed to queue annotation");
  }
}

function resetSelections() {
  tags.accent_notes = [];
  tags.emotion = [];
  tags.notes = "";
  tags.flagged = false;
  [
    "accent_other",
    "emotion_other",
    "topic_other",
    "environment_other",
    "dialect",
    "sub_dialect",
    "gender",
    "age",
    "code_switch",
    "topic",
    "environment",
    "face_visible",
    "lips_visible",
    "gestures_prominent",
  ].forEach((key) => {
    delete tags[key];
  });
  document.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
  document.querySelectorAll('input[type="text"]').forEach((inp) => {
    inp.value = "";
  });
  const notes = document.getElementById("notesBox");
  if (notes) {
    notes.value = "";
  }
}

function initVideo() {
  const video = document.getElementById("videoPlayer");
  if (!video) return;
  video.muted = true;
  const startPlayback = () => {
    video.play().catch(() => {});
  };
  document.addEventListener("click", startPlayback, { once: true });
  document.addEventListener("touchstart", startPlayback, { once: true });
  loadSampleVideo(video);
  const keepInline = () => {
    if (document.fullscreenElement === video) {
      document.exitFullscreen().catch(() => {});
    }
    if (video.webkitDisplayingFullscreen) {
      video.webkitExitFullscreen();
    }
  };
  video.addEventListener("fullscreenchange", keepInline);
  video.addEventListener("webkitbeginfullscreen", keepInline);
}

document.addEventListener("DOMContentLoaded", () => {
  initVideo();
  getAnnot();
  setBuildSha(window.__BUILD && window.__BUILD.sha);
  updateSaveBadge("saved");

  document.querySelectorAll("[data-set-tag]").forEach((btn) => {
    btn.addEventListener("click", () => setTag(btn.dataset.setTag, btn.dataset.value, btn));
  });
  document.querySelectorAll("[data-toggle-accent]").forEach((btn) => {
    btn.addEventListener("click", () => toggleAccent(btn.dataset.value, btn));
  });
  document.querySelectorAll("[data-toggle-emotion]").forEach((btn) => {
    btn.addEventListener("click", () => toggleEmotion(btn.dataset.value, btn));
  });

  const accentOther = document.getElementById("accentOtherBox");
  if (accentOther) {
    accentOther.addEventListener("input", (e) => handleTextInput("accent_other", e.target.value));
  }
  const emotionOther = document.getElementById("emotionOtherBox");
  if (emotionOther) {
    emotionOther.addEventListener("input", (e) => handleTextInput("emotion_other", e.target.value));
  }
  const topicOther = document.getElementById("topicOtherBox");
  if (topicOther) {
    topicOther.addEventListener("input", (e) => handleTextInput("topic_other", e.target.value));
  }
  const envOther = document.getElementById("environmentOtherBox");
  if (envOther) {
    envOther.addEventListener("input", (e) => handleTextInput("environment_other", e.target.value));
  }
  const notesBox = document.getElementById("notesBox");
  if (notesBox) {
    notesBox.addEventListener("input", (e) => handleTextInput("notes", e.target.value));
  }

  const dark = document.getElementById("darkModeBtn");
  if (dark) {
    dark.addEventListener("click", () => {
      document.documentElement.classList.toggle("dark");
      document.body.classList.toggle("dark");
    });
  }
  const flag = document.getElementById("flagBtn");
  if (flag) {
    flag.addEventListener("click", () => {
      tags.flagged = true;
      alert("Clip flagged");
      queueMetaUpdate("flag").catch(() => {});
    });
  }
  const submit = document.getElementById("submitBtn");
  if (submit) {
    submit.addEventListener("click", submitAnnotation);
  }

  const wrapper = document.getElementById("video-wrapper");
  const toggleBtn = document.getElementById("videoToggle");
  if (toggleBtn && wrapper) {
    toggleBtn.addEventListener("click", () => {
      wrapper.classList.toggle("hidden");
    });
  }

  synchronizeMetaState();
});

synchronizeMetaState();

document.addEventListener("buildmeta:ready", (ev) => {
  const detail = ev && ev.detail;
  const sha = detail && detail.sha ? detail.sha : (window.__BUILD && window.__BUILD.sha);
  if (sha) {
    setBuildSha(sha);
  }
});
