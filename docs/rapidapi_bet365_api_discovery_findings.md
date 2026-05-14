# RapidAPI bet365 API Discovery Findings

Date: 2026-05-14

## API tested

RapidAPI API host:

```txt
bet36528.p.rapidapi.com
```

The GitHub workflow uses only the `RAPIDAPI_KEY` secret. No key should be committed or pasted into workflow inputs.

## Request budget

The free plan is limited, so every workflow run should use:

```txt
max_requests = 1
```

## Market discovery result

Endpoint:

```txt
GET /markets
```

Result: worked.

Important discoveries:

```txt
Tennis sportId = 12
Market: Correct Score First Set
marketId = 12404
period = p1
marketType = correctscore
```

SlipIQ V3 outcome IDs:

```txt
3:6 = outcomeId 12414
4:6 = outcomeId 12415
5:7 = outcomeId 12416
```

This is the first API source that has proven the exact SlipIQ V3 market exists in its market catalog.

## Tournament discovery result

Endpoint:

```txt
GET /tournaments?sportId=12
```

Result: worked.

Important discovery:

```txt
ATP Rome, Italy Men Singles
tournamentId = 2781
```

## Fixture discovery result

Endpoint:

```txt
GET /fixtures?tournamentId=2781
```

Result: worked.

Returned 269 fixtures.

Odds-enabled fixtures found included:

```txt
fixtureId: id1200278171201158
match: Ruud, Casper vs Darderi, Luciano
status: Pre-Game
hasOdds: true
startTime: 2026-05-15T13:30:00.000Z
```

```txt
fixtureId: id1200278171201150
match: Landaluce, Martin vs Medvedev, Daniil
status: Live
hasOdds: true
startTime: 2026-05-14T17:00:00.000Z
```

The safer test fixture was Ruud vs Darderi because it was pre-game.

## Odds by fixture test

Endpoint:

```txt
GET /odds?fixtureId=id1200278171201158&verbosity=3
```

Result: HTTP 200.

But it returned only 4 basic markets:

```txt
121
123
1233
1237
```

It did not include marketId 12404.

## Targeted V3 market odds test

Endpoint:

```txt
GET /odds?fixtureId=id1200278171201158&marketId=12404&verbosity=3
```

Result: HTTP 200.

But it still returned only the same 4 basic markets:

```txt
121
123
1233
1237
```

The response did not include:

```txt
marketId 12404
3:6 outcomeId 12414
4:6 outcomeId 12415
5:7 outcomeId 12416
```

The generated V3 summary had:

```txt
3:6 = null
4:6 = null
5:7 = null
grouped odds = null
candidate rows = 0
```

## Interpretation

The API market catalog confirms that `Correct Score First Set` exists globally.

However, for the tested Ruud vs Darderi fixture, `/odds` did not return that market, even when `marketId=12404` was supplied.

This means one of these is likely true:

```txt
/odds ignores marketId and returns only default/basic markets
or the fixture did not have first-set correct-score odds available at that time
or a different endpoint is required for deep/special markets
or a different fixture with richer markets is required
```

## Next endpoint to inspect in RapidAPI docs

The next best endpoint is not plain `/odds` unless the docs show additional parameters.

Look for exact cURL for:

```txt
Odds by Fixture
Odds historical
Odds by Tournaments
```

We need to know whether there are parameters such as:

```txt
marketIds
market_id
market
markets
includeMarkets
fixtureIds
sportId
tournamentId
bookmaker
from/to/date
```

## Current conclusion

This bet365 API is still the best candidate because it has the exact market in `/markets`, but the usable odds endpoint for marketId 12404 is not proven yet.

Do not schedule scans or burn requests until the exact endpoint/params for deep market odds are proven.
