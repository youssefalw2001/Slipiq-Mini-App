create table if not exists public.azuro_historical_backtest_v1 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id text not null,
  source text not null default 'azuro_historical_subgraph_backtest',
  signal_id uuid null,
  signal_key text null,
  player_one text null,
  player_two text null,
  match_name text null,
  match_date timestamptz null,
  signal_timestamp timestamptz null,
  strategy_lane text null,
  target_market text null default 'First Set Correct Score',
  target_scores text[] not null default '{}',
  baseline_grouped_odds numeric null,
  baseline_score_odds_json jsonb null,
  chain_id text null,
  subgraph_url text null,
  block_number bigint null,
  block_timestamp timestamptz null,
  block_lookup_json jsonb null,
  azuro_game_id text null,
  azuro_game_title text null,
  azuro_condition_id text null,
  azuro_market_title text null,
  market_available boolean not null default false,
  score_outcomes_json jsonb not null default '{}'::jsonb,
  azuro_grouped_odds numeric null,
  edge_vs_baseline numeric null,
  virtual_funds_json jsonb null,
  decision text not null,
  reason text null,
  raw_game_json jsonb null,
  raw_condition_json jsonb null,
  raw_block_json jsonb null
);

create index if not exists azuro_historical_backtest_v1_run_idx
  on public.azuro_historical_backtest_v1 (run_id, created_at desc);

create index if not exists azuro_historical_backtest_v1_signal_idx
  on public.azuro_historical_backtest_v1 (signal_id);

create index if not exists azuro_historical_backtest_v1_decision_idx
  on public.azuro_historical_backtest_v1 (decision);

alter table public.azuro_historical_backtest_v1 enable row level security;

revoke all privileges on table public.azuro_historical_backtest_v1 from anon;
revoke all privileges on table public.azuro_historical_backtest_v1 from authenticated;
revoke all privileges on table public.azuro_historical_backtest_v1 from public;

grant select, insert, update on table public.azuro_historical_backtest_v1 to service_role;

comment on table public.azuro_historical_backtest_v1 is 'Internal historical Azuro subgraph availability/odds/liquidity backtest rows for First Set Lab signals. Service-role only.';
