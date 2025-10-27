"use strict";

(function (global) {
  const fallback = { sha: "dev", builtAt: null };

  function applyBuildMeta(meta) {
    if (typeof document === "undefined") return;
    const data = meta || fallback;
    document.querySelectorAll("[data-build-sha]").forEach((el) => {
      el.textContent = data.sha || fallback.sha;
    });
    document.querySelectorAll("[data-build-time]").forEach((el) => {
      el.textContent = data.builtAt || "";
    });
    document.dispatchEvent(
      new CustomEvent("buildmeta:ready", { detail: Object.assign({}, data) })
    );
  }

  function setBuildMeta(meta) {
    const data = Object.assign({}, fallback, meta || {});
    global.__BUILD = data;
    applyBuildMeta(data);
  }

  function loadBuildMeta() {
    if (typeof fetch !== "function") {
      setBuildMeta(fallback);
      return;
    }
    fetch("/public/__build.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json().catch(() => fallback) : fallback))
      .then((data) => setBuildMeta(data))
      .catch(() => setBuildMeta(fallback));
  }

  if (global.__BUILD) {
    applyBuildMeta(global.__BUILD);
  } else {
    loadBuildMeta();
  }
})(typeof window !== "undefined" ? window : globalThis);
