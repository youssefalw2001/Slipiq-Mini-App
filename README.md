# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

It is not a traditional tipster project. The product is built around:

```txt
- Live market scanning
- Tennis first-set edge detection
- Timestamped signal receipts
- Supabase proof tracking
- Automatic settlement
- Telegram signal delivery
- Duplicate suppression
- Long-term ROI tracking
- Research shadow lanes
```

---

# Identity

```txt
Brand: First Set Lab
Engine: SlipIQ
Positioning: The hedge fund of tennis markets
Core niche: tennis first-set derivative markets
```

Main live focus:

```txt
- Tennis first-set exact-score clusters
- Bet365 executable grouped odds
- Market inefficiency detection
- Historical edge tracking
- Confidence-layer signal delivery
```

Secondary / research focus:

```txt
- First-set winner comfort signals
- First-set over/under games research
- Bookmaker portability research
- Experimental VIP lanes
```

---

# Current Live Production Strategy

## LIVE TELEGRAM DELIVERY

```txt
Primary production bookmaker:
- Bet365
```

## SHADOW / RESEARCH MODE

```txt
Tracked internally only:
- 1xBet
- 10Bet
- Betano / other books when available in warehouse research
- Betfair checker for automation research only
```

Reason:

```txt
Bet365 currently shows the strongest live execution quality.
Research books remain active internally for historical comparison, line shopping, and future validation.
```

Current production philosophy:

```txt
- Lower volume
- Higher signal quality
- Exact-score focus
- Cleaner Telegram experience
- Reduced market noise
- Long-term edge over hype
```

---

# AI Operator Handoff — Read This First

This section is the canonical handoff for another AI/operator continuing the project.

## Current Frozen Strategy State

```txt
Main model:
- Core Cluster
- Reverse Stretch Cluster

Watchlist / booster:
- Mirror Cluster

Paused / removed from active scanner:
- Core Cluster Plus

Research / VIP only:
- V3 Cluster
- Comfort
- First Set Over/Under research
```

Do **not** mix research lanes into the public main-model ROI.

The clean public proof model is:

```txt
Core + Reverse only
```

Mirror, V3, Comfort, and Over/Under must be tracked separately unless a future backtest + live forward test proves they should be promoted.

---

# Exact Lane Definitions

## Core Cluster

```txt
Lane key:
CORE_P1_ATP_GS_BET365

Public name:
Core Cluster

Bookmaker:
Bet365

Access:
CORE_AND_VIP

Target:
Player 1 wins first set 6:2, 6:3, or 6:4

Protected score group:
6:2 / 6:3 / 6:4

Original gate preserved:
6:3 / 6:4

Role:
Main model volume lane
```

## Reverse Stretch Cluster

```txt
Lane key:
CORE_P2_GS_REVERSE_STRETCH_BET365

Public name:
Reverse Stretch Cluster

Bookmaker:
Bet365

Access:
CORE_AND_VIP

Target:
Player 2 wins first set 2:6, 4:6, or 5:7

Protected score group:
2:6 / 4:6 / 5:7

Original gate preserved:
2:6 / 4:6

Important filter:
market_skew_bucket = EXTREME

Role:
Main model promoted lane
```

## Mirror Cluster

```txt
Lane key:
CORE_P1_MIRROR_WTA_OTHER

Public name:
Mirror Cluster

Target:
Player 1 wins first set 6:3, 6:4, or 7:5

Protected score group:
6:3 / 6:4 / 7:5

Role:
Watchlist / booster only
```

Mirror can still trigger signals, but it is **not** counted inside the main Core + Reverse proof model.

## Core Cluster Plus

```txt
Lane key:
VIP_P1_ATP_GS_MULTI

Public name:
Core Cluster Plus

Role:
Paused / removed from active scanner strategy
```

Do not re-promote Core Cluster Plus without a fresh backtest and live forward test.

## V3 Cluster

```txt
Lane key:
VIP_P2_V3_SHAPE

Public name:
V3 Cluster

Access:
VIP_ONLY

Protected score group:
3:6 / 4:6 / 5:7

Role:
Research / VIP only
```

V3 did **not** replace Core or Reverse. It is separate and should not be counted in main-model ROI.

## Comfort

```txt
Lane key:
COMFORT_FIRST_SET_FAVORITE_GS_1XBET

Public name:
Grand Slam Comfort

Market:
First-set winner

Bookmaker:
1xBet

Role:
Research / paused unless future results improve
```

Comfort is not part of the exact-score grouped model.

---

# Signal Architecture

## Signal Types

```txt
S-Tier:
Highest model edge + strongest pricing inefficiency.

A-Tier:
Strong edge with lower volatility.

Comfort:
Directional first-set winner style positions. Currently research only.

Research:
Shadow-tracked experimental lanes.
```

## Main Markets

```txt
- 1st Set Correct Score
- Grand Slam exact-score clusters
- First-set winner comfort signals, research only
- First-set over/under games, research only
```

## Exact-Score Philosophy

SlipIQ focuses heavily on exact-score clustering because tennis first-set markets are often mispriced during:

```txt
- Serve dominance mismatches
- Surface-adjusted hold-rate gaps
- Slam environments
- Fatigue/travel asymmetry
- Lower-liquidity derivatives
```

---

# Odds Rules

## Grouped Odds

Grouped odds are the executable strategy odds for a protected score group.

Formula:

```txt
grouped_decimal_odds = 1 / ((1 / score_1_odds) + (1 / score_2_odds) + (1 / score_3_odds))
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

Grouped odds are the odds to use for:

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

Never mix up:

```txt
Green model = V2 grouped executable strategy odds
Gold receipt lens = exact landed score recap odds
```

## Decimal to American Odds

```txt
If decimal odds >= 2.00:
American = +(decimal - 1) * 100

If decimal odds < 2.00:
American = -100 / (decimal - 1)
```

## American to Decimal Odds

```txt
If American odds are positive:
Decimal = 1 + (American / 100)

If American odds are negative:
Decimal = 1 + (100 / absolute value of American)
```

## Parlay Odds

```txt
1. Convert each leg to decimal odds.
2. Multiply decimal odds together.
3. Convert final decimal odds back to American odds.
4. Implied probability = 1 / parlay_decimal_odds.
5. Profit on stake = stake * (parlay_decimal_odds - 1).
6. Total return = stake * parlay_decimal_odds.
```

For parlays, use the **executable grouped odds**, not the receipt odds after the result.

---

# Supabase Source of Truth

Project:

```txt
qjvpkkcbscsypymxyker
```

Base signal/result table:

```txt
public.live_signal_unique_results
```

Proof page reads these views:

```txt
public.proof_vault_live_summary_v2_protected
public.proof_vault_daily_summary_v2_protected
public.proof_vault_recent_receipts_v2_protected
```

Important columns:

```txt
live_signal_unique_results.grouped_odds
live_signal_unique_results.selected_side_odds
live_signal_unique_results.trigger_odds
live_signal_unique_results.score_odds_json
live_signal_unique_results.score_cluster
live_signal_unique_results.strategy_lane
live_signal_unique_results.public_signal_name
live_signal_unique_results.status
live_signal_unique_results.first_set_score
live_signal_unique_results.settled_win

proof_vault_recent_receipts_v2_protected.official_decimal_odds
proof_vault_recent_receipts_v2_protected.receipt_decimal_odds
proof_vault_recent_receipts_v2_protected.official_american_odds
proof_vault_recent_receipts_v2_protected.receipt_american_odds
proof_vault_recent_receipts_v2_protected.official_profit_units
proof_vault_recent_receipts_v2_protected.receipt_profit_units
```

Interpretation:

```txt
official/grouped odds = executable strategy odds
receipt odds = exact landed score recap lens
```

---

# Live Workflow (A → Z)

## 1. Market Scan

The engine scans tennis first-set derivative markets.

Main inputs:

```txt
- Match environment
- Surface context
- Player profile
- Market pricing
- Historical score behavior
- Odds inefficiencies
```

---

## 2. Signal Generation

Signals are generated when:

```txt
- Lane rule is passed
- Edge threshold is passed
- Odds are acceptable
- Required score group is present
- Confidence layer validates the setup
```

Signals include:

```txt
- Match
- Score cluster
- Bookmaker
- Decimal odds
- American odds
- Grouped odds
- Historical edge
- Break-even percentage
- Sample size
- Confidence language
```

---

## 3. Duplicate Guard

Before sending:

```txt
- Duplicate signals are checked
- Similar score clusters are filtered
- Telegram spam is reduced
```

This keeps the channels:

```txt
- Cleaner
- More premium
- Easier to trust
```

---

## 4. Telegram Delivery

Current routing:

```txt
Bet365 Core + Reverse → Telegram / public proof
Research books → internal only
Research lanes → separate from main ROI
```

Delivery lanes:

```txt
- Core
- Quant/VIP
- Proof Vault
```

Telegram messages contain:

```txt
- Signal
- Odds
- Historical edge
- Sample size
- Confidence layer
- Timestamped receipt
```

---

## 5. Settlement Engine

After matches finish:

```txt
- Signals auto-settle
- Wins/losses update
- ROI recalculates
- Proof Vault refreshes
```

Tracked metrics:

```txt
- ROI
- Profit units
- Hit rate
- Average odds
- Historical edge
- Bookmaker performance
```

Settlement examples:

```txt
Core target = Player 1 wins first set 6:2 / 6:3 / 6:4
6:4 = WIN
4:6 = LOSS
3:6 = LOSS

Reverse target = Player 2 wins first set 2:6 / 4:6 / 5:7
4:6 = WIN
6:4 = LOSS
7:5 = LOSS
```

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

## Upgraded Bet365 Backtest From Warehouse Artifact

```txt
.github/workflows/api-tennis-upgraded-bet365-backtest-from-warehouse-artifact.yml
scripts/backtest-upgraded-bet365-from-warehouse.mjs
```

Purpose:

```txt
Uses existing warehouse artifact.
Does not pull API-Tennis again.
Backtests upgraded Core + Reverse model.
Keeps Mirror as watchlist.
Excludes Core Cluster Plus.
```

## Coverage Audit

```txt
.github/workflows/api-tennis-warehouse-coverage-audit.yml
scripts/audit-api-tennis-warehouse-coverage.mjs
```

Purpose:

```txt
Checks whether low historical signal count is caused by missing Bet365 data or strict filters.
```

Important finding:

```txt
Historical Bet365 first-set correct-score coverage was strong.
Lower historical count is mainly strict filters + Grand Slam seasonality.
```

## Bookmaker Portability Audit

```txt
.github/workflows/bookmaker-portability-audit.yml
scripts/audit-bookmaker-portability-from-warehouse.mjs
```

Purpose:

```txt
Checks whether Bet365 signals can be copied on other books at equal or better grouped odds.
```

Important logic:

```txt
Only take another book if it has all required target scores and grouped odds >= Bet365 grouped odds.
```

## Live Betfair Checker

```txt
.github/workflows/live-betfair-checker.yml
scripts/live-betfair-checker.mjs
```

Purpose:

```txt
Checks open Supabase signals against API-Tennis Betfair odds.
Does not place bets.
```

Current interpretation:

```txt
Betfair may be clean for automation in theory, but first-set correct-score market coverage can be weak.
```

## First Set Over/Under Backtest

```txt
.github/workflows/first-set-ou-backtest.yml
scripts/backtest-first-set-ou-from-warehouse.mjs
```

Purpose:

```txt
Research lane for first-set total games Over/Under.
Tests Over and Under together and separately.
Do not mix into Core + Reverse proof yet.
```

## Daily Stop Rule Simulator

```txt
.github/workflows/daily-stop-rule-simulator.yml
scripts/simulate-daily-stop-rules.mjs
```

Purpose:

```txt
Tests whether daily stop-loss, stop-win, losing-streak stops, max-signal caps, and green protection improve profit/drawdown.
```

Current interpretation:

```txt
Stop rules can help, but main profit comes from sticking to Core + Reverse through variance.
Do not overfit daily guard rules from one historical test.
```

---

# Latest Validated Strategy Results

Main upgraded Bet365 historical backtest:

```txt
Model:
Core Cluster + Reverse Stretch only

Graded signals:
337

Record:
150W / 187L

Hit rate:
44.51%

Grouped profit units:
+47.90u

Grouped ROI:
+14.21%

Average grouped odds:
2.661 decimal

Worst losing streak:
8 losses
```

Compounding simulation:

```txt
Starting bankroll:
$3,000

Risk:
5% compounded per signal

Historical finish:
About $16,090

Important warning:
Max drawdown was large. This strategy can have painful losing runs.
```

Daily stop-rule simulator baseline:

```txt
No stop rule:
337 bets
+47.90u
$3,000 → about $16,090 at 5% compounding
```

Best historical stop rule by profit:

```txt
Stop after 4 straight losses:
303 bets
+54.30u
$3,000 → about $23,638 at 5% compounding
```

Operator warning:

```txt
The stop rule improved the historical result but did not remove drawdown.
Do not treat it as magic.
The edge still depends on taking the full Core + Reverse sequence over time.
```

---

# Interpreting Bad Days

A bad day does not automatically mean the scanner is wrong.

Scanner accuracy means:

```txt
- The correct lane fired
- The correct score group was used
- The odds were captured correctly
- Grouped odds math was correct
- Settlement graded the side correctly
```

A normal loss means:

```txt
Signal was valid, but the match landed outside the protected group.
```

Do not change the model because of:

```txt
- One bad day
- One losing streak
- One painful Slam slate
- Receipt units looking better/worse than grouped units
```

Judge only after:

```txt
100+ new live Core + Reverse signals
```

---

# Risk / Bankroll Guidance

Research only. Not financial advice.

Safer live forward test:

```txt
1% to 2% per signal for first 25-50 new live signals
```

Aggressive but tested historically:

```txt
5% compounded per signal
```

Very aggressive:

```txt
7% compounded per signal
```

Warning:

```txt
7% can look powerful in projections but becomes emotionally dangerous during losing streaks.
```

The system can be profitable historically and still have:

```txt
- Losing days
- Multi-loss runs
- Drawdowns
- Missed score clusters
- Slam-week volatility
```

---

# Research Layer

Experimental systems remain active internally.

Rules:

```txt
- Research lanes do not count toward main ROI.
- Research lanes must have their own backtest and live ledger.
- Promote a lane only after historical proof + forward-test proof.
- Never promote because of one good receipt.
```

Current research candidates:

```txt
- Mirror watchlist
- V3 Cluster
- Comfort
- First Set Over/Under Games
- Bookmaker routing / line shopping
- Betfair automation feasibility
```

---

# Operator Do / Do Not

## Do

```txt
- Keep Core + Reverse as the main proof model.
- Keep receipt odds separate from grouped odds.
- Use Bet365 as the baseline source book.
- Verify grouped odds math when debugging.
- Use warehouse artifacts before making strategy claims.
- Track red rows publicly.
- Be honest about variance and drawdowns.
```

## Do Not

```txt
- Do not mix V3 into Core + Reverse ROI.
- Do not mix Comfort into exact-score grouped proof.
- Do not use receipt profit as the main proof metric.
- Do not re-enable Core Cluster Plus without testing.
- Do not change strategy after one bad day.
- Do not claim guaranteed wins.
- Do not build automated betting against sportsbook terms.
```

---

# Best Public Positioning

Use language like:

```txt
First Set Lab tracks tennis first-set exact-score clusters using live market pricing and public proof receipts.
Signals are not guaranteed. The model is forward-tested with red rows included.
The main proof model is Core + Reverse using executable grouped odds, not cherry-picked receipt odds.
```

Avoid language like:

```txt
Guaranteed
Lock
Can't lose
Quit your job
Free money
```
