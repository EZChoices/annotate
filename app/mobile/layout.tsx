import { ReactNode } from "react";
import { MobileAuthProvider } from "../../components/mobile/MobileAuthProvider";
import { MobileSyncProvider } from "../../components/mobile/MobileSyncProvider";
import { LocaleProvider } from "../../components/mobile/LocaleProvider";

export const metadata = {
  title: "Dialect Data - Mobile Tasks",
};

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <MobileAuthProvider>
      <LocaleProvider>
        <MobileSyncProvider>
          <div className="min-h-screen bg-slate-100 text-slate-900 transition-colors dark:bg-slate-950 dark:text-slate-100">
            {children}
          </div>
        </MobileSyncProvider>
      </LocaleProvider>
    </MobileAuthProvider>
  );
}
