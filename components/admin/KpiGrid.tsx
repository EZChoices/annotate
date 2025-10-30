import type { ReactNode } from "react";
import KpiCard from "./KpiCard";
import type { MetricValue } from "../../lib/adminQueries";

export interface KpiGridItem {
  id: string;
  title: string;
  metric: MetricValue;
  formatValue: (value: number | null) => string;
  trendMode?: "up-good" | "down-good" | "neutral";
  accent?: "slate" | "emerald" | "blue" | "amber" | "rose";
  subtitle?: ReactNode;
}

interface KpiGridProps {
  items: KpiGridItem[];
  loading?: boolean;
}

export default function KpiGrid({ items, loading = false }: KpiGridProps) {
  const placeholders = Array.from({ length: Math.max(items.length, 12) }).map(
    (_, index) => `placeholder-${index}`
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "16px",
      }}
    >
      {loading
        ? placeholders.map((key) => <SkeletonCard key={key} />)
        : items.map((item, index) => (
            <KpiCard
              key={item.id}
              title={item.title}
              metric={item.metric}
              formatValue={item.formatValue}
              trendMode={item.trendMode ?? "neutral"}
              accent={
                item.accent ?? ACCENT_SEQUENCE[index % ACCENT_SEQUENCE.length]
              }
              subtitle={item.subtitle}
            />
          ))}
    </div>
  );
}

const ACCENT_SEQUENCE: Array<"slate" | "emerald" | "blue" | "amber" | "rose"> = [
  "blue",
  "emerald",
  "amber",
  "rose",
  "slate",
];

function SkeletonCard() {
  return (
    <div
      style={{
        background: "#f1f5f9",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "18px",
        minHeight: "140px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div
        style={{
          width: "50%",
          height: "14px",
          background: "#e2e8f0",
          borderRadius: "6px",
        }}
      />
      <div
        style={{
          width: "70%",
          height: "28px",
          background: "#e2e8f0",
          borderRadius: "6px",
        }}
      />
      <div
        style={{
          width: "40%",
          height: "12px",
          background: "#e2e8f0",
          borderRadius: "6px",
        }}
      />
    </div>
  );
}
