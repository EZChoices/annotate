import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { getServiceSupabase } from "../supabaseServer";
import type { Database } from "../../types/supabase";
import { MobileApiError } from "./errors";
import { isMobileMockMode } from "./mockData";

export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
         Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
         Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

type AuthUserResponse = Awaited<
  ReturnType<ReturnType<typeof createClient<Database>>["auth"]["getUser"]>
>;

export interface ContributorContext {
  contributor: Database["public"]["Tables"]["contributors"]["Row"];
  supabase: ReturnType<typeof getServiceSupabase>;
  accessToken: string;
  userId: string;
}

/**
 * Require that the incoming request is associated with a valid contributor.
 * When called from the mobile app this will attempt to authenticate the
 * supplied bearer token. If no token is supplied, an anonymous contributor
 * will be created (or fetched). In scenarios where mock mode is enabled
 * the returned Supabase client will not be null if the environment is
 * configured, avoiding crashes in downstream consumers.
 */
export async function requireContributor(
  req: NextRequest,
  opts?: { requireMobileFlag?: boolean }
): Promise<ContributorContext> {
  // If we're running in mock mode or Supabase environment variables are
  // entirely absent, return a mock contributor. If the environment variables
  // exist we still return a real Supabase client so downstream calls can
  // interact with the database instead of crashing due to a null client.
  if (isMobileMockMode() || !hasSupabaseEnv()) {
    return {
      contributor: MOCK_CONTRIBUTOR,
      supabase: hasSupabaseEnv()
        ? getServiceSupabase()
        : (null as unknown as ReturnType<typeof getServiceSupabase>),
      accessToken: "mock-token",
      userId: MOCK_CONTRIBUTOR.id,
    };
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;
  let supabase = getServiceSupabase();

  // Without a token we create or fetch an anonymous contributor. If this
  // operation fails we still return the Supabase client we created so
  // downstream calls can attempt fallback operations without crashing.
  if (!token) {
    try {
      const contributor = await getOrCreateAnonymousContributor(supabase);
      return {
        contributor,
        supabase,
        accessToken: "anonymous-bypass",
        userId: contributor.id,
      };
    } catch (error) {
      console.warn(
        "[mobile] anonymous contributor create failed; falling back to mock mode",
        error
      );
      if (hasSupabaseEnv()) {
        supabase = supabase ?? getServiceSupabase();
      }
      return {
        contributor: MOCK_CONTRIBUTOR,
        supabase,
        accessToken: "mock-token",
        userId: MOCK_CONTRIBUTOR.id,
      };
    }
  }

  const { data, error }: AuthUserResponse = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new MobileApiError("UNAUTHORIZED", 401, "Invalid session token");
  }

  const contributor = await getOrCreateContributor(supabase, data.user);

  if (opts?.requireMobileFlag !== false) {
    const mobileFlag =
      (contributor.feature_flags as any)?.mobile_tasks ?? false;
    if (!mobileFlag) {
      throw new MobileApiError(
        "FEATURE_DISABLED",
        403,
        "Mobile tasks are not enabled for this user"
      );
    }
  }

  return { contributor, supabase, accessToken: token, userId: data.user.id };
}

async function getOrCreateContributor(
  supabase: ReturnType<typeof getServiceSupabase>,
  user: User
) {
  const { data, error } = await supabase
    .from("contributors")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw new MobileApiError(
      "SERVER_ERROR",
      500,
      "Unable to load contributor profile"
    );
  }

  if (data) {
    return data;
  }

  const handleBase =
    user.user_metadata?.handle ||
    user.email?.split("@")[0] ||
    `user-${user.id.slice(0, 8)}`;

  const handle =
    String(handleBase)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 40) || `user-${user.id.slice(0, 8)}`;

  const { data: inserted, error: insertError } = await supabase
    .from("contributors")
    .insert({
      id: user.id,
      email: user.email,
      handle,
      feature_flags: { mobile_tasks: true },
    })
    .select("*")
    .single();

  if (insertError || !inserted) {
    throw new MobileApiError(
      "FORBIDDEN",
      403,
      "Contributor profile not found"
    );
  }

  return inserted;
}

const ANON_CONTRIBUTOR_ID = "00000000-0000-4000-8000-000000000042";
const ANON_EMAIL = "anonymous@dialectdata.test";
const MOCK_CONTRIBUTOR: Database["public"]["Tables"]["contributors"]["Row"] = {
  id: "mock-contributor",
  email: "mock@dialectdata.test",
  feature_flags: { mobile_tasks: true },
  capabilities: {},
  handle: "mock-user",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  tier: "silver",
  role: "contributor",
  locale: "ar",
  geo_country: null,
};

async function getOrCreateAnonymousContributor(
  supabase: ReturnType<typeof getServiceSupabase>
) {
  const { data } = await supabase
    .from("contributors")
    .select("*")
    .eq("id", ANON_CONTRIBUTOR_ID)
    .maybeSingle();

  if (data) {
    return data;
  }

  const { data: byEmail } = await supabase
    .from("contributors")
    .select("*")
    .eq("email", ANON_EMAIL)
    .maybeSingle();

  if (byEmail) {
    return data;
  }

  const { data: inserted, error } = await supabase
    .from("contributors")
    .upsert(
      {
        id: ANON_CONTRIBUTOR_ID,
        email: ANON_EMAIL,
        handle: "mobile-anonymous",
        feature_flags: { mobile_tasks: true },
        role: "contributor",
      },
      { onConflict: "id" }
    )
    .select("*")
    .single();

  if (error || !inserted) {
    const fallback = await supabase
      .from("contributors")
      .select("*")
      .eq("email", ANON_EMAIL)
      .maybeSingle();
    if (fallback.data) {
      return fallback.data;
    }
    throw new MobileApiError(
      "SERVER_ERROR",
      500,
      `Unable to create anonymous contributor: ${
        error?.message ?? "unknown"
      }`
    );
  }

  return inserted;
}
