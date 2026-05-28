# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

This is not a normal tipster project. It is a live market-scanning, proof-tracked, research-backed tennis first-set exact-score system with Supabase proof, API-Tennis warehouse backtests, Telegram delivery, and an Azuro/DGPredict Web3 execution-audit layer.

```txt
Core niche:
Tennis first-set exact-score clusters

Main baseline book:
Bet365

Current best execution research path:
Azuro / DGPredict Web3 odds + liquidity audit, then semi-auto wallet-confirmed execution

Product engine:
Live scanner + Supabase proof vault + Telegram delivery + API-Tennis warehouse + historical/reality backtests + Azuro execution audit
```

---

# Read This First: Current State

The project is currently locked around one active live model and one silent high-upside tracker.

Do **not** randomly change strategy rules, mix model buckets, or promote a research lane because of one hot day.

## Active Live / Personal / VIP Model

```txt
OPTIMIZED VIP PROTECTED 3
```

This is the model to stake/post/live-track right now.

Lanes:

```txt
- CORE_P1_ATP_GS_BET365
- CORE_P2_GS_REVERSE_STRETCH_BET365
- RESEARCH_P2_GS_26_46_BET365
- VIP_P2_V3_SHAPE
```

Protected 3 score groups:

```txt
Core:
6:2 / 6:3 / 6:4

Reverse:
2:6 / 4:6 / 5:7

Research P2:
2:6 / 4:6 / 5:7

V3:
3:6 / 4:6 / 5:7
```

Current live reason:

```txt
Protected 3 is winning the current live-forward sample better than Gate-2.
```

## Silent Tracker / High-Upside Candidate

```txt
OPTIMIZED VIP GATE-2
```

Gate-2 is historically stronger but is **not** the active live staking model yet.

Gate-2 score groups:

```txt
Core:
6:3 / 6:4

Reverse:
2:6 / 4:6

Research P2:
2:6 / 4:6

V3:
4:6 / 5:7
```

Operating rule:

```txt
Track Gate-2 silently.
Promote only if it beats Protected 3 after another 100-200 live settled rows.
```

## Public Main

```txt
PUBLIC MAIN = Core + Reverse only
```

Public Main lanes:

```txt
- CORE_P1_ATP_GS_BET365
- CORE_P2_GS_REVERSE_STRETCH_BET365
```

Use Public Main for conservative public proof and clean external claims.

Do **not** mix VIP/research lanes, Mirror, Core Cluster Plus, receipt odds, or Azuro-only simulations into Public Main ROI.

## Watchlist

```txt
WATCHLIST = Mirror only
```

Lane:

```txt
CORE_P1_MIRROR_WTA_OTHER
```

Mirror is not active staking. Historical parity showed it added a lot of volume with almost no edge.

## Removed

```txt
REMOVED = Core Cluster Plus
```

Lane:

```txt
VIP_P1_ATP_GS_MULTI
```

Core Cluster Plus should stay removed unless a fresh historical backtest and live-forward test prove otherwise.

---

# Exact Lane Definitions and Target Odds

These are the current known strategy lanes. Keep these definitions stable unless a new backtest explicitly changes them.

## Core Cluster

```txt
Lane key:
CORE_P1_ATP_GS_BET365

Public name:
Core Cluster

Book:
Bet365

Tour filter:
ATP

Tournament filter:
Grand Slam

Gate-2 scores:
6:3 / 6:4

Protected 3 scores:
6:2 / 6:3 / 6:4

Trigger score:
6:4

Target trigger odds range:
6:4 odds from 5.00 to 6.25

Minimum Gate-2 grouped odds:
2.50

Role:
Public Main + Optimized VIP
```

## Reverse Stretch Cluster

```txt
Lane key:
CORE_P2_GS_REVERSE_STRETCH_BET365

Public name:
Reverse Stretch Cluster

Book:
Bet365

Tournament filter:
Grand Slam

Gate-2 scores:
2:6 / 4:6

Protected 3 scores:
2:6 / 4:6 / 5:7

Target Gate-2 grouped odds range:
2.50 to 4.50

Required market skew:
EXTREME

Role:
Public Main + Optimized VIP
```

## Research P2 GS Sniper

```txt
Lane key:
RESEARCH_P2_GS_26_46_BET365

Public name:
Research P2 GS Sniper

Book:
Bet365

Tournament filter:
Grand Slam

Gate-2 scores:
2:6 / 4:6

Protected 3 scores:
2:6 / 4:6 / 5:7

Target Gate-2 grouped odds range:
2.50 to 4.50

Required market skew:
EXTREME

Role:
Optimized VIP only
```

## V3 Cluster

```txt
Lane key:
VIP_P2_V3_SHAPE

Public name:
V3 Cluster

Book:
Bet365 / 1xBet / 10Bet depending on scanner availability

Gate-2 scores:
4:6 / 5:7

Protected 3 scores:
3:6 / 4:6 / 5:7

Trigger score:
4:6

Target trigger odds range:
4:6 odds from 6.25 to 6.99

Minimum grouped odds:
3.50

Role:
Optimized VIP only
```

## Mirror Cluster

```txt
Lane key:
CORE_P1_MIRROR_WTA_OTHER

Public name:
Mirror Cluster

Protected group:
6:3 / 6:4 / 7:5

Role:
Watchlist only
```

## Core Cluster Plus

```txt
Lane key:
VIP_P1_ATP_GS_MULTI

Public name:
Core Cluster Plus

Role:
Removed / do not stake
```

---

# How the Bets Work

A grouped score signal is **not** a parlay.

For a signal such as:

```txt
6:2 / 6:3 / 6:4
```

place separate exact-score bets on each score.

Grouped decimal odds:

```txt
grouped_decimal_odds = 1 / ((1 / score_1_odds) + (1 / score_2_odds) + ...)
```

Profit units:

```txt
If actual first-set score is inside the group:
profit_units = grouped_decimal_odds - 1

If actual first-set score is outside the group:
profit_units = -1
```

Payout-balanced staking:

```txt
target_return = total_group_stake / sum(1 / odds)
stake_for_score = target_return / score_odds
```

Example:

```txt
Total group stake:
$60

Odds:
6:2 = 10.00
6:3 = 6.50
6:4 = 6.00

Goal:
Split the $60 so any winning score returns roughly the same payout.
```

Never mix receipt odds with grouped odds.

```txt
Grouped odds = executable strategy proof.
Receipt odds = exact landed score recap lens only.
```

---

# Current Results

## Current Live Sample

Current live sample is around the mid-60s settled rows depending on latest settlement.

Recent checked optimized VIP live sample:

```txt
62 optimized VIP settled rows
24 wins / 38 losses
38.71% hit rate
+5.96 grouped units
+25.96 VIP total units
```

Current live drawdown/streak context:

```txt
A recent optimized VIP loss streak reached 9 settled signal rows.
This is uncomfortable but normal for a ~39-41% hit-rate exact-score system.
```

Earlier live snapshot:

```txt
Optimized VIP Protected 3:
56 optimized live rows
about +33.46u VIP total

Optimized VIP Gate-2 on same rows:
about +20.02u with boosters
```

Interpretation:

```txt
Current live sample favors Protected 3.
Do not switch active live staking to Gate-2 yet.
```

## Optimized Profitable Lanes Backtest

Best clean historical lane combo:

```txt
Core + Reverse + Research P2 + V3
Exclude Mirror
Exclude Core Cluster Plus
```

Result:

```txt
511 rows
214W / 297L
41.88% hit rate
+86.45u
16.92% ROI
```

Compounding from $3,000:

```txt
5% risk: about $64,181
7% risk: about $111,459 with very large drawdown
```

## Protected Score Expansion Backtest

This compared:

```txt
Gate-2 vs Protected 3 vs Wide 4
```

Optimized VIP Gate-2 historical:

```txt
610 bets
35.08% hit rate
+142.87u
23.42% ROI
```

Optimized VIP Protected 3 historical:

```txt
610 bets
40.98% hit rate
+90.78u
14.88% ROI
```

Interpretation:

```txt
Gate-2 has higher long-run upside but lower hit rate.
Protected 3 is smoother and currently better live.
```

## Reality Check 100-300 Signals

Workflow/script:

```txt
.github/workflows/reality-check-100-300-signals.yml
scripts/reality-check-100-300-signals.mjs
```

Protected 3 Optimized VIP rolling windows:

```txt
100 signals: 94.91% profitable, median +16.83u, worst -10.58u
200 signals: 100% profitable, median +35.65u, worst +3.33u
300 signals: 100% profitable, median +52.52u, worst +16.51u
```

Gate-2 Optimized VIP rolling windows:

```txt
100 signals: 99.22% profitable, median +22.98u, worst -2.10u
200 signals: 100% profitable, median +55.09u, worst +12.86u
300 signals: 100% profitable, median +82.15u, worst +37.46u
```

Monte Carlo at 5% risk from $3,000:

```txt
Protected 3 Optimized VIP:
100 signals median: about $4,937
200 signals median: about $8,035
300 signals median: about $13,158

Gate-2 tracker:
100 signals median: about $6,760
200 signals median: about $14,829
300 signals median: about $33,378
```

---

# API-Tennis Warehouse and Backtesting System

The historical testing system uses API-Tennis warehouse artifacts instead of pulling live data every time.

## Full Historical Warehouse

```txt
.github/workflows/api-tennis-full-historical-odds-warehouse.yml
```

Purpose:

```txt
Pull API-Tennis fixture/odds history into reusable warehouse artifacts.
```

Important combined warehouse file:

```txt
first_set_correct_score_wide_combined.csv
```

This file is used by downstream backtests for first-set correct-score markets.

## Live Scanner Parity Backtest

```txt
.github/workflows/live-scanner-parity-backtest.yml
scripts/backtest-live-scanner-parity-from-warehouse.mjs
```

Purpose:

```txt
Rebuild historical candidates using live-scanner-style lanes.
Shows why live volume can be much higher than strict Public Main historical count.
```

Finding:

```txt
Broad live scanner volume is real, but extra volume is not automatically better.
Mirror added many rows with almost no edge.
Core Cluster Plus was negative.
```

## Optimized Profitable Lanes Backtest

```txt
.github/workflows/optimized-profitable-lanes-backtest.yml
scripts/optimize-live-scanner-profitable-lanes.mjs
```

Purpose:

```txt
Test which lane combinations actually improve units/ROI.
```

Winner:

```txt
Core + Reverse + Research P2 + V3
No Mirror
No Core Cluster Plus
```

## Protected Score Expansion Backtest

```txt
.github/workflows/protected-score-expansion-backtest.yml
scripts/backtest-protected-score-expansion-from-warehouse.mjs
```

Purpose:

```txt
Compare Gate-2, Protected 3, and Wide 4 score groups.
```

Finding:

```txt
Gate-2 is historically highest upside.
Protected 3 is smoother and currently better live.
Wide 4 improves hit rate but dilutes payout too much.
```

## Reality Check 100-300 Signals

```txt
.github/workflows/reality-check-100-300-signals.yml
scripts/reality-check-100-300-signals.mjs
```

Purpose:

```txt
Rolling 100/200/300 signal windows + Monte Carlo.
Closest-to-reality test before waiting for future live rows.
```

---

# Supabase Source of Truth

Supabase project:

```txt
qjvpkkcbscsypymxyker
```

Always inspect the schema before editing queries.

## Locked Proof Views

```txt
public.proof_vault_locked_model_rows_v1
public.proof_vault_locked_model_summary_v1
public.proof_vault_locked_model_5pct_compound_v1
```

Use these for the current proof page and locked model comparison.

## VIP Booster Views

```txt
public.proof_vault_vip_pocket_booster_rows_v1
public.proof_vault_vip_pocket_booster_summary_v1
public.proof_vault_vip_pocket_booster_5pct_compound_v1
```

Use these for protected rows plus VIP pocket booster units.

## Legacy Protected Proof Views

```txt
public.proof_vault_live_summary_v2_protected
public.proof_vault_daily_summary_v2_protected
public.proof_vault_recent_receipts_v2_protected
```

Use only when needed for legacy proof/receipt display.

## Important Columns

Common columns to inspect:

```txt
id
signal_key
event_date
settled_at
updated_at
scanned_at
match_name
strategy_lane
public_signal_name
score_cluster
score_odds_json
first_set_score
display_status
status
grouped_profit_units_calc
vip_pocket_total_profit_units
vip_pocket_total_staked_units
vip_pocket_booster_profit_units
```

Sanity checks:

```txt
1. Active Optimized VIP rows must only include:
   CORE_P1_ATP_GS_BET365
   CORE_P2_GS_REVERSE_STRETCH_BET365
   RESEARCH_P2_GS_26_46_BET365
   VIP_P2_V3_SHAPE

2. Mirror must not be counted in Optimized VIP.

3. Core Cluster Plus must not be counted in Optimized VIP.

4. WIN/LOSS must match actual first_set_score inside/outside the expected score group.

5. score_odds_json must contain all expected target score odds.
```

Example expected score group SQL logic:

```sql
case
  when strategy_lane = 'CORE_P1_ATP_GS_BET365' then array['6:2','6:3','6:4']
  when strategy_lane = 'CORE_P2_GS_REVERSE_STRETCH_BET365' then array['2:6','4:6','5:7']
  when strategy_lane = 'RESEARCH_P2_GS_26_46_BET365' then array['2:6','4:6','5:7']
  when strategy_lane = 'VIP_P2_V3_SHAPE' then array['3:6','4:6','5:7']
end
```

---

# Website / Proof Page

Current proof page:

```txt
docs/proof.html
```

Current design:

```txt
Show only the best active live model:
Optimized VIP Protected 3
Core + Reverse + Research P2 + V3
```

The page should not show all versions publicly.

Current settled bets UI:

```txt
Daily accordion ledger
One row per date
Click arrow/date to expand all bets for that date
```

Date row shows:

```txt
settled count
wins/losses
units
cash P/L
risked amount
last balance
```

Expanded bet row shows:

```txt
match
lane
score group
actual first-set score
WIN/LOSS
units
risk
P/L
balance after
```

Recent proof page commit:

```txt
9c26b629fe21eeda9bf25f079462cc21aed208f6
```

---

# Azuro / DGPredict Web3 Execution Path

We found that Azuro/DGPredict may make semi-automated execution possible.

This is now the best new execution path to validate, but do **not** jump straight to full auto-betting.

Correct framing:

```txt
Azuro/DGPredict is the new best execution-research path.
It must prove market coverage, score availability, liquidity, odds quality, safe wallet flow, and settlement reliability.
```

## Current Azuro Components

Workflow:

```txt
.github/workflows/azuro-dgpredict-coverage-audit.yml
```

Script:

```txt
scripts/audit-azuro-dgpredict-first-set-score-coverage.mjs
```

Supabase tables:

```txt
public.azuro_execution_audit_v1
public.azuro_bet_orders_v1
```

The current auditor is SAFE MODE ONLY:

```txt
- No bets placed
- No wallet signing
- No real money movement
```

It checks:

```txt
- Matching Azuro/DGPredict tennis game
- First-set correct-score market
- Target score outcome IDs
- Score odds
- Max bet
- Max payout
- Azuro grouped odds
- Edge vs baseline
- Max executable grouped stake
```

Decision labels:

```txt
BETTABLE
MISSING_GAME
MISSING_MARKET
MISSING_SCORE
LOW_LIMIT
BAD_ODDS
API_ERROR
```

## Azuro Grouped Stake Logic

For each target score:

```txt
max_return_by_bet = maxBet_i * odds_i
max_return_by_payout = maxPayout_i
score_return_cap = min(max_return_by_bet, max_return_by_payout)
```

For the full group:

```txt
group_return_cap = min(score_return_cap across all target scores)
max_group_stake = group_return_cap * sum(1 / odds_i)
```

This tells us the true maximum executable group stake.

## Azuro Execution Phases

Phase 1:

```txt
Coverage/odds/liquidity auditor only.
No wallet.
No money.
```

Phase 2:

```txt
Micro-stake testing.
Manual wallet confirmation.
Track all receipts in Supabase.
```

Phase 3:

```txt
Semi-auto assistant.
Signal fires -> Azuro odds check -> stake splitter -> user confirms wallet transaction -> Supabase stores order/tx -> settlement tracker.
```

Phase 4:

```txt
Full auto only if legal, allowed, technically safe, and hard risk limits are enforced.
```

Never bypass KYC, geo-restrictions, sportsbook terms, or legal rules.
Never store private keys insecurely.

---

# Bankroll / Risk Guidance

Research only. Not financial advice.

Risk tiers:

```txt
1% = safer live validation
2% = serious controlled
3% = aggressive
5% = maximum aggressive
7% = too aggressive for normal use
```

For a $3,000 bankroll:

```txt
1% unit = $30
2% unit = $60
3% unit = $90
5% unit = $150
```

Practical plan:

```txt
Start 1%-2% until next 100 live settled rows.
Move to 3% only if still positive.
Use 5% only after accepting large drawdowns.
```

---

# Promotion Rules

A model or lane can be promoted only if it passes:

```txt
1. Historical warehouse backtest positive
2. Reality check positive over 100/200/300 windows
3. Live-forward 100+ settled rows positive
4. ROI beats or drawdown improves current active model
5. No receipt-unit mixing
6. No hidden watchlist/removed lanes in active bucket
```

Current statuses:

```txt
Stake/post now:
Optimized VIP Protected 3

Track silently:
Optimized VIP Gate-2

Public proof:
Core + Reverse only

Watchlist:
Mirror

Removed:
Core Cluster Plus

New execution path:
Azuro/DGPredict audit -> micro-stake -> semi-auto wallet-confirmed execution
```

---

# Operator Do / Do Not

## Do

```txt
- Keep Public Main separate from Optimized VIP.
- Keep Protected 3 separate from Gate-2.
- Keep Mirror watchlist only.
- Keep Core Cluster Plus removed.
- Use grouped executable odds for proof.
- Use receipt odds only for recap lens.
- Use API-Tennis warehouse artifacts for historical tests.
- Use Supabase views for live proof.
- Check grading and missing odds before making claims.
- Treat Azuro as execution research until coverage/liquidity is proven.
```

## Do Not

```txt
- Do not mix all lanes into one headline ROI.
- Do not switch to Gate-2 just because historical upside is higher.
- Do not promote Mirror because of a tiny hot sample.
- Do not re-enable Core Cluster Plus without testing.
- Do not call it guaranteed.
- Do not call it free money.
- Do not call it a cheat code publicly.
- Do not recommend unsafe auto-betting or insecure wallet/private-key handling.
```

---

# Best Current Next Steps

For any AI/dev continuing the project:

```txt
1. Inspect README first.
2. Inspect docs/proof.html.
3. Query Supabase locked views.
4. Verify latest live settled rows and loss streaks.
5. Run Azuro/DGPredict Coverage Audit.
6. Analyze whether Azuro is BETTABLE, line-check only, missing markets, or not usable yet.
7. If Azuro coverage is good, build the hybrid Azuro-vs-baseline backtest:
   - Baseline Protected 3
   - Azuro-only Protected 3
   - Hybrid Protected 3
   - Baseline Gate-2
   - Azuro-only Gate-2
   - Hybrid Gate-2
8. Simulate 100/200/300/400/500 future settled rows from $3,000 at 3% and 5% compounded risk.
```

The new most important research question:

```txt
Can Azuro/DGPredict execute First Set Lab signals with equal/better grouped odds, enough liquidity, and safe wallet-confirmed flow?
```

If yes, Azuro becomes the best execution path.
If no, keep Bet365 baseline/manual execution and use Azuro as a line checker only.
