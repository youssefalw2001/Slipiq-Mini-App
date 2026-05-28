# Onchainfeed / Azuro First-Set Score Audit Runbook

This runbook is for the SAFE MODE execution-readiness audit only.

It does not sign EIP-712 payloads, does not submit orders, does not read private keys, and does not move funds.

## Purpose

The workflow checks whether First Set Lab's locked Optimized VIP Protected 3 signals can be mapped to Onchainfeed / Azuro tennis first-set correct-score markets with usable odds and enough liquidity.

The active audit lanes are fixed to the current locked model:

- `CORE_P1_ATP_GS_BET365` -> `6:2 / 6:3 / 6:4`
- `CORE_P2_GS_REVERSE_STRETCH_BET365` -> `2:6 / 4:6 / 5:7`
- `RESEARCH_P2_GS_26_46_BET365` -> `2:6 / 4:6 / 5:7`
- `VIP_P2_V3_SHAPE` -> `3:6 / 4:6 / 5:7`

Mirror and removed lanes are intentionally excluded.

## Files

- Script: `scripts/audit-onchainfeed-first-set-score-coverage.mjs`
- Workflow: `.github/workflows/onchainfeed-first-set-score-audit.yml`
- Audit table: `public.azuro_execution_audit_v1`
- Order table: `public.azuro_bet_orders_v1`
- Hardening migration: `supabase/migrations/20260528193000_harden_azuro_execution_tables.sql`

## Required GitHub secrets

The workflow requires:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not add wallet private keys to this workflow. This audit phase does not need them.

## How to run

1. Go to GitHub Actions.
2. Select `Onchainfeed First Set Score Audit`.
3. Click `Run workflow`.
4. Keep defaults unless testing a different Azuro environment.
5. Run.

Default inputs:

```txt
azuro_api_base = https://api.onchainfeed.org/api/v1/public
environment = PolygonUSDT
app_id = dgpredict
limit = 50
min_group_stake = 5
min_edge = 0
stake_probe = 1
token_decimals = 6
write_supabase = true
```

## Output artifacts

The workflow uploads:

- `onchainfeed-first-set-score-audit.zip`
- `onchainfeed_first_set_score_report.md`
- `onchainfeed_first_set_score_summary.json`
- `onchainfeed_first_set_score_audit.csv`
- `onchainfeed_first_set_score_audit.json`

If `write_supabase=true`, rows are inserted into `public.azuro_execution_audit_v1`.

## Decision labels

- `BETTABLE`: all target scores were found and odds/liquidity checks passed configured thresholds.
- `MISSING_GAME`: no matching Onchainfeed tennis game was found.
- `MISSING_MARKET`: a game was found, but no first-set correct-score market was found.
- `MISSING_SCORE`: the market exists, but one or more target scores are absent.
- `LOW_LIMIT`: liquidity or max grouped stake is below the configured threshold.
- `BAD_ODDS`: grouped odds are missing or below configured edge requirements.
- `API_ERROR`: API call or parsing failed.

`BETTABLE` is not a betting recommendation. It only means the audit found enough market coverage to consider a later manual execution phase.

## Interpretation

Use this hierarchy:

1. If most rows are `MISSING_GAME`, Onchainfeed / DGbet coverage is not broad enough for this use case yet.
2. If games are found but most rows are `MISSING_MARKET`, first-set correct-score markets are missing or not exposed.
3. If markets exist but rows are `MISSING_SCORE`, score-cardinality coverage is incomplete.
4. If rows are mostly `LOW_LIMIT`, Azuro can be a line checker but not a meaningful execution venue yet.
5. If rows are `BETTABLE`, manually inspect raw outcomes and limits before considering micro-stake tests.

## Safety rules

- No automatic betting from this workflow.
- No EIP-712 signing in this workflow.
- No private keys in GitHub Actions.
- No wallet transaction without manual confirmation in a separate phase.
- No bypassing sportsbook, jurisdiction, KYC, wallet, or platform restrictions.
- Keep public proof, Optimized VIP proof, and execution-audit rows separate.

## Database security

The Azuro tables should be service-role only:

- RLS enabled on `public.azuro_execution_audit_v1`
- RLS enabled on `public.azuro_bet_orders_v1`
- No anon privileges
- No authenticated privileges
- Service role may select/insert/update

This was applied live and tracked in the migration file listed above.
