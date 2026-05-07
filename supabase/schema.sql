-- SlipIQ production data foundation
-- Run this in Supabase SQL editor before enabling live data.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique,
  username text,
  first_name text,
  plan text not null default 'free' check (plan in ('free', 'premium', 'vip')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id text primary key,
  sport text not null check (sport in ('tennis', 'nba')),
  tournament text,
  surface text,
  starts_at timestamptz,
  status text not null default 'scheduled',
  player_one text,
  player_two text,
  home_team text,
  away_team text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_stat_snapshots (
  id uuid primary key default gen_random_uuid(),
  match_id text references public.matches(id) on delete cascade,
  provider text not null,
  player_name text not null,
  surface text,
  fs1 numeric,
  w1s numeric,
  w2s numeric,
  bp_save numeric,
  sample_size integer,
  raw_payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create table if not exists public.odds_snapshots (
  id uuid primary key default gen_random_uuid(),
  match_id text references public.matches(id) on delete cascade,
  provider text not null,
  bookmaker text,
  market_key text not null,
  outcome_label text not null,
  decimal_odds numeric not null,
  implied_probability numeric generated always as (case when decimal_odds > 0 then 1 / decimal_odds else null end) stored,
  raw_payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create index if not exists odds_snapshots_match_market_idx on public.odds_snapshots(match_id, market_key, captured_at desc);

create table if not exists public.model_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null default 'scheduled',
  provider text not null default 'manual_seed',
  status text not null default 'started' check (status in ('started', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  model_run_id uuid references public.model_runs(id) on delete set null,
  match_id text references public.matches(id) on delete cascade,
  sport text not null check (sport in ('tennis', 'nba')),
  label text not null,
  market_key text not null,
  model_probability numeric not null,
  fair_odds numeric not null,
  bookmaker_odds numeric,
  edge numeric,
  expected_value numeric,
  risk_label text not null default 'unknown',
  tier text not null default 'C',
  explanation text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists opportunities_created_idx on public.opportunities(created_at desc);
create index if not exists opportunities_match_idx on public.opportunities(match_id, market_key);

create table if not exists public.slips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  stake numeric not null default 10,
  legs jsonb not null default '[]'::jsonb,
  combined_odds numeric not null default 1,
  hit_rate numeric not null default 0,
  expected_value numeric not null default 0,
  tier text not null default 'C',
  status text not null default 'saved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists slips_user_created_idx on public.slips(user_id, created_at desc);

create table if not exists public.alert_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  a_tier_window boolean not null default true,
  value_leg_detected boolean not null default true,
  new_match_data boolean not null default false,
  saved_slip_result boolean not null default true,
  s_tier_alert boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  plan text not null check (plan in ('premium', 'vip')),
  provider text not null check (provider in ('telegram_stars', 'stripe')),
  status text not null default 'active',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  telegram_charge_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists subscriptions_user_status_idx on public.subscriptions(user_id, status, expires_at desc);

-- SetFox v3 live signal log. Every model_run records:
--   * each opportunity row that passed Strict Mode (passed = true)
--   * scanner aggregate counts in setfox_scanner_runs
-- This is the foundation for forward-test proof: closing odds and result
-- columns will be backfilled later once match resolution and CLV pipelines
-- exist.
create table if not exists public.live_setfox_signals (
  id uuid primary key default gen_random_uuid(),
  model_run_id uuid references public.model_runs(id) on delete cascade,
  match_id text references public.matches(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  rule_version text not null,
  passed boolean not null,
  rejections text[] not null default '{}',
  score text not null,
  score_family text not null,
  odds_bucket text not null,
  tournament_level text not null,
  match_type text not null,
  surface text,
  model_probability numeric not null,
  fair_odds numeric not null,
  signal_odds numeric,
  opening_odds numeric,
  closing_odds numeric,
  clv numeric,
  beat_closing_line boolean,
  edge numeric,
  expected_value numeric,
  result text not null default 'pending' check (result in ('pending', 'won', 'lost', 'void', 'unknown')),
  raw_payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create index if not exists live_setfox_signals_run_idx on public.live_setfox_signals(model_run_id, captured_at desc);
create index if not exists live_setfox_signals_passed_idx on public.live_setfox_signals(passed, captured_at desc);
create index if not exists live_setfox_signals_match_idx on public.live_setfox_signals(match_id, score);

create table if not exists public.setfox_scanner_runs (
  id uuid primary key default gen_random_uuid(),
  model_run_id uuid references public.model_runs(id) on delete cascade,
  rule_version text not null,
  total_scanned integer not null default 0,
  passed integer not null default 0,
  rejected integer not null default 0,
  tiebreak_blocked integer not null default 0,
  rejections_by_reason jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create index if not exists setfox_scanner_runs_run_idx on public.setfox_scanner_runs(model_run_id);

create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists touch_users_updated_at on public.users;
create trigger touch_users_updated_at before update on public.users for each row execute function public.touch_updated_at();

drop trigger if exists touch_matches_updated_at on public.matches;
create trigger touch_matches_updated_at before update on public.matches for each row execute function public.touch_updated_at();

drop trigger if exists touch_slips_updated_at on public.slips;
create trigger touch_slips_updated_at before update on public.slips for each row execute function public.touch_updated_at();
