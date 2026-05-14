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

## V3 conclusion

The API path works for tennis discovery and basic match markets.

But the tested match-detail endpoint did not expose:

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
V3 first-set correct score availability: NOT PROVEN
```

## Next endpoint needed

The next RapidAPI endpoint to test should be one of the live/in-play or event-market endpoints from the 1xBet API docs.

Look for endpoint names like:

```txt
Get list of event for a live/in-play match
Get events for match
Get event markets
Get match events
Get line events
Get live match
```

We need an endpoint that returns a deeper event/market tree for one match, not only broad prematch markets.

The ideal next test should use:

```txt
match/event ID: 720919071
mode: line or live, depending on docs
lng: en
```

## Do not do yet

Do not schedule scans.
Do not push Telegram alerts from this API yet.
Do not treat match-level `Correct Score` as V3 first-set correct score.
Do not use `Total 2` full-match totals as first-set Total 2 Over 5.5.

## Safe interpretation

This API may still be useful if a deeper endpoint exists.

If not, it can support generic match-level context only, not SlipIQ's flagship First Set Lab V3 signal.
