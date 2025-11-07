import { MOBILE_TASKS_ENABLED } from "./constants";
import { MobileApiError } from "./errors";

export function assertMobileFeatureEnabled() {
  if (!MOBILE_TASKS_ENABLED) {
    throw new MobileApiError(
      "FEATURE_DISABLED",
      503,
      "Mobile tasks are not enabled"
    );
  }
}

