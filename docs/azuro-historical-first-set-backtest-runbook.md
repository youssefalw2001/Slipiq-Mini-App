# Azuro Historical First-Set Subgraph Backtest Runbook

This runbook covers the historical, block-pinned Azuro data-feed backtest lane.

It is SAFE MODE only:

- No wallet access
- No private keys
- No signing
- No order submission
- No live staking

## Why this exists

The goal is to answer one historical question:

> At the exact second a First Set Lab signal fired, did Azuro / DGbet expose the same tennis first-set correct-score market, with the required score outcomes, odds, and any available liquidity / virtual-funds fields?

This is a historical availability and price-reconstruction test. It is not a model change and not a betting recommendation.

## Files

- Script: `scripts/backtest-azuro-historical-first-set-subgraph.py`
- Workflow: `.github/workflows/azuro-historical-first-set-subgraph-backtest.yml`
- Supabase table: `public.azuro_historical_backtest_v1`
- Migration: `supabase/migrations/20260528194500_create_azuro_historical_backtest_v1.sql`

## Supabase table security

The table is internal and service-role only:

- RLS enabled
- No anon grants
- No authenticated grants
- Service role may select / insert / update

Do not make this table public. It can contain raw historical market responses, signal IDs, and internal baseline odds.

## Required inputs

The GitHub workflow can read signals from Supabase by default. It uses:

```txt
source_view = proof_vault_recent_receipts_v2_protected
```

Required GitHub secrets:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Required workflow input:

```txt
blocks_subgraph_url
```

The blocks subgraph URL must match the same chain as the Azuro data-feed subgraph. Without it, the script cannot convert `signal_timestamp` to a historical block number.

## Default Azuro data-feed subgraph

The default is Polygon data-feed:

```txt
https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon
```

Other chains can be tested by changing `subgraph_url` and using a matching `blocks_subgraph_url`.

## How the script works

For every alert:

1. Load alert fields from Supabase or CSV.
2. Parse players from `match_name` when explicit `player_one/player_two` are absent.
3. Use `signal_timestamp` to find the closest historical block from the configured blocks subgraph.
4. Query Azuro data-feed games pinned to that block:

```graphql
query HistoricalGames($from: BigInt!, $to: BigInt!, $first: Int!, $block: Int!) {
  games(first: $first, where: { startsAt_gte: $from, startsAt_lte: $to }, block: { number: $block }) {
    id
    gameId
    title
    startsAt
    conditions { ... }
  }
}
```

5. Match player names and date window to a unique Azuro game candidate.
6. Re-query that game at the same block.
7. Isolate the First Set Correct Score market.
8. Extract requested score outcomes.
9. Pull odds and virtual-funds-like fields if the data-feed schema exposes them.
10. Compute Azuro grouped odds and compare to baseline grouped odds.
11. Output CSV, JSON, sample GraphQL queries, and optional Supabase rows.

## Decision labels

- `AVAILABLE`: historical game, market, target score outcomes, and odds were found at the pinned block.
- `BLOCK_NOT_FOUND`: the timestamp could not be mapped to a block.
- `GAME_NOT_FOUND`: no Azuro game matched the players/date at that historical block.
- `MARKET_NOT_SUPPORTED_BY_AZURO_PROVIDER`: game existed, but First Set Correct Score did not exist at that block.
- `SCORE_MISSING`: market existed, but one or more required score outcomes were absent.
- `ODDS_MISSING`: outcomes existed, but odds were unavailable or unparseable.
- `API_ERROR`: GraphQL/Supabase/API error.

## Input CSV format

Optional CSV columns:

```txt
player_one
player_two
match_date
signal_timestamp
target_market
target_scores
baseline_grouped_odds
baseline_score_odds_json
signal_id
signal_key
match_name
strategy_lane
```

`target_scores` can be JSON or comma-separated:

```txt
["6:2", "6:3", "6:4"]
```

or:

```txt
6:2,6:3,6:4
```

If `strategy_lane` is present and matches the locked First Set Lab lanes, the script uses the locked Protected 3 score group automatically.

## Run from GitHub Actions

1. Open GitHub Actions.
2. Select `Azuro Historical First Set Subgraph Backtest`.
3. Click `Run workflow`.
4. Provide `blocks_subgraph_url` for the same chain as `subgraph_url`.
5. Keep defaults for a first run.

Default inputs:

```txt
source_view = proof_vault_recent_receipts_v2_protected
limit = 50
subgraph_url = https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon
chain_id = polygon
block_window_seconds = 900
match_window_hours = 36
games_first = 200
write_supabase = true
```

## Output artifacts

The workflow uploads:

```txt
azuro-historical-first-set-backtest.zip
azuro_historical_first_set_backtest.csv
azuro_historical_first_set_backtest.json
azuro_historical_first_set_backtest_summary.json
sample_time_travel_queries.graphql
```

If `write_supabase=true`, rows are inserted into:

```txt
public.azuro_historical_backtest_v1
```

## Interpretation

Use this as an execution venue viability test:

- Many `AVAILABLE` rows: Azuro historically carried the market often enough to study pricing.
- Many `MARKET_NOT_SUPPORTED_BY_AZURO_PROVIDER` rows: DGbet/Azuro likely lacked the first-set exact-score sheet at those moments.
- Many `SCORE_MISSING` rows: high-cardinality coverage was incomplete.
- Many `ODDS_MISSING` rows: schema/odds field mapping needs adjustment or historical odds were not stored.
- Many `BLOCK_NOT_FOUND` rows: blocks subgraph URL or timestamp mapping is wrong.

Do not use this to change the locked staking model. It only answers whether Azuro/DGbet was historically a viable venue or line-check source.
