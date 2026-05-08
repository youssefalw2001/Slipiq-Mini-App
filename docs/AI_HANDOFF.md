# SlipIQ AI Handoff

This document is the permanent handoff note for any future AI assistant, Claude Code tab, or developer working on SlipIQ.

## Product identity

SlipIQ is a Telegram Mini App for science-based sports slip intelligence. The launch wedge is tennis first-set correct-score intelligence, not generic betting tips.

Current positioning:

```txt
Bring your slip. SlipIQ grades it, shows weak legs, and rebuilds it only when the research engine finds a better setup.
```

Important safety language:

```txt
Research Mode
No guarantees
Use responsibly
18+
```

Do not use words like:

```txt
guaranteed
lock
sure win
free money
cannot lose
```

## Tech stack

- React + Vite
- TypeScript
- React Router with HashRouter for Render/Telegram deep links
- Zustand slip store
- Supabase Edge Functions + database
- API-Tennis provider
- GitHub Actions for scheduled refresh and backtests
- Render deployment
- Telegram Mini App UX

## Current app features

Implemented or partially implemented:

- Home feed with live/seed mode
- First Set Lab / opportunity cards
- Slip Builder
- IQ Rebuild V1
- Safer / Balanced / Moonshot rebuild mode selector
- Ops Control Center at `/#/ops`
- Scheduled data refresh workflow
- Blind Strategy Simulation workflow

## Backend/data pipeline

Core path:

```txt
API-Tennis -> Supabase data-refresh Edge Function -> Supabase tables -> SlipIQ frontend
```

The app reads live data through `VITE_SLIPIQ_DATA_API_URL`.

The refresh workflow uses GitHub secret:

```txt
SLIPIQ_REFRESH_SECRET
```

The backtest/simulation workflows require:

```txt
API_TENNIS_KEY
```

Optional failure alert secrets:

```txt
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_CHAT_ID
```

## Strategy history and findings

### Original broad SetFox Strict

Old SetFox Strict focused on:

```txt
ITF
a normal first-set score family
odds_12_18
no tiebreaks
no doubles
positive EV/edge
```

Blind sim result from independent mode over 2025-05-01 to 2026-05-06:

```txt
Bets: 1,253
Wins: 83
Hit rate: 6.62%
Average odds: x15.11
Profit: -55.6u
ROI: -4.44%
Positive months: 5/13
```

Verdict: Not strong enough to be the main product claim.

### Grass Lab Candidate

The strongest current research signal is Grass Lab Candidate:

```txt
surface = grass
odds_bucket = odds_5_8
tournament_level = tour_other
min_probability >= 0.03
min_ev >= 0
min_edge >= 0
```

Blind sim v1 independent result over 2025-05-01 to 2026-05-06:

```txt
Rows loaded: 450,117
Unique matches: 37,525
Bets: 1,679
Wins: 273
Hit rate: 16.26%
Average odds: x7.27
Profit: +288.05u
ROI: +17.16%
Positive months: 9/13
Max drawdown: 45.55u
```

Verdict: Promising research signal, but not final proof yet.

## Important current concern

The Grass Lab result appears in many calendar months, including outside the normal grass season. This may mean:

```txt
1. Surface classifier is wrong
2. API-Tennis has year-round lower-level grass events
3. Tournament names are being misread
```

Before any full product pivot or public claims, audit:

```txt
- one pick per match
- actual tournament names in Grass Lab selected bets
- surface classification quality
- monthly-surface breakdown
- model probability calibration
- odds realism
```

## Current next PR/workstream

The current workstream is Blind Sim V2 Audit.

Goal:

```txt
Make the strategy tester more trustworthy before pivoting the app around Grass Lab.
```

V2 audit should:

- enforce max one selected score outcome per match by default
- emit surface audit output
- emit top tournament examples
- emit monthly surface breakdown
- emit selected audit sample rows
- emit calibration report comparing model probability buckets to actual hit rate
- emit strategy freeze manifest
- keep all app UI unchanged

## How to run Blind Strategy Simulation

In GitHub:

```txt
Actions -> Blind Strategy Simulation -> Run workflow
```

Short smoke test:

```txt
start_date: 2026-05-01
end_date: 2026-05-06
model_mode: independent
one_pick_per_match: 1
```

Full research test:

```txt
start_date: 2025-05-01
end_date: 2026-05-06
model_mode: independent
one_pick_per_match: 1
```

Artifact to inspect first:

```txt
results/independent/blind-sim-summary.json
```

Then inspect:

```txt
results/independent/blind-sim-audit-samples.csv
results/independent/blind-sim-monthly-surface.csv
results/independent/blind-sim-bets.csv
```

## Decision rules before pivoting app

Do not fully pivot to Grass Lab unless V2 audit shows:

```txt
Grass Lab remains positive with one-pick-per-match
ROI is not carried by one small tournament group
Surface/tournament examples make sense
Monthly results remain reasonably stable
Model calibration issues are understood and copy is adjusted
```

If Grass Lab survives V2 audit, the next app PR should be:

```txt
Grass Lab Strategy Pivot
```

That PR should:

- make Grass Lab the main scanner identity
- show a proof/research card with blind sim stats
- update IQ Rebuild modes around Grass Lab
- downgrade old SetFox Strict to experimental/research
- add a Proof Log skeleton
- keep no-guarantee language everywhere

## Product roadmap after audit

Recommended order:

```txt
1. Blind Sim V2 Audit
2. Grass Lab Strategy Pivot if audit passes
3. Public Proof Log
4. Share-card export
5. Onboarding explaining Grass Lab and why rejection is valuable
6. Founding member/paywall screen
7. Private beta with 10-25 users
```

## Important instruction for future AI/developers

Do not chase random new betting strategies. The current priority is to validate or reject Grass Lab cleanly. If it passes, focus the app around it. If it fails, keep SlipIQ as a research/slip grading product and continue strategy search with transparent proof logs.
