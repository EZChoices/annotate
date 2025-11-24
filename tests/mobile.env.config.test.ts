import test from "node:test";
import assert from "node:assert/strict";

import { isMockModeEnabled, readMobileHealth } from "../lib/mobile/health.ts";

test("mock mode stays off unless explicitly enabled", () => {
  const env = {
    MOBILE_ENABLE_MOCK_MODE: "",
    NEXT_PUBLIC_ENABLE_MOBILE_MOCK: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  } as NodeJS.ProcessEnv;
  assert.equal(isMockModeEnabled(env), false);
});

test("mock mode can be explicitly enabled", () => {
  const env = {
    MOBILE_ENABLE_MOCK_MODE: "true",
    NEXT_PUBLIC_ENABLE_MOBILE_MOCK: "",
  } as NodeJS.ProcessEnv;
  assert.equal(isMockModeEnabled(env), true);
});

test("service and anon Supabase keys must differ when both provided", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "same-key",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "same-key",
  } as NodeJS.ProcessEnv;
  const health = readMobileHealth(env);
  assert.equal(health.supabaseConfigured, true);
  assert.equal(health.supabaseKeysDistinct, false);
});

test("distinct Supabase keys pass the guard", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  } as NodeJS.ProcessEnv;
  const health = readMobileHealth(env);
  assert.equal(health.supabaseConfigured, true);
  assert.equal(health.supabaseKeysDistinct, true);
});
