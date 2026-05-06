# SlipIQ Data Provider Research

## Current decision

Do not pay for a provider until first-set market depth is verified.

Best first test: Odds-API.io free key.

Second test: OddsPapi market list + odds response.

Fallback: The Odds API for general tennis match-winner, game spread, and total markets only.

## Why this matters

SlipIQ's flagship strategy is First Set Lab: modeling tennis first-set correct-score outcomes from serve strength, hold probability, surface, and market price.

The key data requirement is not generic tennis odds. The key requirement is first-set correct-score odds or the closest fallback markets.

## Provider ranking

### 1. Odds-API.io

Best lead right now.

Pros:
- Tennis-specific page claims ATP, WTA, Grand Slams, live/pre-match odds.
- Lists match winner, set betting, game handicap, set handicap, total games, first-set winner, live in-play, tiebreak in match, outright winner, and to-win-a-set.
- Free plan exists for testing.
- Multi-odds endpoint can fetch up to 10 events per request.

Risk:
- Public docs do not clearly confirm first-set correct-score odds.
- We must test API response or ask support.

Test goal:
- Confirm whether any market maps to first-set correct score.
- If not, confirm first-set winner + total games + set betting availability.

### 2. OddsPapi

Good second candidate.

Pros:
- Claims 300+ bookmakers, 60+ sports, pre-match/live odds, historical odds, WebSocket.
- Provides GET markets and GET odds endpoints.
- Market list endpoint can be used to search by sport/period/market name.
- Good structure for discovering whether tennis first-set correct-score markets exist.

Risk:
- Public examples are soccer-heavy.
- Need API key to inspect actual tennis market IDs and odds response.

Test goal:
- Use GET markets filtered by tennis sportId.
- Search market names/periods for: correct score, first set, set score, set betting, winner set 1, total games set 1.

### 3. The Odds API

Useful fallback, not flagship provider.

Pros:
- Clean docs and reliable general odds API.
- Tennis supports match winner plus some game spreads/totals from selected bookmakers.

Risk:
- Does not appear to support first-set correct-score odds.
- Likely insufficient for the main SlipIQ strategy.

Use case:
- Backup provider for supporting tennis markets or NBA/support legs.

## Serve/stat inputs

### Jeff Sackmann / Tennis Abstract

Useful for historical research and backtesting.

Risk:
- Licensed CC BY-NC-SA 4.0 / non-commercial.
- Do not use directly in a paid product without permission or legal review.

Good use:
- Internal research and model prototyping.
- Backtesting during development if handled carefully.

Not ideal:
- Commercial production data source without permission.

### Tennis Match Charting Project

Useful for detailed point-level analysis.

Risk:
- Also non-commercial license.
- Coverage is not complete enough for daily production boards.

Good use:
- Researching model assumptions.
- Improving serve/point-level estimates.

## Fallback market strategy

If first-set correct-score odds are unavailable:

1. Use model-generated first-set correct-score probabilities.
2. Show fair odds only.
3. Compare to available first-set winner, set betting, total games, or set total markets.
4. Let the user manually compare sportsbook odds for exact first-set score.
5. Label exact-score odds as unavailable when provider does not supply them.

This keeps the brand honest and prevents fake edge claims.

## Provider test checklist

For each provider/key:

1. Fetch sports/leagues and identify tennis sportId or slug.
2. Fetch today's ATP/WTA fixtures.
3. Fetch odds for 3-5 tennis fixtures.
4. List all market names and periods returned.
5. Search for:
   - first set correct score
   - set 1 correct score
   - first set score
   - set betting
   - first set winner
   - total games first set
   - game totals
6. Check bookmaker coverage for Bet365, Pinnacle, DraftKings, FanDuel, Betfair, Unibet, 1xBet.
7. Confirm decimal odds format.
8. Confirm rate limits and pricing.
9. Confirm historical odds availability for backtesting.
10. Confirm commercial usage terms.

## Required normalized output

Any real adapter must return the shape documented in:

```txt
docs/provider-adapter-format.md
```

## Recommendation

Start with Odds-API.io free key because it has the strongest tennis-specific market claims and a no-credit-card/free testing path.

If Odds-API.io does not expose first-set correct score, test OddsPapi because its market discovery endpoint should reveal whether that market exists.

If neither exposes first-set correct score, launch the first production version with:

- model probabilities
- fair odds
- first-set winner fallback
- set total games fallback
- manual exact-score odds comparison
- clear labels that exact-score book odds are unavailable from provider
