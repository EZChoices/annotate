import { useMemo, useState } from "react";
import {
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from "recharts";

interface BreakdownRow {
  dialect?: string;
  country?: string;
  count: number;
}

interface PieOrTreeChartProps {
  dialectData: BreakdownRow[];
  countryData: BreakdownRow[];
  loading?: boolean;
}

const COLORS = [
  "#6366f1",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#0ea5e9",
  "#8b5cf6",
  "#f87171",
  "#14b8a6",
];

const MODES = [
  { id: "dialect", label: "Dialect" },
  { id: "country", label: "Country" },
] as const;

export default function PieOrTreeChart({
  dialectData,
  countryData,
  loading = false,
}: PieOrTreeChartProps) {
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("dialect");

  const { data, title } = useMemo(() => {
    if (mode === "country") {
      return {
        title: "Breakdown by Country",
        data: Array.isArray(countryData)
          ? countryData.map((row) => ({
              name: row.country || "Unknown",
              value: row.count || 0,
            }))
          : [],
      };
    }
    return {
      title: "Breakdown by Dialect",
      data: Array.isArray(dialectData)
        ? dialectData.map((row) => ({
            name: row.dialect || "Unknown",
            value: row.count || 0,
          }))
        : [],
    };
  }, [mode, dialectData, countryData]);

  const hasData = data.some((row) => row.value > 0);

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
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
        }}
      >
        <div style={{ fontWeight: 700, color: "#0f172a" }}>{title}</div>
        <div style={{ display: "flex", gap: "8px" }}>
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              style={{
                background: option.id === mode ? "#1d4ed8" : "#e2e8f0",
                color: option.id === mode ? "#ffffff" : "#1e293b",
                border: "none",
                borderRadius: "999px",
                padding: "6px 12px",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ width: "100%", height: "200px" }}>
        {loading ? (
          <EmptyState message="Loading breakdown…" />
        ) : hasData ? (
          <ResponsiveContainer>
            <PieChart>
              <Pie
                dataKey="value"
                nameKey="name"
                data={data}
                outerRadius={80}
                innerRadius={40}
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${entry.name}-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState message="No breakdown data available." />
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

