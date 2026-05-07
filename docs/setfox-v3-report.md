# SetFox V3 Strategy Report

**Status:** Research-grade. Not yet validated by walk-forward V3. Do not market the app as profitable. Do not gate Premium on any unverified rule.

This document is the honest Phase 8 deliverable for SlipIQ's SetFox v3 work. It exists to keep the team calibrated against the data we actually have, not the data we wish we had.

---

## 1. Executive summary

We did not generate new backtest numbers in this PR. What we shipped is the infrastructure to *honestly* find a robust rule:

- A walk-forward backtest engine (`scripts/backtest-first-set-lab-v3.mjs`) that supports a coupled and an **independent** model mode so we can measure how much of the v2 signal was just cross-market price disagreement.
- A walk-forward optimizer (`scripts/model-walkforward-v3.mjs`) that requires rules to survive on multiple held-out test folds with a Wilson-CI sanity check before promoting them.
- A Monte Carlo drawdown simulator (`scripts/model-drawdown-sim.mjs`).
- A `live_setfox_signals` table, scanner-stats aggregation, and a SetFox filter wired through the live data-refresh path and the React app, so we can start collecting **forward-test proof from today**.

We have *not* enabled Strict Mode as a "validated" badge. The default rule reflects the strongest pocket from the existing 3-window consensus run (ITF / normal score family / x12-18 odds / no tiebreaks / no doubles), but it is shipped as **Research mode** in the UI until walk-forward V3 produces ≥3 positive test folds with ≥80 total test bets and overfit risk < 0.5.

## 2. What currently works

- **Real API-Tennis odds + real first-set results.** `parseFirstSetScore` in v2/v3 reads `fixture.scores[]` and finds `score_set === '1'`. This is the core trustworthy data layer.
- **Chunked historical fetching with retries.** Survives provider hiccups; logs chunk errors per window.
- **V1/V2 backtest engines** correctly compute model probability, fair odds, edge, EV, won/lost flags, and per-bet profit at flat 1u stake.
- **Score family / odds bucket / tournament level / match type / surface taxonomies** are useful and reused across v2/v3.
- **Consensus and master-validate scripts** have the right *shape*; they're just selecting on the wrong objective (see §3).

## 3. What is wrong (and how V3 addresses it)

### 3.1 Circular model

`estimatedPlayerStats` derives `fs1 / w1s / w2s / bpSave` from `firstSetEdge`, which is computed from the **`Home/Away (1st Set)` market**. The resulting correct-score distribution is then compared to the **`Correct Score 1st Half` market**. Any "edge" is largely cross-market price disagreement.

> This is still useful — book-internal mispricing is a real edge — but it is not "we modelled tennis better than the book". It's "we noticed two of the book's prices disagree."

**V3 addresses this** with `BACKTEST_MODEL_MODE=independent`, which forces `firstSetEdge=0`, leaving only tournament-level + surface priors. The walk-forward workflow runs both modes side-by-side. Compare the two reports:
- If `independent` is positive across folds → genuine tennis structure exists.
- If only `coupled` is positive → the strategy is cross-market arbitrage; act accordingly (smaller edge, more volatility, faster line moves).

### 3.2 Top-of-sample selection in `model-master-v2-validate.mjs`

`trainRules()` keeps the top 150 rules **by training ROI** and then "validates" them. With ~2,000+ rules in the search space, the top 150 by train ROI are precisely the most overfit. Reporting the validation ROI of *those specific rules* is an in-sample-leak optimization, not a validation.

**V3 addresses this** with proper walk-forward in `model-walkforward-v3.mjs`:
- For each fold k, train on cumulative windows 0..k-1.
- Survival on training requires bets ≥ minBetsPerWindow, ROI > 0, and Wilson-95 lower bound on hit rate above implied probability.
- Test on window k. Only test-fold metrics are reported as out-of-sample.

### 3.3 Consensus uses overlapping intervals

The current `model-consensus-v2-first-set.yml` defaults run windows that don't actually walk forward (Mar 1-18, Mar 19-31, Apr 1-18). This is more "three-window stability" than walk-forward. It's still informative, but not a forward-test substitute.

**V3 addresses this** with 6 sequential windows by default and a workflow that fans out to two model modes.

### 3.4 Tiebreak leakage into live data

The v2 consensus script skips tiebreak rules in the *rule generator*, but the v2 *backtest engine* and the **live data-refresh function** do not block tiebreak scores. The frontend was happily showing 7-6 / 6-7 cards at -66% to -95% historical ROI as legitimate opportunities.

**V3 addresses this** at three layers:
- v3 backtest hard-blocks tiebreak rows when `BACKTEST_BLOCK_TIEBREAK=1` (default).
- `evaluateSetFox` in `src/lib/setfoxFilter.ts` rejects tiebreak with a dedicated reason.
- The Supabase `data-refresh` function tracks `tiebreak_blocked` in scanner stats.

### 3.5 Surface inference is heuristic regex

Tournament name regex maps "Madrid Challenger" and "Madrid ATP" to the same surface, ignores court info, and silently defaults to hard. Surface accuracy is probably 80-90% for top-tour and lower for ITF/Challenger, which is exactly the pocket we currently care about most.

**V3 addresses this partially** with a rule-based map and a tightened regex; full fix needs a tournament_surface_map.json or, better, an upstream provider field. Tracked but not solved.

### 3.6 Player stats are estimated, not measured

`estimatedPlayerStats` is a heuristic seeded by tournament tier and surface. We do not currently use Jeff Sackmann data, rolling 52-week serve/return percentages, head-to-head, or anything else player-specific.

**V3 does not solve this.** Solving it is the highest-leverage modeling improvement remaining. Plumbing for Sackmann ingestion + per-player rolling stats per surface is the natural next pass.

## 4. Backtest findings (existing)

The user-supplied numbers from prior runs:

| Run | Bets | Wins | Hit rate | Avg odds | Profit | ROI |
|---|---|---|---|---|---|---|
| V1 broad (all positive-EV) | 13,200 | 1,017 | 7.70% | x12.03 | -4,825u | -36.6% |
| V2 challenger blowout (val) | 179 | 31 | 17.3% | x7.52 | +36.5u | +20.4% |
| V2 tour_other blowout (val) | 264 | 25 | 9.5% | x14.19 | +61.3u | +23.2% |
| V2 ITF normal x12-18 (3 win) | 191 | — | — | — | +77u | +40.3% |

**Caveats** (apply to all positive results):

- Sample sizes are thin. The Wilson 95% CI for a 16% hit rate at n=191 spans roughly 11-22%. A 20% ROI at n=191 is one standard error from a flat-line result.
- All three positive pockets used a coupled model. We do not yet know how much of the apparent ROI survives in independent mode.
- The "tournament level" leg-up shifted between runs (challenger → tour_other → ITF) — the rule that wins is a moving target, which is itself a sign of overfitting.
- Tiebreak rows were included in some v1/v2 runs even though they were known to be -66% to -95%, so any backtest that included them is artificially deflated and should be re-run with `BACKTEST_BLOCK_TIEBREAK=1`.

## 5. Walk-forward findings

**None yet.** This PR ships the engine. Run `Model Walkforward V3` to populate this section. The expected first-pass output is:

- `coupled` mode: at least one rule probably survives because cross-market disagreement is a real (if small and crowded) edge.
- `independent` mode: most rules fail. If any survives, that's the real signal.

Watch for:
- High `overfit_risk_score` (≥0.7) → the survivor is likely lucky.
- `worst_test_fold_roi` < `WALKFORWARD_WORST_TEST_ROI_FLOOR` → rule is fragile.
- Wilson hit-rate lower bound < average implied probability → the rule's "edge" is statistically indistinguishable from the book's price.

## 6. Overfitting risk

| Risk | Severity | Mitigation in this PR |
|---|---|---|
| Top-of-sample rule selection | High | Walk-forward optimizer rejects rules that don't survive Wilson sanity check on training |
| Search-space inflation | Medium | Optimizer reports `rules_searched` and computes `overfit_risk_score` from search/survival ratio + sample protection |
| Cross-market leak | High | `BACKTEST_MODEL_MODE=independent` provides a clean baseline; both modes always run side-by-side |
| Tiebreak inclusion | Resolved | Hard-blocked at backtest, filter, and live-data layers |
| Single-period luck | High | Walk-forward needs ≥3 positive test folds by default |
| Fragile thresholds | Medium | Worst-fold-ROI floor; rule complexity cap |
| Survivorship bias in drawdown sim | Medium | Documented caveat; bootstrap is on full CSVs by default |

## 7. Model weaknesses (still open)

1. **Circular features.** Even in independent mode, our priors are tournament-tier and surface-based, not player-specific. Real serve/return rolling stats per surface are the highest-impact next addition.
2. **Surface inference.** Regex/map only. Wrong on at least 5-10% of lower-tier rows.
3. **Doubles.** Excluded by default in v3 because the model is calibrated for singles.
4. **No CLV.** Schema has `opening_odds`, `signal_odds`, `closing_odds`, `clv` columns now; we still need a job that fetches closing odds and backfills them.
5. **No live paper trading yet.** That's exactly what `live_setfox_signals` is for. From the moment the migration is applied, every Strict-Mode pass becomes a forward-tracked bet.

## 8. Best SetFox rule (current default)

```
version: setfox.v3.research.itf-normal-12to18
allowed_tournament_levels: [itf]
allowed_score_families: [normal]    # 6-4, 4-6, 7-5, 5-7
allowed_odds_buckets: [odds_12_18]
max_odds: 18
min_probability: 3%
min_ev: 0
min_edge: 0
block_tiebreak: true
block_doubles: true
```

**Promote to Validated only if** the `Model Walkforward V3` workflow returns:
- ≥3 positive test folds in **independent mode**
- ≥80 total out-of-sample bets
- Worst-fold ROI ≥ -10%
- `overfit_risk_score` ≤ 0.5
- Wilson 95% lower bound on hit rate > average implied probability

Until then, the in-app badge stays "Research mode".

## 9. Rules to block (always)

- `score_family = tiebreak` (7-6 / 6-7) — historically -66% to -95% ROI, no version of the model has shown otherwise
- `match_type = doubles` — different dynamics, not modeled
- `bookmaker_odds > 30` — pure lottery, infinite variance, unsafe to recommend even as research

## 10. Product UX recommendations

1. **Strict Mode toggle** on Home, off by default for Free users (limits feed to SetFox passes).
2. **SetFox badge on cards** (already shipped): green pill if ≥1 outcome passes, neutral if 0.
3. **Per-outcome explanation line** on First Set Lab detail (already shipped): tells the user *why* a row was rejected.
4. **Scanner stats card** at the top of Home (already shipped): "Scanned X · Y passed · Z tiebreak blocks". Builds the perception that we reject more than we recommend, which is the truth.
5. **My Slips → SetFox column** to track passed-leg performance separately from non-SetFox legs. Schema is ready, UI is one column wide.
6. **Confidence badge tone** stays orange ("Research") until walk-forward proof exists. Then yellow ("Watchlist") for ≥3 positive folds. Only flip to green ("Validated") after 200+ live forward bets show a positive Wilson lower bound.
7. **Disclaimers** are already present in `ResponsibleNotice`. Reinforce on the SetFox card with: "Research signal. No guaranteed outcomes."
8. **Premium tier** should not gate on profitability. Gate on volume: more alerts, full history, raw CSV exports, model_run history.

## 11. Launch recommendation

Soft-launch with Strict Mode visible but prominently labeled "Research mode". Use the live forward feed to populate `live_setfox_signals` for 30 days, then gate any "Validated" claim on the forward results, **not** on the historical backtest.

Do not advertise hit rates or ROI numbers anywhere user-facing. Show probabilities, edge, EV, fair odds, and let the math speak.

## 12. Monetization recommendation

- Free: live feed + SetFox badge + 3 saved slips
- Premium ($9.99 / 500 Stars): unlimited slips, full SetFox signal log, alerts, exports
- VIP ($29.99 / 1500 Stars): early alerts, weekly model report, monthly drawdown simulations on the user's slip history

Do **not** charge for "winning picks". Charge for the scanner, the math, the alerts, and the audit trail.

## 13. What still needs live proof

| Item | Source | Verdict |
|---|---|---|
| Independent-mode positive ROI | Workflow re-run with `BACKTEST_MODEL_MODE=independent` across 6 walk-forward windows | Pending |
| Walk-forward survival of the default rule | `model-walkforward-v3.mjs` | Pending |
| Forward-test from `live_setfox_signals` | Run data-refresh on schedule for 30 days, backfill match results | Pending |
| CLV signal | Still needs closing-line ingestion | Not implemented |
| Real serve/return stats | Sackmann ingestion job | Not implemented |

## 14. Grade

**Before this PR:** model proof 5/10. Tiebreak leak in live path; selection bias in master-validate; no walk-forward; no forward-test infrastructure; circular model un-measured.

**After this PR:**
- *Code/infrastructure*: 7.5/10. We can now run an honest walk-forward, separate cross-market arbitrage from real tennis edge, hard-block toxic scores, and forward-track every signal.
- *Strategy proof*: 5/10 (unchanged). New numbers haven't been generated yet; old ROI claims still depend on coupled-mode estimates and thin samples. The grade only moves when the workflow produces independent-mode survivors.

## How to actually get to 8/10 or better

1. Run `Model Walkforward V3` with the default 6 windows in **both** modes.
2. Inspect the artifacts. If independent-mode candidates exist with ≥3 positive folds and overfit risk < 0.5, lock that rule into `SETFOX_RULE`.
3. Apply `supabase/schema.sql` so `live_setfox_signals` and `setfox_scanner_runs` exist in production.
4. Schedule `data-refresh` to run twice daily (already a workflow). Let it accumulate 30 days of forward signals.
5. Build a `setfox-resolve` job: read fixture results, mark each signal won/lost/void, compute live ROI + Wilson CI.
6. **Then** flip the in-app confidence badge to Watchlist or Validated.

Until step 6, the app shows real math, real odds, real model probability, real EV, and real "the book disagrees with itself by X%" — and is honest that those are inputs, not promises.
