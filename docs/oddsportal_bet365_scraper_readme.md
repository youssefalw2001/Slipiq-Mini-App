# SlipIQ OddsPortal bet365 1st Set Correct Score scraper

This scraper is for historical tennis 1st Set Correct Score research.

## Safety

- Read-only browser automation.
- No login.
- No betting.
- No captcha bypass.
- Uses slow pacing and saves progress continuously.
- Respect OddsPortal terms and verify samples manually before using results.

## Proven method

The working OddsPortal market URL format looks like:

```txt
https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12
```

The important mechanic is:

1. Open the exact Correct Score / 1st Set market URL.
2. Find each score row by both score and visible odds, for example `4:6 3 +3000`.
3. Click the far-left side of that row, where OddsPortal expands the bookmaker list.
4. Search only near that expanded row for a compact element containing `bet365`.
5. Extract the bet365 price.
6. Convert American odds to decimal.
7. Calculate grouped odds.

Do not treat visible OddsPortal odds as bet365 unless the expanded row confirms bet365.

## Smoke test expectation

The smoke URL is in:

```txt
data/oddsportal_exact_smoke_urls.txt
```

Expected smoke result:

```txt
bet365_confirmed_count = 6
3:6 bet365 +6600 = 67.00
4:6 bet365 +1800 = 19.00
5:7 bet365 +5000 = 51.00
6:3 bet365 +200 = 3.00
6:4 bet365 +450 = 5.50
7:5 bet365 +1400 = 15.00
p2_grouped_9_12 around 11.4725
p1_grouped_9_12 around 1.7188
```

## GitHub Actions

Run:

```txt
Actions -> OddsPortal Bet365 Overnight Scrape -> Run workflow
```

For a quick verification:

```txt
mode: smoke
```

For the overnight scrape:

```txt
mode: overnight
limit_total: 120
max_matches_per_results: 25
wait_ms: 4500
pause_seconds: 1.2
```

The workflow always runs the smoke test first. Overnight scraping only starts if the smoke test passes.

Artifacts are uploaded as:

```txt
oddsportal-bet365-smoke
oddsportal-bet365-overnight
```

The most important files are:

```txt
artifacts/output/oddsportal-bet365-overnight/bet365_master_odds_db.csv
artifacts/output/oddsportal-bet365-overnight/summary.json
artifacts/output/oddsportal-bet365-overnight/progress.json
artifacts/output/backtest-overnight/backtest_summary.json
artifacts/output/backtest-overnight/backtest_trades.csv
```

## Local / Codespaces commands

Install:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements-oddsportal.txt
python -m playwright install --with-deps chromium
```

Smoke test:

```bash
python scripts/oddsportal_bet365_first_set_scraper.py \
  --exact-urls-file data/oddsportal_exact_smoke_urls.txt \
  --limit-total 1 \
  --out artifacts/output/oddsportal-bet365-smoke \
  --smoke-test
```

Overnight scrape:

```bash
python scripts/oddsportal_bet365_first_set_scraper.py \
  --results-urls-file data/oddsportal_major_results_urls.txt \
  --limit-total 120 \
  --max-matches-per-results 25 \
  --out artifacts/output/oddsportal-bet365-overnight
```

Backtest:

```bash
python scripts/backtest_bet365_v3_from_csv.py \
  --csv artifacts/output/oddsportal-bet365-overnight/bet365_master_odds_db.csv \
  --out artifacts/output/backtest-overnight \
  --stake 100
```

## Outputs

Scraper output columns include:

- `first_set_score`
- `p2_3_6_raw`, `p2_3_6_decimal`
- `p2_4_6_raw`, `p2_4_6_decimal`
- `p2_5_7_raw`, `p2_5_7_decimal`
- `p2_grouped_9_12`
- `p2_v3_hit`
- `p1_6_3_raw`, `p1_6_3_decimal`
- `p1_6_4_raw`, `p1_6_4_decimal`
- `p1_7_5_raw`, `p1_7_5_decimal`
- `p1_grouped_9_12`
- `p1_hit`
- `bet365_confirmed_count`
- `status`

Grouped formula:

```txt
1 / (1/odds_a + 1/odds_b + 1/odds_c)
```

P2 V3 hit:

```txt
first_set_score in 3:6, 4:6, 5:7
```

P1 hit:

```txt
first_set_score in 6:3, 6:4, 7:5
```
