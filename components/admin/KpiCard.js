export default function KpiCard({ title, value, subtitle }) {
  return (
    <div
      style={{
        background: "#ffffff",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        padding: "16px",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.08)",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minHeight: "120px",
        justifyContent: "space-between",
      }}
    >
      <div style={{ fontSize: "0.85rem", color: "#475569", fontWeight: 600 }}>
        {title}
      </div>
      <div style={{ fontSize: "1.75rem", fontWeight: 700, color: "#0f172a" }}>
        {value ?? "—"}
      </div>
      {subtitle ? (
        <div style={{ fontSize: "0.85rem", color: "#64748b" }}>{subtitle}</div>
      ) : null}
    </div>
  );
}

