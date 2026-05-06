# Odds-API.io Tennis Market Probe

This probe checks whether an Odds-API.io key exposes the tennis markets SlipIQ needs.

## Why this exists

SlipIQ's flagship market is tennis first-set correct score.

Before integrating or paying, we need to inspect actual tennis odds responses for:

- first-set correct score
- first-set winner
- set betting
- first-set total games
- game totals

## Security

Never paste the API key in chat or commit it to the repo.

Store it only as a GitHub Actions secret:

```txt
ODDS_API_IO_KEY
```

## How to run

1. GitHub repo → Settings → Secrets and variables → Actions.
2. Add repository secret:
   ```txt
   ODDS_API_IO_KEY=your_key
   ```
3. Go to:
   ```txt
   Actions → Probe Odds-API.io Tennis Markets → Run workflow
   ```
4. Open the workflow logs.
5. Look for:
   ```txt
   Probe verdict signals
   ```

## What the results mean

If it says:

```txt
POSSIBLE MATCH
```

Then the response may include first-set correct-score style markets. Inspect logs carefully before integrating.

If it says:

```txt
FALLBACK LIKELY
```

Then first-set/set/total markets may exist, but exact first-set correct score was not clearly confirmed.

If it says:

```txt
NO CLEAR MATCH
```

Then this sampled Odds-API.io response did not expose the flagship market.

## Notes

The probe uses:

- `GET /events` for tennis events.
- `GET /odds/multi` for odds on up to 10 sampled events.

It intentionally prints market signals, not the secret key.
