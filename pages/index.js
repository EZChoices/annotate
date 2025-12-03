export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "32px",
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        background:
          "radial-gradient(circle at 10% 20%, #e0f2fe 0, transparent 25%), radial-gradient(circle at 90% 10%, #ede9fe 0, transparent 22%), linear-gradient(135deg, #f8fafc, #e2e8f0)",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          maxWidth: "820px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        <header>
          <p
            style={{
              fontSize: "12px",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              fontWeight: 700,
              color: "#475569",
              margin: 0,
            }}
          >
            Dialect Data
          </p>
          <h1
            style={{
              margin: "6px 0",
              fontSize: "32px",
              fontWeight: 800,
            }}
          >
            Annotation Workspace
          </h1>
          <p style={{ margin: 0, color: "#475569" }}>
            Pick the surface you need. Stage 2 is for deep annotation; Mobile is for
            quick microtasks; Admin gives health and config.
          </p>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "12px",
          }}
        >
          <LinkCard
            title="Stage 2"
            href="/stage2?debug=1"
            desc="Deep annotation PWA with transcript/translation/codeswitch editors."
          />
          <LinkCard
            title="Stage 2 Stats"
            href="/stage2/stats"
            desc="Manifest health, prefill coverage, session stats."
          />
          <LinkCard
            title="Mobile Tasks"
            href="/mobile"
            desc="Microtask flow for gig workers. OTP optional; mock mode available."
          />
          <LinkCard
            title="Admin Dashboard"
            href="/admin"
            desc="KPIs, throughput, stuck items, flags, and drilldowns."
          />
          <LinkCard
            title="Remote Config"
            href="/admin/mobile/settings"
            desc="Toggle mobile flags, bundle sizes, and defaults."
          />
          <LinkCard
            title="API manifest"
            href="/api/tasks"
            desc="Raw manifest JSON for Stage 2."
          />
        </section>
      </div>
    </main>
  );
}

function LinkCard({ title, desc, href }) {
  return (
    <a
      href={href}
      style={{
        display: "block",
        padding: "16px",
        borderRadius: "14px",
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        boxShadow: "0 12px 32px rgba(15,23,42,0.08)",
        textDecoration: "none",
        color: "#0f172a",
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 16px 36px rgba(59,130,246,0.16)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "none";
        e.currentTarget.style.boxShadow = "0 12px 32px rgba(15,23,42,0.08)";
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>{title}</h3>
        <span style={{ fontSize: "16px", color: "#2563eb" }}>{">"}</span>
      </div>
      <p style={{ margin: 0, color: "#475569", fontSize: "14px", lineHeight: 1.5 }}>
        {desc}
      </p>
    </a>
  );
}
