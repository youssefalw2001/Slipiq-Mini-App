# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

It is not a traditional tipster project. The product is built around live scanning, timestamped signal receipts, Supabase proof tracking, automatic settlement, and disciplined risk language.

```txt
Brand: First Set Lab
Engine: SlipIQ
Positioning: The hedge fund of tennis markets
Core niche: tennis first-set derivative markets
Main live markets:
- First-set correct-score clusters
- Grand Slam first-set winner comfort signals
- Shadow-tracked research lanes
```

---

## Current System Architecture

```txt
API Tennis
  -> GitHub Actions scanner
  -> Supabase live_signals ledger
  -> Supabase duplicate delivery guard
  -> Telegram Core / Quant channels
  -> Supabase settlement workflow
  -> Daily/mature Proof Vault recap
  -> Whop checkout + member dashboard
```

### What each platform does

```txt
GitHub Actions
- Runs the scanner every 2 hours
- Runs settlement every 2 hours
- Runs daily Proof Vault recaps
- Runs historical research / strategy discovery workflows

API Tennis
- Upcoming fixtures
- First-set correct-score odds
- First-set winner odds
- Results used for settlement

Supabase
- Permanent proof ledger
- Open/settled signal state
- Telegram delivery log
- Deduped proof / ROI queries

Telegram
- Fast live delivery terminal
- Core and Quant private signal channels
- Free proof channel later for delayed proof/education

Whop
- Checkout
- Paid access instructions
- Telegram onboarding links
- Proof Vault / Signal Receipt archive
- Future API-based member audits and access automation
```

---

## Product Tiers

### Free Proof Vault

Purpose:

```txt
- delayed proof highlights
- education
- weekly recap posts
- no live private signals
```

### Core Terminal

Core receives:

```txt
- Core exact-score signals
- Grand Slam Comfort signals
- mature proof recaps
- simple signal format
- no bookmaker names shown publicly
```

### Quant Terminal

Quant receives:

```txt
- everything Core receives
- VIP-only exact-score lanes
- deeper proof recaps
- future Stacked Confidence notes
- later: Research Watchlist summaries after enough proof
```

### Research Watchlist

Research lanes are **not sent to Core or Quant by default**.

They are tracked in Supabase only until enough live proof exists.

---

## Live Strategy Lanes

### Core exact-score lane

```txt
Lane: CORE_P1_ATP_GS_BET365
Access: CORE_AND_VIP
Market: Correct Score 1st Half
Cluster: 6:3 / 6:4
Book stored internally: bet365
Tournament group: GRAND_SLAM
```

### WTA mirror lane

```txt
Lane: CORE_P1_MIRROR_WTA_OTHER
Access: CORE_AND_VIP
Market: Correct Score 1st Half
Cluster: 6:3 / 6:4 / 7:5
Tour: WTA
Tournament group: OTHER_TOUR
```

### Quant / VIP Core Plus lane

```txt
Lane: VIP_P1_ATP_GS_MULTI
Access: VIP_ONLY
Market: Correct Score 1st Half
Cluster: 6:3 / 6:4
Books stored internally: bet365 / 1xBet / 10Bet
Tournament group: GRAND_SLAM
```

### Original realistic V3 lane

```txt
Lane: VIP_P2_V3_SHAPE
Access: VIP_ONLY
Market: Correct Score 1st Half
Cluster: 3:6 / 4:6 / 5:7
Minimum grouped odds: 3.50
Trigger score: 4:6
Trigger odds range: 6.25 to 6.99
```

This is the corrected realistic V3 version. The older dream version based on assumed ~7.0 grouped odds is not used as production logic.

### Comfort lane

```txt
Lane: COMFORT_FIRST_SET_FAVORITE_GS_1XBET
Access: CORE_AND_VIP
Market: Home/Away (1st Set)
Tournament group: GRAND_SLAM
Favorite odds range: 1.50 to 1.65
Historical model context: 75.17% hit rate over 149 historical signals
```

The Comfort lane is the lower-variance trust layer. It is treated separately from exact-score lanes.

### Research P2 Grand Slam sniper lane

```txt
Lane: RESEARCH_P2_GS_26_46_BET365
Access: RESEARCH_ONLY
Market: Correct Score 1st Half
Cluster: 2:6 / 4:6
Book stored internally: bet365
Tournament group: GRAND_SLAM
Grouped odds: 2.50 to 4.50
Required skew: EXTREME
Telegram: disabled by design
Supabase: enabled
```

This was added after the fast wide-net future-holdout audit found a promising P2 Grand Slam cluster. It is shadow-tracked only until more live proof exists.

---

## Confidence Layer Plan

Signals should eventually display one of these branded confidence labels:

```txt
Core Edge
- normal exact-score price edge

Comfort Confidence
- lower-variance Grand Slam first-set winner edge

Stacked Confidence
- exact-score edge and Comfort model align on the same match/side

Research Watchlist
- shadow-tracked strategy under live validation
```

Important rule:

```txt
Do not use fake percentages like 95% confidence.
Use branded model labels, not guaranteed claims.
```

---

## Current Live Proof Snapshot

Example latest observed state from Supabase during launch tracking:

```txt
Raw settled signal rows: 24
Wins: 12
Losses: 12
Hit rate: 50.00%
Average odds: 2.920
Profit: +10.1669u
Flat ROI: +42.36%

Deduped unique settled ideas: 16
Wins: 8
Losses: 8
Hit rate: 50.00%
Average odds: 2.905
Profit: +6.9813u
Flat ROI: +43.63%
```

Use deduped unique ideas for public proof whenever possible. Raw signal rows can include repeated scan windows for the same match/lane idea.

Risk language:

```txt
Live proof is early.
Historical and live results do not guarantee future performance.
Use 0.5% to 1.0% flat staking for public guidance.
```

---

## Main Workflows

### 1. Live scanner and Telegram delivery

```txt
Workflow:
.github/workflows/api-tennis-live-first-set-lab-scanner.yml

Scripts:
scripts/api_tennis_live_first_set_lab_scanner.mjs
scripts/first_set_lab_supabase_deliver.mjs
```

Schedule:

```txt
Every 2 hours at minute 17
```

What it does:

```txt
1. Pulls API Tennis fixtures.
2. Pulls API Tennis odds.
3. Builds exact-score, comfort, and research candidate rows.
4. Dedupes candidates into signal rows.
5. Writes artifact CSV/JSON files.
6. Upserts every signal into Supabase live_signals.
7. Uses telegram_signal_deliveries as a duplicate guard.
8. Sends Core/Quant Telegram alerts only when allowed.
9. Skips Telegram for RESEARCH_ONLY rows.
```

Manual run:

```txt
Actions -> API Tennis Live First Set Lab Scanner -> Run workflow
```

Manual defaults:

```txt
send_telegram: true
```

For dry-run testing, manually set:

```txt
send_telegram: false
```

Important implementation detail:

```txt
The scanner step itself always runs with --send-telegram=false.
That is intentional.
The real sending happens in the Supabase delivery guard step.
Check first_set_lab_supabase_delivery_summary.json for the true send result.
```

Successful delivery should show:

```txt
telegram_attempted > 0
telegram_sent > 0
errors: []
```

Scheduled live sending requires this GitHub Secret:

```txt
ENABLE_LIVE_TELEGRAM_SEND=true
```

If scheduled runs are scanning but not sending, check this secret first.

Artifacts:

```txt
first_set_lab_live_report.md
first_set_lab_live_summary.json
first_set_lab_live_signals.csv
first_set_lab_live_raw_candidates.csv
first_set_lab_live_telegram_log.csv
first_set_lab_supabase_delivery_report.md
first_set_lab_supabase_delivery_summary.json
first_set_lab_supabase_delivery_log.csv
```

---

### 2. Signal settlement workflow

```txt
Workflow:
.github/workflows/first-set-lab-settle-signals.yml

Script:
scripts/first_set_lab_settle_signals.mjs
```

Schedule:

```txt
Every 2 hours at minute 47
```

What it does:

```txt
1. Reads open Supabase live_signals.
2. Checks API Tennis results.
3. Extracts first-set score.
4. Grades exact-score clusters and first-set winner signals.
5. Updates status = settled.
6. Writes first_set_score, settled_win, settled_at.
7. Exports settlement artifact logs.
```

Manual run:

```txt
Actions -> First Set Lab Settle Signals -> Run workflow
```

Inputs:

```txt
limit: 250
max_future_hours: 1
```

Artifacts:

```txt
first_set_lab_settlement_report.md
first_set_lab_settlement_summary.json
first_set_lab_settlement_log.csv
```

---

### 3. Daily Proof Vault recap

```txt
Workflow:
.github/workflows/first-set-lab-daily-recap.yml

Script:
scripts/first_set_lab_daily_recap.mjs
```

Schedule:

```txt
Daily at 23:30 UTC
```

Purpose:

```txt
The Supabase ledger updates instantly.
Telegram recaps wait until the window is mature enough.
```

Default gates:

```txt
min_paid_settled: 10
max_paid_open: 3
core_min_units: 0
vip_min_units: -1
force_final: false
send_free_proof: false
```

This prevents ugly partial recaps like:

```txt
2W / 6L
-2.45u
18 open signals
```

from being blasted too early.

Manual run:

```txt
Actions -> First Set Lab Daily Proof Vault Recap -> Run workflow
```

Testing settings:

```txt
send_telegram: false
lookback_hours: 24
send_free_proof: false
force_final: false
min_paid_settled: 10
max_paid_open: 3
core_min_units: 0
vip_min_units: -1
```

Force a final honest recap even if red:

```txt
force_final: true
```

Artifacts:

```txt
first_set_lab_daily_recap_report.md
first_set_lab_daily_recap_summary.json
first_set_lab_daily_recap_messages.csv
```

---

### 4. Historical full odds warehouse

```txt
Workflow:
.github/workflows/api-tennis-full-historical-odds-warehouse.yml
```

Purpose:

```txt
Builds the historical API Tennis odds warehouse used by research workflows.
```

Main output artifact:

```txt
api-tennis-full-historical-odds-warehouse-combined
```

This artifact feeds the wide-net strategy discovery workflow.

---

### 5. Fast wide-net strategy discovery

```txt
Workflow:
.github/workflows/api-tennis-wide-net-strategy-discovery.yml

Script:
scripts/api_tennis_wide_net_strategy_discovery.py
```

Purpose:

```txt
Find new 2-score and 3-score first-set correct-score clusters.
Test price buckets, skew buckets, tournament groups, tour, book groups, and favorite/underdog status.
Run walk-forward + future-holdout validation.
Simulate daily caps and 1% / 2% / 4% compounding.
```

Default inputs:

```txt
artifact_name: api-tennis-full-historical-odds-warehouse-combined
start_bankroll: 5000
min_bets: 100
min_test_bets: 15
min_validate_bets: 15
min_future_bets: 20
max_rules: 800
books: bet365,1xBet
```

Main outputs:

```txt
wide_net_strategy_report.md
wide_net_strategy_audit.json
wide_net_strategy_cards.json
wide_net_strategy_leaderboard.csv
wide_net_strategy_top_snipers.csv
wide_net_strategy_research_watchlist.csv
wide_net_strategy_train_test.csv
wide_net_strategy_risk_sims.csv
wide_net_strategy_monthly.csv
wide_net_strategy_bankroll_curves.json
```

Interpretation:

```txt
wide_net_strategy_top_snipers.csv
- rules that pass the clean future-holdout checks

wide_net_strategy_research_watchlist.csv
- promising rules that hit old sniper thresholds but are not production-ready
```

Current research result that became a shadow lane:

```txt
RESEARCH_P2_GS_26_46_BET365
P2 2:6 / 4:6
Grand Slam
bet365
Grouped odds 2.50 to 4.50
Research-only until enough live proof exists
```

---

### 6. Signal Room Volume Lite

```txt
Workflow:
.github/workflows/api-tennis-signal-room-volume-lite.yml

Script:
scripts/api_tennis_signal_room_volume_lite.py
```

Purpose:

```txt
Focused historical test for current Core/Quant room logic.
It answers: what does Core get, what does Quant get, what is the volume, ROI, drawdown, and compounding profile?
```

Use this to understand the room-level business model, not to discover brand-new lanes.

---

## Required GitHub Secrets

### API Tennis

Use at least one valid key name:

```txt
API_TENNIS_KEY
APITENNIS_API_KEY
API_TENNIS_API_KEY
```

### Telegram

```txt
TELEGRAM_BOT_TOKEN
TELEGRAM_CORE_CHAT_ID
TELEGRAM_VIP_CHAT_ID
TELEGRAM_FREE_CHAT_ID   # optional / only needed for free proof recaps
```

### Supabase

```txt
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

### Live send control

```txt
ENABLE_LIVE_TELEGRAM_SEND=true
```

If this is not true, scheduled scanner runs will not send Telegram messages even if they generate signals.

### Whop / future access automation

```txt
WHOP_API_KEY
WHOP_CORE_PRODUCT_ID
WHOP_QUANT_PRODUCT_ID
```

Never commit API keys to the repository. Never paste active API keys into public files or screenshots. If a key is exposed, rotate it immediately.

---

## Supabase Tables

The current live system depends on at least these tables.

### live_signals

Purpose:

```txt
Permanent signal ledger.
Every signal becomes a timestamped receipt.
```

Important columns:

```txt
signal_key
signal_type
selected_side
selected_side_odds
market_source
scanned_at
event_key
event_date
event_time
starts_at
minutes_to_start
event_status
match_name
player1
player2
tour
tournament_group
tournament_name
internal_bookmaker
market_name
strategy_lane
public_signal_name
access
score_cluster
public_target
trigger_score
trigger_odds
score_odds_json
grouped_odds
break_even_hit_rate
historical_hit_rate
historical_roi
historical_sample
model_edge_vs_breakeven
public_tier
signal_quality
status
first_set_score
settled_win
settled_at
created_at
updated_at
```

### telegram_signal_deliveries

Purpose:

```txt
Duplicate guard for Telegram sends.
Prevents the same signal/room pair from sending twice after successful delivery.
```

Important columns:

```txt
signal_id
signal_key
room_key
telegram_chat_id
telegram_message_id
sent_ok
skipped_duplicate
error_json
message_preview
```

Recommended future tables:

```txt
whop_members
telegram_members
access_logs
signal_results_daily
proof_vault_windows
```

---

## Useful Supabase Queries

### Current live status

```sql
select
  count(*) as total_signals,
  count(*) filter (where status = 'open') as open_signals,
  count(*) filter (where status = 'settled') as settled_signals,
  count(*) filter (where status = 'settled' and settled_win = true) as settled_wins,
  count(*) filter (where status = 'settled' and settled_win = false) as settled_losses,
  max(scanned_at) as latest_scan,
  max(settled_at) as latest_settlement
from public.live_signals;
```

### Raw settled ROI

```sql
select
  count(*) as bets,
  count(*) filter (where settled_win = true) as wins,
  count(*) filter (where settled_win = false) as losses,
  round(avg(coalesce(selected_side_odds::numeric, grouped_odds::numeric)), 3) as avg_odds,
  round(sum(case when settled_win then coalesce(selected_side_odds::numeric, grouped_odds::numeric) - 1 else -1 end), 4) as profit_units,
  round((sum(case when settled_win then coalesce(selected_side_odds::numeric, grouped_odds::numeric) - 1 else -1 end) / nullif(count(*), 0)) * 100, 2) as flat_roi_pct
from public.live_signals
where status = 'settled';
```

### Deduped unique idea ROI

```sql
with settled as (
  select
    *,
    coalesce(selected_side_odds::numeric, grouped_odds::numeric) as odds,
    case when settled_win then coalesce(selected_side_odds::numeric, grouped_odds::numeric) - 1 else -1 end as profit_units
  from public.live_signals
  where status = 'settled'
), deduped as (
  select distinct on (
    match_name,
    event_date,
    strategy_lane,
    signal_type,
    coalesce(score_cluster, ''),
    coalesce(selected_side, '')
  )
    *
  from settled
  order by
    match_name,
    event_date,
    strategy_lane,
    signal_type,
    coalesce(score_cluster, ''),
    coalesce(selected_side, ''),
    settled_at asc,
    scanned_at asc
)
select
  count(*) as unique_ideas,
  count(*) filter (where settled_win = true) as wins,
  count(*) filter (where settled_win = false) as losses,
  round(avg(odds), 3) as avg_odds,
  round(sum(profit_units), 4) as profit_units,
  round((sum(profit_units) / nullif(count(*), 0)) * 100, 2) as flat_roi_pct
from deduped;
```

---

## Testing and Sending Playbook

### Test live scanner without Telegram

```txt
Actions -> API Tennis Live First Set Lab Scanner
send_telegram: false
```

Check:

```txt
first_set_lab_live_summary.json
first_set_lab_live_report.md
first_set_lab_live_signals.csv
first_set_lab_supabase_delivery_summary.json
```

Expected dry-run behavior:

```txt
signals_upserted > 0 if candidates exist
telegram_attempted = 0
telegram_sent = 0
errors = []
```

### Send live Telegram signals manually

```txt
Actions -> API Tennis Live First Set Lab Scanner
send_telegram: true
```

Check:

```txt
first_set_lab_supabase_delivery_summary.json
```

Expected live-send behavior:

```txt
telegram_attempted > 0
telegram_sent > 0
errors = []
```

If there are signals but no Telegram messages:

```txt
1. Check send_telegram input.
2. Check ENABLE_LIVE_TELEGRAM_SEND for scheduled runs.
3. Check TELEGRAM_BOT_TOKEN.
4. Check TELEGRAM_CORE_CHAT_ID / TELEGRAM_VIP_CHAT_ID.
5. Check first_set_lab_supabase_delivery_summary.json.
6. Check telegram_signal_deliveries for duplicate guard rows.
```

### Settle results manually

```txt
Actions -> First Set Lab Settle Signals
limit: 250
max_future_hours: 1
```

If results are missing, wait for API Tennis to publish first-set scores and rerun later.

### Test recap gates

```txt
Actions -> First Set Lab Daily Proof Vault Recap
send_telegram: false
```

Check:

```txt
first_set_lab_daily_recap_report.md
first_set_lab_daily_recap_summary.json
```

If a recap is held, check the gate reason. This is intentional when the proof window is immature or too many signals are still open.

---

## How to Test New Strategies / Systems

Do not add a new strategy straight into Core or Quant.

Use this path:

### Step 1: Research historically

Run:

```txt
API Tennis Wide-Net Strategy Discovery
```

Look for:

```txt
ROI > 15%
Hit rate > 38% for exact-score sniper lanes
Max drawdown < 20% at 2% staking
Enough future-holdout sample
No future ROI collapse flag
```

### Step 2: Put promising strategies into Research Watchlist

Add the strategy to the live scanner as:

```txt
access: RESEARCH_ONLY
telegram_room: Research
Telegram delivery: disabled
Supabase tracking: enabled
```

### Step 3: Let it settle live

Track:

```txt
open count
settled count
wins/losses
flat units
flat ROI
average odds
deduped unique idea ROI
```

### Step 4: Require live proof before graduation

Minimum before considering Core/Quant:

```txt
20+ live settled unique ideas for early watch
50+ live settled unique ideas for serious review
100+ live settled unique ideas before heavy marketing
```

### Step 5: Graduate carefully

If a research lane survives live proof:

```txt
Research Watchlist -> Quant-only beta -> Core/Quant production
```

Never graduate a strategy based on one big win.

---

## Whop Setup

Whop is the checkout and paid member dashboard.

Current intended flow:

```txt
Website / social
  -> Whop checkout
  -> Whop post-purchase instructions
  -> private Telegram invite link
  -> Telegram live signal terminal
  -> Whop Proof Vault / Signal Receipt archive
```

### Core Telegram link handling

Core buyers should only see the Core private Telegram invite after purchase.

### Quant Telegram link handling

Quant buyers should only see the Quant private Telegram invite after purchase.

### Whop API future use

The Whop API should eventually support:

```txt
- active member audit
- Core vs Quant buyer verification
- cancellation/refund checks
- Telegram access mismatch reports
- possible Signal Receipt / Proof Vault automation if Whop allows content posting
```

Do not paste active Whop API keys into chat or commit them to the repo. Use GitHub Secrets only.

### Recommended Whop dashboard sections

```txt
Start Here
Telegram Access
Signal Receipt System
Confidence Layer
Proof Vault
$5K Lab
Weekly Calibration Reports
Risk Rules
FAQ
```

Signal Receipt concept:

```txt
Every signal gets archived with:
- match
- market
- target
- covered score cluster or selected side
- grouped price
- confidence layer
- timestamp
- final first-set score
- win/loss result
```

---

## API Tennis Market Notes

API Tennis labels tennis first-set correct score as:

```txt
Correct Score 1st Half
```

For tennis, this is treated as first-set correct score.

Score labels:

```txt
P1 scores:
6:0, 6:1, 6:2, 6:3, 6:4, 7:5, 7:6

P2 scores:
0:6, 1:6, 2:6, 3:6, 4:6, 5:7, 6:7
```

Grouped odds formula:

```txt
grouped_odds = 1 / sum(1 / individual_score_odds)
```

Example:

```txt
P1 6:3 / 6:4 grouped odds
= 1 / (1/odds_6_3 + 1/odds_6_4)
```

Comfort market:

```txt
Home/Away (1st Set)
```

---

## Risk and Compliance Rules

Use this language:

```txt
price intelligence
probability edge
historical model context
break-even rate
paper-tracked signal
no-deletion proof ledger
flat staking
18+ decision-support only
```

Avoid this language:

```txt
guaranteed
lock
risk-free
automatic profit
sure win
get rich
```

Public staking guidance:

```txt
0.5% to 1.0% flat stake per signal
```

Internal/aggressive research simulations can test:

```txt
2% compounding
4% compounding
5% compounding for Comfort-only simulations
```

Do not promote aggressive compounding as guaranteed or safe.

---

## Local Development

Frontend app stack:

```txt
React + Vite
TypeScript
Tailwind CSS
Telegram Web App SDK
Zustand
Recharts
Supabase/PostgreSQL
```

Commands:

```bash
npm install
npm run dev
npm run build
npm run test
```

Most scanner/research scripts are designed for GitHub Actions, but can be run locally if API keys, Supabase credentials, and input artifacts are available.

---

## Current Priorities

```txt
1. Keep scanner and settlement stable.
2. Keep scheduled Telegram sending live only through Supabase duplicate guard.
3. Track deduped proof, not just raw rows.
4. Keep research lanes shadow-only until enough live proof exists.
5. Build Whop as a premium Proof Vault / Signal Receipt dashboard.
6. Add Confidence Layer fields to signals.
7. Add Whop member audit once WHOP_API_KEY is safely stored in GitHub Secrets.
```

---

## Operator Rule

```txt
Ledger updates instantly.
Signals send through the duplicate guard.
Recaps wait until the proof window is meaningful.
Research tracks silently before it sells.
```
