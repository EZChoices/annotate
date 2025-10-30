'use client';

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import FiltersBar from "../../components/admin/FiltersBar";
import KpiCard from "../../components/admin/KpiCard";
import LeaderboardTable from "../../components/admin/LeaderboardTable";
import DataTable from "../../components/admin/DataTable";
import PieOrTreeChart from "../../components/admin/PieOrTreeChart";
import PrefillCoverageChart from "../../components/admin/PrefillCoverageChart";
import LeaderboardBarChart from "../../components/admin/LeaderboardBarChart";
import AnnotatorDrilldown from "../../components/admin/AnnotatorDrilldown";
import { exportAsCSV, exportAsJSONL } from "../../lib/csv";
import type { AdminStats } from "../../lib/adminQueries";

const TimeSeriesChart = dynamic(
  () => import("../../components/admin/TimeSeriesChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton title="Throughput (30d)" />,
  }
);

const FunnelChart = dynamic(() => import("../../components/admin/FunnelChart"), {
  ssr: false,
  loading: () => <ChartSkeleton title="Funnel" />,
});

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

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<AdminStats>;
};

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const hoursFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

function formatNumber(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return numberFormatter.format(value);
}

function formatHours(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${hoursFormatter.format(value)} h`;
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${percentFormatter.format(value)}%`;
}

function formatMinutes(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Math.round(value)} min`;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(date);
}

function buildQueryString(filters: FiltersState) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  return query ? `?${query}` : "";
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

const KPI_ACCENTS = [
  "blue",
  "emerald",
  "blue",
  "emerald",
  "amber",
  "blue",
  "amber",
  "rose",
  "blue",
  "emerald",
  "amber",
  "rose",
] as const;

export default function AdminDashboardPage() {
  const [filters, setFilters] = useState<FiltersState>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStuckRows, setSelectedStuckRows] = useState<StuckRow[]>([]);
  const [selectedFlagRows, setSelectedFlagRows] = useState<FlagRow[]>([]);

  const queryString = useMemo(() => buildQueryString(filters), [filters]);
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<AdminStats>(`/api/admin/stats${queryString}`, fetcher, {
    refreshInterval: 60000,
    revalidateOnFocus: false,
  });

  const handleFiltersChange = useCallback((next: FiltersState) => {
    setFilters(next);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const annotateIds = data?.filters.availableAnnotators ?? [];

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

  const filteredLeaderboard = useMemo(() => {
    const base = data?.analytics.annotatorLeaderboard ?? [];
    if (!searchQuery) return base;
    const query = searchQuery.toLowerCase();
    return base.filter((row) =>
      row.annotator?.toLowerCase().includes(query)
    );
  }, [data?.analytics.annotatorLeaderboard, searchQuery]);

  const stuckColumns: ColumnDef<StuckRow>[] = useMemo(
    () => [
      { accessorKey: "clipId", header: "Clip ID" },
      { accessorKey: "stage", header: "Stage" },
      {
        accessorKey: "priority",
        header: "Priority",
        cell: (info) => info.getValue<number | null>() ?? "—",
      },
      {
        accessorKey: "assignedTo",
        header: "Assigned to",
        cell: (info) => info.getValue<string>() || "unassigned",
      },
      {
        accessorKey: "lastActionAt",
        header: "Last action",
        cell: (info) => formatDateTime(info.getValue<string | null>() ?? null),
      },
      {
        accessorKey: "ageDays",
        header: "Age (days)",
        cell: (info) => {
          const value = info.getValue<number | null>();
          return value != null ? `${value}` : "—";
        },
      },
    ],
    []
  );

  const flagColumns: ColumnDef<FlagRow>[] = useMemo(
    () => [
      { accessorKey: "clipId", header: "Clip ID" },
      {
        accessorKey: "type",
        header: "Type",
        cell: (info) => (info.getValue<string>() || "").toUpperCase(),
      },
      {
        accessorKey: "note",
        header: "Note",
        cell: (info) => info.getValue<string>() || "—",
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: (info) => formatDateTime(info.getValue<string | null>() ?? null),
      },
    ],
    []
  );

  const handleExportAll = useCallback(
    (format: "csv" | "jsonl") => {
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
      if (format === "csv") {
        exportAsCSV(`admin-dashboard-${suffix}.csv`, rows);
      } else {
        exportAsJSONL(`admin-dashboard-${suffix}.jsonl`, rows);
      }
    },
    [data]
  );

  const handleExportSelection = useCallback(
    (rows: unknown[], format: "csv" | "jsonl", prefix: string) => {
      if (!rows.length) return;
      const suffix = new Date().toISOString().slice(0, 10);
      if (format === "csv") exportAsCSV(`${prefix}-${suffix}.csv`, rows as any[]);
      else exportAsJSONL(`${prefix}-${suffix}.jsonl`, rows as any[]);
    },
    []
  );

  const supabaseStatus = data?.environment.supabaseStatus;
  const statusMessage = data?.environment.message;
  const lastSync = data?.environment.lastSync;

  const kpis = [
    {
      title: "Total clips",
      metric: data?.kpis.totalClips,
      formatter: formatNumber,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[0],
    },
    {
      title: "Total duration",
      metric: data?.kpis.totalDurationHours,
      formatter: formatHours,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[1],
    },
    {
      title: "% complete (clips)",
      metric: data?.kpis.pctCompleteCount,
      formatter: formatPercent,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[2],
    },
    {
      title: "% complete (hours)",
      metric: data?.kpis.pctCompleteDuration,
      formatter: formatPercent,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[3],
    },
    {
      title: "Awaiting annotation",
      metric: data?.kpis.awaitingAnnotation,
      formatter: formatNumber,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[4],
    },
    {
      title: "In annotation",
      metric: data?.kpis.inAnnotation,
      formatter: formatNumber,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[5],
    },
    {
      title: "QA pending",
      metric: data?.kpis.qaPending,
      formatter: formatNumber,
      trend: "neutral" as const,
      accent: KPI_ACCENTS[6],
    },
    {
      title: "QA fail rate",
      metric: data?.kpis.qaFailRate,
      formatter: formatPercent,
      trend: "down-good" as const,
      accent: KPI_ACCENTS[7],
      deltaFormatter: (value: number) =>
        `${percentFormatter.format(value)} pts`,
    },
    {
      title: "Active annotators (24h)",
      metric: data?.kpis.activeAnnotators24h,
      formatter: formatNumber,
      trend: "up-good" as const,
      accent: KPI_ACCENTS[8],
    },
    {
      title: "Throughput (7d)",
      metric: data?.kpis.throughput7d,
      formatter: formatNumber,
      trend: "up-good" as const,
      accent: KPI_ACCENTS[9],
    },
    {
      title: "Avg turnaround",
      metric: data?.kpis.avgTurnaroundMinutes,
      formatter: formatMinutes,
      trend: "down-good" as const,
      accent: KPI_ACCENTS[10],
    },
    {
      title: "Stuck >24h",
      metric: data?.kpis.stuckOver24h,
      formatter: formatNumber,
      trend: "down-good" as const,
      accent: KPI_ACCENTS[11],
    },
  ];

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "24px",
        fontFamily:
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        display: "grid",
        gap: "20px",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          marginBottom: "4px",
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
            <p style={{ margin: "4px 0 0 0", color: "#475569" }}>
              Last data sync: {formatDateTime(lastSync ?? data?.generatedAt ?? null)}
              {isValidating ? " · refreshing…" : ""}
            </p>
            <p style={{ margin: "0", color: "#475569", fontSize: "0.9rem" }}>
              Time window: {formatDateTime(data?.timeWindow.from ?? null)} →{" "}
              {formatDateTime(data?.timeWindow.to ?? null)}
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{
                  display: "inline-block",
                  width: "10px",
                  height: "10px",
                  borderRadius: "999px",
                  background: statusColor(supabaseStatus),
                }}
              />
              <span style={{ color: "#475569", fontWeight: 600 }}>
                Supabase Status: {supabaseStatus ?? "unknown"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => mutate()}
              style={primaryButtonStyle}
            >
              Re-sync
            </button>
            <button
              type="button"
              onClick={() => handleExportAll("csv")}
              style={secondaryButtonStyle}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => handleExportAll("jsonl")}
              style={secondaryButtonStyle}
            >
              Export JSONL
            </button>
          </div>
        </div>
        {statusMessage ? (
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
            {statusMessage}
          </div>
        ) : null}
        <FiltersBar
          filters={filters}
          onChange={handleFiltersChange}
          annotatorOptions={annotateIds}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
        />
      </header>

      {error ? (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #f87171",
            color: "#b91c1c",
            padding: "12px 16px",
            borderRadius: "8px",
          }}
        >
          Failed to load dashboard data. This usually means Supabase credentials
          are missing or the `clips` table is empty. Details: {error.message}
        </div>
      ) : null}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
        }}
      >
        {kpis.map((kpi, index) => (
          <KpiCard
            key={kpi.title}
            title={kpi.title}
            metric={kpi.metric ?? { value: null, delta: null }}
            trendMode={kpi.trend}
            accent={KPI_ACCENTS[index % KPI_ACCENTS.length]}
            formatValue={kpi.formatter}
            formatDelta={(delta) =>
              kpi.deltaFormatter
                ? kpi.deltaFormatter(delta)
                : numberFormatter.format(delta)
            }
            loading={isLoading && !data}
          />
        ))}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "16px",
          alignItems: "stretch",
        }}
      >
        <TimeSeriesChart
          title="Throughput (30 days)"
          data={data?.analytics.throughput30d ?? []}
          loading={isLoading && !data}
        />
        <FunnelChart
          data={data?.analytics.funnel ?? []}
          loading={isLoading && !data}
        />
        <PrefillCoverageChart
          coverage={data?.analytics.prefillCoverage ?? {
            transcript: null,
            translation: null,
            diarization: null,
          }}
          loading={isLoading && !data}
        />
        <PieOrTreeChart
          dialectData={data?.analytics.dialectDistribution ?? []}
          countryData={data?.analytics.countryDistribution ?? []}
          loading={isLoading && !data}
        />
        <LeaderboardBarChart
          data={filteredLeaderboard}
          loading={isLoading && !data}
        />
      </section>

      <section style={{ display: "grid", gap: "16px" }}>
        <LeaderboardTable data={filteredLeaderboard} />
        <details
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "16px",
            boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
          }}
        >
          <summary
            style={{
              fontWeight: 700,
              color: "#0f172a",
              cursor: "pointer",
            }}
          >
            Per-Annotator View
          </summary>
          <div style={{ marginTop: "16px" }}>
            <AnnotatorDrilldown annotators={annotateIds} />
          </div>
        </details>
        <div style={{ display: "grid", gap: "16px" }}>
          <ActionBar
            title="Stuck clips"
            selectedCount={selectedStuckRows.length}
            onExportCSV={() =>
              handleExportSelection(selectedStuckRows, "csv", "stuck-clips")
            }
            onExportJSON={() =>
              handleExportSelection(selectedStuckRows, "jsonl", "stuck-clips")
            }
          />
          <DataTable<StuckRow>
            title="Stuck clips (>24h)"
            data={filteredStuck}
            columns={stuckColumns}
            emptyMessage="No clips are currently stuck."
            defaultSorting={[{ id: "priority", desc: false }]}
            onSelectionChange={setSelectedStuckRows}
          />
        </div>
        <div style={{ display: "grid", gap: "16px" }}>
          <ActionBar
            title="Recent flags"
            selectedCount={selectedFlagRows.length}
            onExportCSV={() =>
              handleExportSelection(selectedFlagRows, "csv", "recent-flags")
            }
            onExportJSON={() =>
              handleExportSelection(selectedFlagRows, "jsonl", "recent-flags")
            }
          />
          <DataTable<FlagRow>
            title="Recent flags"
            data={filteredFlags}
            columns={flagColumns}
            emptyMessage="No flag activity yet."
            defaultSorting={[{ id: "createdAt", desc: true }]}
            onSelectionChange={setSelectedFlagRows}
          />
        </div>
      </section>
    </main>
  );
}

function ActionBar({
  title,
  selectedCount,
  onExportCSV,
  onExportJSON,
}: {
  title: string;
  selectedCount: number;
  onExportCSV: () => void;
  onExportJSON: () => void;
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "12px 16px",
        display: "flex",
        flexWrap: "wrap",
        gap: "12px",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ fontWeight: 600, color: "#0f172a" }}>
        {title} {selectedCount > 0 ? `(${selectedCount} selected)` : ""}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" onClick={onExportCSV} style={secondaryButtonStyle}>
          Export selected CSV
        </button>
        <button type="button" onClick={onExportJSON} style={secondaryButtonStyle}>
          Export selected JSONL
        </button>
      </div>
    </div>
  );
}

function ChartSkeleton({ title }: { title: string }) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
        minHeight: "260px",
      }}
    >
      <div
        style={{
          height: "20px",
          background: "#e2e8f0",
          borderRadius: "6px",
          marginBottom: "16px",
        }}
      />
      <div
        style={{
          width: "100%",
          height: "200px",
          background: "#f1f5f9",
          borderRadius: "6px",
        }}
      >
        <span
          style={{
            display: "block",
            textAlign: "center",
            paddingTop: "90px",
            color: "#94a3b8",
            fontSize: "0.9rem",
          }}
        >
          Loading {title}…
        </span>
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  background: "#1d4ed8",
  color: "#ffffff",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.9rem",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "#e2e8f0",
  color: "#0f172a",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.85rem",
};
