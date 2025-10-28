(function(){
  const DEBUG =
    (() => {
      try {
        const params = new URLSearchParams(window.location.search || '');
        if (typeof window.DEBUG === 'boolean') {
          return window.DEBUG;
        }
        return params.has('debug');
      } catch {
        return false;
      }
    })();

  function mountHUD() {
    if (!DEBUG || document.getElementById('dd-debug-hud')) return;
    const el = document.createElement('div');
    el.id = 'dd-debug-hud';
    el.style.cssText =
      'position:fixed;right:10px;bottom:10px;width:420px;max-height:55vh;overflow:auto;' +
      'background:#0b1020;color:#e6f3ff;font:12px/1.4 ui-monospace,monospace;' +
      'border:1px solid #304070;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:99999;';
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-bottom:1px solid #223">' +
      '<strong style="font-size:12px">Dialect Data - Debug HUD</strong>' +
      '<button id="dd-clear" style="margin-left:auto;background:#162039;color:#9fc5ff;border:1px solid #2a3b66;border-radius:6px;padding:.15rem .5rem;cursor:pointer">Clear</button>' +
      '</div>' +
      '<pre id="dd-log" style="padding:.5rem .75rem;white-space:pre-wrap;margin:0;"></pre>';
    document.body.appendChild(el);
    const btn = document.getElementById('dd-clear');
    if (btn) {
      btn.onclick = () => {
        const pre = document.getElementById('dd-log');
        if (pre) pre.textContent = '';
      };
    }
  }

  function logHUD(obj, title = 'LOG') {
    if (!DEBUG) return;
    try {
      const pre = document.getElementById('dd-log');
      if (!pre) return;
      const t = new Date().toISOString().replace('T', ' ').replace('Z', '');
      const payload =
        typeof obj === 'string'
          ? obj
          : JSON.stringify(obj, null, 2);
      pre.textContent += `\n[${t}] ${title}\n${payload}\n`;
      pre.scrollTop = pre.scrollHeight;
    } catch {
      /* noop */
    }
  }

  async function fetchInspected(url, options = {}, tag = 'fetch') {
    if (!DEBUG) {
      return fetch(url, options);
    }
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, options);
      const headers = {};
      try {
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } catch {
        /* noop */
      }
      let preview = null;
      try {
        const ct = res.headers && res.headers.get
          ? res.headers.get('content-type') || ''
          : '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('vtt')) {
          preview = await res.clone().text();
          if (preview && preview.length > 200) {
          preview = preview.slice(0, 200) + '...';
          }
        }
      } catch {
        /* noop */
      }
      logHUD(
        {
          tag,
          url,
          status: res.status,
          ok: res.ok,
          headers,
          preview,
          ms: Date.now() - started,
        },
        'NET'
      );
      return res;
    } catch (error) {
      logHUD(
        {
          tag,
          url,
          error: error && error.message ? error.message : String(error),
          ms: Date.now() - started,
        },
        'NET-ERROR'
      );
      throw error;
    }
  }

  window.__DD_DEBUG = {
    DEBUG,
    mountHUD,
    logHUD,
    fetchInspected,
  };
})();
