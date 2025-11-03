import { useEffect, useMemo, useState } from "react";
import Head from "next/head";

const SESSION_KEY = "ea_stage2_session_stats";
const ANNOTATOR_KEY = "ea_stage2_annotator_id";

function extractItems(payload) {
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.manifest && Array.isArray(payload.manifest.items)) {
    return payload.manifest.items;
  }
  return [];
}

function countByStatus(items, key) {
  const counts = {};
  items.forEach((item) => {
    const value = (item && item[key]) || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  });
  return counts;
}

function formatPercent(part, total) {
  if (!total) return "0%";
  const pct = Math.round((part / total) * 1000) / 10;
  return `${pct}%`;
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleDateString()} ${date
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .replace(/\u202f/g, " ")}`;
}

function useSessionStats() {
  const [sessionStats, setSessionStats] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const load = () => {
      try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) {
          setSessionStats(null);
          return;
        }
        const parsed = JSON.parse(raw);
        setSessionStats({
          completed: Number(parsed.completed) || 0,
          skipped: Number(parsed.skipped) || 0,
          updatedAt: parsed.updatedAt || null,
          annotator: parsed.annotator || null,
        });
      } catch {
        setSessionStats(null);
      }
    };
    load();
    window.addEventListener("storage", load);
    return () => window.removeEventListener("storage", load);
  }, []);

  return sessionStats;
}

export default function Stage2StatsPage() {
  const [annotator, setAnnotator] = useState("anonymous");
  const [inputAnnotator, setInputAnnotator] = useState("anonymous");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const [envNames, setEnvNames] = useState(null);

  const sessionStats = useSessionStats();

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(ANNOTATOR_KEY);
      if (stored) {
        setAnnotator(stored);
        setInputAnnotator(stored);
      }
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/env_names", { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (active) setEnvNames(data);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!annotator) return;
    let active = true;
    const controller = new AbortController();

    const fetchManifest = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/tasks?stage=2&annotator_id=${encodeURIComponent(
            annotator
          )}&seed_fallback=false&include_missing_prefill=true`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await res.json();
        if (!active) return;
        const extracted = extractItems(payload);
        setItems(extracted);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setItems([]);
        setError(err && err.message ? err.message : String(err));
        setLoading(false);
      }
    };

    fetchManifest();
    return () => {
      active = false;
      controller.abort();
    };
  }, [annotator]);

  const summary = useMemo(() => {
    const total = items.length;
    const withTranscript = items.filter(
      (item) => item && item.prefill && item.prefill.transcript_vtt_url
    ).length;
    const withTranslation = items.filter(
      (item) => item && item.prefill && item.prefill.translation_vtt_url
    ).length;
    const withCodeSwitch = items.filter(
      (item) => item && item.prefill && item.prefill.code_switch_vtt_url
    ).length;
    const withDiar = items.filter(
      (item) => item && item.prefill && item.prefill.diarization_rttm_url
    ).length;
    const gold = items.filter((item) => item && item.is_gold).length;
    return {
      total,
      withTranscript,
      withTranslation,
      withCodeSwitch,
      withDiar,
      missingTranscript: total - withTranscript,
      gold,
      stage0: countByStatus(items, "stage0_status"),
      stage1: countByStatus(items, "stage1_status"),
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!showMissingOnly) return items;
    return items.filter(
      (item) =>
        !item ||
        !item.prefill ||
        !(item.prefill.transcript_vtt_url || item.prefill.translation_vtt_url || item.prefill.code_switch_vtt_url)
    );
  }, [items, showMissingOnly]);

  const handleAnnotatorSubmit = (event) => {
    event.preventDefault();
    const next = (inputAnnotator || "").trim() || "anonymous";
    setAnnotator(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(ANNOTATOR_KEY, next);
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <>
      <Head>
        <title>Stage 2 Ops Dashboard</title>
      </Head>
      <main className="page">
        <header>
          <h1>Stage 2 Ops Dashboard</h1>
          <p className="subtitle">
            Live peek at the current manifest, prefill coverage, and your local progress. (Locking and
            admin auth can follow once we wire SSO.)
          </p>
        </header>

        <section className="card">
          <h2>Annotator Feed</h2>
          <form onSubmit={handleAnnotatorSubmit} className="annotator-form">
            <label htmlFor="annotator-id">Annotator ID</label>
            <div className="annotator-row">
              <input
                id="annotator-id"
                value={inputAnnotator}
                onChange={(e) => setInputAnnotator(e.target.value)}
                placeholder="anonymous"
              />
              <button type="submit">Refresh</button>
            </div>
            <p className="description">
              Using <code>{annotator}</code> &mdash; set via <code>ea_stage2_annotator_id</code> in local storage.
            </p>
          </form>
          {loading ? <p className="status">Loading manifest…</p> : null}
          {error ? (
            <p className="status error">
              Fetch failed: <code>{error}</code>
            </p>
          ) : null}
        </section>

        <section className="grid">
          <div className="card">
            <h2>Manifest Health</h2>
            <div className="stat-grid">
              <div className="stat">
                <span className="label">Total items</span>
                <span className="value">{summary.total}</span>
              </div>
              <div className="stat">
                <span className="label">Prefill transcript</span>
                <span className="value">
                  {summary.withTranscript} ({formatPercent(summary.withTranscript, summary.total)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Missing transcript</span>
                <span className="value alert">
                  {summary.missingTranscript} ({formatPercent(summary.missingTranscript, summary.total)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Prefill translation</span>
                <span className="value">
                  {summary.withTranslation} ({formatPercent(summary.withTranslation, summary.total)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Prefill diarization</span>
                <span className="value">
                  {summary.withDiar} ({formatPercent(summary.withDiar, summary.total)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Gold clips</span>
                <span className="value">{summary.gold}</span>
              </div>
            </div>
            <div className="status-grid">
              <div>
                <h3>Stage 0 status</h3>
                <ul>
                  {Object.entries(summary.stage0).map(([status, count]) => (
                    <li key={status}>
                      <span className="status-label">{status}</span>
                      <span className="status-value">
                        {count} ({formatPercent(count, summary.total)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Stage 1 status</h3>
                <ul>
                  {Object.entries(summary.stage1).map(([status, count]) => (
                    <li key={status}>
                      <span className="status-label">{status}</span>
                      <span className="status-value">
                        {count} ({formatPercent(count, summary.total)})
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Your Session</h2>
            {sessionStats ? (
              <>
                <p className="info-line">
                  Annotator: <code>{sessionStats.annotator || "unknown"}</code>
                </p>
                <div className="stat-grid small">
                  <div className="stat">
                    <span className="label">Completed</span>
                    <span className="value">{sessionStats.completed}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Skipped</span>
                    <span className="value">{sessionStats.skipped}</span>
                  </div>
                  <div className="stat">
                    <span className="label">Last update</span>
                    <span className="value">{formatDate(sessionStats.updatedAt)}</span>
                  </div>
                </div>
                <p className="hint">
                  These numbers are saved to <code>localStorage</code> once you load or submit a clip.
                </p>
              </>
            ) : (
              <p className="hint">
                No local session stats yet. Open Stage 2, load a clip, and this panel will populate.
              </p>
            )}
          </div>

          <div className="card">
            <h2>Environment Snapshot</h2>
            {envNames && envNames.ok ? (
              <ul className="env-list">
                {Object.entries(envNames.names || {}).map(([k, v]) => (
                  <li key={k}>
                    <span className="env-key">{k}</span>
                    <span className="env-value">{typeof v === "boolean" ? String(v) : v || "—"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Could not load env names (endpoint restricted or offline).</p>
            )}
          </div>
        </section>

        <section className="card">
          <header className="table-header">
            <h2>Manifest Items</h2>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showMissingOnly}
                onChange={(e) => setShowMissingOnly(e.target.checked)}
              />
              Show only clips missing any prefill
            </label>
          </header>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Asset ID</th>
                  <th>Stage0</th>
                  <th>Stage1</th>
                  <th>Prefill: Transcript</th>
                  <th>Prefill: Translation</th>
                  <th>Prefill: Code Switch</th>
                  <th>Prefill: Diar</th>
                  <th>Assigned Cell</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      {showMissingOnly
                        ? "All clips currently have at least one prefill asset."
                        : "No manifest items found."}
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item, idx) => {
                    const hasTranscript = item?.prefill?.transcript_vtt_url ? "✅" : "—";
                    const hasTranslation = item?.prefill?.translation_vtt_url ? "✅" : "—";
                    const hasCS = item?.prefill?.code_switch_vtt_url ? "✅" : "—";
                    const hasDiar = item?.prefill?.diarization_rttm_url ? "✅" : "—";
                    return (
                      <tr key={item?.asset_id || idx}>
                        <td>{idx + 1}</td>
                        <td>
                          <code>{item?.asset_id || "unknown"}</code>
                        </td>
                        <td>{item?.stage0_status || "—"}</td>
                        <td>{item?.stage1_status || "—"}</td>
                        <td className={hasTranscript === "—" ? "missing" : ""}>{hasTranscript}</td>
                        <td className={hasTranslation === "—" ? "missing" : ""}>{hasTranslation}</td>
                        <td className={hasCS === "—" ? "missing" : ""}>{hasCS}</td>
                        <td className={hasDiar === "—" ? "missing" : ""}>{hasDiar}</td>
                        <td>{item?.assigned_cell || "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <style jsx>{`
        .page {
          max-width: 1080px;
          margin: 0 auto;
          padding: 2rem 3vw 4rem;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        header h1 {
          margin-bottom: 0.25rem;
        }
        .subtitle {
          margin-top: 0;
          color: #4b5563;
        }
        .card {
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          padding: 1.5rem;
          margin-bottom: 1.5rem;
          box-shadow: 0 10px 25px rgba(15, 23, 42, 0.08);
        }
        .annotator-form {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .annotator-row {
          display: flex;
          gap: 0.75rem;
          max-width: 420px;
        }
        input {
          flex: 1;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.5rem 0.75rem;
        }
        button {
          border: none;
          background: #2563eb;
          color: #fff;
          font-weight: 600;
          border-radius: 8px;
          padding: 0.5rem 1rem;
          cursor: pointer;
        }
        button:hover {
          background: #1d4ed8;
        }
        .table-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 1rem;
        }
        .table-meta {
          margin: 0.3rem 0 0;
          font-size: 0.85rem;
          color: #6b7280;
        }
        .filters-row {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          margin-bottom: 1rem;
        }
        .filters-row input,
        .filters-row select {
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.45rem 0.75rem;
          background: #fff;
          flex: 1 1 220px;
        }
        .filters-row select {
          min-width: 180px;
        }
        .pagination {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.75rem;
          margin-top: 1rem;
        }
        .pagination button {
          background: #1f2937;
          padding: 0.4rem 0.8rem;
        }
        .pagination button[disabled] {
          background: #9ca3af;
          cursor: not-allowed;
        }
        .description {
          margin: 0;
          color: #6b7280;
        }
        .status {
          margin-top: 1rem;
          color: #6b7280;
        }
        .status.error {
          color: #b91c1c;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 1.25rem;
          margin-bottom: 1.5rem;
        }
        .stat-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 0.75rem;
        }
        .stat-grid.small {
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        }
        .stat {
          background: #f8fafc;
          border-radius: 10px;
          padding: 0.75rem 0.9rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .label {
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #6b7280;
        }
        .value {
          font-size: 1.2rem;
          font-weight: 600;
          color: #0f172a;
        }
        .value.alert {
          color: #b91c1c;
        }
        .status-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1rem;
          margin-top: 1.25rem;
        }
        .status-grid ul {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .status-grid li {
          display: flex;
          justify-content: space-between;
          padding: 0.35rem 0;
          border-bottom: 1px dashed #e5e7eb;
          font-size: 0.95rem;
        }
        .status-label {
          color: #4b5563;
        }
        .status-value {
          font-weight: 600;
        }
        .env-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .env-key {
          font-weight: 600;
          margin-right: 0.5rem;
        }
        .env-value {
          color: #1f2937;
        }
        .hint {
          color: #6b7280;
          font-size: 0.9rem;
        }
        .info-line {
          margin-bottom: 0.75rem;
          color: #1f2937;
        }
        .table-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }
        .checkbox {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.9rem;
          color: #374151;
        }
        .table-wrapper {
          overflow-x: auto;
          margin-top: 1rem;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 720px;
        }
        th,
        td {
          border: 1px solid #e5e7eb;
          padding: 0.6rem 0.75rem;
          text-align: left;
          font-size: 0.92rem;
        }
        th {
          background: #f8fafc;
          font-weight: 600;
          color: #0f172a;
        }
        td.missing {
          color: #b91c1c;
          font-weight: 600;
        }
        td.empty {
          text-align: center;
          color: #6b7280;
          font-style: italic;
        }
        @media (max-width: 720px) {
          .annotator-row {
            flex-direction: column;
          }
          button {
            width: 100%;
          }
        }
      `}</style>
    </>
  );
}
