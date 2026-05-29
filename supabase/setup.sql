-- First Set Lab / SlipIQ
-- Supabase setup for Azuro / DGPredict execution audit.
-- Safe mode: schema and views only. No betting execution.

begin;

create table if not exists public.azuro_execution_audit_v1 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'azuro_backend_api',
  run_id text,
  signal_id uuid,
  signal_key text,
  match_name text,
  event_date date,
  starts_at timestamptz,
  strategy_lane text,
  public_signal_name text,
  model_bucket text,
  target_scores text[] not null default '{}',
  baseline_grouped_odds numeric,
  azuro_game_id text,
  azuro_game_title text,
  azuro_league text,
  azuro_sport text,
  azuro_condition_id text,
  azuro_market_title text,
  score_outcomes_json jsonb not null default '{}'::jsonb,
  azuro_grouped_odds numeric,
  edge_vs_baseline numeric,
  min_score_max_bet numeric,
  min_score_max_payout numeric,
  max_group_stake numeric,
  gas_estimate_json jsonb,
  fee_estimate_json jsonb,
  decision text not null default 'UNTESTED',
  reason text,
  raw_match_json jsonb,
  raw_conditions_json jsonb,
  raw_calculations_json jsonb
);

create table if not exists public.azuro_bet_orders_v1 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  signal_id uuid,
  audit_id uuid references public.azuro_execution_audit_v1(id) on delete set null,
  score text not null,
  condition_id text,
  outcome_id text,
  stake numeric,
  odds numeric,
  min_odds numeric,
  max_bet numeric,
  max_payout numeric,
  order_id text,
  tx_hash text,
  status text not null default 'PLANNED',
  payout numeric,
  raw_order_json jsonb,
  raw_status_json jsonb
);

create table if not exists public.azuro_historical_backtest_v1 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id text,
  model text,
  event_date date,
  match_name text,
  strategy_lane text,
  platform_used text,
  target_scores text[],
  actual_first_set_score text,
  baseline_grouped_odds numeric,
  azuro_grouped_odds numeric,
  grouped_odds_used numeric,
  edge_vs_baseline numeric,
  result text,
  profit_units numeric,
  bankroll_after_3pct numeric,
  bankroll_after_5pct numeric,
  raw_json jsonb
);

create index if not exists azuro_execution_audit_v1_signal_idx on public.azuro_execution_audit_v1(signal_id);
create index if not exists azuro_execution_audit_v1_created_idx on public.azuro_execution_audit_v1(created_at desc);
create index if not exists azuro_execution_audit_v1_decision_idx on public.azuro_execution_audit_v1(decision);
create index if not exists azuro_execution_audit_v1_strategy_lane_idx on public.azuro_execution_audit_v1(strategy_lane);
create index if not exists azuro_bet_orders_v1_signal_idx on public.azuro_bet_orders_v1(signal_id);
create index if not exists azuro_bet_orders_v1_status_idx on public.azuro_bet_orders_v1(status);

create or replace view public.azuro_execution_latest_v1 as
with ranked as (
  select
    a.*,
    row_number() over (
      partition by coalesce(a.signal_id::text, nullif(a.signal_key, ''), concat_ws('|', a.event_date::text, a.match_name, a.strategy_lane, a.target_scores::text))
      order by a.created_at desc, a.id desc
    ) as rn
  from public.azuro_execution_audit_v1 a
)
select * from ranked where rn = 1;

create or replace view public.azuro_execution_summary_v1 as
select
  count(*)::integer as latest_signals,
  count(*) filter (where decision = 'BETTABLE')::integer as bettable_signals,
  count(*) filter (where decision = 'MISSING_GAME')::integer as missing_game_signals,
  count(*) filter (where decision = 'MISSING_MARKET')::integer as missing_market_signals,
  count(*) filter (where decision = 'MISSING_SCORE')::integer as missing_score_signals,
  count(*) filter (where decision = 'LOW_LIMIT')::integer as low_limit_signals,
  count(*) filter (where decision = 'BAD_ODDS')::integer as bad_odds_signals,
  count(*) filter (where decision = 'API_ERROR')::integer as api_error_signals,
  round((100.0 * count(*) filter (where decision = 'BETTABLE') / nullif(count(*), 0))::numeric, 2) as coverage_rate_pct,
  round(avg(azuro_grouped_odds)::numeric, 6) as avg_azuro_grouped_odds,
  round(avg(baseline_grouped_odds)::numeric, 6) as avg_baseline_grouped_odds,
  round(avg(edge_vs_baseline)::numeric, 6) as avg_edge_vs_baseline,
  round(percentile_cont(0.5) within group (order by max_group_stake)::numeric, 2) as median_max_group_stake,
  round(avg(max_group_stake)::numeric, 2) as avg_max_group_stake,
  max(created_at) as refreshed_at
from public.azuro_execution_latest_v1;

create or replace view public.azuro_execution_lane_summary_v1 as
select
  strategy_lane,
  public_signal_name,
  count(*)::integer as latest_signals,
  count(*) filter (where decision = 'BETTABLE')::integer as bettable_signals,
  count(*) filter (where decision = 'MISSING_GAME')::integer as missing_game_signals,
  count(*) filter (where decision = 'MISSING_MARKET')::integer as missing_market_signals,
  count(*) filter (where decision = 'MISSING_SCORE')::integer as missing_score_signals,
  count(*) filter (where decision = 'LOW_LIMIT')::integer as low_limit_signals,
  count(*) filter (where decision = 'BAD_ODDS')::integer as bad_odds_signals,
  count(*) filter (where decision = 'API_ERROR')::integer as api_error_signals,
  round((100.0 * count(*) filter (where decision = 'BETTABLE') / nullif(count(*), 0))::numeric, 2) as coverage_rate_pct,
  round(avg(azuro_grouped_odds)::numeric, 6) as avg_azuro_grouped_odds,
  round(avg(baseline_grouped_odds)::numeric, 6) as avg_baseline_grouped_odds,
  round(avg(edge_vs_baseline)::numeric, 6) as avg_edge_vs_baseline,
  round(percentile_cont(0.5) within group (order by max_group_stake)::numeric, 2) as median_max_group_stake,
  max(created_at) as refreshed_at
from public.azuro_execution_latest_v1
group by strategy_lane, public_signal_name
order by latest_signals desc, strategy_lane;

create or replace view public.azuro_execution_bettable_signals_v1 as
select *
from public.azuro_execution_latest_v1
where decision = 'BETTABLE'
order by created_at desc;

grant select on public.azuro_execution_audit_v1 to anon, authenticated;
grant select on public.azuro_bet_orders_v1 to anon, authenticated;
grant select on public.azuro_historical_backtest_v1 to anon, authenticated;
grant select on public.azuro_execution_latest_v1 to anon, authenticated;
grant select on public.azuro_execution_summary_v1 to anon, authenticated;
grant select on public.azuro_execution_lane_summary_v1 to anon, authenticated;
grant select on public.azuro_execution_bettable_signals_v1 to anon, authenticated;

commit;
