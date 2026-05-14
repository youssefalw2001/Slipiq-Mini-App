# SlipIQ RapidAPI Odds Feed Mobile Runbook

This is the no-code/mobile flow for probing RapidAPI Odds Feed for SlipIQ V3 tennis first-set correct-score odds.

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

Do not paste this key into chat, code, commits, or workflow inputs.

## Where to get the workflow values from RapidAPI

On the RapidAPI Odds Feed API page:

1. Open the endpoint you want to test.
2. Open `Code Snippets`.
3. Choose JavaScript / fetch.
4. Find this header:

```js
'x-rapidapi-host': 'something.p.rapidapi.com'
```

Use that as the GitHub Action `rapidapi_host` value.

Then look at the request URL. Example:

```txt
https://something.p.rapidapi.com/v1/odds?sport=tennis&bookmaker=1xbet
```

Use:

```txt
endpoint: /v1/odds
params: {"sport":"tennis","bookmaker":"1xbet"}
```

The exact endpoint and params depend on the RapidAPI page. Do not guess if the page shows different names.

## How to run on mobile

1. Open the repo in GitHub.
2. Tap `Actions`.
3. Tap `RapidAPI Odds Feed Probe`.
4. Tap `Run workflow`.
5. Fill in:

```txt
mode: live-tennis-1xbet-discovery
rapidapi_host: the host from RapidAPI, without https://
endpoint: the endpoint path from RapidAPI, like /v1/odds
params: {"sport":"tennis","bookmaker":"1xbet"}
bookmaker: 1xBet
grouped_threshold: 3.3
max_requests: 1
```

6. Tap the green `Run workflow` button.

## What to check after it runs

Open the completed workflow run and download the artifact named like:

```txt
rapidapi-oddsfeed-probe-live-tennis-1xbet-discovery
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

The most important file is:

```txt
upcoming_firstset_summary.json
```

## What a good result means

Good result:

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

## First probing order

Run these in order until the API proves exact market availability.

### 1. Tennis discovery

```json
{"sport":"tennis"}
```

Goal: prove the API returns tennis.

### 2. 1xBet discovery

```json
{"sport":"tennis","bookmaker":"1xbet"}
```

Goal: prove the API returns bookmaker-specific odds for 1xBet.

### 3. Correct-score market discovery

Try only the market names shown on the RapidAPI page. Common examples are:

```json
{"sport":"tennis","bookmaker":"1xbet","market":"correct_score"}
```

```json
{"sport":"tennis","bookmaker":"1xbet","market":"1st_set_correct_score"}
```

```json
{"sport":"tennis","bookmaker":"1xbet","market":"set_1_correct_score"}
```

Goal: find exact 1st Set Correct Score market naming.

### 4. Event-specific odds

After the raw JSON reveals an event ID, use the endpoint and parameter names from RapidAPI docs, for example:

```json
{"event_id":"PASTE_EVENT_ID_HERE","bookmaker":"1xbet"}
```

or:

```json
{"fixture_id":"PASTE_FIXTURE_ID_HERE","bookmaker":"1xbet"}
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
