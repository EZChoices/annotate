"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MobileBundleResponse } from "../../../lib/mobile/types";
import { cacheBundle } from "../../../lib/mobile/idb";
import { useMobileAuth } from "../../../components/mobile/MobileAuthProvider";

export default function MobileWelcomePage() {
  const router = useRouter();
  const { fetchWithAuth } = useMobileAuth();
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
      <h1 className="text-2xl font-semibold">Welcome to Dialect Data Mobile</h1>
      <p className="text-sm text-slate-500">
        Hang tight while we reserve your first bundle. This also finishes your
        OTP sign-in.
      </p>
      {status === "loading" ? (
        <p className="text-sm text-slate-500">Fetching bundle…</p>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-semibold disabled:opacity-60"
        onClick={() => router.replace("/mobile")}
        disabled={status === "loading"}
      >
        {status === "loading" ? "Preparing…" : "Skip to task list"}
      </button>
    </main>
  );
}
