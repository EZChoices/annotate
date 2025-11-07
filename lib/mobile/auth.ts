import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
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

  const userId = data.user.id;
  const { data: contributor, error: contributorError } = await supabase
    .from("contributors")
    .select("*")
    .eq("id", userId)
    .single();

  if (contributorError || !contributor) {
    throw new MobileApiError(
      "FORBIDDEN",
      403,
      "Contributor profile not found"
    );
  }

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

  return { contributor, supabase, accessToken: token, userId };
}

