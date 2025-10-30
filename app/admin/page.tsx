"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import FiltersBar from "../../components/admin/FiltersBar";
import KpiGrid, { type KpiGridItem } from "../../components/admin/KpiGrid";
import DistributionChart from "../../components/admin/charts/DistributionChart";
import LeaderboardChart from "../../components/admin/charts/LeaderboardChart";
import PrefillCoverageChart from "../../components/admin/charts/PrefillCoverageChart";
import AnnotatorDrilldown from "../../components/admin/AnnotatorDrilldown";
import StuckClipsTable from "../../components/admin/tables/StuckClipsTable";
import RecentFlagsTable from "../../components/admin/tables/RecentFlagsTable";
import { exportAsCSV, exportAsJSONL } from "../../lib/csv";
import type { AdminStats } from "../../lib/adminQueries";

const ThroughputChart = dynamic(
  () => import("../../components/admin/charts/ThroughputChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton title="Throughput" />,
  }
);

const FunnelChart = dynamic(
  () => import("../../components/admin/charts/FunnelChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton title="Pipeline Funnel" />,
  }
);

type FiltersState = {
  from?: string;
  to?: string;
  stage?: string;
  priority?: string;
  dialect?: string;
  country?: string;
  annotatorId?: string;
};

type StuckRow = AdminStats["tables"]["stuck"][number];
type FlagRow = AdminStats["tables"]["recentFlags"][number];

export default function AdminDashboardPage() {
  const [filters, setFilters] = useState<FiltersState>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [showAnnotatorView, setShowAnnotatorView] = useState(true);
  const [selectedStuckRows, setSelectedStuckRows] = useState<StuckRow[]>([]);
  const [selectedFlagRows, setSelectedFlagRows] = useState<FlagRow[]>([]);

  const queryString = useMemo(() => buildQueryString(filters), [filters]);
  const { data, error, isLoading, isValidating, mutate } = useSWR<AdminStats>(
    `/api/admin/stats${queryString}`,
    fetcher,
    {
      refreshInterval: 60000,
      revalidateOnFocus: false,
    }
  );

  const loading = isLoading && !data;
  const annotatorOptions = data?.filters.availableAnnotators ?? [];

  const handleFiltersChange = useCallback((next: FiltersState) => {
    setFilters(next);
    setSelectedFlagRows([]);
    setSelectedStuckRows([]);
  }, []);

  const handleExportAllCsv = useCallback(() => {
    if (!data) return;
    const rows = [
      ...(data.tables.stuck || []).map((row) => ({ table: "stuck", ...row })),
      ...(data.tables.recentFlags || []).map((row) => ({
        table: "recentFlags",
        ...row,
      })),
    ];
    if (rows.length === 0) return;
    const suffix = new Date().toISOString().slice(0, 10);
    exportAsCSV(`admin-dashboard-${suffix}.csv`, rows);
  }, [data]);

  const handleExportSelection = useCallback(
    (rows: unknown[], format: "csv" | "jsonl", prefix: string) => {
      if (!rows.length) return;
      const suffix = new Date().toISOString().slice(0, 10);
      if (format === "csv") exportAsCSV(`${prefix}-${suffix}.csv`, rows as any[]);
      else exportAsJSONL(`${prefix}-${suffix}.jsonl`, rows as any[]);
    },
    []
  );

  const handleToggleAnnotatorView = useCallback(() => {
    setShowAnnotatorView((prev) => !prev);
  }, []);

  const friendlyError = useMemo(() => {
    if (!error) return null;
    const message = error.message || "";
    if (message.includes("422")) {
      return "Supabase returned HTTP 422. Check that the required filters (stage or annotator) are valid and that the backend tables contain rows.";
    }
    return `Unable to load admin stats. ${message}`;
  }, [error]);

  const filteredStuck = useMemo(() => {
    const base = data?.tables.stuck ?? [];
    if (!searchQuery) return base;
    const query = searchQuery.toLowerCase();
    return base.filter((row) => {
      const clipId = row.clipId?.toLowerCase() ?? "";
      const assigned = row.assignedTo?.toLowerCase() ?? "";
      return clipId.includes(query) || assigned.includes(query);
    });
  }, [data?.tables.stuck, searchQuery]);

  const filteredFlags = useMemo(() => {
    const base = data?.tables.recentFlags ?? [];
    if (!searchQuery) return base;
    const query = searchQuery.toLowerCase();
    return base.filter((row) => {
      const clipId = row.clipId?.toLowerCase() ?? "";
      const type = row.type?.toLowerCase() ?? "";
      const note = row.note?.toLowerCase() ?? "";
      return clipId.includes(query) || type.includes(query) || note.includes(query);
    });
  }, [data?.tables.recentFlags, searchQuery]);

  const leaderboardData = useMemo(() => {
    const base = data?.analytics.annotatorLeaderboard ?? [];
    if (!searchQuery) return base;
    const query = searchQuery.toLowerCase();
    return base.filter((row) => row.annotator?.toLowerCase().includes(query));
  }, [data?.analytics.annotatorLeaderboard, searchQuery]);

  const kpiItems: KpiGridItem[] = useMemo(() => {
    const metrics = data?.kpis;
    const fallback = { value: null, delta: null };
    return [
      {
        id: "totalClips",
        title: "Total Clips",
        metric: metrics?.totalClips ?? fallback,
        formatValue: formatNumber,
        trendMode: "neutral",
      },
      {
        id: "totalHours",
        title: "Total Hours",
        metric: metrics?.totalDurationHours ?? fallback,
        formatValue: formatHours,
        trendMode: "neutral",
      },
      {
        id: "pctCompleteCount",
        title: "% Complete (Count)",
        metric: metrics?.pctCompleteCount ?? fallback,
        formatValue: formatPercent,
        trendMode: "up-good",
      },
      {
        id: "pctCompleteDuration",
        title: "% Complete (Duration)",
        metric: metrics?.pctCompleteDuration ?? fallback,
        formatValue: formatPercent,
        trendMode: "up-good",
      },
      {
        id: "backlog",
        title: "Backlog",
        metric: metrics?.awaitingAnnotation ?? fallback,
        formatValue: formatNumber,
        trendMode: "down-good",
      },
      {
        id: "inAnnotation",
        title: "In Annotation",
        metric: metrics?.inAnnotation ?? fallback,
        formatValue: formatNumber,
        trendMode: "neutral",
      },
      {
        id: "qaPending",
        title: "QA Pending",
        metric: metrics?.qaPending ?? fallback,
        formatValue: formatNumber,
        trendMode: "down-good",
      },
      {
        id: "qaFailRate",
        title: "QA Fail Rate",
        metric: metrics?.qaFailRate ?? fallback,
        formatValue: formatPercent,
        trendMode: "down-good",
      },
      {
        id: "activeAnnotators",
        title: "Active Annotators (24h)",
        metric: metrics?.activeAnnotators24h ?? fallback,
        formatValue: formatNumber,
        trendMode: "up-good",
      },
      {
        id: "throughput7d",
        title: "7-Day Throughput",
        metric: metrics?.throughput7d ?? fallback,
        formatValue: formatNumber,
        trendMode: "up-good",
      },
      {
        id: "avgTurnaround",
        title: "Avg Turnaround (min)",
        metric: metrics?.avgTurnaroundMinutes ?? fallback,
        formatValue: formatMinutes,
        trendMode: "down-good",
      },
      {
        id: "stuck",
        title: "Stuck Clips (>24h)",
        metric: metrics?.stuckOver24h ?? fallback,
        formatValue: formatNumber,
        trendMode: "down-good",
      },
    ];
  }, [data?.kpis]);

  const supabaseStatus = data?.environment.supabaseStatus;
  const supabaseMessage = data?.environment.message;
  const lastSync = formatUtcTime(data?.environment.lastSync ?? data?.generatedAt ?? null);
  const windowLabel = formatWindow(data?.timeWindow.from, data?.timeWindow.to);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "24px",
        fontFamily:
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        display: "grid",
        gap: "24px",
      }}
    >
      <header
        style={{
          maxWidth: "72rem",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <h1 style={{ fontSize: "1.9rem", margin: 0, color: "#0f172a" }}>
              Admin Dashboard
            </h1>
            <p style={{ margin: "4px 0", color: "#475569" }}>Last Sync: {lastSync}</p>
            <p style={{ margin: 0, color: "#475569", fontSize: "0.9rem" }}>{windowLabel}</p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                color: "#475569",
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  background: statusColor(supabaseStatus),
                }}
              />
              Supabase Status: {supabaseStatus ?? "unknown"}
            </span>
          </div>
        </div>
        {supabaseMessage ? (
          <div
            style={{
              background: "#fefce8",
              border: "1px solid #fde68a",
              color: "#854d0e",
              padding: "10px 12px",
              borderRadius: "8px",
              fontSize: "0.85rem",
            }}
          >
            {supabaseMessage}
          </div>
        ) : null}
        {friendlyError ? (
          <div
            style={{
              background: "#fee2e2",
              border: "1px solid #f87171",
              color: "#b91c1c",
              padding: "10px 12px",
              borderRadius: "8px",
              fontSize: "0.85rem",
            }}
          >
            {friendlyError}
          </div>
        ) : null}
        <FiltersBar
          filters={filters}
          onChange={handleFiltersChange}
          annotatorOptions={annotatorOptions}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onResync={() => mutate()}
          onExportCsv={handleExportAllCsv}
          onToggleAnnotatorView={handleToggleAnnotatorView}
          annotatorViewEnabled={showAnnotatorView}
        />
      </header>

      <section style={{ maxWidth: "72rem", margin: "0 auto", width: "100%" }}>
        <KpiGrid items={kpiItems} loading={loading} />
      </section>

      <section
        style={{
          display: "grid",
          gap: "20px",
        }}
      >
        <FunnelChart data={data?.analytics.funnel ?? []} loading={loading} />
        <ThroughputChart
          data={data?.analytics.throughput30d ?? []}
          loading={loading}
        />
        <DistributionChart
          dialectData={data?.analytics.dialectDistribution ?? []}
          countryData={data?.analytics.countryDistribution ?? []}
          loading={loading}
        />
        <LeaderboardChart data={leaderboardData} loading={loading} />
        <PrefillCoverageChart
          coverage={
            data?.analytics.prefillCoverage ?? {
              transcript: null,
              translation: null,
              diarization: null,
            }
          }
          loading={loading}
        />
      </section>

      <section
        style={{
          display: "grid",
          gap: "20px",
        }}
      >
        <StuckClipsTable
          data={filteredStuck}
          loading={loading}
          onSelectionChange={setSelectedStuckRows}
          onExportCsv={() =>
            handleExportSelection(selectedStuckRows, "csv", "stuck-clips")
          }
          onExportJson={() =>
            handleExportSelection(selectedStuckRows, "jsonl", "stuck-clips")
          }
        />
        <RecentFlagsTable
          data={filteredFlags}
          loading={loading}
          onSelectionChange={setSelectedFlagRows}
          onExportCsv={() =>
            handleExportSelection(selectedFlagRows, "csv", "recent-flags")
          }
          onExportJson={() =>
            handleExportSelection(selectedFlagRows, "jsonl", "recent-flags")
          }
        />
      </section>

      {showAnnotatorView && (
        <section
          style={{
            maxWidth: "72rem",
            margin: "0 auto",
            width: "100%",
          }}
        >
          <details open>
            <summary
              style={{
                cursor: "pointer",
                fontWeight: 700,
                color: "#0f172a",
                fontSize: "1rem",
                marginBottom: "12px",
              }}
            >
              Per-Annotator View
            </summary>
            <AnnotatorDrilldown
              annotators={annotatorOptions}
              selectedAnnotator={filters.annotatorId || annotatorOptions[0]}
            />
          </details>
        </section>
      )}
    </main>
  );
}

async function fetcher(url: string): Promise<AdminStats> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return response.json();
}

function buildQueryString(filters: FiltersState) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

function formatNumber(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatHours(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} h`;
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

function formatMinutes(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Math.round(value)} min`;
}

function formatUtcTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(11, 19)} UTC`;
}

function formatWindow(from?: string, to?: string) {
  if (!from || !to) return "Window: —";
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Window: —";
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
  return `Window: ${formatter.format(start)} → ${formatter.format(end)}`;
}

function statusColor(status?: AdminStats["environment"]["supabaseStatus"]) {
  switch (status) {
    case "online":
      return "#16a34a";
    case "degraded":
      return "#f59e0b";
    case "offline":
      return "#dc2626";
    default:
      return "#94a3b8";
  }
}

function ChartSkeleton({ title }: { title: string }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "72rem",
        margin: "0 auto",
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        minHeight: "240px",
        boxShadow: "0 8px 24px -18px rgba(15, 23, 42, 0.45)",
      }}
    >
      <div
        style={{
          width: "40%",
          height: "16px",
          background: "#e2e8f0",
          borderRadius: "6px",
          marginBottom: "12px",
        }}
      />
      <div
        style={{
          width: "100%",
          height: "200px",
          background: "repeating-linear-gradient(90deg,#f1f5f9,#f1f5f9 20px,#e2e8f0 20px,#e2e8f0 40px)",
          borderRadius: "10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#94a3b8",
        }}
      >
        Loading {title}…
      </div>
    </div>
  );
}
