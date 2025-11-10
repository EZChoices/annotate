"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastVariant = "success" | "error" | "info";

type ToastRecord = {
  id: string;
  message: string;
  variant: ToastVariant;
};

type ToastContextValue = {
  pushToast: (message: string, variant?: ToastVariant) => void;
  dismissToast: (id: string) => void;
};

const MobileToastContext = createContext<ToastContextValue | null>(null);

export function MobileToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const pushToast = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev, { id, message, variant }]);
      timers.current[id] = setTimeout(() => dismissToast(id), 3500);
    },
    [dismissToast]
  );

  useEffect(
    () => () => {
      Object.values(timers.current).forEach((timer) => clearTimeout(timer));
      timers.current = {};
    },
    []
  );

  const value = useMemo(
    () => ({
      pushToast,
      dismissToast,
    }),
    [pushToast, dismissToast]
  );

  return (
    <MobileToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`w-full max-w-sm rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-lg transition-all ${
              toast.variant === "success"
                ? "bg-emerald-600/95 dark:bg-emerald-500/90"
                : toast.variant === "error"
                ? "bg-rose-600/95 dark:bg-rose-500/90"
                : "bg-slate-900/90 dark:bg-slate-700/95"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </MobileToastContext.Provider>
  );
}

export function useMobileToast() {
  const ctx = useContext(MobileToastContext);
  if (!ctx) {
    throw new Error("useMobileToast must be used within MobileToastProvider");
  }
  return ctx;
}
