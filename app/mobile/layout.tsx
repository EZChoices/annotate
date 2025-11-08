import { ReactNode } from "react";
import { MobileAuthProvider } from "../../components/mobile/MobileAuthProvider";
import { MobileSyncProvider } from "../../components/mobile/MobileSyncProvider";

export const metadata = {
  title: "Dialect Data - Mobile Tasks",
};

const hasSupabaseEnv =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export default function MobileLayout({ children }: { children: ReactNode }) {
  if (!hasSupabaseEnv) {
    return (
      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "#f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <p style={{ fontSize: "0.85rem", color: "#475569", marginBottom: 8 }}>
            Mobile Console
          </p>
          <h1 style={{ fontSize: "1.5rem", marginBottom: 12 }}>
            Mobile login unavailable
          </h1>
          <p style={{ fontSize: "0.95rem", color: "#475569" }}>
            Provide Supabase client credentials before using mobile tasks. Add{" "}
            <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to your environment, then
            redeploy.
          </p>
        </div>
      </div>
    );
  }

  return (
    <MobileAuthProvider>
      <MobileSyncProvider>
        <div className="min-h-screen bg-slate-100">{children}</div>
      </MobileSyncProvider>
    </MobileAuthProvider>
  );
}
