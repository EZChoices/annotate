"use client";

import { useRouter } from "next/navigation";

export default function MobileWelcomePage() {
  const router = useRouter();
  return (
    <main className="max-w-md mx-auto p-6 space-y-4 text-center">
      <h1 className="text-2xl font-semibold">Welcome to Dialect Data Mobile</h1>
      <p className="text-sm text-slate-500">
        You&rsquo;re almost ready. Please review the contributor terms and tap
        continue to fetch your first bundle of tasks.
      </p>
      <button
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-semibold"
        onClick={() => router.push("/mobile")}
      >
        Accept & Continue
      </button>
    </main>
  );
}

