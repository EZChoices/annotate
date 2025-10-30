import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartCard from "./ChartCard";

const STAGE_LABELS: Record<string, string> = {
  RIGHTS: "Stage 0 · Rights",
  TRIAGE: "Stage 1 · Triage",
  ANNOTATE: "Stage 2 · Annotate",
  QA: "QA",
  DONE: "Done",
  FLAG: "Flagged",
  DUP: "Duplicate",
};

interface FunnelDatum {
  stage: string;
  count: number;
}

interface FunnelChartProps {
  data: FunnelDatum[];
  loading?: boolean;
}

export default function FunnelChart({
  data,
  loading = false,
}: FunnelChartProps) {
  const chartData = Array.isArray(data)
    ? data.map((row) => ({
        ...row,
        stageLabel: STAGE_LABELS[row.stage] ?? row.stage,
      }))
    : [];
  const hasData = chartData.some((row) => row.count > 0);

  return (
    <ChartCard title="Pipeline Funnel" loading={loading}>
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
              width={150}
              tick={{ fontSize: 12 }}
            />
            <Tooltip />
            <Bar dataKey="count" fill="#10b981" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyState message="No clips in the current funnel window." />
      )}
    </ChartCard>
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

