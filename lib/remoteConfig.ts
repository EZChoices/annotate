import {
  SupabaseRemoteConfigAdapter,
  getRemoteConfigSnapshot,
  getRemoteConfigValue,
  refreshRemoteConfigFromAdapter,
  setRemoteConfigValue,
  useRemoteConfigAdapter,
} from "./mobile/remoteConfig";
import { getServiceSupabase } from "./supabaseServer";

let adapterBound = false;

if (!adapterBound) {
  try {
    const supabase = getServiceSupabase();
    useRemoteConfigAdapter(new SupabaseRemoteConfigAdapter(supabase));
    adapterBound = true;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[remote-config] Supabase credentials missing; falling back to in-memory adapter."
      );
    }
  }
}

export {
  SupabaseRemoteConfigAdapter,
  getRemoteConfigSnapshot,
  getRemoteConfigValue,
  refreshRemoteConfigFromAdapter,
  setRemoteConfigValue,
  useRemoteConfigAdapter,
};
