# RapidAPI 1xBet API Discovery Findings

Date: 2026-05-14

## API tested

RapidAPI API:

```txt
1xbet-api
```

Host:

```txt
1xbet-api.p.rapidapi.com
```

The GitHub workflow used the `RAPIDAPI_KEY` secret only. No key was committed.

## Working path discovered

### 1. List sports

Endpoint:

```txt
GET /sports?mode=line&lng=en
```

Result: worked.

Important discovery:

```txt
Tennis sport ID = 4
```

### 2. Get tennis leagues

Endpoint:

```txt
GET /sports/4/leagues?mode=line&lng=en
```

Result: worked.

Important discovery:

```txt
ATP. Rome league ID = 45687
```

### 3. Get ATP Rome matches

Endpoint:

```txt
GET /matches?mode=line&lng=en&sport_id=4&league_id=45687
```

Result: worked after adding both `sport_id` and `league_id`.

Important discovery:

```txt
Match: Casper Ruud vs Luciano Darderi
Match/event ID: 720919071
League: ATP. Rome
Sport: Tennis
```

### 4. Get match detail

Endpoint:

```txt
GET /matches/720919071?mode=line&lng=en
```

Result: worked.

Returned markets included:

```txt
1x2
Handicap
Total 1
Total
Total 2
Correct Score
Team 1, Result + Total
```

But the returned `Correct Score` market was match/set-result style only:

```txt
2
2 - 1
0 - 2
1 - 2
```

That is not the SlipIQ V3 market.

### 5. Get match market periods

Endpoint:

```txt
GET /matches/720919071/markets/periods?mode=line&lng=en
```

Result: worked.

Important discovery:

```txt
1st set period ID = 89469
2nd set period ID = 89473
```

### 6. Get first-set markets attempt

Endpoint tested:

```txt
GET /matches/720919071/markets?mode=line&lng=en&period_id=89469
```

Result: HTTP 200, but it still did not return the V3 correct-score rows.

Returned markets included:

```txt
1x2
Handicap
Even/Odd
Total 1
Total
European Handicap
Tie-Break
Total 2
3Way Total
Sets Handicap
Correct Score
Loss Without Scoring
Come From Behind And Win
Total Sets
Set / Match
```

The returned `Correct Score` market was still set-result style:

```txt
0 - 2
1 - 2
2
2 - 1
```

The returned `Total 2` lines were around full-match game totals like:

```txt
Individual Total 2 Over = 9.5
Individual Total 2 Over = 10
Individual Total 2 Over = 10.5
Individual Total 2 Over = 11
Individual Total 2 Over = 11.5
```

That is not first-set Total 2 Over 5.5.

### 7. Get market v2

Endpoint tested:

```txt
GET /matches/720919071/markets_v2?mode=line&lng=en
```

Result: HTTP 200, but it still returned match-level markets only.

The returned `Correct Score` market was still set-result style:

```txt
0 - 2
1 - 2
2
2 - 1
```

No V3 score rows were found.

### 8. Get market v2 with first-set period

Endpoint tested:

```txt
GET /matches/720919071/markets_v2?mode=line&lng=en&period_id=89469
```

Result: HTTP 200, but no V3 rows were found.

The probe summary reported:

```txt
3:6 = null
4:6 = null
5:7 = null
grouped odds = null
candidate rows = 0
```

The raw market list still contained broad match markets only, including:

```txt
1x2
Handicap
Total
Total 1
Total 2
Correct Score
Tie-Break
Set / Match
Come From Behind And Win
```

The `Total 2` lines were still full-match individual totals around 9.5 to 11.5, not first-set Total 2 Over 5.5.

## V3 conclusion

The API path works for tennis discovery and basic match markets.

But the tested endpoints have not exposed:

```txt
1st Set Correct Score
3:6
4:6
5:7
Total 2 Over 5.5 first set
```

Current status:

```txt
Sports discovery: PROVEN
Tennis ID: PROVEN = 4
League discovery: PROVEN
ATP Rome league ID: PROVEN = 45687
Match discovery: PROVEN
Match detail endpoint: PROVEN
1st set period ID: PROVEN = 89469
markets endpoint: PROVEN but not V3
markets_v2 endpoint: PROVEN but not V3
V3 first-set correct score availability: NOT PROVEN
```

## Practical conclusion

For this match and this API mode, the `1xbet-api` RapidAPI source does not expose SlipIQ V3 first-set correct-score rows.

Do not spend more requests on these exact endpoint patterns for V3:

```txt
/matches/{id}
/matches/{id}/markets
/matches/{id}/markets?period_id=89469
/matches/{id}/markets_v2
/matches/{id}/markets_v2?period_id=89469
```

## Next possible test

Only continue testing this API if the RapidAPI docs show a different endpoint for live/in-play event trees.

Look for exact endpoint names like:

```txt
Get list of event for a live/in-play match
Get live match events
Get event markets
Get events for match
```

If no such endpoint exists, this API can support generic match-level context only, not SlipIQ's flagship First Set Lab V3 signal.

## Do not do yet

Do not schedule scans.
Do not push Telegram alerts from this API yet.
Do not treat match-level `Correct Score` as V3 first-set correct score.
Do not use `Total 2` full-match totals as first-set Total 2 Over 5.5.
