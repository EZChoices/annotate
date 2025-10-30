import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartCard from "./ChartCard";

interface ThroughputPoint {
  date: string;
  completedCount: number;
}

interface ThroughputChartProps {
  data: ThroughputPoint[];
  loading?: boolean;
}

export default function ThroughputChart({
  data,
  loading = false,
}: ThroughputChartProps) {
  const hasData = Array.isArray(data) && data.length > 0;

  return (
    <ChartCard title="Throughput (30 days)" loading={loading}>
      {hasData ? (
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

