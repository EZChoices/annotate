import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  children: ReactNode;
  height?: number;
  action?: ReactNode;
  loading?: boolean;
}

export default function ChartCard({
  title,
  children,
  height = 240,
  action,
  loading = false,
}: ChartCardProps) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "72rem",
        margin: "0 auto",
        background: "#ffffff",
        borderRadius: "12px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 8px 24px -18px rgba(15, 23, 42, 0.45)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <h2
          style={{
            fontSize: "1rem",
            fontWeight: 700,
            margin: 0,
            color: "#0f172a",
          }}
        >
          {title}
        </h2>
        {action}
      </div>
      <div style={{ width: "100%", height }}>
        {loading ? <ChartSkeleton /> : children}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "repeating-linear-gradient(45deg,#f1f5f9,#f1f5f9 10px,#e2e8f0 10px,#e2e8f0 20px)",
        borderRadius: "10px",
      }}
    />
  );
}

