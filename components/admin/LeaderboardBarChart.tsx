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
import type { AnnotatorLeaderboardRow } from "../../lib/adminQueries";

interface LeaderboardBarChartProps {
  data: AnnotatorLeaderboardRow[];
  loading?: boolean;
}

export default function LeaderboardBarChart({
  data,
  loading = false,
}: LeaderboardBarChartProps) {
  const top = Array.isArray(data) ? data.slice(0, 10) : [];
  const chartData = top.map((row) => ({
    annotator: row.annotator || "Unknown",
    clipsDone: row.clipsDone,
    hoursDone: Math.round(row.hoursDone * 100) / 100,
    qaPassPercent: Math.round((row.qaPassRate ?? 0) * 100),
  }));

  const hasData = chartData.length > 0;

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
        Annotator Leaderboard
      </div>
      <div style={{ width: "100%", height: "200px" }}>
        {loading ? (
          <EmptyState message="Loading leaderboard…" />
        ) : hasData ? (
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
                width={140}
                tick={{ fontSize: 12 }}
              />
              <Tooltip />
              <Legend />
              <Bar dataKey="clipsDone" fill="#2563eb" name="Clips" />
              <Bar dataKey="hoursDone" fill="#10b981" name="Hours" />
              <Bar dataKey="qaPassPercent" fill="#f97316" name="QA Pass %" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState message="No annotator metrics yet." />
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

