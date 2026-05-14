# RapidAPI Odds Feed Discovery Findings

Date: 2026-05-14

## Summary

The RapidAPI key, host, endpoint, and GitHub Actions pipeline work.

However, the tested endpoint is not enough for SlipIQ V3 first-set correct-score odds.

Endpoint tested:

```txt
https://odds-feed.p.rapidapi.com/api/v1/markets/feed
```

## What worked

The first smoke test using the curl-style params returned HTTP 200, which means:

```txt
RAPIDAPI_KEY works
x-rapidapi-host works
/api/v1/markets/feed works
GitHub Actions works
Artifact upload works
```

The first smoke result returned empty data for the provided event IDs:

```json
{
  "total": 0,
  "per_page": 100,
  "current_page": 0,
  "last_page": -1,
  "data": []
}
```

That means the API call worked, but those event IDs / market params had no matching markets at runtime.

## What the discovery run proved

The small discovery run tested likely first-set/correct-score params.

The API returned validation errors showing:

### `event_ids` is required

Requests without `event_ids` returned:

```txt
Field required: event_ids
```

So `/api/v1/markets/feed` cannot be used as a broad market discovery endpoint by itself.

### `market_name` is restricted

The endpoint rejected `CORRECT_SCORE`, `1ST_SET_CORRECT_SCORE`, and `SET_1_CORRECT_SCORE`.

The API said accepted `market_name` values are only:

```txt
1X2
OVER_UNDER
ASIAN_HANDICAP
HOME_AWAY
BOTH_TEAMS_TO_SCORE
```

### `period` is restricted

The endpoint rejected `FIRST_SET`.

The API said accepted `period` values are only:

```txt
FULL_TIME_AND_OT
FULL_TIME
```

## SlipIQ conclusion

This specific endpoint:

```txt
/api/v1/markets/feed
```

is useful for basic full-time markets, but it does not expose the SlipIQ V3 target market:

```txt
Tennis 1st Set Correct Score: 3:6 / 4:6 / 5:7
```

Therefore, do not spend more free-tier requests brute-forcing first-set correct-score names on this endpoint.

## Current status

```txt
RapidAPI connectivity: PROVEN
markets/feed endpoint for V3: NOT SUITABLE
V3 exact market availability from this API: NOT PROVEN
```

## Next step

Open the RapidAPI Odds Feed page and look for a different endpoint that sounds like one of these:

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

The next endpoint we need is not `/api/v1/markets/feed` unless RapidAPI documents a different parameter set for special tennis markets.

The next useful probe should answer:

```txt
Can the API list tennis event IDs?
Can the API list all markets for one tennis event?
Can it return non-basic markets beyond 1X2 / totals / handicap?
Can it return first-set correct score?
```

## Safe rule

Do not run scheduled scans yet.

Keep all RapidAPI tests manual and small until one endpoint proves exact V3 availability.
