import { useMemo, useState } from "react";
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import ChartCard from "./ChartCard";

interface BreakdownRow {
  dialect?: string;
  country?: string;
  count: number;
}

interface DistributionChartProps {
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
  { id: "dialect", label: "By Dialect" },
  { id: "country", label: "By Country" },
] as const;

export default function DistributionChart({
  dialectData,
  countryData,
  loading = false,
}: DistributionChartProps) {
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("dialect");

  const { data, title } = useMemo(() => {
    if (mode === "country") {
      return {
        title: "Distribution by Country",
        data: Array.isArray(countryData)
          ? countryData.map((row) => ({
              name: row.country || "Unknown",
              value: row.count || 0,
            }))
          : [],
      };
    }
    return {
      title: "Distribution by Dialect",
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
    <ChartCard
      title={title}
      loading={loading}
      action={
        <div style={{ display: "flex", gap: "6px" }}>
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
      }
    >
      {hasData ? (
        <ResponsiveContainer>
          <PieChart>
            <Pie
              dataKey="value"
              nameKey="name"
              data={data}
              outerRadius={90}
              innerRadius={50}
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
        <EmptyState message="No distribution data for this filter set." />
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

