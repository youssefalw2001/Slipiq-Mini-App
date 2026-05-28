# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

It is not a traditional tipster project. It is a live market-scanning, proof-tracked, research-backed system for tennis first-set derivative markets.

```txt
Core niche:
Tennis first-set exact-score clusters

Main source book:
Bet365

Product engine:
Live scanner + Supabase proof vault + Telegram delivery + historical warehouse backtests
```

---

# Current Locked Strategy State

This is the current operating structure as of the latest live/historical research cycle.

## Public Main

```txt
PUBLIC MAIN = Core + Reverse only

Lanes:
- CORE_P1_ATP_GS_BET365
- CORE_P2_GS_REVERSE_STRETCH_BET365

Use:
- Public proof
- Clean main model reporting
- Conservative external performance claims
```

Do **not** mix VIP, research, Mirror, V3, Comfort, Over/Under, or receipt-only units into Public Main ROI.

## Optimized VIP / Personal Staking Model

```txt
OPTIMIZED VIP = Protected 3-score Core + Reverse + Research P2 + V3

Lanes:
- CORE_P1_ATP_GS_BET365
- CORE_P2_GS_REVERSE_STRETCH_BET365
- RESEARCH_P2_GS_26_46_BET365
- VIP_P2_V3_SHAPE

Current live use:
- Primary private/VIP model
- Current personal staking model
- Tracked separately from Public Main
```

## Watchlist Only

```txt
WATCHLIST = Mirror

Lane:
- CORE_P1_MIRROR_WTA_OTHER

Status:
Tracked, but not used as main staking proof.
```

Mirror can have short hot runs, but historical parity showed it added a lot of volume with very little edge. Keep it separate until it passes a new forward test.

## Removed

```txt
REMOVED = Core Cluster Plus

Lane:
- VIP_P1_ATP_GS_MULTI

Status:
Removed from active staking model.
```

Do not re-promote Core Cluster Plus without a fresh historical backtest and a live-forward test.

## Silent Tracker

```txt
SILENT TRACKER = Gate-2 version

Meaning:
Original 2-score groups only.

Status:
Historically strong, but not promoted live yet because current live rows favor Protected 3-score.
```

---

# Score Group Definitions

## Core Cluster

```txt
Lane key:
CORE_P1_ATP_GS_BET365

Bookmaker:
Bet365

Original Gate-2:
6:3 / 6:4

Protected 3-score live group:
6:2 / 6:3 / 6:4

Role:
Public Main + Optimized VIP
```

## Reverse Stretch Cluster

```txt
Lane key:
CORE_P2_GS_REVERSE_STRETCH_BET365

Bookmaker:
Bet365

Original Gate-2:
2:6 / 4:6

Protected 3-score live group:
2:6 / 4:6 / 5:7

Important filter:
market_skew_bucket = EXTREME

Role:
Public Main + Optimized VIP
```

## Research P2

```txt
Lane key:
RESEARCH_P2_GS_26_46_BET365

Bookmaker:
Bet365

Original Gate-2:
2:6 / 4:6

Protected 3-score live group:
2:6 / 4:6 / 5:7

Role:
Optimized VIP only
```

## V3 Cluster

```txt
Lane key:
VIP_P2_V3_SHAPE

Bookmaker:
Bet365 / 1xBet / 10Bet depending on scanner availability

Gate-2 tracker:
4:6 / 5:7

Protected 3-score live group:
3:6 / 4:6 / 5:7

Role:
Optimized VIP only
```

## Mirror Cluster

```txt
Lane key:
CORE_P1_MIRROR_WTA_OTHER

Protected group:
6:3 / 6:4 / 7:5

Role:
Watchlist only
```

---

# Odds Rules

## Grouped Odds

Grouped odds are the executable strategy odds for a score cluster.

```txt
grouped_decimal_odds = 1 / ((1 / score_1_odds) + (1 / score_2_odds) + ...)
```

Example:

```txt
Scores:
6:2 = 10.00
6:3 = 6.50
6:4 = 6.00

Grouped odds:
1 / ((1/10.00) + (1/6.50) + (1/6.00))
```

Grouped odds are used for:

```txt
- Real signal posting
- Main ROI tracking
- Bankroll simulations
- Parlay calculations
- Public proof model
```

## Receipt Odds

Receipt odds are the exact landed score odds after the result.

Receipt odds are useful for:

```txt
- Recap content
- Dopamine proof lens
- Showing what exact score landed
```

Receipt odds are **not** the main proof model.

Never mix:

```txt
Green model = grouped executable strategy odds
Gold receipt lens = exact landed score recap odds
```

---

# Current Supabase Proof Views

Project:

```txt
qjvpkkcbscsypymxyker
```

Locked model comparison views:

```txt
public.proof_vault_locked_model_rows_v1
public.proof_vault_locked_model_summary_v1
public.proof_vault_locked_model_5pct_compound_v1
```

VIP booster views:

```txt
public.proof_vault_vip_pocket_booster_rows_v1
public.proof_vault_vip_pocket_booster_summary_v1
public.proof_vault_vip_pocket_booster_5pct_compound_v1
```

Legacy protected proof views:

```txt
public.proof_vault_live_summary_v2_protected
public.proof_vault_daily_summary_v2_protected
public.proof_vault_recent_receipts_v2_protected
```

---

# Website Proof Page

Current proof page:

```txt
docs/proof.html
```

The proof page now separates:

```txt
- Public Main
- Optimized VIP
- Mirror Watchlist
- Removed Core Plus
- Broad Live audit
- 5% compounding replay
- Optimized VIP signal ledger
```

Do not show one mixed number as the main proof number.

---

# Historical Testing / Research Workflows

## Full Historical Warehouse

```txt
.github/workflows/api-tennis-full-historical-odds-warehouse.yml
```

Purpose:

```txt
Pulls historical API-Tennis fixture and odds data into warehouse artifacts.
```

## Live Scanner Parity Backtest

```txt
.github/workflows/live-scanner-parity-backtest.yml
scripts/backtest-live-scanner-parity-from-warehouse.mjs
```

Purpose:

```txt
Rebuilds broad live scanner lanes from warehouse data to compare live density vs historical density.
```

Key finding:

```txt
Broad scanner volume is real, but not all volume is valuable.
Mirror added many rows historically with nearly flat profit.
Core Cluster Plus was negative historically.
```

## Optimized Profitable Lanes Backtest

```txt
.github/workflows/optimized-profitable-lanes-backtest.yml
scripts/optimize-live-scanner-profitable-lanes.mjs
```

Best historical lane combo:

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
7% risk: about $111,459
```

Important warning:

```txt
7% had very large drawdown and is not the default recommendation.
```

## Protected Score Expansion Backtest

```txt
.github/workflows/protected-score-expansion-backtest.yml
scripts/backtest-protected-score-expansion-from-warehouse.mjs
```

Purpose:

```txt
Compares Gate-2, Protected 3-score, and Wide 4-score groups.
```

Key finding:

```txt
Historical high-upside winner:
Gate-2 Core + Reverse + Research P2 + V3

610 bets
35.08% hit rate
+142.87u
23.42% ROI
```

But current live rows favored Protected 3-score, so Gate-2 remains a silent tracker, not the active live staking model yet.

## Reality Check 100-300 Signals

```txt
.github/workflows/reality-check-100-300-signals.yml
scripts/reality-check-100-300-signals.mjs
```

Purpose:

```txt
Runs rolling 100 / 200 / 300 settled-signal windows and Monte Carlo simulations.
This is the closest-to-reality test before waiting for actual future live signals.
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

# Current Live Interpretation

Current live data has favored the Protected 3-score live model more than Gate-2 so far.

Operating decision:

```txt
Stake / post live:
Optimized VIP Protected 3-score

Track silently:
Optimized VIP Gate-2

Promote Gate-2 only if it beats Protected 3 after 100-200 additional live settled rows.
```

Current live optimized VIP has already reached roughly:

```txt
+33u live settled range
```

Do not treat that as a guarantee. Treat it as a strong early live-forward sample.

---

# Risk / Bankroll Guidance

Research only. Not financial advice.

## Suggested personal start

```txt
Start with small real stakes until at least 100 more live settled signals.
```

Recommended risk tiers:

```txt
1% = safer live validation
2% = serious but controlled
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

Personal-use recommendation:

```txt
Start at 1%-2% until the next 100 live settled signals.
Move toward 3% only if the model stays positive.
Use 5% only after you fully accept large drawdowns.
```

Never risk funds needed for basic life expenses.

---

# Promotion Rules

A lane can be promoted only if it passes:

```txt
1. Historical warehouse backtest positive
2. Reality check positive over 100 / 200 / 300 windows
3. Live-forward sample of 100+ settled rows positive
4. ROI beats the current live model or improves drawdown
5. No hidden mixing of receipt units into grouped units
```

Current status:

```txt
Public Main:
Core + Reverse

Optimized VIP:
Protected 3-score Core + Reverse + Research P2 + V3

Silent tracker:
Gate-2 Core + Reverse + Research P2 + V3

Watchlist:
Mirror

Removed:
Core Cluster Plus
```

---

# Operator Do / Do Not

## Do

```txt
- Keep Public Main separate from Optimized VIP.
- Keep grouped odds separate from receipt odds.
- Use Bet365 as the baseline source book.
- Track red rows publicly.
- Judge strategy only after meaningful sample sizes.
- Use warehouse artifacts before making strategy claims.
- Be honest about drawdowns and variance.
```

## Do Not

```txt
- Do not mix receipt profit into grouped model proof.
- Do not promote Mirror because of one hot week.
- Do not re-enable Core Cluster Plus without testing.
- Do not switch live staking to Gate-2 until it proves itself forward.
- Do not claim guaranteed wins.
- Do not call it free money.
- Do not build automated betting against sportsbook terms.
```

---

# Best Public Positioning

Use language like:

```txt
First Set Lab tracks tennis first-set exact-score clusters using live market pricing and public proof receipts.
Signals are not guaranteed. The model is forward-tested with red rows included.
The public proof model is Core + Reverse using executable grouped odds, not cherry-picked receipt odds.
```

Avoid language like:

```txt
Guaranteed
Lock
Can't lose
Quit your job
Free money
Cheat code
```
