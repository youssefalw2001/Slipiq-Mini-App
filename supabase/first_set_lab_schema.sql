-- SlipIQ / First Set Lab Supabase proof ledger
-- Run this once in Supabase SQL Editor before enabling live Telegram delivery.

create extension if not exists pgcrypto;

create table if not exists public.signal_rooms (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  tier text not null,
  telegram_chat_id text,
  is_active boolean default true,
  created_at timestamptz default now()
);

insert into public.signal_rooms (key, name, tier)
values
  ('free_proof', 'Free Proof Channel', 'free'),
  ('core', 'Core Signal Chat', 'core'),
  ('vip', 'VIP First Set Lab', 'vip')
on conflict (key) do nothing;

create table if not exists public.live_signals (
  id uuid primary key default gen_random_uuid(),
  signal_key text unique not null,
  scanned_at timestamptz not null default now(),
  event_key text not null,
  event_date date,
  event_time text,
  starts_at timestamptz,
  minutes_to_start int,
  event_status text,
  match_name text,
  player1 text,
  player2 text,
  tour text,
  tournament_group text,
  tournament_name text,
  market_name text default 'Correct Score 1st Half',
  strategy_lane text not null,
  public_signal_name text,
  access text not null,
  score_cluster text,
  public_target text,
  internal_bookmaker text,
  trigger_score text,
  trigger_odds numeric,
  score_odds_json jsonb,
  grouped_odds numeric,
  break_even_hit_rate numeric,
  historical_hit_rate numeric,
  historical_roi numeric,
  historical_sample int,
  model_edge_vs_breakeven numeric,
  public_tier text,
  signal_quality numeric,
  status text default 'open',
  first_set_score text,
  settled_win boolean,
  settled_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists live_signals_event_key_idx on public.live_signals(event_key);
create index if not exists live_signals_event_date_idx on public.live_signals(event_date);
create index if not exists live_signals_status_idx on public.live_signals(status);
create index if not exists live_signals_strategy_lane_idx on public.live_signals(strategy_lane);

create table if not exists public.telegram_signal_deliveries (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.live_signals(id) on delete cascade,
  signal_key text not null,
  room_key text not null,
  telegram_chat_id text,
  telegram_message_id text,
  sent_at timestamptz default now(),
  sent_ok boolean default false,
  skipped_duplicate boolean default false,
  error_json jsonb,
  message_preview text,
  created_at timestamptz default now(),
  unique(signal_id, room_key)
);

create index if not exists telegram_signal_deliveries_signal_key_idx on public.telegram_signal_deliveries(signal_key);
create index if not exists telegram_signal_deliveries_room_key_idx on public.telegram_signal_deliveries(room_key);

create table if not exists public.signal_results_daily (
  id uuid primary key default gen_random_uuid(),
  result_date date not null,
  room_key text not null,
  strategy_lane text,
  bets int default 0,
  wins int default 0,
  losses int default 0,
  hit_rate numeric,
  avg_odds numeric,
  flat_roi numeric,
  profit_units numeric,
  created_at timestamptz default now(),
  unique(result_date, room_key, strategy_lane)
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique,
  telegram_username text,
  tier text default 'free',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  tier text not null,
  status text default 'active',
  provider text default 'telegram_stars',
  provider_payment_id text,
  started_at timestamptz default now(),
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- Service role key is used by GitHub Actions; RLS can stay enabled later for app-facing anon access.
