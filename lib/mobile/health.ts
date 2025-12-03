function flagEnabled(value?: string | null) {
  if (value === undefined || value === null) return false;
  return value.trim().toLowerCase() === "true";
}

export function isMockModeEnabled(env: NodeJS.ProcessEnv = process.env) {
  const explicit =
    flagEnabled(env.MOBILE_ENABLE_MOCK_MODE) ||
    flagEnabled(env.NEXT_PUBLIC_ENABLE_MOBILE_MOCK);
  const serviceKey =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_KEY ||
    env.SUPABASE_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  const explicitMockKey = serviceKey.trim().toLowerCase() === "mock";
  const hasSupabase =
    Boolean(
      (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_PROJECT_URL) &&
        serviceKey
    );
  if (!hasSupabase) return true;
  return explicit || explicitMockKey;
}

export function readMobileHealth(env: NodeJS.ProcessEnv = process.env) {
  const supabaseUrl =
    env.SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    env.SUPABASE_PROJECT_URL ||
    "";
  const supabaseServiceKey =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SERVICE_KEY ||
    env.SUPABASE_KEY ||
    "";
  const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const supabaseConfigured = Boolean(supabaseUrl && supabaseServiceKey);
  const supabaseKeysDistinct =
    supabaseAnonKey && supabaseServiceKey
      ? supabaseAnonKey !== supabaseServiceKey
      : null;

  const bunnyBase =
    env.BUNNY_KEEP_URL || env.BUNNY_BASE || env.BUNNY_PULL_BASE || "";
  const bunnyConfigured = Boolean(bunnyBase);

  return {
    supabaseConfigured,
    supabaseKeysDistinct,
    supabaseUrl: supabaseConfigured ? supabaseUrl : null,
    bunnyConfigured,
    bunnyBase: bunnyConfigured ? bunnyBase : null,
    mockEnabled: isMockModeEnabled(env),
  };
}
