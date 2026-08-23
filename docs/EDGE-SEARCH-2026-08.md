# Edge Search — August 2026

**Question:** forget the existing strategy — is there *any* real edge findable in the
API-Tennis data?

**Answer: no established edge was found.** One candidate has a pulse and is worth
forward-testing. Several apparent edges were investigated and shown to be artifacts.

Method: fresh 12-month pull (2025-09-01 → 2026-08-20), correct tiebreak-aware score
parsing, chronological 70/30 train/holdout split. Four hypotheses pre-specified in
`scripts/edge-search.mjs`; a fifth formed after round 1 and disclosed as such in
`scripts/edge-search-2-beat-pinnacle.mjs`.

Sample: 7,513 finished singles with a valid set-1 score, 6,989 with correct-score
prices, 18 bookmakers in the feed, 97,843 individual score prices, 26,166
market/side observations with a Pinnacle reference.

---

## Finding 1 — First-set correct score is definitively dead

Every score outcome, best price across all 18 books, tiebreaks correctly counted:

| Price band | n | Hit rate | Break-even | ROI | t |
|---|---|---|---|---|---|
| 1–5 | 1,560 | 21.22% | 22.34% | −5.08% | −1.10 |
| 5–7 | 11,444 | 15.73% | 16.64% | −6.13% | −3.00 |
| 7–9 | 13,564 | 11.44% | 12.87% | −11.42% | −5.38 |
| 9–12 | 13,004 | 8.50% | 9.92% | −15.18% | −6.16 |
| 12–16 | 20,064 | 5.98% | 7.29% | −18.89% | −8.22 |
| 16–22 | 12,444 | 4.52% | 5.42% | −17.00% | −4.95 |
| 22+ | 25,763 | 1.70% | 1.65% | −36.48% | −7.48 |
| **All pooled** | **97,843** | **7.14%** | **4.11%** | **−20.04%** | **−10.02** |

Not one band clears its break-even. n=97,843 and t=−10.02 — this is no longer a
question of sample size. **This market cannot be beaten from this data.** Note this
is at *best price across 18 books*, the most favourable accounting possible.

## Finding 2 — The favourite–longshot "pulse" was the tiebreak bug

The earlier audit flagged short-priced correct scores as the one region with possible
value. With tiebreaks correctly counted, that disappears:

| | n | Hit | Break-even | ROI | t |
|---|---|---|---|---|---|
| Shortest-priced score, TRAIN | 4,892 | 16.99% | 17.53% | −4.90% | −1.60 |
| Shortest-priced score, **HOLDOUT** | 2,097 | 17.88% | 17.40% | **+1.01%** | **0.21** |

Essentially exactly fair. The apparent bias was mostly the missing tiebreak losses.
**Hypothesis rejected.**

## Finding 3 — Line shopping is worth ~10 points, and is not optional

Same bet (shortest-priced first-set score), different execution:

| Execution | n | Avg odds | ROI |
|---|---|---|---|
| bet365 only | 6,704 | 5.13 | **−13.60%** |
| Best of 18 books | 6,989 | 5.72 | **−3.12%** |

Betting a single book costs ~10.5 points of ROI. Every backtest in this repo used
`Math.max` across books, i.e. assumed perfect line shopping, while the live model
staked one book. That gap alone is larger than any claimed edge.

## Finding 4 — WARNING: the "arbitrage" in this feed is mostly fake

The raw scan reported 12,717 arbitrage opportunities (11.06% of observations),
including "risk-free 37%" on `Home Team Total (1st Set)`. **These are not real.**

```
Home Team Total (1st Set)
  Over:   1xBet 4.15   Betano 1.40   Superbet 4.15
  Under:  1xBet 1.19   Betano 2.70   Superbet 1.20
```

The API does not expose the handicap line in the outcome label. 1xBet's "Over" and
Betano's "Over" are **different lines**. Taking best-of-both is not a hedge — both
sides can lose. Any Total / Handicap / Over-Under / Aces / Double-Faults market in
this feed is unusable for arbitrage detection.

Real 2-way complementary markets (`Home/Away`, `Home/Away (1st Set)`, `Odd/Even`)
*do* show genuine small arbs, but they are ~0.2–0.5%, require accounts at up to 18
books including Pinnacle / Betfair / SBO, and arbing is the fastest route to account
limitation. Not a business.

**Any future arb scanner must verify that outcome labels are complementary before
summing implied probabilities.**

## Finding 5 — The structural insight: you were playing in the most expensive market

Median bookmaker margin after full line shopping, genuine 2-way markets only:

| Market | Margin (best of all books) | Margin (single book) |
|---|---|---|
| Home/Away (match winner) | **1.86%** | 5.71% |
| Home/Away (1st Set) | **2.52%** | 7.03% |
| Set Betting | 5.24% | 12.27% |
| Number of sets | 5.25% | 7.55% |
| Odd/Even (1st Set) | 6.41% | 7.64% |
| **First-set correct score** | **~11%** | **~13–17%** |

Mean Pinnacle two-way margin: **3.42%**.

To profit in correct score you must out-predict the market by >13%. In first-set
match winner, by >2.5%. **The niche was chosen backwards.** This is the single most
useful strategic finding in this document.

## Finding 6 — The one candidate with a pulse: value vs Pinnacle

Pinnacle is a low-margin, high-limit book that does not restrict winners, so its
vig-free price is the best available estimate of true probability. Standard
professional approach — no sport model at all:

```
pinnacle_fair_prob = (1/pinn_side) / (1/pinn_home + 1/pinn_away)
value = best_other_book_price / (1/pinnacle_fair_prob) - 1
bet if value >= threshold
```

Baseline, no selection — bet every side at best non-Pinnacle price:

| Market | n | ROI | t |
|---|---|---|---|
| Home/Away | 13,582 | −4.63% | −4.07 |
| Home/Away (1st Set) | 12,584 | −3.90% | −3.86 |

Threshold selected on train, applied **once** to holdout:

| | n | Hit | Avg odds | Units | ROI | t | 95% CI |
|---|---|---|---|---|---|---|---|
| TRAIN, value ≥ 5% | 758 | — | — | — | +1.79% | 0.21 | — |
| **HOLDOUT, value ≥ 5%** | **346** | 32.95% | 5.24 | +59.5u | **+17.21%** | **1.30** | **[−8.73%, +43.14%]** |

### Verdict: NOT established. Do not stake this.

Reasons, stated plainly:

1. **CI includes zero.** [−8.73%, +43.14%].
2. **Fails its own noise bar.** With K=5 hypotheses tested, expected best-of-noise
   t ≈ 1.79. Observed t = 1.30. It does not clear the bar I set before looking.
3. **Train and holdout disagree.** Train said +1.79%, holdout said +17.21%. A real
   edge is boringly consistent. This inconsistency is the signature of noise.
4. **Per-book scatter is incoherent** — bet365 −20.59% (n=116), 1xBet +40.31%
   (n=100), SBO +92.70% (n=23). Random dispersion, not a pattern.
5. **It selects longshots** (avg odds 5.24). Large price disagreements cluster where
   books are slowest and limits are smallest, and where a stale price gets pulled
   before you can take it.

### Why it is still the best candidate

It requires no sport model, no calibration, no player stats. It only requires that
one book is slower than Pinnacle — which is structurally true and not a fitted
parameter. It operates at a 3.42% margin instead of 17%. And it is testable forward
with zero money at risk, because the value is computable at bet time.

## What to do

1. **Abandon first-set correct score.** Finding 1 is conclusive at n=97,843.
2. **Fix and re-baseline.** `looksLikeTennisSet` is patched in
   `backtest-first-set-lab{,-v2,-v3}.mjs`. Re-run any backtest whose numbers you
   still quote. Expect every headline to collapse.
3. **Re-grade the live Supabase ledger.** If `result-resolver` shares the parser,
   tiebreak first sets may be recorded as void rather than LOSS, meaning live P/L is
   overstated too.
4. **Forward-log Pinnacle value, no stakes.** Compute `value` for every
   `Home/Away` and `Home/Away (1st Set)` quote at scan time and store it. After
   ~400 settled observations you will know whether Finding 6 is real. Zero risk.
5. **Track CLV.** Signal price vs Pinnacle closing price. If you cannot beat
   Pinnacle's close, there is no edge, and this answers it in weeks rather than the
   ~325+ settled bets a direct ROI test needs.
6. **Repoint the product.** The scanner, Supabase proof vault, Telegram delivery and
   ledger are all genuinely good. A line-shopping / value-vs-sharp tool for a 2-way
   market is a more honest and more defensible product than exact-score tips, and it
   reuses nearly all of the existing infrastructure.

## Bonus deliverable — true first-set score base rates

Measured on 6,989 matches with tiebreaks correctly included. Your model claimed
~20% for outcomes whose real rate is ~12%. These are the real numbers:

| Score | True rate | Fair odds |
|---|---|---|
| 4:6 | 12.22% | 8.18 |
| 6:4 | 12.10% | 8.26 |
| 6:3 | 12.02% | 8.32 |
| 3:6 | 11.26% | 8.88 |
| 6:7 | 8.46% | 11.83 |
| 6:2 | 8.01% | 12.48 |
| 7:6 | 7.30% | 13.70 |
| 2:6 | 6.44% | 15.53 |
| 1:6 | 5.02% | 19.91 |
| 6:1 | 4.72% | 21.18 |
| 7:5 | 4.66% | 21.44 |
| 5:7 | 4.65% | 21.50 |
| 6:0 | 1.63% | 61.31 |
| 0:6 | 1.50% | 66.56 |

Tiebreak first sets are **15.78%** of all matches (7:6 + 6:7) — the single largest
category after the four common scores, and the one your pipeline was deleting.

### The mechanism, stated precisely

Tiebreak first sets are 15.78% of matches and are guaranteed losses for every group
used here. Deleting them from the denominator multiplies the apparent hit rate by:

```
1 / (1 - 0.1578) = 1.187
```

A true 32.13% group (6:2/6:3/6:4) therefore *appears* to hit 38.15%. At grouped odds
3.02 that turns a break-even proposition into roughly the +20–25% ROI the README
advertises. **That single factor is the whole claimed edge.**

Caveat on using the table above for lane-level prediction: the lanes select matches
by price shape, so their *conditional* score probabilities differ from these
unconditional rates. The table is the right input for model calibration, not for
predicting a specific lane's ROI. The pooled check does line up though — the four
lanes averaged ~29% true against a 29.07% break-even, predicting roughly 0% to −3%,
against −2.77% measured.

---

*Research audit. Not financial advice. No edge was established; nothing here is a
recommendation to stake money.*
