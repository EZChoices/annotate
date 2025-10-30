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
import type { PrefillCoverage } from "../../../lib/adminQueries";

interface PrefillCoverageChartProps {
  coverage: PrefillCoverage;
  loading?: boolean;
}

export default function PrefillCoverageChart({
  coverage,
  loading = false,
}: PrefillCoverageChartProps) {
  const metrics = [
    { key: "transcript", label: "Transcript", value: coverage.transcript },
    { key: "translation", label: "Translation", value: coverage.translation },
    { key: "diarization", label: "Diarization", value: coverage.diarization },
  ];

  const prepared = metrics
    .filter((item) => item.value != null)
    .map((item) => ({
      label: item.label,
      percent: item.value ?? 0,
    }));

  const hasData = prepared.length > 0;

  return (
    <ChartCard title="Prefill Coverage" loading={loading}>
      {hasData ? (
        <ResponsiveContainer>
          <BarChart
            data={prepared}
            layout="vertical"
            margin={{ top: 12, right: 24, left: 24, bottom: 12 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              domain={[0, 100]}
              tickFormatter={(value) => `${value}%`}
            />
            <YAxis
              dataKey="label"
              type="category"
              width={120}
              tick={{ fontSize: 12 }}
            />
            <Tooltip formatter={(value) => `${value}%`} />
            <Bar dataKey="percent" fill="#6366f1" />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <EmptyState message="No coverage stats available." />
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

