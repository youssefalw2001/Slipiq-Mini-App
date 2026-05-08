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
- Score Hunter / First Set Lab opportunity cards
- Slip Builder
- IQ Rebuild V1
- Safer / Balanced / Moonshot rebuild mode selector
- Ops Control Center at `/#/ops`
- Scheduled data refresh workflow
- Blind Strategy Simulation workflow
- Proof Log screen at `/#/proof`

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

### Score Hunter Candidate, formerly Grass Lab Candidate

The strongest current research signal was originally called Grass Lab Candidate:

```txt
surface = grass
odds_bucket = odds_5_8
tournament_level = tour_other
min_probability >= 0.03
min_ev >= 0
min_edge >= 0
```

Important: the name Grass Lab is deprecated. Surface labels are not reliable enough for product claims. The signal should be positioned as Score Hunter Lab / Set 1 Score Hunter, not as a grass-court strategy.

Blind sim V2 audit independent result over 2025-05-01 to 2026-05-06 with one pick per match:

```txt
Rows loaded: 450,093
Unique matches: 37,523
Bets: 1,664
Wins: 268
Hit rate: 16.11%
Average odds: x7.26
Profit: +268.2u
ROI: +16.12%
Positive months: 9/13
Max drawdown: 46.45u
Duplicate match picks after guard: 0
```

Verdict: Promising research signal that survived a stricter audit. Not final proof until live paper tracking verifies odds availability and execution.

## Important current concern

The old Grass Lab result appears in many calendar months, including outside the normal grass season. This likely means the surface label is unreliable.

Before any full product claims, audit and live-track:

```txt
- actual tournament names in selected bets
- odds availability before match start
- one pick per match
- monthly surface breakdown
- model probability calibration
- losing streak/drawdown behavior
```

## Current next PR/workstream

The current workstream is the Score Hunter Pivot.

Goal:

```txt
Rename Grass Lab to Score Hunter Lab, show proof transparently, and prepare live paper tracking.
```

This workstream should:

- keep all safety copy: Research Mode, No guarantees, Use responsibly
- make Score Hunter the main research lane
- downgrade old SetFox Strict to legacy/experimental
- add or maintain a Proof Log screen
- avoid claiming future profit
- avoid using surface as a public product claim

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

## Decision rules before charging hard

Do not launch strong paid claims unless:

```txt
Score Hunter remains positive with one-pick-per-match
ROI is not carried by one small tournament group
Live paper tracking confirms odds are available to users
Monthly results remain reasonably stable
Model calibration issues are understood and copy is adjusted
Users are clearly warned about low hit rate and losing streaks
```

## Product roadmap after Score Hunter pivot

Recommended order:

```txt
1. Score Hunter Pivot
2. Live Paper Proof Log with every signal and result
3. Bankroll Autopilot / Patience Score
4. Share-card export
5. Onboarding explaining high-odds value and losing streaks
6. Founding member/paywall screen
7. Private beta with 10-25 users
```

## Important instruction for future AI/developers

Do not chase random new betting strategies. The current priority is to validate Score Hunter live and build transparent proof/logging around it. If live odds or results fail, keep SlipIQ as a research/slip grading product and continue strategy search with transparent proof logs.
