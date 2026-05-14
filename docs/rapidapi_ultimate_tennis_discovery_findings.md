# RapidAPI Ultimate Tennis API Discovery Findings

Date: 2026-05-14

## API tested

RapidAPI host:

```txt
ultimate-tennis1.p.rapidapi.com
```

Endpoint tested:

```txt
GET /live_scores
```

The workflow used the `RAPIDAPI_KEY` GitHub secret only. No API key was committed.

## Result

The request failed:

```txt
HTTP status: 404
ok: false
```

Raw response was an HTML Heroku error page:

```txt
No such app
```

## Interpretation

This does not look like a normal API validation error. It looks like the provider's backend app is missing, disabled, or misconfigured behind RapidAPI.

No tennis scores, matches, markets, bookmakers, odds, or V3 rows were returned.

## V3 status

```txt
live scores: not proven
odds endpoint: not found/tested
Correct Score First Set: not found
3:6 / 4:6 / 5:7 odds: not found
historical odds: not found
```

## Recommendation

Do not spend more requests on `ultimate-tennis1.p.rapidapi.com` unless the RapidAPI page shows a different working host or endpoint.

This source is not currently useful for SlipIQ V3.

Keep using the proven path:

```txt
OddsPortal bet365 row-arrow scraper for official historical V3 odds
```

The bet365 RapidAPI source remains useful for catalog/fixture research, but its odds endpoints did not return V3 prices in the tests performed so far.
