# SlipIQ Mini App

**SlipIQ** is a Telegram Mini App and research engine for tennis first-set price intelligence.

**Tagline:** Don't guess. Calculate.

SlipIQ is not a tipster product. It is a probability/price-intelligence system built to compare first-set score patterns against real bookmaker prices, especially niche first-set tennis correct-score markets.

---

## Current Status: First Set Lab Signal Room

SlipIQ has evolved from a single V3 backtest into a **First Set Lab live signal engine**.

The current product direction is:

```txt
Free proof channel -> Core Signal Chat -> VIP First Set Lab
```

The live scanner now supports:

```txt
Core Chat:
- Core P1 ATP Grand Slam Cluster: 6:3 / 6:4
- Core P1 Mirror WTA Other Tour: 6:3 / 6:4 / 7:5

VIP Chat:
- Everything Core receives
- VIP ATP Grand Slam multi-source Core Cluster Plus: 6:3 / 6:4
- VIP P2 V3 Cluster: 3:6 / 4:6 / 5:7
```

Telegram messages intentionally **do not show bookmaker names**. Bookmaker names are stored only in internal artifacts/logs for audit, paper tracking, and grading.

Current live scanner:

```txt
.github/workflows/api-tennis-live-first-set-lab-scanner.yml
scripts/api_tennis_live_first_set_lab_scanner.mjs
```

Current focused signal-room historical test:

```txt
.github/workflows/api-tennis-signal-room-volume-lite.yml
scripts/api_tennis_signal_room_volume_lite.py
```

Why this is called **Signal Room Volume Lite**:

```txt
It replaces the cancelled/heavy V3 Pro Volume workflow.
It tests the same business question, but only against the actual Core/VIP signal-room lanes.
It answers: what does Core get, what does VIP get, hit rate, ROI, volume, drawdown, and 2%/4% compounding.
```

---

## Market Definition

API Tennis labels the tennis first-set correct score market as:

```txt
Correct Score 1st Half
```

For tennis, this is treated as **first-set correct score**. The market contains:

```txt
6:0, 6:1, 6:2, 6:3, 6:4, 7:5, 7:6
0:6, 1:6, 2:6, 3:6, 4:6, 5:7, 6:7
```

---

## Main Strategy Families

### P2 V3

P2 V3 means **Player 2 wins the first set** by:

```txt
3:6 / 4:6 / 5:7
```

Grouped odds:

```txt
p2_grouped_odds = 1 / (1/odds_3_6 + 1/odds_4_6 + 1/odds_5_7)
```

### P1 Mirror

P1 Mirror means **Player 1 wins the first set** by:

```txt
6:3 / 6:4 / 7:5
```

Grouped odds:

```txt
p1_grouped_odds = 1 / (1/odds_6_3 + 1/odds_6_4 + 1/odds_7_5)
```

### P1 Core

Discovery Turbo found a stronger simplified family:

```txt
P1_CORE_7_10 = 6:3 / 6:4
```

Grouped odds:

```txt
p1_core_grouped_odds = 1 / (1/odds_6_3 + 1/odds_6_4)
```

This is now the cleanest public-facing strategy family because it is simple and historically strong.

---

## Current API Tennis Warehouse

Historical warehouse range:

```txt
2025-02-17 to 2026-05-17
roughly 15 months
```

Warehouse summary:

```txt
fixtures_full rows: 11,116
odds_full_long rows: 2,568,641
first_set_correct_score_wide rows: 55,502
moneyline_favorite rows: 285,784
first-set correct-score wide settled rows: 46,979
settled side candidates: 93,578
errors: 0
```

Historical data is useful for research, but it does **not fully prove odds timing**. Final trust requires live pre-match paper tracking with:

```txt
scanned_at
event_time
minutes_to_start
market_name
score odds
grouped odds
internal bookmaker
Telegram room routed
settled result
```

---

## Major Findings

### 1. Old dream was inflated by assumed odds

Old blind simulation dream:

```txt
P2 V3 trigger
~2,690 bets
~906 wins
~33.68% hit rate
assumed grouped odds around 3.50
$5,000 with 2% compounding showed a massive/million-style output
```

Reality check:

```txt
The hit-rate pattern existed, but the old run used scenario odds around 3.50.
Real reconstructed grouped odds averaged closer to ~2.65 and raw P2 V3 lost without price/model filters.
```

P2 V3 scenario-vs-real audit:

```txt
Trigger: P2 4:6 odds between 6.25 and 6.99

Scenario odds version:
6,819 settled book-row triggers
2,248 wins
32.97% hit rate
assumed odds: 3.50
+15.38% flat ROI

Real grouped odds version:
6,817 real-available rows
2,246 wins
32.95% hit rate
average real grouped odds: ~2.65
-13.83% flat ROI
```

Conclusion:

```txt
The old dream did not die, but it evolved.
The real strategy must use price gates, model scoring, and live pre-match proof.
```

### 2. Grouped odds math is correct

Grouped odds validation passed:

```txt
P2 rows with all three scores: 55,168
P1 rows with all three scores: 55,399
P2 mismatches > 0.001: 0
P1 mismatches > 0.001: 0
```

The issue is not the dutching formula. The issue is finding the right price/timing/filter.

### 3. Missing first-set results bug was fixed

Earlier weak results were partly caused by missing/ungraded first-set scores being counted as losses.

Corrected broad both-side result:

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

### 4. V3 Pro changed the direction

V3 Pro found that the edge is probably not just:

```txt
P2 V3 + high grouped odds
```

It is more likely:

```txt
side-aware cluster model + market shape + book/tournament context + price gate
```

V3 Pro run summary:

```txt
generated: 2026-05-17T18:51:44Z
split cutoff: 2026-01-13
wide rows: 55,502
candidate rows: 93,578
train candidates: 69,755
rules tested: 32,882
```

Best overall V3 Pro:

```txt
P2_V3_9_12
ALL_BOOKS
ATP Grand Slam
score threshold 70

99 bets
57 wins
57.58% hit rate
avg odds 2.379
+34.32% flat ROI
6/6 positive months
max drawdown 10.76%
worst losing streak 5
no overfit flags
```

Best scalable V3 Pro:

```txt
P1_MIRROR_9_12
1xBet + bet365
WTA Other Tour
score threshold 41.48
daily cap 3

270 bets
127 wins
47.04% hit rate
avg odds 2.584
+21.44% flat ROI
12/15 positive months
max drawdown 14.23%
worst losing streak 6
no overfit flags
```

Best single-book V3 Pro:

```txt
P1_MIRROR_9_12
10Bet
ATP Strong 500/250
score threshold 70

90 bets
50 wins
55.56% hit rate
avg odds 2.309
+27.45% flat ROI
8/11 positive months
max drawdown 7.76%
worst losing streak 4
no overfit flags
```

Important feature weights:

```txt
P1_MIRROR_9_12: +5.98
P2_V3_9_12: -6.08
bet365: +7.72
10Bet: +6.96
Betano: +6.57
WilliamHill: +5.61
1xBet: +1.45
ATP: +9.30
WTA: -9.48 globally, but WTA works in specific pockets
STRONG_500_250: +4.60
MID_GROUP_RATIO_MIXED: +19.30
HIGH_GROUP_RATIO_OUTERS_LONG: +14.76
LOW_GROUP_RATIO_BALANCED: -30.00
```

Main V3 Pro insight:

```txt
Old idea: 33% hit at 3.30-3.50 odds.
New idea: 47%-58% hit at 2.30-2.60 odds using score/shape filters.
```

### 5. Strategy Discovery Turbo found P1 Core

Strategy Discovery Turbo replaced the cancelled broad discovery engine with a faster focused search.

It tested:

```txt
wide rows: 55,502
settled wide rows: 46,979
candidate rows: 374,332
rules tested: 200,000 safety cap
families: P1_CORE, P1_MID_LATE, P1_MIRROR, P1_TIGHT, P2_CORE, P2_MID_LATE, P2_TIGHT, P2_V3
```

Best overall / best bet365:

```txt
TURBO005764
P1_CORE_7_10
bet365
ATP Grand Slam
trigger: 6:4 odds 5.00-6.25
minimum grouped odds: 2.50
daily cap: 10

162 bets
70 wins
43.21% hit rate
avg odds 3.12
break-even 32.03%
edge +11.18 points
+27.64% flat ROI
5/6 positive months
2% compounding: $5,000 -> $11,389
max drawdown 13.4%
worst losing streak 6
no overfit flags
```

Best scalable Turbo:

```txt
P1_CORE_7_10
bet365 + 1xBet
ATP Grand Slam
trigger: 6:4 odds 5.00-6.25
minimum grouped odds: 2.60

320 bets
134 wins
41.88% hit rate
avg odds 2.97
+20.72% flat ROI
6/6 positive months
2% compounding: $5,000 -> $16,500
max drawdown 22.6%
worst losing streak 10
no overfit flags
```

Best three-book Turbo:

```txt
P1_CORE_7_10
bet365 + 1xBet + 10Bet
ATP Grand Slam
minimum grouped odds: 2.60

383 bets
159 wins
41.51% hit rate
avg odds 2.99
+20.19% flat ROI
6/6 positive months
2% compounding: $5,000 -> $20,030
max drawdown 33.5%
worst losing streak 14
```

Important warning:

```txt
Highest-volume positive/no-flag candidate had 4,230 bets but only +0.14% flat ROI.
2% compounding collapsed to about $129 with ~98% drawdown.
Volume alone is not king. Volume + edge + drawdown control is king.
```

---

## Live Scanner V1

Workflow:

```txt
.github/workflows/api-tennis-live-first-set-lab-scanner.yml
scripts/api_tennis_live_first_set_lab_scanner.mjs
```

What it does:

```txt
1. Pulls upcoming fixtures.
2. Pulls Correct Score 1st Half odds.
3. Calculates grouped odds for each lane.
4. Applies Core/VIP filters.
5. Dedupes public-facing signals by event/lane/access.
6. Routes signals to Telegram Core and VIP chats.
7. Hides bookmaker names from Telegram.
8. Stores bookmaker names internally in artifact CSV/JSON.
```

Required GitHub Secrets:

```txt
API_TENNIS_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CORE_CHAT_ID
TELEGRAM_VIP_CHAT_ID
```

Dry-run:

```txt
Actions -> API Tennis Live First Set Lab Scanner -> Run workflow
send_telegram: false
```

Live send:

```txt
send_telegram: true
```

Scheduled runs:

```txt
every 2 hours
```

Output artifact:

```txt
api-tennis-live-first-set-lab-scanner
```

Important files:

```txt
first_set_lab_live_report.md
first_set_lab_live_summary.json
first_set_lab_live_signals.csv
first_set_lab_live_raw_candidates.csv
first_set_lab_live_telegram_log.csv
```

First dry run result before Core widening:

```txt
Fixtures: 203
Odds matches: 193
Raw candidate rows: 15
Deduped public signals: 14
Core signals: 0
VIP-only signals: 14
Telegram sent: 0 because dry-run
Errors: 0
```

After that, Core was widened to include the WTA Other Tour P1 Mirror lane so Core is not too quiet.

---

## Signal Room Volume Lite

Workflow:

```txt
.github/workflows/api-tennis-signal-room-volume-lite.yml
scripts/api_tennis_signal_room_volume_lite.py
```

Purpose:

```txt
This is the focused replacement for the cancelled V3 Pro Volume workflow.
It tests the exact current Core/VIP live scanner lanes, not a massive optimizer grid.
```

It reports:

```txt
CORE_ROOM
VIP_ROOM_ALL
VIP_EXTRA_ONLY

bets
wins
hit rate
average grouped odds
break-even rate
flat ROI
active days
bets/month
2% compounding from $5,000
4% compounding from $5,000
max drawdown
worst losing streak
train/test split
lane mix
book mix
```

Run:

```txt
Actions -> API Tennis Signal Room Volume Lite -> Run workflow

artifact_name: api-tennis-full-historical-odds-warehouse-combined
start_bankroll: 5000
risk_pct: 0.02
dream_risk_pct: 0.04
train_ratio: 0.70
```

Output artifact:

```txt
api-tennis-signal-room-volume-lite
```

Important files:

```txt
signal_room_volume_lite_report.md
signal_room_volume_lite_cards.json
signal_room_volume_lite_results.csv
signal_room_volume_lite_train_test.csv
signal_room_volume_lite_signals.csv
```

---

## Current Core / VIP Product Structure

### Free Proof Channel

Purpose:

```txt
education
weekly proof
selected delayed recaps
public trust building
```

### Core Signal Chat

Proposed launch price:

```txt
$19/month at launch
$29/month after proof
```

Core receives:

```txt
Core P1 ATP Grand Slam Cluster
Core P1 Mirror WTA Other Tour
B-tier and A-tier signals
simple explanation
no bookmaker names shown
paper-tracked results
```

### VIP First Set Lab

Proposed launch price:

```txt
$49/month early
$79/month after proof
$99/month if live tracking is strong
```

VIP receives:

```txt
All Core signals
VIP P1 ATP Grand Slam multi-source Core Cluster Plus
VIP P2 V3 Cluster
A/S-tier premium signals
higher-confidence lanes
early alerts
weekly model/report breakdown
```

Important rule:

```txt
Core must not be bad leftovers.
Core should be solid filtered signals.
VIP gets more complete, earlier, and stronger premium access.
```

---

## Supabase Plan

Supabase should become the permanent live signal ledger, result grader, and app backend.

### Required tables

#### users

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique,
  telegram_username text,
  tier text default 'free',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

#### signal_rooms

```sql
create table signal_rooms (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  tier text not null,
  telegram_chat_id text,
  is_active boolean default true,
  created_at timestamptz default now()
);
```

Recommended room keys:

```txt
free_proof
core_signals
vip_first_set_lab
```

#### live_signals

```sql
create table live_signals (
  id uuid primary key default gen_random_uuid(),
  signal_key text unique not null,
  scanned_at timestamptz not null default now(),
  event_key text not null,
  event_date date,
  event_time text,
  starts_at timestamptz,
  minutes_to_start int,
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
  status text default 'open',
  first_set_score text,
  settled_win boolean,
  settled_at timestamptz,
  created_at timestamptz default now()
);
```

#### telegram_signal_deliveries

```sql
create table telegram_signal_deliveries (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references live_signals(id) on delete cascade,
  room_key text not null,
  telegram_chat_id text,
  telegram_message_id text,
  sent_at timestamptz default now(),
  sent_ok boolean default false,
  error_json jsonb,
  message_preview text
);
```

#### signal_results_daily

```sql
create table signal_results_daily (
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
```

#### subscriptions

```sql
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  tier text not null,
  status text default 'active',
  provider text default 'telegram_stars',
  provider_payment_id text,
  started_at timestamptz default now(),
  expires_at timestamptz,
  created_at timestamptz default now()
);
```

### Supabase environment variables

GitHub Secrets needed later:

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

App frontend env:

```txt
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

### Supabase workflow plan

Live scanner V2 should:

```txt
1. Scan API Tennis.
2. Build signal rows.
3. Upsert into live_signals by signal_key.
4. Send Telegram only if signal is new and not already delivered.
5. Insert telegram_signal_deliveries row.
6. Later, settlement workflow fetches fixtures/results.
7. Update first_set_score, settled_win, settled_at.
8. Aggregate daily/weekly results into signal_results_daily.
```

This is critical because GitHub Actions artifacts are not enough for a paid product. Supabase becomes the proof ledger.

---

## Important Workflows

### Historical warehouse

```txt
.github/workflows/api-tennis-full-historical-odds-warehouse.yml
```

### Grouped odds validation

```txt
.github/workflows/api-tennis-grouped-odds-validation-audit.yml
scripts/api_tennis_grouped_odds_validation_audit.py
```

### P2 V3 scenario vs real audit

```txt
.github/workflows/api-tennis-p2-v3-scenario-vs-real-audit.yml
scripts/api_tennis_p2_v3_scenario_vs_real_audit.py
```

### P2 V3 price gate optimizer

```txt
.github/workflows/api-tennis-p2-v3-price-gate-optimizer.yml
scripts/api_tennis_p2_v3_price_gate_optimizer.py
```

### P2 V3 deep grid optimizer

```txt
.github/workflows/api-tennis-p2-v3-deep-grid-optimizer.yml
scripts/api_tennis_p2_v3_deep_grid_optimizer.py
```

### V3 Pro model optimizer

```txt
.github/workflows/api-tennis-v3-pro-model-optimizer.yml
scripts/api_tennis_v3_pro_model_optimizer.py
```

### Strategy Discovery Turbo

```txt
.github/workflows/api-tennis-strategy-discovery-turbo.yml
scripts/api_tennis_strategy_discovery_turbo.py
```

### Live First Set Lab scanner

```txt
.github/workflows/api-tennis-live-first-set-lab-scanner.yml
scripts/api_tennis_live_first_set_lab_scanner.mjs
```

### Signal Room Volume Lite

```txt
.github/workflows/api-tennis-signal-room-volume-lite.yml
scripts/api_tennis_signal_room_volume_lite.py
```

---

## Safety / Product Rules

SlipIQ is a decision-support tool, not a guarantee engine.

Do not use:

```txt
guaranteed
lock
sure win
automatic profit
risk-free
```

Use:

```txt
probability edge
fair odds vs market odds
positive EV candidate
price confirmation required
historical hit rate
break-even hit rate
paper-tracked signal
decision-support tool
```

This repository is for research, data extraction, backtesting, paper tracking, and alerts. It should not include code that places bets automatically or bypasses sportsbook protections.

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

Current priority is the live signal and proof ledger because the math and price intelligence are the product.

MVP build order after live signal tracking stabilizes:

```txt
1. Supabase live_signals ledger
2. Telegram Core/VIP alert routing
3. Settlement/grading workflow
4. Signal history dashboard
5. First Set Lab opportunity cards
6. Telegram Mini App profile/payments
7. Premium / Telegram Stars gating
```

---

## Local Commands

```bash
npm install
npm run dev
npm run build
npm run test
```

Python and Node workflow scripts are designed mainly for GitHub Actions, but can be run locally if inputs, API keys, and artifacts are available.
