import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

export default function TimeSeriesChart({ data }) {
  const hasData = Array.isArray(data) && data.length > 0;

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
        Throughput (30d)
      </div>
      <div style={{ width: "100%", height: "200px" }}>
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

