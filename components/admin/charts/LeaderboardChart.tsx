import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartCard from "./ChartCard";
import type { AnnotatorLeaderboardRow } from "../../../lib/adminQueries";

interface LeaderboardChartProps {
  data: AnnotatorLeaderboardRow[];
  loading?: boolean;
}

export default function LeaderboardChart({
  data,
  loading = false,
}: LeaderboardChartProps) {
  const top = Array.isArray(data) ? data.slice(0, 10) : [];
  const chartData = top.map((row) => ({
    annotator: row.annotator || "Unknown",
    clipsDone: row.clipsDone,
    hoursDone: Math.round(row.hoursDone * 100) / 100,
    qaPassPercent: Math.round((row.qaPassRate ?? 0) * 100),
  }));

  const hasData = chartData.length > 0;

  return (
    <ChartCard title="Annotator Leaderboard (Top 10)" loading={loading}>
      {hasData ? (
        <ResponsiveContainer>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 12, right: 24, left: 24, bottom: 12 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" />
            <YAxis
              dataKey="annotator"
              type="category"
              width={150}
              tick={{ fontSize: 12 }}
            />
            <Tooltip />
            <Legend />
            <Bar dataKey="clipsDone" fill="#2563eb" name="Clips" />
            <Bar dataKey="qaPassPercent" fill="#f97316" name="QA Pass %" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyState message="No annotator metrics for the selected filters." />
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

