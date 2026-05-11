# SlipIQ Recent Memory Update — May 2026

This file captures the most important context from the latest SlipIQ research sprint. A new AI/chat session should read this **after** `docs/SLIPIQ_AI_HANDOFF.md`.

Last updated: 2026-05-11

---

## 1. Current strategic conclusion

The strongest current version of SlipIQ is no longer exact `4-6` as the main bet.

Current model:

```txt
Exact 4-6 = trigger / signal detector
Player 2 & 9–12 = main bet
2-leg Player 2 & 9–12 = optional upside mode
Exact 4-6 = tiny kicker / shadow tracker only
```

Reason:

```txt
The model appears to detect Player 2 first-set pressure better than it predicts one exact score.
```

`Player 2 & 9–12` wins on:

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

Important: `6-7` is 13 games and is **not** included in `9–12`.

---

## 2. The big 13-month API-Tennis workflow result

A larger GitHub run was done for:

```txt
Date range: 2025-04-01 → 2026-05-01
Candidate rows: 4,806
Starting bankroll: $5,000
Risk: 2% compound
```

Critical limitation:

```txt
Real grouped Player 2 & 9–12 odds rows: 0
```

So the run did **not** prove real historical `Player 2 & 9–12` odds. It tested scenario odds.

### Straight V3 Player 2 & 9–12 result

```txt
V3 Strict straight:
Bets: 2,690
Wins: 906
Losses: 1,784
Hit rate: 33.68%
```

Scenario results at 2% compound:

```txt
2.80 odds: failed badly
3.00 odds: not enough / drawdown problem
3.30 odds: strong
3.50 odds: extremely strong
3.60 odds: extremely strong but availability uncertain
```

The memorable `3.50` scenario:

```txt
Starting bankroll: $5,000
Bets: 2,690
Wins: 906
Losses: 1,784
Odds: 3.50
Risk: 2% compound
Final bankroll: about $17.53M
```

Math:

```txt
A win at 3.50 with 2% risk = +5% bankroll
A loss = -2% bankroll
Bankroll ≈ 5000 × 1.05^906 × 0.98^1784
```

This is scenario math, not a promise. It depends on real odds being available.

### Ultra Player 2 & 9–12 result

```txt
Ultra straight:
Bets: 2,116
Wins: 719
Losses: 1,397
Hit rate: 33.98%
```

Same conclusion:

```txt
2.80 is rejected.
3.00 is borderline / not good enough for 2% compounding.
3.30+ is playable.
3.50+ is the best target.
```

---

## 3. Straight beats parlay for main live focus

The 2-leg parlay version can be powerful, but it is much more volatile.

V3 2-leg parlay at scenario odds:

```txt
Parlays: 1,345
Wins: 146
Losses: 1,199
Hit rate: 10.86%
Worst losing streak: about 51 parlays
```

At 3.50 per leg, it still made money in the scenario run, but the drawdowns and losing streaks were much harder.

Final live focus decision:

```txt
Main strategy: straight V3 Player 2 & 9–12
Target odds: 3.50+
Playable minimum: 3.30+
Avoid: 2.80
Be careful: 3.00
Parlay: small optional side mode only
```

Suggested live staking, if bankroll is $5,000:

```txt
Straight Player 2 & 9–12: around 1% risk = $50
2-leg parlay: 0.25%–0.5% = $12.50–$25
Exact 4-6 kicker: tiny only or paper
```

The 2% compound setting is for backtests and aggressive scenario modeling, not default live staking.

---

## 4. Split-stake idea tested

The user asked about splitting one signal stake between exact `4-6` and grouped `Player 2 & 9–12`, for example:

```txt
40% stake on exact 4-6
60% stake on Player 2 & 9–12
```

Finding:

```txt
40/60 can work, but it is not optimal.
```

Because `Player 2 & 9–12` already includes `4-6`, exact `4-6` is a bonus kicker that hurts performance whenever the true result is `3-6` or `5-7`.

Best practical split:

```txt
90% Player 2 & 9–12
10% exact 4-6 kicker
```

Aggressive but acceptable:

```txt
80% Player 2 & 9–12
20% exact 4-6 kicker
```

Not preferred as default:

```txt
40% exact 4-6
60% Player 2 & 9–12
```

---

## 5. API attempts and conclusions

### API-Tennis

API-Tennis gave historical fixtures, exact-score triggers, and first-set results, but did not provide real historical grouped `Player 2 & 9–12` odds in the 13-month run.

Status:

```txt
Useful for results and triggers.
Not enough for grouped market odds proof.
```

### OddsAPI / Odds-API.io

A workflow was created:

```txt
.github/workflows/oddsapi-io-player2-9-12-scan.yml
scripts/scan-oddsapi-io-player2-9-12.mjs
```

It found tennis events and raw score/event data, but it did not find:

```txt
Exact 4-6 candidate odds rows
Player 2 & 9–12 rows
3.30+ target rows
```

It also hit free-plan request limits.

Conclusion:

```txt
OddsAPI has tennis event data, but it is not solving the deep first-set market problem right now.
```

### SportsGameOdds

A workflow was created:

```txt
.github/workflows/sportsgameodds-player2-9-12-scan.yml
scripts/scan-sportsgameodds-player2-9-12.mjs
```

Important discoveries:

```txt
The SportsGameOdds key/auth works.
The API recognizes sportID TENNIS.
The free trial blocks broad sport searches.
The free trial requires leagueID or eventID.
ATP, WTA, and ITF leagueIDs were blocked at the current subscription tier.
```

Conclusion:

```txt
SportsGameOdds has not been disproven.
The trial tier blocked the actual tennis league/event access before we could test the 9–12 market.
Ask them for ATP/WTA/ITF access or a demo eventID/sample JSON.
```

Message to SportsGameOdds:

```txt
Hi, my free trial API key can authenticate and see sportID TENNIS, but ATP, WTA, and ITF leagueIDs return “unavailable at your current subscription tier.”

Before upgrading, I need to confirm one exact tennis market:

Market:
1 Set Winner & 1 Set Exact Games
or 1st Set Winner & Total Games

Example selection:
Player name & 9–12 games

Example:
Tirante Thiago Agustin & 9–12

Can you temporarily enable ATP/WTA/ITF access on my trial, or send me one sample eventID/JSON response that includes this market from bet365 or another bookmaker?
```

### RapidAPI / MCP

The user has a RapidAPI key and asked about MCP. Conclusion:

```txt
Best path is not direct MCP right now.
Use GitHub Actions with RAPIDAPI_KEY and RAPIDAPI_HOST secrets if the specific RapidAPI product exposes deep tennis markets.
```

Need from user before building:

```txt
RapidAPI product/API name
Host
Endpoint docs
Market examples
```

---

## 6. Bet365 scraper repos checked

### davccavalcante/bet365-api-scraper

README required Bet365 cookies and was oriented toward Bet365 InPlay API / live football data.

Conclusion:

```txt
Do not use as-is.
Not good for historical tennis odds.
Do not build around copied Bet365 cookies or anything that may violate platform terms.
```

### Chiang97912/bet365.com

Inspected README and code. It is an old Python 3.6 websocket scraper with `autobahn` and `twisted`.

Code is hardcoded around:

```txt
sport_type = football  # football or basketball
```

It parses:

```txt
ID=1 football
ID=18 basketball
```

Conclusion:

```txt
Not useful for SlipIQ tennis historical odds.
No tennis parser.
No historical odds.
Old dependencies.
Potential compliance/stability concerns.
```

Do not spend more time forcing this repo.

---

## 7. Why we moved away from live API chasing

The live API path became a headache and did not directly answer the biggest question.

New priority:

```txt
Historical proof first.
Live automation later.
```

The real question now is:

```txt
When our V3/Ultra trigger appears, was a realistic 9–12-style price around 3.30–3.50 historically available often enough?
```

Since direct grouped odds are hard to obtain, use one of these faster historical paths:

```txt
1. Historical first-set correct-score odds for 3-6, 4-6, 5-7
2. Reconstruct Player 2 & 9–12 odds from exact-score odds
3. Tennis-Data outcome/filter backtesting to build confidence score
4. Provider one-time CSV export instead of live API
```

Reconstruction formula:

```txt
Implied probability of Player 2 & 9–12 ≈ 1/odds_3-6 + 1/odds_4-6 + 1/odds_5-7
Estimated 9–12 odds ≈ 1 / implied_probability
```

Example from Stake screenshot:

```txt
3-6 = 8.60
4-6 = 7.20
5-7 = 21.00
Estimated grouped odds ≈ 3.30
```

---

## 8. Tennis-Data.co.uk direction

The user suggested:

```txt
tennis-data.co.uk
```

Conclusion:

```txt
Yes, it helps — not for direct Player 2 & 9–12 odds, but for historical first-set outcome/filter analysis.
```

Tennis-Data can help test:

```txt
Which match conditions produce the highest selected-player first-set 9–12 hit rate?
```

It includes ATP/WTA historical match data with set scores and match-winner odds, not direct first-set grouped market odds.

Important limitation:

```txt
Tennis-Data rows are Winner/Loser, not bookmaker Player 1/Player 2 order.
It cannot directly prove Player 2 listing-side 9–12 odds.
It is for building filters and confidence scoring.
```

---

## 9. New Tennis-Data workflow added

Files added:

```txt
scripts/backtest-tennis-data-9-12-filter.mjs
.github/workflows/tennis-data-9-12-filter-backtest.yml
```

Commits:

```txt
41d217c  Add Tennis-Data 9-12 filter backtest script
602aa47  Add Tennis-Data 9-12 filter backtest workflow
```

Workflow name:

```txt
Tennis-Data 9-12 Filter Backtest
```

Recommended run settings:

```txt
years: 2024,2025,2026
tours: atp,wta
bankroll: 5000
risk: 0.02
scenario_odds: 3.00,3.30,3.50,3.60
min_rows: 50
urls: leave blank
```

Artifact to upload:

```txt
tennis-data-9-12-filter-backtest
```

Main output:

```txt
tennis-data-9-12-filter-summary.json
```

Other outputs:

```txt
tennis-data-best-filters.csv
tennis-data-grouped-filter-summary.csv
tennis-data-side-candidates.csv
tennis-data-scenario-3-50-bankroll-curves.csv
```

What to look for:

```txt
filters with hit_rate 35%+
break_even_odds under 3.00
enough rows to matter
manageable losing streaks / drawdown
```

This workflow should be used to create a SlipIQ confidence-score layer on top of the V3/Ultra trigger.

---

## 10. Current confidence and live plan

Current confidence:

```txt
Straight Player 2 & 9–12 at 3.30+: around 80% concept confidence
Straight Player 2 & 9–12 at 3.50+: strongest target
2-leg parlays: powerful but only 65–75% confidence because drawdowns are brutal
Exact 4-6 alone: not main focus anymore
```

Live plan:

```txt
1. Wait for V3 Strict / Ultra exact 4-6 trigger.
2. Check if Player 2 & 9–12 is available.
3. Do not take 2.80.
4. Be cautious at 3.00.
5. Prefer 3.30+.
6. Target 3.50+.
7. Straight bet is main.
8. Parlay is small optional side mode only.
9. Exact 4-6 is tiny kicker or paper tracker.
```

Manual workflow is manageable because expected volume is low:

```txt
Average: about 1–2 signals/day
Busy day: 3–5 signals
Slow day: 0 signals
```

---

## 11. Product/brand emotional context

The user is deeply invested in SlipIQ and wants to feel proud of building something real.

Important framing:

```txt
Do not overpromise guaranteed profit.
Do reinforce that the strategy improved because we identified the actual edge: Player 2 first-set pressure.
The 9–12 screenshot was the major turning point.
```

Key narrative:

```txt
The user accidentally showed the 9–12 market screenshot.
That revealed the bigger edge.
Exact 4-6 was not the whole strategy; it was the signal.
Player 2 & 9–12 became the stronger market expression.
```

Use language that is supportive but disciplined:

```txt
Excited, yes.
Proud, yes.
Reckless, no.
```

---

## 12. Updated next actions

Immediate next action:

```txt
Run Tennis-Data 9-12 Filter Backtest.
Upload artifact.
Analyze filters and confidence-score candidates.
```

Then:

```txt
1. Use Tennis-Data to find high hit-rate 9–12 conditions.
2. Combine those filters with V3/Ultra exact 4-6 trigger.
3. Continue searching for historical 3-6 / 4-6 / 5-7 exact-score odds.
4. Reconstruct estimated Player 2 & 9–12 odds.
5. Only return to live API work when a provider confirms the exact market in sample JSON.
```

Do not let future AI restart from generic app boilerplate or generic sports betting advice. The current research priority is:

```txt
Prove and sharpen Straight V3 Player 2 & 9–12 at 3.30–3.50+.
```
