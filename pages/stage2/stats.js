import { useEffect, useMemo, useState } from "react";
import Head from "next/head";

const SESSION_KEY = "ea_stage2_session_stats";
const ANNOTATOR_KEY = "ea_stage2_annotator_id";
const ITEMS_PER_PAGE = 250;

function formatPercent(part, total) {
  if (!total) return "0%";
  const pct = Math.round((part / total) * 1000) / 10;
  return `${pct}%`;
}

function formatDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.toLocaleDateString()} ${date
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .replace(/\u202f/g, " ")}`;
}

function formatStatusLabel(label) {
  if (!label) return "Unknown";
  return label
    .toString()
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  const [summary, setSummary] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [envNames, setEnvNames] = useState(null);
  const [stage0Filter, setStage0Filter] = useState("all");
  const [stage1Filter, setStage1Filter] = useState("all");
  const [prefillFilter, setPrefillFilter] = useState("any");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");

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
    setPage(1);
  }, [stage0Filter, stage1Filter, prefillFilter, searchTerm]);

  useEffect(() => {
    if (!annotator) return;
    let active = true;
    const controller = new AbortController();

    const fetchManifest = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          stage: String(2),
          annotator_id: annotator,
          page: String(page),
          page_size: String(ITEMS_PER_PAGE),
          seed_fallback: "false",
          include_missing_prefill: "true",
          stats_view: "1",
        });
        if (stage0Filter !== "all") params.set("stage0", stage0Filter);
        if (stage1Filter !== "all") params.set("stage1", stage1Filter);
        if (prefillFilter !== "any") params.set("prefill_filter", prefillFilter);
        if (searchTerm.trim()) params.set("search", searchTerm.trim());

        const res = await fetch(`/api/tasks?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = await res.json();
        if (!active) return;
        setItems(Array.isArray(payload.items) ? payload.items : []);
        setSummary(payload.__summary || null);
        setMeta(payload.__meta || null);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setItems([]);
        setSummary(null);
        setMeta(null);
        setError(err && err.message ? err.message : String(err));
        setLoading(false);
      }
    };

    fetchManifest();
    return () => {
      active = false;
      controller.abort();
    };
  }, [annotator, page, stage0Filter, stage1Filter, prefillFilter, searchTerm]);

  const handleAnnotatorSubmit = (event) => {
    event.preventDefault();
    const next = (inputAnnotator || "").trim() || "anonymous";
    setAnnotator(next);
    setPage(1);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(ANNOTATOR_KEY, next);
      } catch {
        /* ignore */
      }
    }
  };

  const handleResetFilters = () => {
    setStage0Filter("all");
    setStage1Filter("all");
    setPrefillFilter("any");
    setSearchTerm("");
    setPage(1);
  };

  const handlePageJump = (event) => {
    event.preventDefault();
    const numeric = Number.parseInt(pageInput, 10);
    if (Number.isNaN(numeric)) {
      setPageInput(String(currentPage || 1));
      return;
    }
    const safeTarget = Math.min(Math.max(numeric, 1), totalPages || 1);
    setPage(safeTarget);
  };

  const totalItems = summary?.total ?? 0;
  const withTranscript = summary?.withTranscript ?? 0;
  const withTranslation = summary?.withTranslation ?? 0;
  const withDiar = summary?.withDiar ?? 0;
  const missingTranscript = summary?.missingTranscript ?? Math.max(totalItems - withTranscript, 0);
  const stage0Counts = summary?.stage0 || {};
  const stage1Counts = summary?.stage1 || {};
  const totalPages = meta?.total_pages ?? 1;
  const currentPage = meta?.page ?? page;
  const effectivePageSize = meta?.page_size ?? ITEMS_PER_PAGE;
  const filteredCount = summary?.total ?? meta?.filtered_rows ?? 0;
  const availableCount = meta?.keep_rows ?? meta?.available_rows ?? null;
  const pageStart = filteredCount === 0 ? 0 : (currentPage - 1) * effectivePageSize + 1;
  const pageEnd =
    filteredCount === 0 ? 0 : Math.min(filteredCount, pageStart + items.length - 1);
  const hasItems = items.length > 0;
  const hasFiltersApplied =
    stage0Filter !== "all" || stage1Filter !== "all" || prefillFilter !== "any" || !!searchTerm.trim();
  const metaSkipped = meta?.skipped_missing_transcript ?? 0;
  const emptyMessage = loading
    ? "Loading manifest..."
    : hasFiltersApplied
    ? "No clips match the current filters."
    : "No manifest items found.";
  const tableMetaLine = (() => {
    if (!summary && !meta) return loading ? "Loading manifest..." : "";
    if (!filteredCount) {
      return loading
        ? "Loading manifest..."
        : hasFiltersApplied
        ? "No clips match the current filters."
        : "No manifest clips available yet.";
    }
    const parts = [
      `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${filteredCount.toLocaleString()} clips`,
    ];
    if (availableCount != null && availableCount !== filteredCount) {
      parts.push(`Keep table total: ${availableCount.toLocaleString()}`);
    }
    if (metaSkipped) {
      parts.push(`Skipped missing transcript: ${metaSkipped.toLocaleString()}`);
    }
    return parts.join(" • ");
  })();

  const stage0Options = useMemo(() => {
    const keys = Object.keys(stage0Counts || {});
    keys.sort();
    return ["all", ...keys];
  }, [stage0Counts]);
  const stage1Options = useMemo(() => {
    const keys = Object.keys(stage1Counts || {});
    keys.sort();
    return ["all", ...keys];
  }, [stage1Counts]);

  useEffect(() => {
    setPageInput(String(currentPage || 1));
  }, [currentPage]);

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
                <span className="value">{totalItems.toLocaleString()}</span>
              </div>
              <div className="stat">
                <span className="label">Prefill transcript</span>
                <span className="value">
                  {withTranscript.toLocaleString()} ({formatPercent(withTranscript, totalItems)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Missing transcript</span>
                <span className={`value ${missingTranscript ? "alert" : ""}`}>
                  {missingTranscript.toLocaleString()} ({formatPercent(missingTranscript, totalItems)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Prefill translation</span>
                <span className="value">
                  {withTranslation.toLocaleString()} ({formatPercent(withTranslation, totalItems)})
                </span>
              </div>
              <div className="stat">
                <span className="label">Prefill diarization</span>
                <span className="value">
                  {withDiar.toLocaleString()} ({formatPercent(withDiar, totalItems)})
                </span>
              </div>
            </div>
            <div className="status-grid">
              <div>
                <h3>Stage 0 status</h3>
                <ul>
                  {Object.keys(stage0Counts).length === 0 ? (
                    <li className="status-empty">No data yet.</li>
                  ) : (
                    Object.entries(stage0Counts).map(([status, count]) => (
                      <li key={status}>
                        <span className="status-label">{formatStatusLabel(status)}</span>
                        <span className="status-value">
                          {count.toLocaleString()} ({formatPercent(count, totalItems)})
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
              <div>
                <h3>Stage 1 status</h3>
                <ul>
                  {Object.keys(stage1Counts).length === 0 ? (
                    <li className="status-empty">No data yet.</li>
                  ) : (
                    Object.entries(stage1Counts).map(([status, count]) => (
                      <li key={status}>
                        <span className="status-label">{formatStatusLabel(status)}</span>
                        <span className="status-value">
                          {count.toLocaleString()} ({formatPercent(count, totalItems)})
                        </span>
                      </li>
                    ))
                  )}
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
            <div>
              <h2>Manifest Items</h2>
              {tableMetaLine ? <p className="table-meta">{tableMetaLine}</p> : null}
            </div>
            <div className="table-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleResetFilters}
                disabled={!hasFiltersApplied}
              >
                Reset filters
              </button>
            </div>
          </header>

          <div className="filters-row">
            <select value={stage0Filter} onChange={(e) => setStage0Filter(e.target.value)}>
              {stage0Options.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "Stage 0: All statuses" : `Stage 0: ${formatStatusLabel(status)}`}
                </option>
              ))}
            </select>
            <select value={stage1Filter} onChange={(e) => setStage1Filter(e.target.value)}>
              {stage1Options.map((status) => (
                <option key={status} value={status}>
                  {status === "all" ? "Stage 1: All statuses" : `Stage 1: ${formatStatusLabel(status)}`}
                </option>
              ))}
            </select>
            <select value={prefillFilter} onChange={(e) => setPrefillFilter(e.target.value)}>
              <option value="any">Prefill: Any</option>
              <option value="missing">Prefill: Missing transcript</option>
            </select>
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search asset or cell"
            />
          </div>

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
                {!hasItems ? (
                  <tr>
                    <td colSpan={9} className="empty">
                      {tableMetaLine || emptyMessage}
                    </td>
                  </tr>
                ) : (
                  items.map((item, idx) => {
                    const assetId = item?.asset_id || "unknown";
                    const rowNumber = pageStart ? pageStart + idx : idx + 1;
                    const stage0 = item?.stage0_status ? formatStatusLabel(item.stage0_status) : "-";
                    const stage1 = item?.stage1_status ? formatStatusLabel(item.stage1_status) : "-";
                    const prefill = item?.prefill || {};
                    const hasTranscript = Boolean(prefill.transcript_vtt_url);
                    const hasTranslation = Boolean(prefill.translation_vtt_url);
                    const hasCS = Boolean(prefill.code_switch_vtt_url);
                    const hasDiar = Boolean(prefill.diarization_rttm_url);
                    return (
                      <tr key={assetId || idx}>
                        <td>{rowNumber}</td>
                        <td>
                          <code>{assetId}</code>
                        </td>
                        <td>{stage0}</td>
                        <td>{stage1}</td>
                        <td className={hasTranscript ? "" : "missing"}>{hasTranscript ? "yes" : "no"}</td>
                        <td className={hasTranslation ? "" : "missing"}>{hasTranslation ? "yes" : "no"}</td>
                        <td className={hasCS ? "" : "missing"}>{hasCS ? "yes" : "no"}</td>
                        <td className={hasDiar ? "" : "missing"}>{hasDiar ? "yes" : "no"}</td>
                        <td>{item?.assigned_cell || "-"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <form className="page-jump" onSubmit={handlePageJump}>
              <label htmlFor="page-jump-input" className="sr-only">Jump to page</label>
              <input
                id="page-jump-input"
                type="number"
                min="1"
                max={Math.max(1, totalPages)}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
              />
              <button type="submit" className="secondary-button">Go</button>
            </form>
            <button
              type="button"
              onClick={() => setPage((prev) => Math.max(1, Math.min(prev - 1, totalPages)))}
              disabled={currentPage <= 1}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((prev) => Math.max(1, Math.min(prev + 1, totalPages)))}
              disabled={currentPage >= totalPages}
            >
              Next
            </button>
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
        .table-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .secondary-button {
          background: #f3f4f6;
          color: #1f2937;
          border: 1px solid #d1d5db;
        }
        .secondary-button:hover:not([disabled]) {
          background: #e5e7eb;
        }
        .secondary-button[disabled] {
          cursor: not-allowed;
          opacity: 0.6;
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
        .pagination span {
          font-size: 0.9rem;
          color: #374151;
        }
        .page-jump {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .page-jump input {
          width: 4rem;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.35rem 0.5rem;
          text-align: center;
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
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
        .status-grid li.status-empty {
          justify-content: flex-start;
          color: #6b7280;
          font-style: italic;
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

