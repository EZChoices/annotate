(function () {
  const BANNER_ID = "ea-selftest-banner";
  const PASS_EVENT = "EA_SELFTEST_PASS";
  const FAIL_EVENT = "EA_SELFTEST_FAIL";

  function ensureBanner() {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      banner.style.cssText =
        "position:fixed;top:12px;left:12px;z-index:100000;" +
        "padding:6px 10px;border-radius:6px;font:12px/1.4 monospace;" +
        "background:#111;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.35);";
      banner.textContent = "EA SELFTEST: pending";
      (document.body || document.documentElement).appendChild(banner);
    }
    return banner;
  }

  function updateBanner(status, detail) {
    const banner = ensureBanner();
    banner.textContent = detail
      ? `EA SELFTEST: ${status} – ${detail}`
      : `EA SELFTEST: ${status}`;
    banner.style.background = status === "PASS" ? "#065f46" : "#7f1d1d";
  }

  function signal(type, detail) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (err) {
      console.warn("[EA SELFTEST] dispatch failed", err);
    }
  }

  function fail(reason) {
    console.error("[EA SELFTEST] FAIL", reason);
    updateBanner("FAIL", typeof reason === "string" ? reason : reason?.message);
    signal(FAIL_EVENT, { reason: reason?.message || String(reason) });
  }

  function pass(item) {
    const detail = item && item.asset_id ? `asset=${item.asset_id}` : "";
    console.log("[EA SELFTEST] PASS", detail);
    updateBanner("PASS", detail);
    signal(PASS_EVENT, { asset_id: item?.asset_id || null });
  }

  async function runSelfTest() {
    console.log("[EA SELFTEST] BOOT start");
    try {
      const tasksResp = await fetch("/api/tasks", { cache: "no-store" });
      if (!tasksResp.ok) {
        throw new Error(`tasks status ${tasksResp.status}`);
      }
      const payload = await tasksResp.json();
      const items = Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.manifest?.items)
        ? payload.manifest.items
        : [];
      if (!items.length) {
        throw new Error("no manifest items returned");
      }
      const item = items[0];
      if (!item || !item.prefill || !item.prefill.transcript_vtt_url) {
        throw new Error("missing transcript_vtt_url");
      }
      const transcriptUrl = item.prefill.transcript_vtt_url;
      console.log("[EA SELFTEST] verifying transcript", transcriptUrl);
      const vttResp = await fetch(transcriptUrl, { cache: "no-store" });
      if (!vttResp.ok) {
        throw new Error(`transcript fetch ${vttResp.status}`);
      }
      const ct = vttResp.headers.get("content-type") || "";
      if (!/text/.test(ct)) {
        throw new Error(`unexpected transcript content-type ${ct}`);
      }
      window.__EA_CURRENT = item;
      pass(item);
    } catch (err) {
      fail(err);
    }
  }

  window.addEventListener("load", () => {
    ensureBanner();
    runSelfTest();
  });
})();
