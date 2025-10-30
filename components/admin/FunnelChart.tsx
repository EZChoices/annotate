import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface FunnelDatum {
  stage: string;
  count: number;
}

const STAGE_LABELS: Record<string, string> = {
  RIGHTS: "Rights",
  TRIAGE: "Triage",
  ANNOTATE: "Annotate",
  QA: "QA",
  DONE: "Done",
  FLAG: "Flagged",
  DUP: "Duplicates",
};

interface FunnelChartProps {
  data: FunnelDatum[];
  title?: string;
  loading?: boolean;
}

export default function FunnelChart({
  data,
  title = "Funnel",
  loading = false,
}: FunnelChartProps) {
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
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
        minHeight: "260px",
      }}
    >
      <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
        {title}
      </div>
      <div style={{ width: "100%", height: "200px" }}>
        {loading ? (
          <EmptyState message="Loading funnel…" />
        ) : hasData ? (
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
                width={140}
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

function EmptyState({ message }: { message: string }) {
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

