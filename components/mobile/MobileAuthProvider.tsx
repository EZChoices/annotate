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

export interface MobileAuthContextValue {
  status: MobileAuthStatus;
  session: Session | null;
  user: Session["user"] | null;
  supabase: SupabaseClient<Database>;
  fetchWithAuth: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  signOut: () => Promise<void>;
}

const MobileAuthContext = createContext<MobileAuthContextValue | null>(null);

export function MobileAuthProvider({ children }: { children: ReactNode }) {
  const supabase = getBrowserSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<MobileAuthStatus>("loading");

  useEffect(() => {
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
  }, [supabase]);

  const fetchWithAuth = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
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
    [session?.access_token, supabase]
  );

  const value = useMemo<MobileAuthContextValue>(() => {
    return {
      status,
      session,
      user: session?.user ?? null,
      supabase,
      fetchWithAuth,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    };
  }, [fetchWithAuth, session, status, supabase]);

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
