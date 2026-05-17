# SlipIQ Mini App

**SlipIQ** is a Telegram Mini App and research engine for tennis first-set price intelligence.

**Tagline:** Don't guess. Calculate.

SlipIQ is not a tipster product. It is a probability/price-intelligence system built to compare first-set score patterns against real bookmaker prices, especially niche first-set tennis correct-score markets.

---

## Current Research Mission

The current mission is to find the cleanest, highest-edge first-set tennis signal system using API Tennis historical odds.

We are no longer only testing one hard rule. We are building a discovery engine that can search across:

```txt
P2 V3 grouped score strategy
P1 mirror grouped score strategy
both-side grouped strategies
alternative clusters
exact-score patterns
bookmaker pockets
tournament group pockets
price gates
train/test stability
monthly stability
```

The dream result we are trying to responsibly validate came from an older blind simulation:

```txt
Original old-sim dream profile:
P2 V3 trigger
~2,690 bets
~906 wins
~33.68% hit rate
assumed grouped odds around 3.50
$5,000 with 2% compounding showed a massive/million-style outcome
```

Important correction: that older run used **scenario odds** around `3.50`, not fully verified real reconstructed grouped odds. The new research is trying to determine whether that dream can survive real bookmaker prices, proper grading, train/test validation, and live pre-match execution.

---

## Flagship Strategy: V3 / First Set Lab

The main strategy family is called **V3**.

### P2 V3

P2 V3 means **Player 2 wins the first set** by one of these exact scores:

```txt
3:6
4:6
5:7
```

From the match page perspective:

```txt
Player 1 wins 3, 4, or 5 games
Player 2 wins 6 or 7 games
Player 2 wins first set
First-set total games are usually 9-12
```

The grouped synthetic price is calculated by dutching the three exact scores:

```txt
p2_grouped_odds = 1 / (1/odds_3_6 + 1/odds_4_6 + 1/odds_5_7)
```

### P1 mirror

The P1 mirror uses:

```txt
6:3
6:4
7:5
```

```txt
p1_grouped_odds = 1 / (1/odds_6_3 + 1/odds_6_4 + 1/odds_7_5)
```

### Important market name

API Tennis labels the tennis first-set correct score market as:

```txt
Correct Score 1st Half
```

For tennis, in our warehouse, this means first-set correct score. The market contains the standard first-set score options:

```txt
6:0, 6:1, 6:2, 6:3, 6:4, 7:5, 7:6
0:6, 1:6, 2:6, 3:6, 4:6, 5:7, 6:7
```

---

## Current API Tennis Warehouse

Current historical warehouse range:

```txt
2025-02-17 to 2026-05-17
roughly 15 months
```

Important warehouse summary:

```txt
fixtures_full rows: 11,116
odds_full_long rows: 2,568,641
first_set_correct_score_wide rows: 55,502
moneyline_favorite rows: 285,784
first-set correct-score wide settled rows: 46,979
settled side candidates: 93,578
errors: 0
```

The historical data is useful for research, but **we do not yet fully know odds timing**. It should be treated as historical/pre-match-like snapshots unless live timing is proven. Final trust requires live pre-match paper tracking with `scanned_at`, `event_time`, and `minutes_to_start`.

---

## Major Findings So Far

### 1. Missing first-set scores were once incorrectly counted as losses

A major bug was found and fixed. Earlier weak results were caused by missing/ungraded first-set scores being counted as losses.

Correct settled-only result for the broad both-side 9-12 model:

```txt
ATP
bet365 + 10Bet
both-side 9-12 cluster
cluster odds 3.00-3.50
middle score odds 7.00-9.00

1,085 settled bets
360 wins
33.18% hit rate
avg odds ~3.26
+7.88% flat ROI
```

This confirmed that the low-volume/low-ROI issue was partly a test-design/grading issue, not proof that the strategy was dead.

### 2. Original P2-only V3 pattern exists, but real odds matter

P2 V3 scenario-vs-real audit:

```txt
Trigger:
P2 4:6 odds between 6.25 and 6.99

Win condition:
first_set_score in 3:6 / 4:6 / 5:7
```

Scenario odds version:

```txt
6,819 settled book-row triggers
2,248 wins
32.97% hit rate
assumed odds: 3.50
+15.38% flat ROI
huge compounding output
```

Real reconstructed grouped odds version:

```txt
6,817 real-available rows
2,246 wins
32.95% hit rate
average real grouped odds: ~2.65
-13.83% flat ROI
```

Conclusion:

```txt
The hit-rate pattern is real.
The old million-style compounding was inflated by assuming 3.50 grouped odds on every signal.
Real grouped price gating is required.
```

### 3. Grouped odds math validation passed

Grouped odds validation audit result:

```txt
P2 rows with all three scores: 55,168
P1 rows with all three scores: 55,399
P2 mismatches > 0.001: 0
P1 mismatches > 0.001: 0
```

The formula and dutching logic are correct. The audit also confirmed the market being used was `Correct Score 1st Half`, not full-match correct score.

Example dutching validation:

```txt
3:6 @ 8.50
4:6 @ 8.20
5:7 @ 22.00

Grouped odds: ~3.5081
$100 dutched stake pays about $350.81 if any of the three scores wins.
```

### 4. Price gate is the real edge filter

Raw P2 V3 at average real odds around `2.65` loses.

P2 V3 becomes more interesting when real grouped odds clear a price gate. Early positive pockets found:

```txt
All books / specific tournament pockets / gate >= 3.05:
small sample but high ROI pockets

10Bet ATP gate >= 3.15 / 3.30:
very strong single-book sniper profile

bet365 + 10Bet ATP gate >= 3.15:
best practical core profile so far
```

### 5. Tournament group matters

Deep grid optimizer showed that tournament group matters strongly.

Bad/weak areas:

```txt
Grand Slams: bad in the current sample
Masters 1000: mostly neutral/okay
Other Tour: mixed
```

Strong pocket:

```txt
ATP
STRONG_500_250
all books
grouped odds >= 3.05

78 bets
35 wins
44.87% hit rate
avg odds 3.60
+62.40% flat ROI
```

### 6. Surface is not available in the current 15-month warehouse

The deep grid joined `fixtures_full_combined.csv`, but surface coverage was:

```txt
Surface known candidates: 0
Surface unknown candidates: 6,817
```

So surface should not be trusted yet from the current API Tennis warehouse. If needed later, surface must be collected from another source or an enriched exporter.

---

## Current Best Candidate Strategies

These are research candidates, not final paid-signal proof.

### Best single-book sniper candidate

```txt
ATP
10Bet
P2 V3
real grouped odds >= 3.15

61 bets
24 wins
39.34% hit rate
avg odds 3.58
+41.48% flat ROI
positive months: 11 / 14
```

Stricter version:

```txt
ATP
10Bet
real grouped odds >= 3.30

51 bets
20 wins
39.22% hit rate
avg odds 3.64
+43.92% flat ROI
max drawdown ~13.2%
worst losing streak 7
```

Interpretation: 10Bet is the cleanest single-book VIP/sniper candidate, but volume is low.

### Best practical core candidate

```txt
ATP
bet365 + 10Bet
P2 V3
real grouped odds >= 3.15

150 bets
52 wins
34.67% hit rate
avg odds 3.58
+24.53% flat ROI
positive months: 9 / 15
```

Slightly more volume:

```txt
ATP
bet365 + 10Bet
real grouped odds >= 3.00

209 bets
69 wins
33.01% hit rate
avg odds 3.44
+14.44% flat ROI
```

### Best volume candidate

```txt
ATP
1xBet + bet365 + 10Bet
real grouped odds >= 2.80

408 bets
139 wins
34.07% hit rate
avg odds 3.18
+7.87% flat ROI
```

Interpretation: better for public signal flow, but drawdown is higher and ROI is lower.

---

## Current Problem We Are Solving

The question is no longer simply:

```txt
Does P2 V3 work?
```

The real question is:

```txt
Can we transform V3 into a scored signal engine that improves hit rate, ROI, volume, and drawdown at the same time?
```

V3 should stop being one rigid rule and become:

```txt
V3 Pro Score = trigger quality + price quality + tournament quality + book quality + market-shape quality + favorite context
```

Then the system should rank signals and optionally cap daily plays.

---

## V3 Pro Model Direction

V3 Pro is the current master-plan optimizer.

It learns feature weights from the chronological train period and scores candidates using:

```txt
family: P2 V3 or P1 mirror
bookmaker
tour: ATP/WTA
tournament group
surface if available
trigger zone
price bucket
cluster shape bucket
first-set favorite bucket
match favorite bucket
```

It then tests:

```txt
score thresholds
daily caps: none, 3/day, 5/day, 10/day
book groups
tournament groups
ATP/WTA
P2/P1/all family modes
one-pick-per-match mode
train/test split
monthly stability
```

This is meant to find:

```txt
VIP sniper model
Premium core model
Public volume model
Avoid zones
```

---

## Key Workflows

### Historical warehouse

```txt
.github/workflows/api-tennis-full-historical-odds-warehouse.yml
```

Builds the full API Tennis historical odds warehouse.

Current artifact name:

```txt
api-tennis-full-historical-odds-warehouse-combined
```

### Grouped odds validation

```txt
.github/workflows/api-tennis-grouped-odds-validation-audit.yml
scripts/api_tennis_grouped_odds_validation_audit.py
```

Purpose:

```txt
Verify grouped odds math
Verify P2/P1 dutching payout logic
Confirm market name
Export grouped_odds_math_audit.csv
```

### P2 V3 scenario vs real audit

```txt
.github/workflows/api-tennis-p2-v3-scenario-vs-real-audit.yml
scripts/api_tennis_p2_v3_scenario_vs_real_audit.py
```

Purpose:

```txt
Compare old assumed 3.50 scenario odds vs real reconstructed grouped odds
Show whether the old dream was hit-rate-driven or price-inflated
```

### P2 V3 price gate optimizer

```txt
.github/workflows/api-tennis-p2-v3-price-gate-optimizer.yml
scripts/api_tennis_p2_v3_price_gate_optimizer.py
```

Purpose:

```txt
Find the minimum real grouped odds gate where P2 V3 becomes profitable
Split by book, ATP/WTA, tournament group, and book groups
```

### P2 V3 deep grid optimizer

```txt
.github/workflows/api-tennis-p2-v3-deep-grid-optimizer.yml
scripts/api_tennis_p2_v3_deep_grid_optimizer.py
```

Purpose:

```txt
Search P2 V3 by bookmaker + tournament group + price gate + surface if available
Identify clean pockets like 10Bet ATP or Strong 500/250
```

### Strategy discovery engine

```txt
.github/workflows/api-tennis-strategy-discovery-engine.yml
scripts/api_tennis_strategy_discovery_engine.py
```

Purpose:

```txt
Search multiple strategy families, not just P2 V3
Test clusters, exact scores, book groups, train/test, monthly stability, drawdown
Rank strategies by clean strategy score, not raw ROI only
```

### V3 Pro model optimizer

```txt
.github/workflows/api-tennis-v3-pro-model-optimizer.yml
scripts/api_tennis_v3_pro_model_optimizer.py
```

Purpose:

```txt
Turn V3 into a scored signal model
Learn feature weights from train data
Test score thresholds and daily caps
Find VIP/core/volume models with train/test validation
```

Recommended run settings:

```txt
artifact_name: api-tennis-full-historical-odds-warehouse-combined
start_bankroll: 5000
risk_pct: 0.02
train_ratio: 0.70
min_feature_rows: 40
min_bets: 50
min_test_bets: 15
```

---

## Odds Timing Problem

API Tennis is reliable enough for research and discovery, but not enough alone to fully prove a paid signal system.

Known limitation:

```txt
The current historical warehouse does not prove exact odds timing.
```

We do not yet know whether historical odds are:

```txt
opening odds
closing odds
stored snapshot odds
last pre-match odds
```

Required live timing audit:

```txt
scan upcoming matches before start
save scanned_at
event_time
minutes_to_start
bookmaker
3:6 / 4:6 / 5:7 odds
grouped odds
market name
match status
then compare against historical odds after settlement
```

A real paid signal must be proven with our own live pre-match signal log.

---

## Product Direction

The product wedge is:

```txt
First Set Lab
Tennis first-set grouped-score price intelligence
```

The commercial angle is not "picks." It is:

```txt
market inefficiency detector
price-gated first-set score signals
historical edge vs break-even
live paper-tracked proof
```

Signal tiers could become:

```txt
B-tier: valid V3 Pro score / smaller edge
A-tier: strong score + price gate + stable book/tournament pocket
S-tier: elite score + high price + best book/tournament pocket
```

Suggested product split:

```txt
VIP sniper: 10Bet/strict high-score signals
Premium core: bet365 + 10Bet balanced model
Public volume: wider 1xBet + bet365 + 10Bet model with lower ROI but more flow
```

---

## Safety / Product Rules

SlipIQ is a decision-support tool, not a guarantee engine.

Do not use language like:

```txt
guaranteed
lock
sure win
automatic profit
risk-free
```

Use language like:

```txt
probability edge
fair odds vs market odds
positive EV candidate
price confirmation required
historical hit rate
break-even hit rate
decision-support tool
```

This repository is for research, data extraction, backtesting, and alerts. It should not include code that places bets automatically or bypasses sportsbook protections.

---

## Original App Build Direction

The Telegram Mini App stack remains:

```txt
React + Vite
TypeScript
Tailwind CSS
Telegram Web App SDK
Zustand
Recharts
Supabase/PostgreSQL
Telegram Stars payments later
```

But current priority is the data/odds engine, because the math and price intelligence are the product.

MVP app build order after research stabilizes:

```txt
1. First Set Lab probability/price engine
2. Real odds feed import / seed data
3. Opportunity Card
4. Home Feed
5. Match Detail / Probability Deep Dive
6. Telegram alerts
7. Signal history and paper-tracked results
8. Premium / Telegram Stars
```

---

## Local Commands

```bash
npm install
npm run dev
npm run build
npm run test
```

Python workflow scripts are designed mainly for GitHub Actions, but can be run locally if inputs and dependencies are available.
