# SlipIQ AI Handoff Memory

This is the canonical context file for any new AI/chat session working on SlipIQ. Read it before changing code, running GitHub Actions, interpreting Supabase data, or giving strategy advice.

Last updated: 2026-05-11

---

## 1. Product identity

SlipIQ is a Telegram Mini App / betting-intelligence product focused on tennis first-set probability.

Core positioning:

- Tagline: **Don’t guess. Calculate.**
- Flagship feature: **First Set Lab**
- Main wedge: tennis first-set probability, especially Player 2 first-set pressure spots.
- Product stance: decision support and probability intelligence, not guaranteed picks.
- Design style: dark terminal intelligence / Bloomberg terminal meets sports betting.

Original stack:

- React + Vite or Next.js
- TypeScript
- Tailwind CSS
- Telegram Web App SDK
- Supabase/PostgreSQL
- Telegram Bot alerts
- GitHub Actions as the main research/test runner
- API-Tennis for fixtures, odds, and score enrichment

Repo:

```txt
youssefalw2001/Slipiq-Mini-App
```

Supabase project used live:

```txt
afemheuneiqwoaambmvw
```

---

## 2. The major strategy evolution

### Old core idea

The old strategy was exact first-set correct score:

```txt
Market: Tennis 1st Set Correct Score
Target scoreline: 4-6
Meaning: Player 2 wins the first set 4 games to 6 games
```

Main exact-score trigger:

```txt
Official V3 Strict
scoreline: 4-6
odds: 6.25–6.99
tournament_level: tour_other / lower-tier bucket
match type: singles only
timing: pre-match only
```

Ultra exact trigger:

```txt
Ultra V1
scoreline: 4-6
odds: 6.50–6.99
tournament_level: tour_other
match type: singles only
timing: pre-match only
```

### New core strategy

Live settlement showed exact `4-6` was too narrow, but many exact-score losses were still Player 2 first-set wins nearby:

```txt
3-6
4-6
5-7
```

So the new best strategy is:

```txt
Market: 1 Set Winner & 1 Set Exact Games
Selection: Player 2 & 9–12
Wins on: 3-6, 4-6, 5-7
```

This means SlipIQ is no longer mainly “predict exact 4-6.” It is now:

```txt
Detect Player 2 first-set pressure, then choose the best market.
```

Current hierarchy:

```txt
#1 Main safer strategy:
Player 2 & 9–12 after V3 Strict / Ultra exact 4-6 trigger

#2 Upside strategy:
2-leg parlay using two separate Player 2 & 9–12 signals

#3 High-payout shadow:
Exact 4-6, small stake / tracker only until live proof improves

#4 Side trackers:
Exact 3-6, exact 5-7, Player 2 & 13

#5 Old V2 wide:
Scanner only / context, not main staking
```

Critical distinction:

```txt
Do NOT bet Player 2 & 9–12 on every tennis match.
Only consider it when the exact 4-6 trigger appears in the V3 Strict / Ultra zone.
```

---

## 3. Market definitions

### Exact 4-6

```txt
First set exact score 4-6.
Player 2 wins the first set 6 games to 4.
```

### Player 2 & 9–12

This is usually **not** listed under plain Correct Score. Search book menus for:

```txt
1 Set Winner & 1 Set Exact Games
1st Set Winner & Total Games
Set 1 Winner & Total Games
Set Winner + Total Games
Set Winner & Games
Player Name & 9–12
```

For a match listed as:

```txt
Player 1 vs Player 2
```

and an exact trigger of:

```txt
4-6
```

the grouped safer bet is:

```txt
Player 2 & 9–12
```

It wins on:

```txt
3-6
4-6
5-7
```

It loses on:

```txt
0-6
1-6
2-6
6-7
all Player 1 first-set wins
```

Important: `6-7` is 13 total games, not 9–12.

---

## 4. Historical proxy results for Player 2 & 9–12

Important limitation: the historical Supabase table had real exact `4-6` odds, but did **not** have true historical `Player 2 & 9–12` grouped odds. Therefore grouped market ROI is scenario/proxy based using assumed odds.

Supabase table used:

```txt
private_first_set_history
```

Dataset context:

```txt
tour_other singles
observed table range in the analysis: 2026-03-01 → 2026-05-01
```

### V3 Strict trigger proxy

Trigger:

```txt
Exact 4-6 odds 6.25–6.99
```

Grouped Player 2 & 9–12 proxy:

```txt
Bets: 106
Wins: 41
Losses: 65
Hit rate: 38.68%
Break-even odds: 2.585
```

Scenario ROI:

```txt
At 3.00 odds: +16.04% ROI, +17.0u
At 3.50 odds: +35.38% ROI, +37.5u
At 3.85 odds: +48.92% ROI, +51.85u
At 4.00 odds: +54.72% ROI, +58.0u
```

### Ultra trigger proxy

Trigger:

```txt
Exact 4-6 odds 6.50–6.99
```

Grouped Player 2 & 9–12 proxy:

```txt
Bets: 95
Wins: 38
Losses: 57
Hit rate: 40.00%
Break-even odds: 2.50
```

Scenario ROI:

```txt
At 3.00 odds: +20.00% ROI, +19u
At 3.50 odds: +40.00% ROI, +38u
At 3.85 odds: +54.00% ROI, +51.3u
At 4.00 odds: +60.00% ROI, +57u
```

Takeaway:

```txt
The model seems better at identifying Player 2 first-set pressure than exact 4-6 only.
```

---

## 5. Early live settlement results

### Exact 4-6 live start

Early exact V3 Strict live settlement was weak:

```txt
Exact V3 Strict sample: about 21–23 settled matches
Exact 4-6 wins: 2
Hit rate: about 8.7%–9.5%
Profit: roughly -8u to -10u
```

This is too small to kill the strategy, but it is a strong warning not to scale exact `4-6` aggressively.

### Player 2 & 9–12 live proxy

On the same V3 Strict matches:

```txt
Settled grouped proxy rows: 21
Wins: 7
Losses: 14
Hit rate: 33.33%
```

At example grouped odds of 3.85:

```txt
Break-even hit rate: 25.97%
Proxy hit rate: 33.33%
Approx ROI: +28%
```

Takeaway:

```txt
Player 2 & 9–12 is currently the best SlipIQ live strategy candidate.
```

---

## 6. Odds rules

### Straight Player 2 & 9–12

Based on historical proxy + early live proxy:

```txt
2.60 = theoretical historical break-even area
2.80 = playable only with caution / Ultra preference
3.00 = minimum playable
3.30+ = good
3.50–3.60 = strong
3.85–4.00 = excellent
```

bet365 was reported by the user/Manus to show this market around:

```txt
2.80–3.60
```

Preferred rule:

```txt
Use V3 Strict or Ultra exact 4-6 trigger.
Bet Player 2 & 9–12 only if odds are 3.00+.
Prefer 3.30+.
```

### 2-leg Player 2 & 9–12 parlay

Two separate qualifying signals are paired:

```txt
Leg 1: Player 2 & 9–12
Leg 2: Player 2 & 9–12
Parlay odds = leg odds × leg odds
```

Examples:

```txt
2.80 × 2.80 = 7.84
3.00 × 3.00 = 9.00
3.30 × 3.30 = 10.89
3.50 × 3.50 = 12.25
3.60 × 3.60 = 12.96
```

Latest requested GitHub workflow uses:

```txt
Starting bankroll: $5,000
Risk: 2% compound per parlay
Date range: 2025-04-01 → 2026-05-01
```

---

## 7. Simulation results already discussed

### Straight Player 2 & 9–12, $5k, 1.3% compound, 13-month projection

V3 Strict projected about 675 bets in 13 months:

```txt
2.80 odds: $5k → $9,324
3.00 odds: $5k → $18,090
3.30 odds: $5k → $48,735
3.50 odds: $5k → $94,160
3.60 odds: $5k → $130,801
```

Ultra projected about 605 bets in 13 months:

```txt
2.80 odds: $5k → $11,674
3.00 odds: $5k → $21,578
3.30 odds: $5k → $54,066
3.50 odds: $5k → $99,546
3.60 odds: $5k → $134,998
```

These are projections from a 62-day proxy sample and assume hit rate, volume, odds availability, and compounding all hold.

### 2-leg Player 2 & 9–12 parlay, $5k, 1.3% compound, 13-month projection

V3 Strict 2-leg proxy:

```txt
Sample: 53 parlays
Wins: 8
Losses: 45
Observed hit rate: 15.09%
Projected 13 months: about 338 parlays
```

Projected:

```txt
2.80 leg odds / 7.84 parlay: $5k → $9,024
3.00 leg odds / 9.00 parlay: $5k → $18,192
3.30 leg odds / 10.89 parlay: $5k → $55,864
3.50 leg odds / 12.25 parlay: $5k → $123,373
3.60 leg odds / 12.96 parlay: $5k → $185,675
```

Ultra 2-leg proxy:

```txt
Sample: 47 parlays
Wins: 7
Losses: 40
Observed hit rate: 14.89%
Projected 13 months: about 299 parlays
```

Projected:

```txt
2.80 leg odds / 7.84 parlay: $5k → $7,957
3.00 leg odds / 9.00 parlay: $5k → $14,695
3.30 leg odds / 10.89 parlay: $5k → $39,221
3.50 leg odds / 12.25 parlay: $5k → $78,453
3.60 leg odds / 12.96 parlay: $5k → $112,190
```

---

## 8. GitHub workflows and files

### Live feasibility workflow

Files:

```txt
scripts/live-execution-feasibility-watch.mjs
.github/workflows/live-execution-feasibility-watch.yml
```

Workflow name:

```txt
Live Execution Feasibility Watch
```

Purpose:

```txt
Checks whether exact 4-6 odds in the 6.25–6.99 range appear live before match start.
Tracks lead_minutes and odds stability.
```

Useful settings:

```txt
Quick:
cycles: 1
interval_seconds: 0

Short stability:
cycles: 4
interval_seconds: 300

Long watch:
cycles: 8
interval_seconds: 1800
```

### New Player 2 & 9–12 two-leg workflow

Files:

```txt
scripts/backtest-player2-9-12-two-leg.mjs
.github/workflows/player2-9-12-two-leg-backtest.yml
```

Commits:

```txt
b256ad0  Add Player 2 9-12 two-leg backtest script
96de819  Add Player 2 9-12 two-leg backtest workflow
```

Workflow name:

```txt
Player 2 9-12 Two-Leg Backtest
```

Purpose:

```txt
1. Scan historical API-Tennis fixtures + odds
2. Find V3 Strict / Ultra exact 4-6 triggers
3. Try to extract real Player 2 & 9–12 grouped odds
4. Fall back to scenario odds if real grouped odds are missing
5. Simulate straight Player 2 & 9–12
6. Simulate 2-leg Player 2 & 9–12 parlays
7. Use configured bankroll and risk
```

Recommended run settings:

```txt
date_start: 2025-04-01
date_stop: 2026-05-01
bankroll: 5000
risk: 0.02
scenario_odds: 2.80,3.00,3.30,3.50,3.60
delay_ms: 150
```

Artifact to upload back:

```txt
player2-9-12-two-leg-backtest
```

Main file:

```txt
player2-9-12-two-leg-summary.json
```

Other useful files:

```txt
player2-9-12-candidates.csv
two-leg-parlay-backtest-rows.csv
straight-backtest-rows.csv
```

When reading results, always separate:

```txt
Exact 4-6 result
Straight Player 2 & 9–12 result
2-leg Player 2 & 9–12 parlay result
Real grouped odds result
Scenario grouped odds result
```

Do not mix real grouped odds with scenario odds without labeling clearly.

---

## 9. Supabase tables and status

Relevant tables:

```txt
private_live_observation_log
private_live_observation_runs
private_result_resolver_runs
private_first_set_history
private_grouped_9_12_observation_log
private_bankroll_settings
```

### private_live_observation_log

Tracks exact-score live signals, odds movement, start time, actual score, result, and profit.

Important issue found:

```txt
The resolver depended on is_strict_candidate = true.
Some V3 Strict odds-band rows had is_strict_candidate = false.
Rows with candidate_scoreline='4-6' and odds_at_discovery in [6.25, 7.00) were patched to is_strict_candidate=true.
After that, resolver started settling rows.
```

### private_grouped_9_12_observation_log

Created to track new grouped market separately.

Purpose:

```txt
Stores Player 2 & 9–12 derived candidates from V3 Strict 4-6 signals.
Wins if actual first set is 3-6, 4-6, or 5-7.
Allows manual/API grouped odds logging from bet365/Dexsport/etc.
```

Initial status after creation:

```txt
Total grouped rows: 33
Settled grouped rows: 21
Wins: 7
Losses: 14
Pending result: 12
Proxy hit rate: 33.33%
Grouped odds: null for all at creation because book odds need manual/API capture
```

---

## 10. Platform notes

The strategy needs books that support:

```txt
Tennis first set markets
1 Set Winner & 1 Set Exact Games
Player name & 9–12
1st Set Correct Score
```

### Regulated sportsbook candidate

bet365 appears promising because it reportedly has the needed Player 2 & 9–12 market around:

```txt
2.80–3.60
```

Other regulated books to check:

```txt
DraftKings
BetMGM
Fanatics
FanDuel
Caesars
```

Market availability varies by state and match.

### Crypto/casino-like sportsbook candidate

Dexsport screenshots showed the exact grouped format:

```txt
Player Name & 6
Player Name & 7–8
Player Name & 9–12
Player Name & 13
```

Example:

```txt
Cobolli & 9–12 = 2.45
Tirante & 9–12 = 3.85
```

Stake screenshots showed exact score odds:

```txt
4-6 = 7.20
3-6 = 8.60
5-7 = 21.00
```

But Stake grouped Player & 9–12 was not confirmed in screenshots.

Compliance note:

```txt
Do not recommend illegal use or bypassing geolocation restrictions.
For U.S. users, use only legal platforms available where they are physically located.
Stake.com and Stake.us differ; Stake.us is not the same sportsbook product.
```

---

## 11. Productization and pricing

The new strategy is strong enough to become the flagship SlipIQ product.

Positioning:

```txt
SlipIQ First Set Lab detects Player 2 first-set pressure and identifies when grouped 9–12 game markets may be mispriced.
```

Do not market as guaranteed profit.

Suggested launch tiers:

```txt
Founders: $29/month for first 50–100 users
Premium: $49/month
VIP: $99/month
```

After 100–300 settled live grouped bets with real odds and positive ROI:

```txt
Premium: $79/month
VIP: $149/month
Elite: $249/month limited seats
```

Estimated private strategy/product value by proof stage:

```txt
Backtest only: $5k–$20k
Backtest + early live proxy/current stage: $20k–$75k
100–300 live settled grouped bets positive: $100k–$300k+
6+ months verified live results + paying users: $500k+ product potential
```

---

## 12. Current action plan

Immediate next step:

```txt
Run GitHub Actions → Player 2 9-12 Two-Leg Backtest
```

Use:

```txt
date_start: 2025-04-01
date_stop: 2026-05-01
bankroll: 5000
risk: 0.02
scenario_odds: 2.80,3.00,3.30,3.50,3.60
delay_ms: 150
```

Upload artifact back into ChatGPT:

```txt
player2-9-12-two-leg-backtest
```

Analyze:

```txt
1. Did the API expose real Player 2 & 9–12 grouped odds?
2. If yes, compare real grouped odds ROI.
3. If no, use scenario odds carefully.
4. Compare straight vs 2-leg parlay.
5. Compare V3 Strict vs Ultra trigger.
6. Watch drawdowns and losing streaks.
```

Continue Supabase live tracking and manually/API log real grouped odds from bet365/Dexsport.

---

## 13. Risk rules

Suggested live discipline:

```txt
Paper or tiny stakes until real grouped odds are logged.
Do not scale exact 4-6 aggressively.
For Player 2 & 9–12, require 3.00+ odds; prefer 3.30+.
For 2-leg parlays, both legs should meet minimum odds.
Use 1.0%–1.3% until more live proof; 2% is aggressive and currently only being backtested.
Stop after bad streaks.
Never chase losses.
```

Stop rules:

```txt
Stop after 5 parlay losses in one day.
Pause after -10% to -15% drawdown.
Pause if odds are not actually available live.
Pause if settlement/resolver data looks wrong.
```

---

## 14. Quick prompt for a new AI tab

Paste this:

```txt
Read docs/SLIPIQ_AI_HANDOFF.md in my GitHub repo `youssefalw2001/Slipiq-Mini-App` first. We are working on SlipIQ First Set Lab. The old exact 4-6 strategy is now mainly a trigger. The current main strategy is Player 2 & 9–12 after a V3 Strict / Ultra exact 4-6 trigger, plus optional 2-leg Player 2 & 9–12 parlays. Focus on the GitHub workflow `Player 2 9-12 Two-Leg Backtest`, Supabase grouped tracking, and real grouped odds logging. Separate real grouped odds from scenario odds.
```
