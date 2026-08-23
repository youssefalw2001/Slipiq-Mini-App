# Pre-Registered Out-of-Sample Test — August 2026

**Written and committed BEFORE any data was fetched.** This is the point. Every
positive result in this repo was produced by searching until something looked good.
This test fixes the rules, the window, the metric, and the pass/fail thresholds in
advance, runs **once**, and reports whatever comes back.

If I change anything after seeing results, that change is disclosed in §7.

---

## 1. Why this window

| Dataset | Coverage |
|---|---|
| `combined-2024-2026-enriched-first-set-scores.csv` | 2024-10-05 → 2026-05-06 |
| `real_grouped_price_study.csv` | samples within 2026-05 → 2026-07 |
| **This test** | **2026-05-07 → 2026-08-20** |

The test window begins the day after the main research dataset ends. No lane, gate,
threshold or score group in this repo was tuned on it. It is genuinely unseen.

Expected volume: unknown in advance. Grand-Slam-filtered lanes will be thin (only
Roland Garros and Wimbledon fall in the window). The `VIP_P2_V3_SHAPE` lane has no
tournament filter and should carry most of the sample.

## 2. Rules under test — frozen, copied from code not from README

Source of truth is `scripts/api_tennis_live_first_set_lab_scanner.mjs` (the live
scanner), **not** `README.md`. Where they disagree, the code wins, because the code
is what actually generated the live signals.

| Lane | Scores | Book priority | Grouped gate | Trigger gate | Filters |
|---|---|---|---|---|---|
| `CORE_P1_ATP_GS_BET365` | 6:3 / 6:4 | bet365 | ≥ 2.50 | 6:4 in [5.00, 6.25] | ATP, Grand Slam |
| `VIP_P2_V3_SHAPE` | 3:6 / 4:6 / 5:7 | bet365, 1xBet, 10Bet | ≥ 3.50 | 4:6 in [6.25, 6.99] | none |
| `RESEARCH_P2_GS_26_46_BET365` | 2:6 / 4:6 | bet365 | 2.50 – 4.50 | none | Grand Slam, skew = EXTREME |
| `CORE_P2_GS_REVERSE_STRETCH` * | 2:6 / 4:6 / 5:7 | bet365 | 2.50 – 4.50 | none | Grand Slam, skew = EXTREME |

\* This lane appears in `README.md` as an active VIP lane but **does not exist in the
live scanner code**. Implemented here from the README spec and flagged as
README-derived.

Also pre-declared: the scanner's `CORE_P1_ATP_GS_BET365` uses **6:3 / 6:4** (Gate-2),
while README says the actively staked model is **Protected 3** (6:2 / 6:3 / 6:4).
Both variants are evaluated. Exactly two variants. This is not a search.

Carried over verbatim from the scanner:
- Market: `Correct Score 1st Half`
- `event_type_key` 265 (ATP) and 266 (WTA)
- Grouped odds = `1 / Σ(1/oᵢ)`
- Skew buckets from `scoreSkewBucket()`: ratio ≥ 1.75 = EXTREME
- Tournament grouping from `tournamentGroup()`
- One signal per match per lane (dedup on `event_key:lane:score_cluster`, first
  qualifying book in lane order) — matches the scanner's `stableSignalKey`

## 3. What is deliberately NOT done

- **No `Math.max` across bookmakers.** Every backtest in this repo takes the best
  price across all books, which is not executable and biases ROI upward. This test
  uses the lane's own named book, exactly as the live scanner does.
- **No model probability, no EV filter, no edge filter.** The calibration audit
  showed the model is worse than a constant and its `edge` column is anti-predictive.
  The lanes are pure price/shape gates, which is what they actually are.
- **No booster overlay.** Grouped units only. The 0.50u exact-score booster is
  reported separately if at all, never mixed into the headline.
- **No parameter variation.** Gates are used as written. No re-runs with adjusted
  thresholds.

## 4. Primary endpoint

**Optimized VIP Protected 3, grouped units, flat 1u per signal, over the full window.**

```
profit_units = grouped_odds - 1   if actual first-set score ∈ score group
             = -1                 otherwise
ROI = Σ profit_units / n
```

Actual first-set score is read from `fixture.scores[]` where `score_set == '1'`.
Finished singles only. Any fixture without a resolvable set-1 score is excluded and
counted in the exclusion log.

Secondary endpoints: each lane individually, the Gate-2 variant, and combined
Core + Reverse + Research + V3.

## 5. Pass / fail, fixed now

| Outcome | Interpretation |
|---|---|
| ROI ≥ +10% **and** n ≥ 100 | Genuine support. The claimed edge survived unseen data. I will say so plainly. |
| ROI between 0% and +10% | Weak/inconclusive. Consistent with no edge after vig. Not support. |
| ROI between −10% and 0% | Consistent with no edge. |
| ROI ≤ −15% | Consistent with the −18.02% real-price measurement — market is efficient and the vig is the whole story. |
| n < 40 | **Test is void.** Too thin to read. I will report the number and draw no conclusion. |

Stated in advance so it cannot be reinterpreted later:

- At n ≈ 150 and grouped odds ≈ 2.8, the standard error on ROI is roughly **±11%**.
  A result of +12% would be about 1 SE from zero. **This test cannot prove an edge
  exists.** It can only fail to refute one, or refute it fairly convincingly.
- A single positive window is not validation. Under the multiple-testing arithmetic
  in `docs/EDGE-AUDIT-2026-08.md`, ~325 settled bets are needed to detect a 15% edge
  at 95% confidence.
- If the result is positive I will **not** treat it as vindication, and if it is
  negative I will **not** treat it as final. I will report the number and the
  uncertainty around it.

## 6. Known limitations of this test

1. **Odds snapshot timing is unknown.** API-Tennis returns an odds record for a
   finished fixture without a documented timestamp. It may be opening, closing, or
   last-seen price. If it is closing price it is *more* favourable than what a
   bettor gets; if it is a late in-play-adjacent price it may be unrealistic in
   either direction. This is the single largest weakness and it is unfixable from
   this data source. It is why logging real prices at signal time still matters.
2. **No stake limits.** Exact-score markets are heavily limited. A positive ROI here
   does not establish that meaningful money can be placed.
3. **Free-tier rate limits** may force date sampling. Any sampling will be
   disclosed and will be systematic (contiguous or every-Nth-day), never
   result-dependent.
4. **Survivorship in the odds feed.** Matches missing the correct-score market are
   excluded; if that exclusion correlates with outcome, results are biased. The
   exclusion rate will be reported.

## 7. Deviations log

**Deviation 1 — first-set score parser (made after seeing data shapes, before seeing results).**

The API-Tennis probe returned first-set scores shaped `{"score_first":"7.9","score_second":"6.7"}`.
That is a tiebreak encoding: games `7`–`6`, breaker won `9`–`7`. The integer part is games.

My original `firstSetScore()` returned the literal `"7.9:6.7"`, which matches no score
group. Fixed to truncate to games and validate as a completed set.

While fixing it I found the repo's own `parseFirstSetScore()` has the same input but a
worse failure mode — it returns `null`, which **drops the match from the sample**:

```js
looksLikeTennisSet(7.9, 6.7)  // false  -> parseFirstSetScore returns null
```

Because a 7:6 / 6:7 first set is a guaranteed loss for every score group used here,
dropping those matches removes only losses. This is look-ahead bias: you cannot know
before the match that a set will reach a tiebreak.

The run therefore reports both accountings. This was **not** a threshold change and
did not alter any lane gate. No other deviations. Test run once.

**Non-deviation note:** `CORE_P2_GS_REVERSE_STRETCH` produced zero qualifying signals.
It was left in the output as a zero rather than removed or loosened.

---

*Research audit. Not financial advice.*
