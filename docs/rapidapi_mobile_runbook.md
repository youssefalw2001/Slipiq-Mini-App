# SlipIQ RapidAPI Odds Feed Mobile Runbook

This is the no-code/mobile flow for probing RapidAPI Odds Feed for SlipIQ V3 tennis first-set correct-score odds.

## Important security note

If you accidentally paste a RapidAPI key into chat, treat it as exposed.

Immediately rotate/revoke that key inside RapidAPI, then save the new key only as the GitHub Actions secret named:

```txt
RAPIDAPI_KEY
```

Do not paste the new key into chat, code, commits, workflow inputs, screenshots, or docs.

## What this does

The workflow is read-only.

It can:
- Call the RapidAPI Odds Feed API using the `RAPIDAPI_KEY` GitHub secret.
- Save raw JSON responses as GitHub Actions artifacts.
- Search the response for tennis / 1xBet / 1st Set Correct Score odds.
- Try to find the V3 scores: `3:6`, `4:6`, `5:7`.
- Calculate grouped V3 odds if all three scores are found.
- Create a SlipIQ-compatible `upcoming_firstset_summary.json` for the existing Supabase pusher.
- Dry-run the Supabase pusher shape check.

It does not:
- Log in to any sportsbook.
- Place bets.
- Store sportsbook credentials.
- Commit or print your RapidAPI key.

## One-time setup

In GitHub mobile/browser:

1. Open the repo: `youssefalw2001/Slipiq-Mini-App`.
2. Go to `Settings`.
3. Go to `Secrets and variables` → `Actions`.
4. Tap `New repository secret`.
5. Add this secret name:

```txt
RAPIDAPI_KEY
```

6. Paste your RapidAPI key as the value.
7. Save.

## Current RapidAPI Odds Feed smoke endpoint

The current workflow defaults are already set from the RapidAPI curl example.

Use these defaults for the first smoke test:

```txt
mode: rapidapi-live-1x2-smoke
rapidapi_host: odds-feed.p.rapidapi.com
endpoint: /api/v1/markets/feed
params: {"placing":"LIVE","market_name":"1X2","bet_type":"BACK","page":"0","event_ids":"845,123,435,22,842,844,845","period":"FULL_TIME_AND_OT"}
bookmaker: 1xBet
grouped_threshold: 3.3
max_requests: 1
```

This first run is only a connectivity/schema smoke test. It uses `market_name=1X2`, so it will probably not find V3 first-set correct-score rows yet.

A successful smoke test means:

```txt
The API key works.
The host works.
The endpoint works.
Raw JSON artifacts are created.
```

After that, the next step is to discover the API's exact parameter name/value for tennis 1st-set correct score.

## How to run on mobile

1. Open the repo in GitHub.
2. Tap `Actions`.
3. Tap `RapidAPI Odds Feed Probe`.
4. Tap `Run workflow`.
5. Leave the defaults for the first smoke test.
6. Tap the green `Run workflow` button.

## What to check after it runs

Open the completed workflow run and download the artifact named like:

```txt
rapidapi-oddsfeed-probe-rapidapi-live-1x2-smoke
```

Inside the artifact, look for:

```txt
summary.json
normalized_candidate_odds.csv
rapidapi_v3_summary.json
upcoming_firstset_summary.json
*.raw.json
*.meta.json
```

The first smoke run may show zero V3 rows because it is using `1X2`, not first-set correct score. That is okay.

## What a good V3 result means

For a real V3 market test, a good result is:

```txt
exact_3_6_rows > 0
exact_4_6_rows > 0
exact_5_7_rows > 0
actionable_count > 0
```

This means the API returned all three V3 legs and the grouped odds passed the threshold.

## Signal labels

- `WATCH` = RapidAPI / 1xBet source found a V3 candidate, but bet365 baseline is not confirmed.
- `OFFICIAL` = bet365 baseline confirmed and V3 passes.
- `BOOSTED` = bet365 passes and another bookmaker offers better grouped odds.
- `SKIP` = missing one of `3:6`, `4:6`, `5:7`, or grouped odds below threshold.

RapidAPI 1xBet-only results should start as `WATCH`, not `OFFICIAL`.

## First probing order after smoke test

Run these in order until the API proves exact market availability.

### 1. Tennis discovery

Use the endpoint/params shown by RapidAPI for tennis events or market feeds. Keep the same host:

```txt
rapidapi_host: odds-feed.p.rapidapi.com
```

Goal: prove the API returns tennis events/markets.

### 2. Correct-score market discovery

Try only the market names shown by the RapidAPI docs or raw JSON. Possible names to test only if the API supports them:

```json
{"placing":"LIVE","market_name":"CORRECT_SCORE","bet_type":"BACK","page":"0","period":"FIRST_SET"}
```

```json
{"placing":"LIVE","market_name":"1ST_SET_CORRECT_SCORE","bet_type":"BACK","page":"0"}
```

```json
{"placing":"LIVE","market_name":"SET_1_CORRECT_SCORE","bet_type":"BACK","page":"0"}
```

Goal: find exact 1st Set Correct Score market naming.

### 3. Event-specific odds

After the raw JSON reveals a tennis event ID, use the endpoint and parameter names from RapidAPI docs, for example:

```json
{"placing":"LIVE","market_name":"CORRECT_SCORE","bet_type":"BACK","page":"0","event_ids":"PASTE_EVENT_ID_HERE","period":"FIRST_SET"}
```

Goal: pull one match's full market tree instead of wasting requests on the whole board.

## Important rules

- Do not run every 15 minutes until exact market availability is proven.
- Do not send Telegram alerts from RapidAPI-only `WATCH` rows.
- Do not treat `Total 2 Over 5.5 first set` as a replacement for correct-score odds.
- Do not store 1xBet credentials.
- Do not automate sportsbook login or bet placement.
- Always manually verify before any real-world betting decision.

## Pipeline target

The intended safe pipeline is:

```txt
RapidAPI Odds Feed
→ raw JSON artifact
→ normalized candidate odds CSV
→ rapidapi_v3_summary.json
→ upcoming_firstset_summary.json
→ Supabase dry-run shape check
→ later Supabase logging only after schema is confirmed
```
