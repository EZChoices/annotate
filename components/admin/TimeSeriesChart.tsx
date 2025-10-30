import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface TimeSeriesPoint {
  date: string;
  completedCount: number;
}

interface TimeSeriesChartProps {
  title: string;
  data: TimeSeriesPoint[];
  loading?: boolean;
  height?: number;
}

export default function TimeSeriesChart({
  title,
  data,
  loading = false,
  height = 220,
}: TimeSeriesChartProps) {
  const hasData = Array.isArray(data) && data.length > 0;

  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 8px 20px -18px rgba(15, 23, 42, 0.45)",
        minHeight: height + 60,
      }}
    >
      <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "12px" }}>
        {title}
      </div>
      <div style={{ width: "100%", height }}>
        {loading ? (
          <EmptyState message="Loading throughput…" />
        ) : hasData ? (
          <ResponsiveContainer>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="completedCount"
                stroke="#2563eb"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState message="No throughput data in window." />
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

