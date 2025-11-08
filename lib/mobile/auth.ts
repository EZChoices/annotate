import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import { getServiceSupabase } from "../supabaseServer";
import type { Database } from "../../types/supabase";
import { MobileApiError } from "./errors";

type AuthUserResponse = Awaited<
  ReturnType<ReturnType<typeof createClient<Database>>["auth"]["getUser"]>
>;

export interface ContributorContext {
  contributor: Database["public"]["Tables"]["contributors"]["Row"];
  supabase: ReturnType<typeof getServiceSupabase>;
  accessToken: string;
  userId: string;
}

export async function requireContributor(
  req: NextRequest,
  opts?: { requireMobileFlag?: boolean }
): Promise<ContributorContext> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;
  if (!token) {
    throw new MobileApiError(
      "UNAUTHORIZED",
      401,
      "Missing Authorization header"
    );
  }

  const supabase = getServiceSupabase();
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

  const handle = String(handleBase)
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
