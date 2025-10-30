import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

const STAGE_LABELS = {
  RIGHTS: "Rights",
  TRIAGE: "Triage",
  ANNOTATE: "Annotate",
  QA: "QA",
  DONE: "Done",
  FLAG: "Flagged",
  DUP: "Duplicates",
};

export default function FunnelChart({ data }) {
  const chartData = Array.isArray(data)
    ? data.map((row) => ({
        ...row,
        stageLabel: STAGE_LABELS[row.stage] || row.stage,
      }))
    : [];
  const hasData = chartData.some((row) => row.count > 0);

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
      <div style={{ fontWeight: 600, color: "#0f172a", marginBottom: "12px" }}>
        Funnel
      </div>
      <div style={{ width: "100%", height: "200px" }}>
        {hasData ? (
          <ResponsiveContainer>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 12, right: 24, left: 24, bottom: 12 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="stageLabel"
                width={120}
                tick={{ fontSize: 12 }}
              />
              <Tooltip />
              <Bar dataKey="count" fill="#10b981" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState message="No funnel data available." />
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#94a3b8",
        fontSize: "0.9rem",
      }}
    >
      {message}
    </div>
  );
}

