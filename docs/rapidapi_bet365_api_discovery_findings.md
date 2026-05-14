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

The proof-match fixture was also found:

```txt
fixtureId: id1200278171201168
match: Sinner, Jannik vs Ofner, Sebastian
status: Finished
startTime: 2026-05-09T17:00:00.000Z
```

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

## Odds by tournament test

Endpoint:

```txt
GET /odds-by-tournaments?tournamentIds=2781&verbosity=3&oddsFormat=decimal
```

Result: HTTP 200.

It returned odds for only 2 ATP Rome fixtures and only basic markets. It did not include marketId 12404 or V3 outcomes.

## Historical odds tests

### Ruud vs Darderi with V3 outcome filter

Endpoint:

```txt
GET /historical-odds?fixtureId=id1200278171201158&outcomeId=12414
```

Result: HTTP 404.

Message:

```txt
No historical odds found for the specified filters.
```

### Ruud vs Darderi fixture only

Endpoint:

```txt
GET /historical-odds?fixtureId=id1200278171201158
```

Result: HTTP 200.

But it returned only the same 4 basic markets. It did not include marketId 12404.

### Sinner vs Ofner proof fixture only

Endpoint:

```txt
GET /historical-odds?fixtureId=id1200278171201168
```

Result: HTTP 200.

But it returned only 3 basic markets:

```txt
121
123
1217
```

It did not include:

```txt
marketId 12404
3:6 outcomeId 12414
4:6 outcomeId 12415
5:7 outcomeId 12416
```

This means the API could not reproduce the known OddsPortal/bet365 proof match V3 prices:

```txt
3:6 = 67.00
4:6 = 19.00
5:7 = 51.00
```

## Interpretation

The API market catalog confirms that `Correct Score First Set` exists globally.

However, the odds and historical odds endpoints tested so far return only default/basic markets, even for a finished Sinner vs Ofner fixture.

This means one of these is likely true:

```txt
/odds and /historical-odds expose only limited/basic markets on the free tier
or the API stores the market catalog but does not serve deep tennis correct-score prices through these endpoints
or a different undocumented endpoint/parameter is required for deep/special markets
or this provider does not have historical V3 first-set correct-score odds even though it lists the market definition
```

## Current conclusion

This bet365 API is useful for:

```txt
market catalog discovery
sports/tournament/fixture discovery
basic market odds/history
```

It is not yet proven useful for SlipIQ's flagship V3 odds, because the actual price endpoints have not returned marketId 12404.

Do not schedule scans or burn requests until the exact endpoint/params for deep market odds are proven.

For official historical V3, the best proven method remains the OddsPortal bet365 row-arrow scraper.
