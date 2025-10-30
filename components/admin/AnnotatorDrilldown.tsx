import { useEffect, useMemo, useState } from "react";

interface AnnotatorDrilldownProps {
  annotators: string[];
}

const SESSION_KEY = "ea_stage2_session_stats";

interface SessionStats {
  completed: number;
  skipped: number;
  updatedAt: string | null;
  annotator: string | null;
}

interface ManifestItem {
  prefill?: {
    transcript_vtt_url?: string | null;
    translation_vtt_url?: string | null;
    diarization_rttm_url?: string | null;
  };
  stage0_status?: string;
  stage1_status?: string;
  is_gold?: boolean;
}

interface ManifestSummary {
  total: number;
  transcript: number;
  translation: number;
  diarization: number;
  gold: number;
  stage0: Record<string, number>;
  stage1: Record<string, number>;
}

function extractItems(payload: any): ManifestItem[] {
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && payload.manifest && Array.isArray(payload.manifest.items)) {
    return payload.manifest.items;
  }
  return [];
}

function countByStatus(items: ManifestItem[], key: "stage0_status" | "stage1_status") {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = (item && item[key]) || "unknown";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function computeSummary(items: ManifestItem[]): ManifestSummary {
  const total = items.length;
  const transcript = items.filter(
    (item) => item?.prefill?.transcript_vtt_url
  ).length;
  const translation = items.filter(
    (item) => item?.prefill?.translation_vtt_url
  ).length;
  const diarization = items.filter(
    (item) => item?.prefill?.diarization_rttm_url
  ).length;
  const gold = items.filter((item) => Boolean(item?.is_gold)).length;
  return {
    total,
    transcript,
    translation,
    diarization,
    gold,
    stage0: countByStatus(items, "stage0_status"),
    stage1: countByStatus(items, "stage1_status"),
  };
}

function formatPercent(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 1000) / 10}%`;
}

function useSessionStats(): SessionStats | null {
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);

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

export default function AnnotatorDrilldown({
  annotators,
}: AnnotatorDrilldownProps) {
  const [selected, setSelected] = useState<string>(
    annotators?.[0] || "anonymous"
  );
  const [items, setItems] = useState<ManifestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionStats = useSessionStats();

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/tasks?stage=2&annotator_id=${encodeURIComponent(
            selected
          )}&limit=500&seed_fallback=false`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          if (!active) return;
          const friendly =
            res.status === 404
              ? "No manifest assigned to this annotator yet."
              : res.status === 422
              ? "Annotation ID missing or invalid. Enter an active annotator ID."
              : `Backend returned HTTP ${res.status}.`;
          setError(friendly);
          setItems([]);
          setLoading(false);
          return;
        }
        const payload = await res.json();
        if (!active) return;
        setItems(extractItems(payload));
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to fetch manifest data."
        );
        setItems([]);
        setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected]);

  const summary = useMemo(() => computeSummary(items), [items]);

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "12px",
          alignItems: "center",
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: "0.8rem",
            color: "#475569",
            gap: "4px",
          }}
        >
          <span style={{ fontWeight: 600 }}>Annotator</span>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            style={{ minWidth: "200px" }}
          >
            {[...(annotators ?? []), "anonymous"].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => setSelected((prev) => `${prev}`)}
          style={{
            background: "#e2e8f0",
            color: "#0f172a",
            border: "none",
            borderRadius: "6px",
            padding: "8px 14px",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          Refresh
        </button>
        {loading ? (
          <span style={{ color: "#475569", fontSize: "0.85rem" }}>
            Loading manifest…
          </span>
        ) : null}
      </div>
      {error ? (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #fca5a5",
            color: "#b91c1c",
            borderRadius: "8px",
            padding: "12px",
          }}
        >
          {error}
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gap: "12px",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        }}
      >
        <MiniCard
          title="Assigned clips"
          value={summary.total}
          accent="#2563eb"
        />
        <MiniCard
          title="Transcript coverage"
          value={formatPercent(summary.transcript, summary.total)}
          accent="#10b981"
        />
        <MiniCard
          title="Translation coverage"
          value={formatPercent(summary.translation, summary.total)}
          accent="#14b8a6"
        />
        <MiniCard
          title="Diarization coverage"
          value={formatPercent(summary.diarization, summary.total)}
          accent="#6366f1"
        />
        <MiniCard
          title="Gold clips"
          value={summary.gold}
          accent="#f97316"
        />
      </div>
      <div
        style={{
          display: "grid",
          gap: "12px",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <StatusBreakdown title="Stage 0 status" map={summary.stage0} />
        <StatusBreakdown title="Stage 1 status" map={summary.stage1} />
        <SessionBlock stats={sessionStats} />
      </div>
    </div>
  );
}

function MiniCard({
  title,
  value,
  accent,
}: {
  title: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: `1px solid ${accent}`,
        padding: "12px",
        minHeight: "110px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
    >
      <span style={{ fontSize: "0.8rem", color: "#475569", fontWeight: 600 }}>
        {title}
      </span>
      <span style={{ fontSize: "1.5rem", fontWeight: 700, color: "#0f172a" }}>
        {value}
      </span>
    </div>
  );
}

function StatusBreakdown({
  title,
  map,
}: {
  title: string;
  map: Record<string, number>;
}) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px", color: "#0f172a" }}>
        {title}
      </div>
      {entries.length ? (
        <ul style={{ margin: 0, paddingLeft: "18px", color: "#475569" }}>
          {entries.map(([status, count]) => (
            <li key={status}>
              <strong>{count}</strong> — {status}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, color: "#94a3b8" }}>No status breakdown yet.</p>
      )}
    </div>
  );
}

function SessionBlock({ stats }: { stats: SessionStats | null }) {
  if (!stats) {
    return (
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          border: "1px solid #e2e8f0",
          padding: "16px",
          color: "#94a3b8",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: "8px", color: "#0f172a" }}>
          Session snapshot
        </div>
        <p style={{ margin: 0 }}>
          No local session metrics yet. Start annotating to populate this panel.
        </p>
      </div>
    );
  }
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "8px", color: "#0f172a" }}>
        Session snapshot
      </div>
      <p style={{ margin: "0 0 6px 0", color: "#475569" }}>
        Annotator: <strong>{stats.annotator || "unassigned"}</strong>
      </p>
      <p style={{ margin: "0 0 6px 0", color: "#475569" }}>
        Completed in session: <strong>{stats.completed}</strong>
      </p>
      <p style={{ margin: "0 0 6px 0", color: "#475569" }}>
        Skipped in session: <strong>{stats.skipped}</strong>
      </p>
      <p style={{ margin: 0, color: "#94a3b8", fontSize: "0.8rem" }}>
        Updated {stats.updatedAt ? new Date(stats.updatedAt).toLocaleString() : "—"}
      </p>
    </div>
  );
}

