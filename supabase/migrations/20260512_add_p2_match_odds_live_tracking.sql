-- SlipIQ First Set Lab
-- Adds Player 1/Player 2 match-winner odds capture fields to live V3 exact-score
-- observations and grouped Player 2 & 9-12 tracking rows.
--
-- Purpose:
--   Compare live settled results for:
--   1. V3 all
--   2. V3 + Player 2 match odds under 1.60
--   3. V3 + Player 2 match odds under 1.50
--   4. Player 2 & 9-12 grouped rows when real grouped odds are logged
--
-- Important:
--   These fields store match-winner odds for Player 2, not exact 4-6 odds and
--   not grouped Player 2 & 9-12 odds.

alter table public.private_live_observation_log
  add column if not exists player1_match_odds numeric,
  add column if not exists player2_match_odds numeric,
  add column if not exists player2_match_odds_source text,
  add column if not exists player2_match_odds_observed_at timestamp with time zone,
  add column if not exists match_odds_raw jsonb default '{}'::jsonb;

alter table public.private_live_observation_log
  add column if not exists p2_odds_under_1_60 boolean generated always as (
    player2_match_odds is not null and player2_match_odds < 1.60
  ) stored,
  add column if not exists p2_odds_under_1_50 boolean generated always as (
    player2_match_odds is not null and player2_match_odds < 1.50
  ) stored;

alter table public.private_grouped_9_12_observation_log
  add column if not exists player1_match_odds numeric,
  add column if not exists player2_match_odds numeric,
  add column if not exists player2_match_odds_source text,
  add column if not exists player2_match_odds_observed_at timestamp with time zone,
  add column if not exists match_odds_raw jsonb default '{}'::jsonb;

alter table public.private_grouped_9_12_observation_log
  add column if not exists p2_odds_under_1_60 boolean generated always as (
    player2_match_odds is not null and player2_match_odds < 1.60
  ) stored,
  add column if not exists p2_odds_under_1_50 boolean generated always as (
    player2_match_odds is not null and player2_match_odds < 1.50
  ) stored;

create index if not exists idx_private_live_observation_log_p2_match_odds
  on public.private_live_observation_log (player2_match_odds)
  where player2_match_odds is not null;

create index if not exists idx_private_live_observation_log_p2_under_flags
  on public.private_live_observation_log (p2_odds_under_1_60, p2_odds_under_1_50);

create index if not exists idx_private_grouped_9_12_p2_match_odds
  on public.private_grouped_9_12_observation_log (player2_match_odds)
  where player2_match_odds is not null;

create index if not exists idx_private_grouped_9_12_p2_under_flags
  on public.private_grouped_9_12_observation_log (p2_odds_under_1_60, p2_odds_under_1_50);

comment on column public.private_live_observation_log.player2_match_odds is
  'Player 2 match-winner odds captured at/near V3 exact 4-6 signal time. Used for V3 + P2 odds <1.60/<1.50 live splits.';

comment on column public.private_grouped_9_12_observation_log.player2_match_odds is
  'Player 2 match-winner odds captured at/near grouped Player 2 & 9-12 signal time. Used for V3 + P2 odds <1.60/<1.50 live splits.';
