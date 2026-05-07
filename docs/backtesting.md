# SlipIQ First Set Lab Backtesting

Backtesting is how SlipIQ checks whether First Set Lab is a real probability edge or just a good-looking model.

## What Backtest v1 does

The v1 backtest script:

1. Pulls historical API-Tennis fixtures for a date range.
2. Pulls API-Tennis odds for the same date range.
3. Extracts `Correct Score 1st Half` odds.
4. Parses the actual first-set score from returned fixture results.
5. Runs the SlipIQ first-set score distribution model.
6. Compares model probability against the actual result.
7. Simulates 1-unit paper bets where configured filters pass.
8. Outputs JSON summary and CSV row data.

## Run from GitHub Actions

Go to:

```txt
Actions -> Backtest First Set Lab -> Run workflow
```

Inputs:

```txt
date_start: YYYY-MM-DD
date_stop: YYYY-MM-DD
min_probability: default 0.03
min_ev: default 0
min_edge: default 0
```

The workflow requires this GitHub secret:

```txt
API_TENNIS_KEY
```

## Output artifacts

The workflow uploads an artifact named:

```txt
first-set-lab-backtest
```

It contains:

```txt
first-set-lab-summary-*.json
first-set-lab-rows-*.csv
```

## Key metrics

- `matches_tested`: matches with usable odds and parseable first-set result.
- `market_rows_tested`: all score-market rows tested.
- `qualified_bets`: rows that passed the filters.
- `wins`: qualified bets where the predicted score matched the actual first-set score.
- `hit_rate`: wins divided by qualified bets.
- `total_profit_units`: simulated profit using 1 unit per qualified bet.
- `roi_per_bet`: total profit divided by qualified bets.
- `average_odds`: average book odds of qualified bets.
- `brier_score_actual_outcome_probability`: rough accuracy score for actual outcome probability.
- `log_loss_actual_outcome_probability`: rough penalty for assigning low probability to the actual score.

## Important caveat

Backtest v1 uses the same current model style as the app: market-implied first-set edge plus estimated serve inputs.

This is not final proof yet. It is the first fast engine to answer:

```txt
Does API-Tennis give enough historical odds/results to test?
Does the current model have signal?
Which filters, odds ranges, and score types look dangerous or promising?
```

If the results are weak, that does not automatically kill SlipIQ. It means the next model upgrade must add stronger rolling serve/hold stats before premium claims.

## Recommended first runs

Start small:

```txt
2026-04-01 to 2026-05-06
```

Then try:

```txt
last 90 days
last 180 days
```

Run multiple filter sets:

```txt
min_probability=0.03, min_ev=0, min_edge=0
min_probability=0.05, min_ev=0.05, min_edge=0.02
min_probability=0.08, min_ev=0.10, min_edge=0.03
```

The goal is not to force a good result. The goal is to find out honestly where the model works, where it fails, and what needs to improve.
