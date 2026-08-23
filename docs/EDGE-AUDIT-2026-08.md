# Edge Audit — August 2026

**Question:** Is there a demonstrated edge in the tennis first-set correct-score system?

**Answer:** No. Not in any lane, at any stake, on any sample currently in this repo.

**Root cause identified — see §6b.** The historical edge is a scoring bug: tiebreak
first sets (22.3% of signals, and guaranteed losses) are silently dropped from
backtests instead of counted. Correcting it moves out-of-sample ROI from **+25.67%
to −2.77%** on the same matches at the same prices.

This document records the evidence. All numbers below were recomputed from raw
files in this repository, not copied from prior summaries.

---

## 1. The decisive test: real prices, real outcomes

`artifacts/output/real_grouped_price_study.csv` is the only dataset here that pairs
**real market prices** for the actual marketed score group (3:6 / 4:6 / 5:7) with
**real settled first-set outcomes**.

| Metric | Value |
|---|---|
| Bets | 277 |
| Hit rate | 26.35% |
| Break-even hit rate needed | 28.77% |
| Mean grouped price | 3.476 |
| P/L (flat 1u) | **-49.91u** |
| **ROI** | **-18.02%** |
| Mean overround | 17.01% |

The loss rate (-18.0%) matches the bookmaker margin (17.0%) almost exactly. That
is the textbook signature of **zero edge**: you are not being beaten by bad luck,
you are paying the vig and nothing else is happening.

Critically, these prices are already **best-price-across-all-bookmakers**
(`Math.max(...odds)` in the backtest engines). This is the most favourable
possible accounting, and it still returns -18%.

## 2. The model has no predictive skill

From the repo's own `artifacts/output/calibration_model.json` (n=3,502 held-out test rows):

| Model | Brier ↓ | Mean predicted | Actual |
|---|---|---|---|
| A. raw model | 0.09965 | 0.2007 | 0.0997 |
| B. **global base rate (a constant)** | 0.08979 | 0.0919 | 0.0997 |
| C. lookup (score+level) | 0.08897 | 0.0929 | 0.0997 |
| D. isotonic-calibrated | 0.08897 | 0.0908 | 0.0997 |

Two things follow:

1. **The raw model is worse than a constant.** Brier 0.0996 vs 0.0898 for simply
   predicting the base rate every time. The model does not merely lack edge — it
   is actively worse than knowing nothing.
2. **It is 2x overconfident.** It says 20.1%, reality is 9.97%. Every `edge` and
   `expected_value` figure downstream is therefore inflated by roughly 2x, which
   means every filter built on `min_ev` / `min_edge` is filtering on noise.

The calibrated versions (C/D/E) recover only to *base-rate* performance. They add
essentially nothing over a lookup table of "how often does this score happen at
this tournament level".

### The model's edge column is anti-predictive

Recomputed over the 11,673 resolved rows in
`artifacts/input/combined-2024-2026-enriched-first-set-scores.csv`, restricted to
the one price band that is positive (5.0–8.0):

| Model `edge` quartile | Mean edge | n | Hit rate | ROI |
|---|---|---|---|---|
| Q1 (lowest) | 0.048 | 818 | 19.07% | **+27.34%** |
| Q2 | 0.066 | 818 | 15.40% | +11.55% |
| Q3 | 0.072 | 818 | 14.06% | +6.05% |
| Q4 (highest) | 0.080 | 820 | 12.32% | **-4.32%** |

Monotonically **backwards**. The more edge the model claims, the worse the result.
Filtering for higher model edge actively destroys money.

Ranking check by model probability decile: actual hit rate does **not** rise with
model probability. It tracks the *bookmaker's* implied probability instead. The
model's only real information is a laundered copy of the price.

## 3. The historical ROIs are search artifacts, not measurements

Headline claims in `README.md`:

- Optimized Profitable Lanes: n=511, +16.92% ROI, t = 2.78
- Optimized VIP Protected 3: n=610, +14.88% ROI, t = 2.67
- Optimized VIP Gate-2: n=610, +23.42% ROI, t = 3.45

Those t-stats would be persuasive for a **single pre-registered** test. They were
not pre-registered. The repo contains **126 workflows and 145 scripts**, roughly
20 named `optimizer`, `discovery`, `grid`, `turbo`, or `wide-net`. A single "deep
grid optimizer" tests hundreds to thousands of configurations.

Expected maximum t-stat from K pure-noise strategies ≈ √(2·ln K):

| K configs searched | Expected best-of-noise t |
|---|---|
| 100 | 3.03 |
| 500 | 3.53 |
| 1,000 | 3.72 |
| 5,000 | 4.13 |

Observed t-stats (2.7–3.5) are **below** what pure noise is expected to produce at
the search scale actually used. The historical edge is not statistically
established. It is indistinguishable from the best of many guesses.

### This is demonstrated, not just asserted

`scripts/demo-why-optimizing-lies.mjs` attaches 8 columns of **pure random
numbers** to the 277 real matches (true edge: -18%) and grid-searches them:

```
20 independent searches on fresh noise
Average "best ROI" discovered: +52.27%
Searches that found a "profitable strategy": 20/20
```

A market that truly pays **-18%** yields "strategies" averaging **+52%** every
single time, from data containing zero information. Searching does not find
edges here; it manufactures them.

## 4. The "reality check" windows prove nothing

`scripts/reality-check-100-300-signals.mjs` slides the window start by 1 row:

| Window | "Tests" reported | Overlap | Truly independent samples |
|---|---|---|---|
| 100 | 511 | 99.0% | **6** |
| 200 | 411 | 99.5% | **3** |
| 300 | 311 | 99.7% | **2** |

"200 signals: 100% of windows profitable" is close to a tautology. If the full
sample is profitable, near-identical overlapping windows must be too. It is ~3
observations wearing a costume of 411.

The Monte Carlo bootstraps from the **already-selected** unit results. It assumes
the edge is real and then measures variance around that assumption. It cannot
validate the edge — it is circular by construction. The compounding projections
($64k, $111k, $33k) inherit this and should be disregarded entirely.

## 5. The live sample is far too small to mean anything

| Metric | Value |
|---|---|
| Settled rows | 62 |
| ROI | +9.61% |
| Standard error of ROI | **±17.52%** |
| t-stat | **0.55** |
| 95% CI on true ROI | **-24.7% to +43.9%** |

The confidence interval comfortably includes zero, and includes the -18% that the
real-price study measured. Required samples to actually detect the claimed edge:

| To detect | at 95% | at 99.7% |
|---|---|---|
| 15% ROI | 325 bets | 761 bets |
| 10% ROI | 731 bets | 1,711 bets |
| 5% ROI | 2,921 bets | 6,843 bets |

62 rows is ~8% of the minimum. A 9-loss streak has already occurred in those 62 rows.

## 6. Structural problems that cap the ceiling

| Problem | Effect |
|---|---|
| **Vig is ~17%** on first-set correct score | Your model must beat the market by >17% before a cent of profit. Nothing in this repo beats it by 1%. |
| **Best-price selection** (`Math.max` across all books) | Backtests assume you always get the single best outlier price on a niche market. Systematically upward-biased and not executable at scale. |
| **Grouping destroys value** | Dutching 3 scores forces you to pair the one plausibly-underpriced short score with heavily -EV longshot legs. This is why single-score 5–8 shows +4.5% while the 3-score group shows -18%. |
| **Circular model** (documented in `setfox-v3-report.md` §3.1) | Features derive from the 1st-set Home/Away market, then get compared to the correct-score market. Any "edge" is cross-market price disagreement, not tennis modelling. |
| **Surface label unreliable** | "grass" rows appear in every month of the year. The grass filter is not measuring surface. |
| **Player stats are estimated, not measured** | No Sackmann data, no rolling serve/return, no H2H. Priors are tournament-tier heuristics. |
| **No CLV tracking** | `clv` columns exist; nothing populates them. Closing-line value is the single most reliable edge test in betting and it has never been run. |
| **Exact-score stake limits** | Even a real edge here is capped by tiny max stakes on correct-score markets. Not addressed anywhere. |

## 6b. ROOT CAUSE FOUND — the tiebreak-exclusion bug

A pre-registered out-of-sample test (`docs/PRE-REGISTERED-TEST-2026-08.md`,
`scripts/prereg-oos-test.mjs`) was run on **2026-05-07 → 2026-08-20**, a window
starting the day after the research dataset ends. It located the specific defect that
manufactured the historical edge.

### The bug

`scripts/backtest-first-set-lab-v2.mjs:233` and `v3.mjs:259`:

```js
function looksLikeTennisSet(a, b) {
  return (a === 6 && b <= 7) || (b === 6 && a <= 7)
      || (a === 7 && b >= 5 && b <= 6) || (b === 7 && a >= 5 && a <= 6);
}
```

API-Tennis encodes a tiebreak set as `games.tiebreakPoints` — a 7-6(9-7) first set
arrives as `score_first:"7.9"`, `score_second:"6.7"`. So:

```js
looksLikeTennisSet(7.9, 6.7)   // false
parseFirstSetScore(fixture)    // null  -> match dropped from sample
```

Verified against every real tiebreak shape in the feed: `7.9/6.7`, `6.7/7.9`,
`7.7/6.5` all return `null`.

### Why it creates a fake edge

A 7:6 or 6:7 first set is a **guaranteed loss** for every score group in use
(6:2/6:3/6:4, 2:6/4:6/5:7, 3:6/4:6/5:7, 6:3/6:4, 2:6/4:6). Confirmed empirically in
the test window: **52 of 52** tiebreak signals were losses, **zero** wins.

Dropping them removes only losses, never wins. And you cannot know in advance that a
set will reach a tiebreak, so the exclusion is pure look-ahead bias. Tiebreaks are
**22.32%** of qualifying signals — roughly one bet in five silently deleted.

### The size of the effect

Same window, same lanes, same prices — only the accounting differs:

| Accounting | n | Hit rate | Avg grouped | Break-even | Units | ROI |
|---|---|---|---|---|---|---|
| **Correct** (tiebreaks = losses) | 137 | **28.47%** | 3.44 | 29.07% | −3.79u | **−2.77%** |
| **Repo method** (tiebreaks dropped) | 106 | **36.79%** | 3.46 | 28.89% | +27.20u | **+25.67%** |

**A 28.44-point ROI swing from one parsing bug.**

### The confirmation

The buggy accounting reproduces the README's headline claims almost exactly:

| | Hit rate | ROI |
|---|---|---|
| README "Optimized VIP Gate-2 historical" | 35.08% | +23.42% |
| Repo-method accounting, this unseen window | **36.79%** | **+25.67%** |
| **Correct accounting, same window** | **28.47%** | **−2.77%** |

The claimed edge is reproducible — as an artifact. Feed the buggy parser fresh,
never-before-seen data and it regenerates the advertised numbers. Fix the parser and
the edge disappears. That is what a measurement error looks like, not a market edge.

Note that break-even barely moves (29.07% vs 28.89%) because prices are unchanged.
The entire gap is manufactured hit rate.

### Out-of-sample result against pre-registered criteria

| Lane | n | Hit | Break-even | ROI | t |
|---|---|---|---|---|---|
| Core Cluster (Gate-2, as coded) | 96 | 26.04% | 32.51% | −21.97% | −1.59 |
| Core Cluster (Protected 3) | 23 | 30.43% | 33.14% | −10.14% | −0.35 |
| V3 Cluster | 26 | 19.23% | 25.77% | −24.68% | −0.82 |
| Research P2 GS Sniper | 88 | 30.68% | 29.23% | +5.63% | +0.33 |
| Reverse Stretch (README-only lane) | **0** | — | — | — | — |
| **PRIMARY: Optimized VIP Protected 3** | **137** | **28.47%** | **29.07%** | **−2.77%** | **−0.21** |
| Secondary: all lanes pooled | 233 | 27.47% | 30.39% | −10.68% | −1.11 |

Pre-registered verdict: **consistent with no edge.** The 95% CI on the primary is
[−28.77%, +23.23%] and includes zero. Every lane's hit rate sits at or below its own
break-even. Not one lane clears its price.

Also worth noting: `CORE_P2_GS_REVERSE_STRETCH_BET365` is listed in `README.md` as an
active VIP staking lane but **does not exist in the live scanner code**, and produced
zero qualifying signals when implemented from the README spec.

Data quality was good — 2,725 finished singles, 96.59% correct-score market coverage,
zero unresolvable set-1 scores. This was not a thin or broken sample.

## 7. The one thing with a pulse (and it is not what is being staked)

Both independent datasets show the same **favourite–longshot bias**: short prices
are underpriced, long prices are badly overpriced.

Pure price rule, no model, 11,673 resolved rows:

| Price band | n | Hit rate | Break-even | ROI | t |
|---|---|---|---|---|---|
| 6–7 | 480 | 21.46% | 15.25% | +41.11% | +3.35 |
| 7–8 | 2,744 | 13.99% | 13.37% | +4.50% | +0.91 |
| 8–10 | 2,038 | 12.76% | 12.44% | +2.79% | +0.47 |
| 12–15 | 1,388 | 6.92% | 7.81% | -10.89% | -1.25 |
| **15–18** | **3,272** | **5.41%** | **6.19%** | **-13.57%** | **-2.13** |
| 18–25 | 858 | 3.85% | 4.70% | -19.41% | -1.39 |
| 25+ | 593 | 2.70% | 3.67% | -26.31% | -1.45 |

Same pattern in the grouped study: the 2.10–2.50 price bucket returns +10.5%,
the 6.00+ bucket returns -52.7%.

Two honest readings:

1. **The reliable, significant finding is negative:** long prices lose heavily.
   `odds_12_18` — the bucket the default SetFox rule targets — is n=4,660 at
   **-12.77% ROI**. The `moonshot_profile` is -21.09%. The current lanes are
   concentrated in the most reliably losing region of the repo's own data.
2. **The positive side is marginal and fragile.** Only the thin 6–7 sub-band
   clears significance, and it is 480 rows carved out after the fact from a
   dataset already filtered by the model. Favourite–longshot bias is a genuine,
   well-documented market phenomenon, but capturing it requires beating a 17% vig
   with real available prices and real stake limits — none of which is measured here.

## 8. Recommendations

**Stop staking real money now.** Not because a loss streak happened, but because
nothing in this repository establishes that the edge exists, and the one
real-price measurement says it is -18%.

Cheapest decisive next step, at zero financial risk:

1. **Log real obtainable prices and max stakes at signal time** for 30–100
   signals. Do not place bets. `scripts/audit-price-sensitivity.mjs` shows
   break-even sits near 2.97 and that the difference between 2.80 and 3.50 is the
   difference between -5.7% and +17.9% per bet. There are currently **zero** real
   observations of the price actually obtainable. 30–100 logged signals settles
   the only genuinely open question in 3–7 weeks.
2. **Populate the `clv` columns.** Compare signal price to closing price. If your
   selections do not consistently beat the closing line, there is no edge — this
   is far faster than waiting for 731 settled bets.
3. **Recalibrate before any further filtering.** Use model C/D from
   `calibration_model.json`. Any `min_ev`/`min_edge` gate running on the raw 2x-
   overconfident model is filtering on noise.
4. **Stop optimizing.** Every additional grid search makes the illusion more
   convincing and the truth harder to see. Freeze the search space; test one
   pre-registered rule.
5. **Move to low-vig markets** if the goal is a real edge. Per
   `scripts/scan-all-market-efficiency.mjs`, a 17% tax is effectively unbeatable;
   a 2% tax is not. Correct-score is the worst possible venue for a first edge.
6. **Do not monetize this as picks.** `AGENTS.md` and `setfox-v3-report.md` §12
   already say it: charge for the scanner, math, alerts and audit trail — never
   for winning picks. Selling an unvalidated, overfit signal to paying users is
   both a reputational and a legal problem.

## 9. Note on repo consistency

This repository contains two contradictory layers:

- **An honest layer** — `docs/setfox-v3-report.md`, `scripts/audit-*.mjs`,
  `scripts/demo-why-optimizing-lies.mjs`, `calibration_model.json`. This layer is
  rigorous, correctly identifies circularity, selection bias, overlapping-window
  inflation and multiple-testing inflation, and grades strategy proof at 5/10.
- **A marketing layer** — `README.md`. This layer presents grid-search outputs as
  validated results, states "100% profitable" over overlapping windows, and
  projects compounded bankrolls to $111,459.

The honest layer is correct. `README.md` should be reconciled with it: the
"Current Results" section states as findings what are in fact unvalidated search
outputs, and it is the file every future agent is instructed to read first.

---

*All figures recomputed from repository data. Research audit, not financial advice.*
