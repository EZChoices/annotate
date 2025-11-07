import type { Database } from "../../types/supabase";
import { getServiceSupabase } from "../supabaseServer";

type EventsTable = Database["public"]["Tables"]["events_mobile"]["Row"];

export async function logMobileEvent(
  contributorId: string,
  name: string,
  props: Record<string, any> = {}
) {
  const supabase = getServiceSupabase();
  await supabase.from("events_mobile").insert({
    contributor_id: contributorId,
    name,
    props,
  } satisfies Partial<EventsTable>);
}

