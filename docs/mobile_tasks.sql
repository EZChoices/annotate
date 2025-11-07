-- Mobile microtask schema for Dialect Data.
-- Run with Supabase service role (psql or supabase db push).

create extension if not exists "pgcrypto";

--------------------------------------------------------------------------------
-- Core contributor + capability tables
--------------------------------------------------------------------------------

create table if not exists public.contributors (
  id uuid primary key default gen_random_uuid(),
  handle text unique,
  email text unique,
  tier text check (tier in ('bronze','silver','gold')) default 'bronze',
  locale text,
  geo_country text,
  capabilities jsonb not null default '{}'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  role text check (role in ('contributor','qa','admin')) default 'contributor',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contributors_geo_country_idx on public.contributors (geo_country);

--------------------------------------------------------------------------------
-- Media assets and clip segments
--------------------------------------------------------------------------------

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  kind text check (kind in ('video','audio')) not null,
  uri text not null,
  duration_ms integer not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.media_assets(id) on delete cascade,
  start_ms integer not null,
  end_ms integer not null,
  overlap_ms integer not null default 2000,
  speakers jsonb not null default '[]'::jsonb,
  context_prev_clip uuid references public.clips(id),
  context_next_clip uuid references public.clips(id),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists clips_asset_start_idx on public.clips (asset_id, start_ms);

--------------------------------------------------------------------------------
-- Task primitives
--------------------------------------------------------------------------------

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid references public.clips(id) on delete cascade,
  task_type text check (task_type in (
    'translation_check','accent_tag','emotion_tag','gesture_tag','safety_flag','speaker_continuity'
  )) not null,
  status text check (status in ('pending','in_progress','needs_review','auto_approved','rejected','complete')) default 'pending',
  target_votes integer not null default 5,
  min_green_for_skip_qa integer not null default 4,
  min_green_for_review integer not null default 3,
  price_cents integer not null,
  ai_suggestion jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  is_golden boolean not null default false,
  golden_answer jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_task_type_status_idx on public.tasks (task_type, status);
create index if not exists tasks_clip_idx on public.tasks (clip_id);

--------------------------------------------------------------------------------
-- Bundles & assignments
--------------------------------------------------------------------------------

create table if not exists public.task_bundles (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid references public.contributors(id) on delete cascade,
  created_at timestamptz not null default now(),
  ttl_minutes integer not null default 45,
  state text check (state in ('active','expired','closed')) default 'active'
);

create unique index if not exists task_bundles_unique_active
  on public.task_bundles (contributor_id)
  where state = 'active';

create table if not exists public.task_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  contributor_id uuid references public.contributors(id) on delete cascade,
  bundle_id uuid references public.task_bundles(id),
  state text check (state in ('leased','submitted','expired','released')) default 'leased',
  leased_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  last_heartbeat_at timestamptz,
  playback_ratio real default 0,
  watched_ms integer default 0,
  constraint task_assignment_unique unique (task_id, contributor_id)
);

create index if not exists task_assignments_task_state_idx on public.task_assignments (task_id, state);
create index if not exists task_assignments_bundle_idx on public.task_assignments (bundle_id, state);

--------------------------------------------------------------------------------
-- Responses & consensus
--------------------------------------------------------------------------------

create table if not exists public.task_responses (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  contributor_id uuid references public.contributors(id) on delete cascade,
  payload jsonb not null,
  duration_ms integer,
  playback_ratio real,
  created_at timestamptz not null default now(),
  unique (task_id, contributor_id)
);

create index if not exists task_responses_task_idx on public.task_responses (task_id);
create index if not exists task_responses_contributor_idx on public.task_responses (contributor_id);

create table if not exists public.task_consensus (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  consensus jsonb not null,
  votes jsonb not null,
  green_count integer not null,
  agreement_score real not null,
  decided_at timestamptz not null default now(),
  final_status text check (final_status in ('auto_approved','needs_review','rejected','undecided')) not null
);

--------------------------------------------------------------------------------
-- Contributor stats, pricing, payouts
--------------------------------------------------------------------------------

create table if not exists public.contributor_stats (
  contributor_id uuid primary key references public.contributors(id) on delete cascade,
  ewma_agreement real default 0.8,
  tasks_total integer default 0,
  tasks_agreed integer default 0,
  flags integer default 0,
  last_active timestamptz,
  golden_correct integer default 0,
  golden_total integer default 0
);

create table if not exists public.task_prices (
  task_type text primary key,
  base_cents integer not null,
  surge_multiplier real not null default 1.0,
  updated_at timestamptz not null default now()
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid references public.contributors(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  amount_cents integer not null,
  export_uri text,
  created_at timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- Events + telemetry
--------------------------------------------------------------------------------

create table if not exists public.events_mobile (
  id bigserial primary key,
  contributor_id uuid references public.contributors(id),
  name text not null,
  props jsonb not null default '{}'::jsonb,
  ts timestamptz not null default now()
);

create table if not exists public.idempotency_keys (
  contributor_id uuid references public.contributors(id) on delete cascade,
  key uuid not null,
  created_at timestamptz not null default now(),
  primary key (contributor_id, key)
);

create index if not exists idempotency_keys_created_idx on public.idempotency_keys (created_at);

--------------------------------------------------------------------------------
-- Row Level Security
--------------------------------------------------------------------------------

alter table public.contributors enable row level security;
alter table public.task_assignments enable row level security;
alter table public.task_responses enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='contributors' and policyname='sel_me'
  ) then
    create policy sel_me on public.contributors
      for select using (id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='contributors' and policyname='upd_me'
  ) then
    create policy upd_me on public.contributors
      for update using (id = auth.uid());
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='task_assignments' and policyname='sel_my_assign'
  ) then
    create policy sel_my_assign on public.task_assignments
      for select using (contributor_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='task_assignments' and policyname='upd_my_assign'
  ) then
    create policy upd_my_assign on public.task_assignments
      for update using (contributor_id = auth.uid());
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='task_responses' and policyname='ins_my_resp'
  ) then
    create policy ins_my_resp on public.task_responses
      for insert with check (contributor_id = auth.uid());
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='task_responses' and policyname='sel_my_resp'
  ) then
    create policy sel_my_resp on public.task_responses
      for select using (contributor_id = auth.uid());
  end if;
end $$;

--------------------------------------------------------------------------------
-- Defaults / seeds (task prices) – adjust as needed
--------------------------------------------------------------------------------

insert into public.task_prices (task_type, base_cents, surge_multiplier)
values
  ('translation_check', 10, 1.0),
  ('accent_tag', 8, 1.0),
  ('emotion_tag', 6, 1.0),
  ('gesture_tag', 10, 1.0)
on conflict (task_type) do update
set base_cents = excluded.base_cents,
    surge_multiplier = excluded.surge_multiplier,
    updated_at = now();
