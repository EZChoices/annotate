"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useMobileAuth } from "../../../components/mobile/MobileAuthProvider";

export default function MobileLoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <MobileLoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <main className="mx-auto max-w-md space-y-4 p-6 text-center">
      <p className="text-sm text-slate-500">Loading login form…</p>
    </main>
  );
}

function MobileLoginForm() {
  const { supabase, session, status } = useMobileAuth();
  const router = useRouter();
  const search = useSearchParams();
  const nextParam = search?.get("next") || "/mobile";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"request" | "verify">("request");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const redirectTo = useMemo(() => {
    const envUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (envUrl) {
      return `${envUrl.replace(/\/$/, "")}/mobile/login`;
    }
    if (typeof window !== "undefined") {
      return `${window.location.origin}/mobile/login`;
    }
    return "/mobile/login";
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const cachedEmail = window.localStorage.getItem("dd-mobile-email");
    if (cachedEmail) {
      setEmail(cachedEmail);
      setStep("verify");
    }

    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    if (hash) {
      const params = new URLSearchParams(hash);
      const codeParam = params.get("error_code");
      const descParam = params.get("error_description");
      if (codeParam || descParam) {
        setLinkError(
          descParam?.replace(/\+/g, " ") ||
            "Authentication link is invalid or expired."
        );
      }
      window.location.hash = "";
    }
  }, []);

  useEffect(() => {
    if (status === "ready" && session) {
      router.replace(nextParam);
    }
  }, [nextParam, router, session, status]);

  const sendCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: redirectTo,
        },
      });
      if (otpError) throw otpError;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("dd-mobile-email", email);
      }
      setMessage("We sent you a 6-digit code. Enter it below to finish signing in.");
      setStep("verify");
    } catch (err: any) {
      setError(err.message || "Failed to send code");
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      if (verifyError) throw verifyError;
      setMessage("Success! Redirecting you to your tasks…");
      router.replace(nextParam);
    } catch (err: any) {
      setError(err.message || "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-md space-y-6 p-6">
      <div className="space-y-1 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Dialect Data
        </p>
        <h1 className="text-2xl font-semibold">OTP Sign-in</h1>
        <p className="text-sm text-slate-500">
          Enter your work email and the six-digit passcode we send you.
        </p>
      </div>

      {status === "loading" ? (
        <p className="text-center text-sm text-slate-500">Checking existing session…</p>
      ) : null}

      <form className="space-y-3" onSubmit={sendCode}>
        <label className="text-sm font-medium text-slate-700" htmlFor="mobile-email">
          Work email
        </label>
        <input
          id="mobile-email"
          type="email"
          required
          className="w-full rounded-lg border border-slate-300 p-3 text-sm"
          placeholder="you@dialectdata.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
        />
        <button
          type="submit"
          disabled={!email || loading}
          className="w-full rounded-lg bg-slate-900 py-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          {loading ? "Sending…" : "Send code"}
        </button>
      </form>

      {step === "verify" ? (
        <form className="space-y-3" onSubmit={verifyCode}>
          <label className="text-sm font-medium text-slate-700" htmlFor="mobile-code">
            6-digit code
          </label>
          <input
            id="mobile-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            required
            className="w-full rounded-lg border border-slate-300 p-3 text-center text-lg tracking-[0.5em]"
            placeholder="••••••"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            maxLength={6}
          />
          <button
            type="submit"
            disabled={code.length !== 6 || loading}
            className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Verifying…" : "Verify & continue"}
          </button>
        </form>
      ) : null}

      {message ? <p className="text-sm text-green-600">{message}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {linkError ? <p className="text-sm text-amber-600">{linkError}</p> : null}

      <div className="text-center text-xs text-slate-500">
        Problems signing in? Email{" "}
        <a className="font-semibold text-slate-700" href="mailto:support@dialectdata.com">
          support@dialectdata.com
        </a>
        .
      </div>

      <Link
        href="/mobile"
        className="block text-center text-sm font-semibold text-blue-600 underline"
      >
        Back to task list
      </Link>
    </main>
  );
}
