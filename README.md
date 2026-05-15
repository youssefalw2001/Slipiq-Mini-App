# SlipIQ Mini App

**SlipIQ** is a Telegram Mini App for tennis first-set betting intelligence.

**Tagline:** Don't guess. Calculate.

SlipIQ is not a tipster product. It is a probability/price-intelligence system built to compare modeled probability vs real bookmaker prices, especially for niche first-set tennis markets.

---

## Current Flagship Strategy: V3

The active SlipIQ research strategy is called **V3**.

V3 means **Player 2 wins the first set** by one of these exact correct scores:

- `3:6`
- `4:6`
- `5:7`

From the match page perspective:

- Player 1 wins 3, 4, or 5 games
- Player 2 wins 6 or 7 games
- Player 2 wins first set
- First-set total games are usually 9-12

We group the three exact-score prices into one synthetic V3 price:

```txt
grouped_odds = 1 / (1/odds_3_6 + 1/odds_4_6 + 1/odds_5_7)
```

### Current V3 thresholds

```txt
below 3.30  = skip
3.30-3.49   = watch/test
3.50+       = A-tier if filters pass
4.00+       = S-tier if filters strongly pass
```

Break-even hit rate:

```txt
break_even = 1 / grouped_odds
```

Examples:

```txt
3.50 odds needs 28.57% hit rate
4.00 odds needs 25.00% hit rate
5.00 odds needs 20.00% hit rate
```

Important: do not claim edge just because hit rate is high. Always compare hit rate against average grouped odds and break-even.

---

## Current Research Direction

The current project is focused on building a reliable historical bet365 first-set correct-score dataset from OddsPortal.

Goal:

```txt
OddsPortal tournament results URL
-> decrypted archive endpoint
-> real player-vs-player events
-> event_id + encodeEventId/event_hash + match_url
-> decoded /match-event/.dat odds endpoint
-> provider 549 bet365 prices
-> V3 grouped odds
-> clean blind backtest
```

### Critical discovery breakthrough

OddsPortal uses encrypted endpoint payloads. We decoded the same payload format for both:

1. `/match-event/...dat` odds endpoints
2. `/ajax-sport-country-tournament-archive...` archive/event-list endpoints

The decoded archive endpoint exposes real match rows in `d.rows[]`, including fields such as:

```txt
id
encodeEventId
home-name
away-name
event-stage-name / status-id
match_url / URL fields
```

This means we no longer rely on fragile visible-page DOM scraping for match discovery.

---

## What Is Solved

```txt
Decoded bet365/provider 549 match odds: WORKING
Decoded archive/tournament event discovery: WORKING
Real match rows from tournament URLs: WORKING
Finished event filtering: WORKING after raw status recovery
Archive event -> match_url -> odds endpoint bridge: PARTIALLY WORKING
```

Latest successful bridge behavior:

```txt
20 events processed
11 rows had decoded odds working
5 rows had missing V3 prices
4 rows had no decoded match-event captured
```

So the odds path is alive. The remaining issue is clean result settlement.

---

## What Is Not Solved Yet

The system must not trust browser `page.url` or visible page text for final result settlement because OddsPortal route memory can show/pollute the wrong visible page.

Current fix direction:

```txt
market_url = intended archive match_url, not page.url
odds_status and result_status are separate
page body text is not trusted for first_set_score
odds-only rows are saved but not backtested
backtest only uses rows where odds_status=ok and result_status=ok
```

If odds are present but the first-set result cannot be trusted, row status should be:

```txt
status = odds_only
odds_status = ok
result_status = needs_result
```

That row is useful for the odds database but must not enter the backtest yet.

---

## Current Best Architecture

### Phase 1: Build match/event list

Use clean public browser context:

```txt
no cookies
no login
no bet365 visual filter
open tournament results URLs
decode archive endpoint
read d.rows[]
save event_id, event_hash, player1, player2, status, match_url
```

### Phase 2: Extract bet365 V3 odds

Use authenticated OddsPortal cookie/session only for odds phase:

```txt
use cookie/storage secret if available
open archive match_url
capture matching /match-event/.dat
decode endpoint
extract provider_id 549 bet365 correct-score prices
calculate V3 grouped odds
save odds rows immediately
```

### Phase 3: Result settlement

Do not trust visible browser text. Preferred result sources:

```txt
1. decoded archive result/set fields if present
2. decoded match-event result/set fields if present
3. separate trusted results dataset joined by event_id/event_hash if needed
```

### Phase 4: Blind backtest

Only backtest rows where:

```txt
status = ok
odds_status = ok
result_status = ok
all 3 V3 prices are present
first_set_score is standard
market_url is unique
```

---

## Main Workflows

### 1. Archive Event Parser Probe

```txt
.github/workflows/oddsportal-archive-event-parser-probe.yml
scripts/oddsportal_archive_event_parser_probe.py
```

Purpose:

```txt
Open tournament results URLs
Capture archive/tournament endpoints
Decrypt payloads
Parse d.rows[] into real events
Output parsed_real_events.csv and high_confidence_events.csv
```

Use this when debugging match discovery.

Recommended small run:

```txt
limit_pages: 5
wait_ms: 4500
max_body_bytes: 2000000
```

Success signs:

```txt
decoded_endpoint_count > 0
parsed_real_event_count > 0
high_confidence_event_count > 0
```

### 2. Archive Events To V3

```txt
.github/workflows/oddsportal-archive-events-to-v3.yml
scripts/oddsportal_archive_events_to_v3_scraper.py
```

Purpose:

```txt
Decode archive events
Filter finished matches
Process chunk by start_index + limit_total
Open each match_url
Capture/decode /match-event/.dat
Extract provider 549 bet365 V3 prices
Save bet365_master_decoded_v3.csv
Run guarded backtest if result rows are clean
```

Use this for odds extraction.

Very small smoke run:

```txt
limit_pages: 2
start_index: 0
limit_total: 1
wait_ms: 3000
pause_seconds: 0.5
include_unfinished: false
skip_bet365_filter: true
```

What to check:

```txt
rows_written: 1
odds_status_counts: ok or clear reason
result_status_counts: ok or needs_result
```

If odds work but result is not trusted, this is still progress:

```txt
odds_status = ok
result_status = needs_result
status = odds_only
```

### 3. Backtest From CSV

```txt
scripts/backtest_bet365_v3_from_csv.py
```

Purpose:

```txt
Run flat-stake V3 backtest from CSV
Only count clean rows
Prevent fake results from route-memory artifacts
```

Safety guards:

```txt
status must be ok
if odds_status exists, it must be ok
if result_status exists, it must be ok
market_url must be unique
first_set_score must be standard
confirmed V3 prices required
```

---

## Recommended Next Testing Path

Do not run big batches until one-row and ten-row smoke tests are clean.

### Step 1: One-row smoke

```txt
limit_pages: 2
start_index: 0
limit_total: 1
wait_ms: 3000
pause_seconds: 0.5
include_unfinished: false
skip_bet365_filter: true
```

Goal:

```txt
rows_written = 1
odds_status = ok or clear reason
market_url = intended match_url, not repeated stale page URL
```

### Step 2: Ten-row sample

```txt
limit_pages: 5
start_index: 0
limit_total: 10
wait_ms: 3000
pause_seconds: 0.5
include_unfinished: false
skip_bet365_filter: true
```

Goal:

```txt
odds rows collected
no fake repeated market_url
no fake repeated first_set_score from page text
```

### Step 3: Odds-only bulk collection

After smoke tests pass, collect odds in chunks:

```txt
start_index: 0,   limit_total: 100
start_index: 100, limit_total: 100
start_index: 200, limit_total: 100
start_index: 300, limit_total: 100
start_index: 400, limit_total: 100
```

The aim is to collect 400-600 odds rows first, then solve/join result settlement separately.

---

## Historical Blind Test Plan

Target sample:

```txt
400-600 valid rows first
then 1000+ rows once pipeline is stable
```

Valid row requirements:

```txt
real match/event row
completed match
provider 549 bet365 odds
3:6, 4:6, 5:7 all present
first_set_score trusted
unique market_url/event_id/event_hash
```

Flat-stake test first:

```txt
stake = $100 per signal
hit = first_set_score in {3:6, 4:6, 5:7}
win profit = stake * (grouped_odds - 1)
loss = -stake
```

Track:

```txt
bets
wins
losses
hit rate
average grouped odds
break-even hit rate
profit
ROI
max drawdown
tier distribution
```

Do not run compounding simulations until the flat-stake blind test is clean and meaningful.

---

## GitHub Secrets

Do not hardcode credentials.

Supported secrets:

```txt
ODDSPORTAL_USERNAME
ODDSPORTAL_PASSWORD
ODDSPORTAL_STORAGE_STATE_B64
ODDSPORTAL_COOKIES_JSON
ODDSPORTAL_COOKIES_JSON_B64
```

Preferred current path is cookie/session secret for authenticated odds phase. Public archive discovery should not need credentials.

---

## Important Safety / Product Rules

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

Also: this repository is for read-only odds research, data extraction, backtesting, and alerts. It should not include code that places bets automatically or bypasses sportsbook protections.

---

## Original Product Build Direction

The app product is still:

- React + Vite
- TypeScript
- Tailwind CSS
- Telegram Web App SDK
- Zustand
- Recharts
- Supabase/PostgreSQL later
- Telegram Stars payments later

But the current priority is the data/odds engine, because the math and price intelligence are the product.

MVP app build order after the data engine stabilizes:

1. First Set Lab probability engine
2. Static seed data / real odds feed import
3. Opportunity Card
4. Home Feed
5. Match Detail / Probability Deep Dive
6. Slip Builder
7. Telegram Mini App integration
8. Supabase persistence
9. Alerts
10. Premium / Telegram Stars

---

## Local Commands

```bash
npm install
npm run dev
npm run build
npm run test
```

Python workflow scripts are intended mainly for GitHub Actions, but can be run locally if dependencies and Playwright browsers are installed.
