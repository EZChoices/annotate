"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MobileBundleResponse } from "../../../lib/mobile/types";
import { cacheBundle } from "../../../lib/mobile/idb";
import { useMobileAuth } from "../../../components/mobile/MobileAuthProvider";
import { useTranslations } from "../../../components/mobile/useTranslations";
import { LocaleToggle } from "../../../components/mobile/LocaleToggle";

export default function MobileWelcomePage() {
  const router = useRouter();
  const { fetchWithAuth } = useMobileAuth();
  const t = useTranslations();
  const [status, setStatus] = useState<"loading" | "error" | "ready">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const warmStart = async () => {
      setStatus("loading");
      setError(null);
      try {
        const response = await fetchWithAuth("/api/mobile/bundle?count=3");
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.message || "Failed to prepare bundle");
        }
        const data: MobileBundleResponse = await response.json();
        await cacheBundle(data);
        if (!cancelled) {
          setStatus("ready");
          router.replace("/mobile");
        }
      } catch (err: any) {
        if (cancelled) return;
        setStatus("error");
        setError(err.message || "Unable to prefetch bundle");
      }
    };
    warmStart();
    return () => {
      cancelled = true;
    };
  }, [fetchWithAuth, router]);

  return (
    <main className="max-w-md mx-auto p-6 space-y-4 text-center">
      <div className="flex justify-end">
        <LocaleToggle />
      </div>
      <h1 className="text-2xl font-semibold">{t("welcomeTitle")}</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {t("welcomeSubtitle")}
      </p>
      {status === "loading" ? (
        <p className="text-sm text-slate-500 dark:text-slate-300">
          {t("fetchingBundle")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      <button
        className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
        onClick={() => router.replace("/mobile")}
        disabled={status === "loading"}
      >
        {status === "loading" ? t("preparing") : t("skipToList")}
      </button>
    </main>
  );
}
