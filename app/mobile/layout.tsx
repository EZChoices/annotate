// @ts-nocheck
"use client";
import { ReactNode } from "react";
import { MobileAuthProvider } from "../../components/mobile/MobileAuthProvider";
import { MobileSyncProvider } from "../../components/mobile/MobileSyncProvider";
import { LocaleProvider } from "../../components/mobile/LocaleProvider";
import { MobileToastProvider } from "../../components/mobile/MobileToastProvider";
import { MockModeBanner } from "../../components/mobile/MockModeBanner";

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <MobileAuthProvider>
      <LocaleProvider>
        <MobileSyncProvider>
          <MobileToastProvider>
            <div className="min-h-screen bg-slate-100 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
              <MockModeBanner />
              {children}
            </div>
            <style jsx global>{`
              @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&display=swap");
              :root {
                --mobile-font: "Space Grotesk", "Inter", "SF Pro Display", system-ui,
                  -apple-system, sans-serif;
              }
              body {
                font-family: var(--mobile-font);
                background: radial-gradient(
                    circle at 20% 20%,
                    rgba(59, 130, 246, 0.12),
                    transparent 32%
                  ),
                  radial-gradient(
                    circle at 80% 0%,
                    rgba(14, 165, 233, 0.1),
                    transparent 28%
                  ),
                  radial-gradient(
                    circle at 50% 80%,
                    rgba(79, 70, 229, 0.08),
                    transparent 36%
                  ),
                  #0f172a;
              }
            `}</style>
          </MobileToastProvider>
        </MobileSyncProvider>
      </LocaleProvider>
    </MobileAuthProvider>
  );
}
