# Blind Sim Enrichment Input

Upload `blind-sim-bets.csv` to this folder before running the GitHub Action:

```txt
artifacts/input/blind-sim-bets.csv
```

Then run:

```txt
GitHub -> Actions -> Enrich Blind Sim First Set Scores -> Run workflow
```

The workflow uses `secrets.API_TENNIS_KEY` to call API-Tennis `get_fixtures`, enriches the CSV with actual first-set scores, and uploads the result as an artifact named `blind-sim-first-set-enriched`.

The script only uses safe first-set/set-1 score fields. It does not use match-final score as first-set score.
