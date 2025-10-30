import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import FiltersBar from "../../components/admin/FiltersBar";
import KpiCard from "../../components/admin/KpiCard";
import LeaderboardTable from "../../components/admin/LeaderboardTable";
import DataTable from "../../components/admin/DataTable";
import { exportAsCSV, exportAsJSONL } from "../../lib/csv";

const TimeSeriesChart = dynamic(
  () => import("../../components/admin/TimeSeriesChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
);
const FunnelChart = dynamic(
  () => import("../../components/admin/FunnelChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
);
const PieOrTreeChart = dynamic(
  () => import("../../components/admin/PieOrTreeChart"),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
);

const fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to fetch admin stats");
  }
  return response.json();
};

const numberFormatter = new Intl.NumberFormat("en-US");
const percentFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
const hoursFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`;
}

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return numberFormatter.format(Math.round(value));
}

function formatHours(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${hoursFormatter.format(value)} h`;
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "0%";
  return `${percentFormatter.format(value)}%`;
}

export default function AdminDashboard() {
  const [filters, setFilters] = useState({});
  const [selectedStuckRows, setSelectedStuckRows] = useState([]);
  const [selectedFlagRows, setSelectedFlagRows] = useState([]);
  const [stuckReassignTo, setStuckReassignTo] = useState("unassigned");
  const [stuckPriority, setStuckPriority] = useState("1");
  const [flagReassignTo, setFlagReassignTo] = useState("unassigned");
  const [flagPriority, setFlagPriority] = useState("1");

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters || {}).forEach(([key, value]) => {
      if (!value) return;
      params.set(key, value);
    });
    const query = params.toString();
    return query ? `?${query}` : "";
  }, [filters]);

  const {
    data,
    error,
    isLoading,
    isValidating,
  } = useSWR(`/api/admin/stats${queryString}`, fetcher, {
    refreshInterval: 60000,
    revalidateOnFocus: false,
  });

  useEffect(() => {
    setSelectedStuckRows([]);
    setSelectedFlagRows([]);
  }, [filters, data?.tables]);

  const annotatorIds = useMemo(() => {
    if (!data?.breakdowns?.annotatorLeaderboard) return [];
    return data.breakdowns.annotatorLeaderboard
      .map((row) => row.annotator)
      .filter(Boolean);
  }, [data]);

  const stuckColumns = useMemo(
    () => [
      {
        accessorKey: "clipId",
        header: "Clip ID",
        cell: (info) => info.getValue(),
      },
      {
        accessorKey: "status",
        header: "Status",
      },
      {
        accessorKey: "priority",
        header: "Priority",
        cell: (info) => info.getValue() ?? "—",
      },
      {
        accessorKey: "assignedTo",
        header: "Assigned To",
        cell: (info) => info.getValue() || "unassigned",
      },
      {
        accessorKey: "lastActionAt",
        header: "Last Action",
        cell: (info) => formatDateTime(info.getValue()),
      },
    ],
    []
  );

  const flagColumns = useMemo(
    () => [
      {
        accessorKey: "clipId",
        header: "Clip ID",
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: (info) => (info.getValue() || "").toUpperCase(),
      },
      {
        accessorKey: "note",
        header: "Note",
        cell: (info) => info.getValue() || "—",
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: (info) => formatDateTime(info.getValue()),
      },
    ],
    []
  );

  const handleFiltersChange = useCallback((next) => {
    setFilters(next);
  }, []);

  const handleGlobalExport = useCallback(
    (format) => {
      if (!data) return;
      const rows = [
        ...(data.tables?.stuck || []).map((row) => ({
          table: "stuck",
          ...row,
        })),
        ...(data.tables?.recentFlags || []).map((row) => ({
          table: "recentFlag",
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

  const handleStuckReassign = useCallback(() => {
    const ids = selectedStuckRows.map((row) => row.clipId);
    console.log("[admin] reassign stuck", { ids, to: stuckReassignTo });
  }, [selectedStuckRows, stuckReassignTo]);

  const handleStuckPriority = useCallback(() => {
    const ids = selectedStuckRows.map((row) => row.clipId);
    console.log("[admin] set priority", { ids, priority: stuckPriority });
  }, [selectedStuckRows, stuckPriority]);

  const handleStuckSendToQA = useCallback(() => {
    const ids = selectedStuckRows.map((row) => row.clipId);
    console.log("[admin] send to qa", { ids });
  }, [selectedStuckRows]);

  const handleStuckExport = useCallback(
    (format) => {
      if (selectedStuckRows.length === 0) return;
      const suffix = new Date().toISOString().slice(0, 10);
      if (format === "csv") {
        exportAsCSV(`stuck-${suffix}.csv`, selectedStuckRows);
      } else {
        exportAsJSONL(`stuck-${suffix}.jsonl`, selectedStuckRows);
      }
    },
    [selectedStuckRows]
  );

  const handleFlagReassign = useCallback(() => {
    const ids = selectedFlagRows.map((row) => row.clipId);
    console.log("[admin] reassign flagged", { ids, to: flagReassignTo });
  }, [selectedFlagRows, flagReassignTo]);

  const handleFlagPriority = useCallback(() => {
    const ids = selectedFlagRows.map((row) => row.clipId);
    console.log("[admin] update flag priority", { ids, priority: flagPriority });
  }, [selectedFlagRows, flagPriority]);

  const handleFlagSendToQA = useCallback(() => {
    const ids = selectedFlagRows.map((row) => row.clipId);
    console.log("[admin] send flagged to qa", { ids });
  }, [selectedFlagRows]);

  const handleFlagExport = useCallback(
    (format) => {
      if (selectedFlagRows.length === 0) return;
      const suffix = new Date().toISOString().slice(0, 10);
      if (format === "csv") {
        exportAsCSV(`flags-${suffix}.csv`, selectedFlagRows);
      } else {
        exportAsJSONL(`flags-${suffix}.jsonl`, selectedFlagRows);
      }
    },
    [selectedFlagRows]
  );

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        padding: "24px",
        fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          marginBottom: "16px",
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
            <h1 style={{ fontSize: "1.75rem", margin: 0, color: "#0f172a" }}>
              Admin Dashboard
            </h1>
            {data?.timeWindow ? (
              <p style={{ margin: 0, color: "#475569" }}>
                Window: {formatDateTime(data.timeWindow.from)}
                {" -> "}
                {formatDateTime(data.timeWindow.to)}
                {isValidating ? " - updating..." : ""}
              </p>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={() => handleGlobalExport("csv")}
              style={primaryButtonStyle}
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => handleGlobalExport("jsonl")}
              style={secondaryButtonStyle}
            >
              Export JSONL
            </button>
          </div>
        </div>
        <FiltersBar
          filters={filters}
          onChange={handleFiltersChange}
          annotatorOptions={annotatorIds}
        />
      </header>

      {error ? (
        <ErrorBanner message={error.message} />
      ) : null}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        {renderKpiCards(data?.kpis, isLoading)}
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <TimeSeriesChart data={data?.series?.throughput30d || []} />
        <FunnelChart data={data?.series?.funnel || []} />
        <PieOrTreeChart
          dialectData={data?.breakdowns?.byDialect || []}
          countryData={data?.breakdowns?.byCountry || []}
        />
      </section>

      <section style={{ display: "grid", gap: "16px", marginBottom: "24px" }}>
        <LeaderboardTable data={data?.breakdowns?.annotatorLeaderboard || []} />
        <div style={{ display: "grid", gap: "16px" }}>
          <BulkActionsBar
            title="Stuck items"
            selectedCount={selectedStuckRows.length}
            reassignValue={stuckReassignTo}
            onReassignChange={setStuckReassignTo}
            onReassign={handleStuckReassign}
            priorityValue={stuckPriority}
            onPriorityChange={setStuckPriority}
            onPriority={handleStuckPriority}
            onSendToQA={handleStuckSendToQA}
            onExportCSV={() => handleStuckExport("csv")}
            onExportJSONL={() => handleStuckExport("jsonl")}
            annotatorOptions={annotatorIds}
          />
          <DataTable
            title=""
            data={data?.tables?.stuck || []}
            columns={stuckColumns}
            emptyMessage="No clips are currently stuck."
            defaultSorting={[{ id: "priority", desc: false }]}
            onSelectionChange={setSelectedStuckRows}
          />
        </div>
        <div style={{ display: "grid", gap: "16px" }}>
          <BulkActionsBar
            title="Recent flags"
            selectedCount={selectedFlagRows.length}
            reassignValue={flagReassignTo}
            onReassignChange={setFlagReassignTo}
            onReassign={handleFlagReassign}
            priorityValue={flagPriority}
            onPriorityChange={setFlagPriority}
            onPriority={handleFlagPriority}
            onSendToQA={handleFlagSendToQA}
            onExportCSV={() => handleFlagExport("csv")}
            onExportJSONL={() => handleFlagExport("jsonl")}
            annotatorOptions={annotatorIds}
          />
          <DataTable
            title=""
            data={data?.tables?.recentFlags || []}
            columns={flagColumns}
            emptyMessage="No new flags."
            defaultSorting={[{ id: "createdAt", desc: true }]}
            onSelectionChange={setSelectedFlagRows}
          />
        </div>
      </section>
    </main>
  );
}

function renderKpiCards(kpis, loading) {
  const placeholders = Array.from({ length: 12 }).map((_, index) => (
    <SkeletonCard key={`placeholder-${index}`} />
  ));
  if (loading && !kpis) return placeholders;
  if (!kpis) return placeholders;
  return [
    <KpiCard
      key="totalClips"
      title="Total Clips"
      value={formatNumber(kpis.totalClips)}
    />,
    <KpiCard
      key="totalHours"
      title="Total Hours"
      value={formatHours(kpis.totalHours)}
    />,
    <KpiCard
      key="backlog"
      title="Backlog"
      value={formatNumber(kpis.backlogCount)}
    />,
    <KpiCard
      key="annotating"
      title="In Annotation"
      value={formatNumber(kpis.inAnnotationCount)}
    />,
    <KpiCard
      key="qaPending"
      title="QA Pending"
      value={formatNumber(kpis.qaPendingCount)}
    />,
    <KpiCard
      key="qaFail"
      title="QA Fail"
      value={formatNumber(kpis.qaFailCount)}
    />,
    <KpiCard
      key="completed"
      title="Completed"
      value={formatNumber(kpis.completedCount)}
      subtitle={formatPercent(kpis.pctCompleteByCount)}
    />,
    <KpiCard
      key="pctDuration"
      title="% Complete (Duration)"
      value={formatPercent(kpis.pctCompleteByDuration)}
    />,
    <KpiCard
      key="throughput7d"
      title="Throughput (7d)"
      value={formatNumber(kpis.throughput7d)}
    />,
    <KpiCard
      key="activeAnnotators"
      title="Active Annotators (24h)"
      value={formatNumber(kpis.activeAnnotators24h)}
    />,
    <KpiCard
      key="stuck"
      title="Stuck >24h"
      value={formatNumber(kpis.stuckOver24h)}
    />,
    <KpiCard
      key="priority"
      title="Priority Split"
      value={`P1 ${formatNumber(kpis.priority?.p1 || 0)} | P2 ${formatNumber(
        kpis.priority?.p2 || 0
      )} | P3 ${formatNumber(kpis.priority?.p3 || 0)}`}
    />,
  ];
}

function BulkActionsBar({
  title,
  selectedCount,
  reassignValue,
  onReassignChange,
  onReassign,
  priorityValue,
  onPriorityChange,
  onPriority,
  onSendToQA,
  onExportCSV,
  onExportJSONL,
  annotatorOptions,
}) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
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
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px",
          alignItems: "center",
        }}
      >
        <label style={bulkLabelStyle}>
          Reassign to
          <select
            value={reassignValue}
            onChange={(event) => onReassignChange(event.target.value)}
            style={bulkSelectStyle}
          >
            <option value="unassigned">Unassigned</option>
            {annotatorOptions?.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onReassign} style={secondaryButtonStyle}>
          Apply
        </button>
        <label style={bulkLabelStyle}>
          Priority
          <select
            value={priorityValue}
            onChange={(event) => onPriorityChange(event.target.value)}
            style={bulkSelectStyle}
          >
            <option value="1">P1</option>
            <option value="2">P2</option>
            <option value="3">P3</option>
          </select>
        </label>
        <button type="button" onClick={onPriority} style={secondaryButtonStyle}>
          Set
        </button>
        <button type="button" onClick={onSendToQA} style={secondaryButtonStyle}>
          Send to QA
        </button>
        <button type="button" onClick={onExportCSV} style={secondaryButtonStyle}>
          Export CSV
        </button>
        <button
          type="button"
          onClick={onExportJSONL}
          style={secondaryButtonStyle}
        >
          Export JSONL
        </button>
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
        minHeight: "260px",
      }}
    >
      <div style={{ marginBottom: "12px", height: "20px", background: "#e2e8f0" }} />
      <div style={{ width: "100%", height: "200px", background: "#f1f5f9" }} />
    </div>
  );
}

function SkeletonCard() {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
        minHeight: "120px",
      }}
    >
      <div style={{ width: "60%", height: "14px", background: "#e2e8f0" }} />
      <div
        style={{
          width: "80%",
          height: "28px",
          background: "#f1f5f9",
          marginTop: "16px",
        }}
      />
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div
      style={{
        background: "#fee2e2",
        border: "1px solid #f87171",
        color: "#b91c1c",
        padding: "12px 16px",
        borderRadius: "8px",
        marginBottom: "16px",
      }}
    >
      Failed to load dashboard data: {message}
    </div>
  );
}

const primaryButtonStyle = {
  background: "#1d4ed8",
  color: "#ffffff",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.9rem",
};

const secondaryButtonStyle = {
  background: "#e2e8f0",
  color: "#0f172a",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const bulkLabelStyle = {
  display: "flex",
  flexDirection: "column",
  fontSize: "0.75rem",
  color: "#475569",
  fontWeight: 600,
  gap: "4px",
};

const bulkSelectStyle = {
  minWidth: "140px",
  padding: "6px",
  borderRadius: "6px",
  border: "1px solid #cbd5f5",
};
