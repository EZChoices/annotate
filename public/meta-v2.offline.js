"use strict";

(function (global) {
  const QUEUE_BATCH_SIZE = 10;
  let draining = false;

  function getState() {
    return global.__META_STATE || {};
  }

  function normalizeRecord(record) {
    const ctx = getState();
    const payload = Object.assign({}, record || {});
    if (!payload.annotator && typeof ctx.getAnnot === "function") {
      payload.annotator = ctx.getAnnot();
    }
    if (!payload.build && typeof ctx.setBuildSha === "function") {
      payload.build = ctx.setBuildSha(payload.build);
    }
    if (!payload.build) {
      payload.build = (global.__BUILD && global.__BUILD.sha) || "dev";
    }
    return payload;
  }

  async function postMeta(record) {
    const annot = record.annotator || "anonymous";
    const res = await fetch(`/api/submit?annotator=${encodeURIComponent(annot)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!res.ok) {
      throw new Error(`submit failed: ${res.status}`);
    }
    return res;
  }

  function notify(status) {
    const ctx = getState();
    if (ctx && typeof ctx.onQueueResult === "function") {
      ctx.onQueueResult(status);
    }
  }

  function notifyError(err) {
    const ctx = getState();
    if (ctx && typeof ctx.onQueueError === "function") {
      ctx.onQueueError(err);
    }
  }

  async function drainMeta() {
    if (draining) return "queued";
    draining = true;
    try {
      while (true) {
        const batch = await EAIDB_META.peekMetaBatch(QUEUE_BATCH_SIZE);
        if (!batch.length) {
          return "synced";
        }
        const processed = [];
        for (const entry of batch) {
          const payload = entry && entry.payload ? entry.payload : entry;
          try {
            await postMeta(payload);
            processed.push(entry._id);
          } catch (err) {
            if (processed.length) {
              await EAIDB_META.removeMetaBatch(processed);
            }
            throw err;
          }
        }
        if (processed.length) {
          await EAIDB_META.removeMetaBatch(processed);
        }
      }
    } finally {
      draining = false;
    }
  }

  async function enqueue(record) {
    const payload = normalizeRecord(record);
    await EAIDB_META.enqueueMeta(payload);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "queued";
    }
    return drainMeta();
  }

  function boot() {
    const ctx = getState();
    if (ctx) {
      if (typeof ctx.getAnnot === "function") {
        try {
          ctx.getAnnot();
        } catch {
          /* noop */
        }
      }
      if (typeof ctx.setBuildSha === "function") {
        try {
          ctx.setBuildSha(ctx.metaState && ctx.metaState.buildSha);
        } catch {
          /* noop */
        }
      }
    }
    drainMeta()
      .then((status) => notify(status))
      .catch((err) => notifyError(err));
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        drainMeta()
          .then((status) => notify(status))
          .catch((err) => notifyError(err));
      });
    }
  }

  if (typeof EAIDB_META === "undefined") {
    console.warn("[meta-offline] EAIDB_META not available; offline queue disabled.");
    global.__META_ENQUEUE = function (record) {
      const payload = normalizeRecord(record);
      return postMeta(payload)
        .then(() => {
          notify("synced");
          return "synced";
        })
        .catch((err) => {
          notifyError(err);
          throw err;
        });
    };
    global.__META_BOOT = boot;
    return;
  }

  global.__META_ENQUEUE = function (record) {
    return enqueue(record)
      .then((status) => {
        notify(status);
        return status;
      })
      .catch((err) => {
        notifyError(err);
        throw err;
      });
  };

  global.__META_BOOT = boot;
})(typeof window !== "undefined" ? window : globalThis);
