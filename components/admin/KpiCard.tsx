import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MetricValue } from "../../lib/adminQueries";

type TrendMode = "up-good" | "down-good" | "neutral";

interface KpiCardProps {
  title: string;
  metric: MetricValue;
  formatValue?: (value: number | null) => string;
  formatDelta?: (delta: number) => string;
  subtitle?: ReactNode;
  trendMode?: TrendMode;
  accent?: "slate" | "emerald" | "blue" | "amber" | "rose";
  loading?: boolean;
}

const ACCENT_MAP: Record<
  NonNullable<KpiCardProps["accent"]>,
  { background: string; border: string }
> = {
  slate: {
    background: "linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)",
    border: "#cbd5f5",
  },
  emerald: {
    background: "linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)",
    border: "#bbf7d0",
  },
  blue: {
    background: "linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)",
    border: "#bfdbfe",
  },
  amber: {
    background: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)",
    border: "#fde68a",
  },
  rose: {
    background: "linear-gradient(135deg, #fdf2f8 0%, #fce7f3 100%)",
    border: "#fbcfe8",
  },
};

function defaultValueFormatter(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function defaultDeltaFormatter(delta: number): string {
  if (Number.isNaN(delta)) return "0";
  const formatter = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  });
  return formatter.format(delta);
}

export default function KpiCard({
  title,
  metric,
  formatValue = defaultValueFormatter,
  formatDelta = defaultDeltaFormatter,
  subtitle,
  trendMode = "neutral",
  accent = "slate",
  loading = false,
}: KpiCardProps) {
  const accentStyle = ACCENT_MAP[accent];
  const valueDisplay = loading
    ? "…"
    : formatValue(metric?.value ?? null);

  const delta = !loading ? metric?.delta : null;
  const hasDelta = delta != null && !Number.isNaN(delta);

  const isPositive = (delta ?? 0) > 0;
  const isNegative = (delta ?? 0) < 0;
  const isImproving =
    trendMode === "neutral"
      ? false
      : trendMode === "up-good"
      ? isPositive
      : trendMode === "down-good"
      ? isNegative
      : false;
  const isDeclining =
    trendMode === "neutral"
      ? false
      : trendMode === "up-good"
      ? isNegative
      : trendMode === "down-good"
      ? isPositive
      : false;

  let deltaColor = "#64748b";
  if (hasDelta) {
    if (isImproving) deltaColor = "#16a34a";
    else if (isDeclining) deltaColor = "#dc2626";
    else deltaColor = "#f59e0b";
  }

  const arrow = hasDelta ? (delta! > 0 ? "▲" : delta! < 0 ? "▼" : "▬") : null;
  const deltaLabel = hasDelta ? formatDelta(delta!) : "";

  return (
    <div
      style={{
        background: accentStyle.background,
        borderRadius: "12px",
        border: `1px solid ${accentStyle.border}`,
        padding: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        minHeight: "140px",
        justifyContent: "space-between",
        boxShadow: "0 10px 20px -20px rgba(15, 23, 42, 0.45)",
      }}
    >
      <div style={{ fontSize: "0.85rem", color: "#475569", fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={loading ? "loading" : valueDisplay}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            style={{ fontSize: "2.0rem", fontWeight: 700, color: "#0f172a" }}
          >
            {valueDisplay}
          </motion.div>
        </AnimatePresence>
        {hasDelta ? (
          <div style={{ fontSize: "0.85rem", fontWeight: 600, color: deltaColor }}>
            {arrow ? `${arrow} ${deltaLabel}` : deltaLabel}
          </div>
        ) : null}
      </div>
      {subtitle ? (
        <div style={{ fontSize: "0.85rem", color: "#64748b" }}>{subtitle}</div>
      ) : null}
    </div>
  );
}
