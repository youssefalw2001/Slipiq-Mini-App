# SlipIQ RapidAPI Odds Feed Mobile Runbook

This is the no-code/mobile flow for probing RapidAPI Odds Feed for SlipIQ V3 tennis first-set correct-score odds.

## Important security note

If you accidentally paste a RapidAPI key into chat, treat it as exposed.

Immediately rotate/revoke that key inside RapidAPI, then save the new key only as the GitHub Actions secret named:

```txt
RAPIDAPI_KEY
```

Do not paste the new key into chat, code, commits, workflow inputs, screenshots, or docs.

## Current finding: `/api/v1/markets/feed` is not enough for V3

The GitHub workflow and RapidAPI connection work.

But the tested endpoint:

```txt
/api/v1/markets/feed
```

is not suitable for SlipIQ V3 first-set correct-score odds.

The discovery artifact showed this endpoint only accepts these `market_name` values:

```txt
1X2
OVER_UNDER
ASIAN_HANDICAP
HOME_AWAY
BOTH_TEAMS_TO_SCORE
```

It rejected:

```txt
CORRECT_SCORE
1ST_SET_CORRECT_SCORE
SET_1_CORRECT_SCORE
```

It also rejected `FIRST_SET` as a period. Accepted periods were only:

```txt
FULL_TIME_AND_OT
FULL_TIME
```

So do not waste more free-tier requests trying first-set correct-score names on `/api/v1/markets/feed`.

## What this workflow still does

The workflow is read-only.

It can:
- Call RapidAPI using the `RAPIDAPI_KEY` GitHub secret.
- Save raw JSON responses as GitHub Actions artifacts.
- Normalize any detected V3 rows if a future endpoint exposes them.
- Create `upcoming_firstset_summary.json` when usable rows exist.
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

## What to do next on RapidAPI mobile

Open the RapidAPI Odds Feed API page and look for another endpoint, not `/api/v1/markets/feed`.

Look for endpoint names like:

```txt
Events
Fixtures
Sports
Leagues
Markets
Bookmaker Odds
Event Odds
Odds by Event
Match Odds
Historical Odds
```

We need an endpoint that can answer one of these:

```txt
List tennis events and event IDs
List all available markets for one tennis event
Return bookmaker odds for one event
Return historical odds for one event
```

The best next screenshot to send is the RapidAPI endpoint list, with your API key hidden.

## If you still run the current workflow

The current workflow can still prove API connectivity, but it probably will not find V3.

Default values:

```txt
mode: rapidapi-discovery-small
rapidapi_host: odds-feed.p.rapidapi.com
endpoint: /api/v1/markets/feed
params: leave blank
params_file: data/rapidapi_oddsfeed_discovery_params.json
bookmaker: 1xBet
grouped_threshold: 3.3
max_requests: 8
```

Expected result for `/api/v1/markets/feed`:

```txt
V3 rows: 0
Reason: endpoint does not support first-set correct score
```

## What a good future V3 result means

For a real V3 market endpoint, a good result is:

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
