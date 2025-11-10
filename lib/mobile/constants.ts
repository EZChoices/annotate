function flagEnabled(value?: string) {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "true";
}

const rawFlag =
  process.env.MOBILE_TASKS_ENABLED ??
  process.env.NEXT_PUBLIC_ENABLE_MOBILE_TASKS;

export const MOBILE_TASKS_ENABLED =
  flagEnabled(rawFlag) ?? true;

export const MOBILE_GOLDEN_RATIO = Number(
  process.env.MOBILE_GOLDEN_RATIO ?? "0.02"
);
export const MOBILE_TARGET_VOTES = Number(
  process.env.MOBILE_TARGET_VOTES ?? "5"
);
export const MOBILE_MIN_GREENS_SKIP_QA = Number(
  process.env.MOBILE_MIN_GREENS_SKIP_QA ?? "4"
);
export const MOBILE_MIN_GREENS_REVIEW = Number(
  process.env.MOBILE_MIN_GREENS_REVIEW ?? "3"
);
export const MOBILE_DEFAULT_BUNDLE_SIZE = Number(
  process.env.MOBILE_BUNDLE_SIZE ?? "3"
);
export const MOBILE_LEASE_MINUTES = Number(
  process.env.MOBILE_LEASE_MINUTES ?? "15"
);
export const MOBILE_BUNDLE_TTL_MINUTES = Number(
  process.env.MOBILE_BUNDLE_TTL_MINUTES ?? "45"
);

export const MOBILE_ALLOWED_TASK_TYPES = [
  "translation_check",
  "accent_tag",
  "emotion_tag",
  "gesture_tag",
  "safety_flag",
  "speaker_continuity",
] as const;

export type MobileTaskType = (typeof MOBILE_ALLOWED_TASK_TYPES)[number];
