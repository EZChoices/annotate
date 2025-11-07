import { ReactNode } from "react";
import { MobileSyncProvider } from "../../components/mobile/MobileSyncProvider";

export const metadata = {
  title: "Dialect Data · Mobile Tasks",
};

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <MobileSyncProvider>
      <div className="min-h-screen bg-slate-100">
        {children}
      </div>
    </MobileSyncProvider>
  );
}

