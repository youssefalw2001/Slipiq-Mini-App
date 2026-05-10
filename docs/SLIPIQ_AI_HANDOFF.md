# SlipIQ AI Handoff Context

Use this file as the first context source for any new AI/chat tab working on SlipIQ.

## Project identity

SlipIQ is a Telegram Mini App and research engine for tennis first-set correct-score probability intelligence.

Core brand positioning:

- Tagline: `Don’t guess. Calculate.`
- Flagship feature: First Set Lab
- Main launch wedge: tennis first-set correct-score edge, especially 4-6 and related second-player first-set scorelines.
- Product stance: decision support and probability intelligence, not guaranteed picks.

## Tech stack

Frontend:

- React + Vite + TypeScript
- Tailwind-style dark mobile UI
- Telegram Mini App SDK
- Zustand
- Recharts

Backend/live research:

- Supabase project currently used live: `afemheuneiqwoaambmvw`
- Supabase Edge Functions
- Supabase tables for live observation logs/runs
- API-Tennis for fixtures, odds, and result/first-set score enrichment
- GitHub Actions are used as the research/test runner

GitHub repo:

- `youssefalw2001/Slipiq-Mini-App`

## Current strongest strategy

The best historical strategy so far is NOT the old SetFox 12-18 odds rule.

Current main strategy:

```txt
Official V2:
score = 4-6
tournament_level = tour_other / lower-tier style bucket
odds = 5.50 to 7.50
singles only
pre-match only
one pick per match
void/retired/cancelled excluded/refunded
```

Ultra strategy:

```txt
Ultra V1:
score = 4-6
tournament_level = tour_other
odds = 6.50 to 6.99
lead window target = 120-299 minutes before start
```

3-6 status:

```txt
3-6 is not the main money strategy yet.
It is a companion/shadow candidate because many 4-6 misses are actual 3-6.
Use it only as shadow/proxy until real live 3-6 odds are logged.
```

## Historical test results from enriched 13-month file

The enriched blind-sim file contained:

```txt
Total rows: 7,688
Actual first-set scores resolved: 7,500
Void/retired/cancelled: 187
Unknown: 1
```

Official V2 from player-floor artifact:

```txt
Bets: 1,234
Wins: 219
Hit rate: 17.75%
Profit: +322.8u
ROI: +26.16%
Max drawdown: 38.4u
Worst losing streak: 33
```

Ultra V1:

```txt
Bets: 227
Wins: 50
Hit rate: 22.03%
Profit: +106.9u
ROI: +47.09%
Max drawdown: 14.85u
Worst losing streak: 12
```

Player-floor top filters from artifact:

```txt
Top 25% player_floor_4_6_score:
Bets: 310
Hit rate: 19.68%
Profit: +121u
ROI: +39.03%
Max drawdown: 27.65u
Worst streak: 23

Top 20% player_floor_4_6_score:
Bets: 248
Hit rate: 20.16%
Profit: +106.9u
ROI: +43.10%
Max drawdown: 22.65u
Worst streak: 17
```

Discovery/blind from same artifact:

```txt
Discovery first 6 months:
631 bets
ROI: +15.21%
Profit: +95.95u

Blind last 7 months:
603 bets
ROI: +37.62%
Profit: +226.85u
Positive months: 6 of 7
```

Important confidence note:

```txt
This is promising historical evidence, not live execution proof.
Live proof still requires controlled live odds + settled win/loss data.
```

## Player-floor model meaning

Player-floor V2 is a no-same-day-leakage expanding-history model.

It calculates player tendencies using prior dates only:

- Player 1: historical tendency to lose first sets 4-6 / 3-6
- Player 2: player-centric tendency to win equivalent scores 6-4 / 6-3
- Combined scores:
  - `player_floor_4_6_score`
  - `player_floor_3_6_score`
  - `player_floor_4_6_or_3_6_score`
  - `p2_first_set_pressure_score`

Accuracy controls used:

- No same-day leakage
- Unique match dedupe before updating player history
- Player-centric conversion: scoreboard 4-6 means player 2 won 6-4 from player 2 perspective
- Shrinkage with `prior_weight = 20`
- Low-sample players are not overtrusted

## 3-6 companion simulation

Proxy result using same odds as 4-6:

```txt
4-6 only:
ROI: +26.16%
Worst streak: 33

80/20 4-6 + 3-6 proxy:
Hit rate: ~32.50%
ROI: +21.88%
Worst streak: 17
```

Interpretation:

- 3-6 reduces streak pain.
- 3-6 lowers ROI.
- Do not bet 3-6 until real live 3-6 odds are logged.

## Supabase live system

Live observation functions/tables have been built in Supabase.

Important live workflow:

```txt
private-live-observation-auto-cycle
private-live-observation-cycle-v3_odds_tracking
private-live-observation-resolver
```

The auto cycle scans live/pre-match API-Tennis fixtures and logs strict candidates.

The resolver was deployed to fill:

```txt
actual_first_set_score
result = won / lost / void / unknown
profit_units_if_flat
settled_at
settlement_notes
```

At the last known checkpoint:

```txt
Live automation: working
Odds tracking: working
Strict candidates: logging
Result settlement: waiting for matches to start/finish
```

Current live proof status:

```txt
Odds availability looked good so far.
No major odds/API errors seen.
No candidate dropped below x5.50 in early checks.
But settled live ROI proof was not complete yet.
```

## GitHub Actions workflows

The user runs tests mainly through GitHub Actions, not local terminal.

Important workflows:

```txt
Blind Strategy Simulation
Enrich Blind Sim First Set Scores
Player Floor First Set Analysis V2
Blind Player Floor Pipeline
Deploy Supabase Function
```

The latest useful workflow:

```txt
Player Floor First Set Analysis V2
```

It expects an enriched CSV and outputs:

```txt
player-floor-first-set-analysis-v2 artifact
player-floor-analysis-summary.json
player-floor-analysis-summary.md
blind-sim-bets-player-floor-enriched.csv
```

The all-in-one fresh holdout workflow added:

```txt
Blind Player Floor Pipeline
```

Intended fresh holdout window:

```txt
2024-05-10 to 2025-05-09
```

Inputs to use:

```txt
start_date: 2024-05-10
end_date: 2025-05-09
window_days: 30
chunk_days: 3
model_mode: independent
block_tiebreak: 1
include_doubles: 0
max_plays_per_day: 5
stake_units: 1
prior_weight: 20
```

A YAML issue was patched around the workflow description/input parsing. If the workflow still fails, inspect the red error from the first failed step.

## What to do next

Priority order:

1. Make `Blind Player Floor Pipeline` run successfully on 2024-05-10 to 2025-05-09.
2. Upload the artifact back to ChatGPT.
3. Analyze:
   - Official V2
   - Ultra V1
   - Floor Elite top 20/25%
   - 3-6 companion proxy
   - blind/holdout month stability
4. If fresh holdout passes, update live Supabase observation to tag:
   - Official V2
   - Ultra V1
   - Floor Elite
   - Companion 3-6 Shadow
5. Keep real-money/live execution small until 100-300 settled live candidates confirm ROI.

## Risk management guidance

Do not overstate certainty.

Recommended live risk until proven:

```txt
1% to 1.5% per bet during live test
2%+ only after strong settled live sample
Do not use 10-20% risk per bet
```

Ultra theoretical Kelly appeared high, but practical risk should stay much lower due to uncertainty and losing streak risk.

## Tone for future AI responses

Be honest and skeptical.

Avoid phrases like:

- guaranteed
- lock
- free money
- safe bet
- cracked the code for sure

Use language like:

- promising historical edge
- needs live settlement proof
- odds execution risk
- sample-size risk
- slippage/bookmaker-limit risk

## Quick start prompt for new chat

Paste this in a new chat:

```txt
Read docs/SLIPIQ_AI_HANDOFF.md in my GitHub repo `youssefalw2001/Slipiq-Mini-App` first. We are working on SlipIQ, a tennis first-set correct-score strategy. Current main strategy is Official V2: 4-6, tour_other, odds 5.50-7.50. Ultra V1 is 4-6, odds 6.50-6.99. Player Floor V2 improved historical results using no-same-day leakage and shrinkage. Supabase project is `afemheuneiqwoaambmvw`. We use GitHub Actions as the test runner. Current task is to get Blind Player Floor Pipeline running for 2024-05-10 to 2025-05-09 and analyze the artifact honestly.
```
