import type { Database } from "../../types/supabase";

export type ParsedCapabilities = {
  langs: Set<string>;
  canTranslate: Set<string>;
  accentRegions: Set<string>;
  roles: Set<string>;
  taskTypes: Set<string>;
};

type Contributor = Database["public"]["Tables"]["contributors"]["Row"];

export function parseCapabilities(contributor: Contributor): ParsedCapabilities {
  const raw = ((contributor.capabilities as any) || {}) as Record<
    string,
    unknown
  >;
  const toSet = (value: unknown): Set<string> => {
    if (Array.isArray(value)) {
      return new Set(value.filter((item) => typeof item === "string"));
    }
    return new Set();
  };
  return {
    langs: toSet(raw.langs || raw.languages),
    canTranslate: toSet(raw.can_translate || raw.canTranslate),
    accentRegions: toSet(raw.accent_regions || raw.accentRegions),
    roles: toSet(raw.roles),
    taskTypes: toSet(raw.task_types || raw.taskTypes),
  };
}

export function hasTaskTypeCapability(
  caps: ParsedCapabilities,
  taskType: string
) {
  return caps.taskTypes.size === 0 || caps.taskTypes.has(taskType);
}
