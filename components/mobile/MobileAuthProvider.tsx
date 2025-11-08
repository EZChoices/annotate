"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/supabase";
import { getBrowserSupabase } from "../../lib/mobile/browserClient";

type MobileAuthStatus = "loading" | "ready";
type MobileAuthMode = "otp" | "bypass";

export interface MobileAuthContextValue {
  status: MobileAuthStatus;
  session: Session | null;
  user: Session["user"] | null;
  supabase: SupabaseClient<Database> | null;
  fetchWithAuth: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  signOut: () => Promise<void>;
  mode: MobileAuthMode;
}

const MobileAuthContext = createContext<MobileAuthContextValue | null>(null);

export function MobileAuthProvider({ children }: { children: ReactNode }) {
  const hasSupabaseEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const otpEnabled =
    hasSupabaseEnv &&
    process.env.NEXT_PUBLIC_ENABLE_MOBILE_LOGIN === "true";

  const supabase = otpEnabled ? getBrowserSupabase() : null;
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<MobileAuthStatus>(
    otpEnabled ? "loading" : "ready"
  );

  useEffect(() => {
    if (!otpEnabled || !supabase) return;
    let isMounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) return;
      setSession(data.session ?? null);
      setStatus("ready");
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setStatus("ready");
    });
    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [otpEnabled, supabase]);

  const fetchWithAuth = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!otpEnabled || !supabase) {
        return fetch(input, init);
      }
      const headers = new Headers(init?.headers ?? undefined);
      const token =
        session?.access_token ||
        (await supabase.auth.getSession()).data.session?.access_token;

      if (!token) {
        throw new Error("Not authenticated");
      }

      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    [otpEnabled, session?.access_token, supabase]
  );

  const value = useMemo<MobileAuthContextValue>(() => {
    if (!otpEnabled) {
      return {
        status: "ready",
        session: null,
        user: null,
        supabase: null,
        fetchWithAuth,
        signOut: async () => {},
        mode: "bypass",
      };
    }

    return {
      status,
      session,
      user: session?.user ?? null,
      supabase,
      fetchWithAuth,
      signOut: async () => {
        await supabase?.auth.signOut();
      },
      mode: "otp",
    };
  }, [fetchWithAuth, otpEnabled, session, status, supabase]);

  return (
    <MobileAuthContext.Provider value={value}>
      {children}
    </MobileAuthContext.Provider>
  );
}

export function useMobileAuth(): MobileAuthContextValue {
  const ctx = useContext(MobileAuthContext);
  if (!ctx) {
    throw new Error("useMobileAuth must be used within MobileAuthProvider");
  }
  return ctx;
}
