# SlipIQ Provider Adapter Format

SlipIQ now supports provider switching in the Supabase `data-refresh` Edge Function.

## Provider modes

Set this Supabase Edge Function secret:

```txt
SLIPIQ_DATA_PROVIDER=manual_seed
```

or:

```txt
SLIPIQ_DATA_PROVIDER=external_normalized
```

## Manual seed provider

`manual_seed` is the current safe default. It uses the bundled Rome seed matches and keeps the app working without external API keys.

## External normalized provider

`external_normalized` expects a provider endpoint URL that returns normalized JSON.

Required Supabase Edge Function secrets:

```txt
SLIPIQ_DATA_PROVIDER=external_normalized
SLIPIQ_EXTERNAL_PROVIDER_URL=https://your-provider-or-adapter-url.example.com/slipiq/tennis-board
SLIPIQ_EXTERNAL_PROVIDER_KEY=optional_bearer_token
```

The `SLIPIQ_EXTERNAL_PROVIDER_KEY` is optional. If present, SlipIQ sends:

```txt
Authorization: Bearer YOUR_KEY
```

## Required JSON shape

The provider endpoint must return:

```json
{
  "matches": [
    {
      "id": "atp-2026-rome-hurkacz-hanfmann",
      "tournament": "Rome Masters 2026",
      "surface": "clay",
      "starts_at": "2026-05-06T13:00:00Z",
      "bookmaker": "ExampleBook",
      "p1": {
        "name": "Hubert Hurkacz",
        "fs1": 0.65,
        "w1s": 0.82,
        "w2s": 0.66,
        "bp_save": 0.68
      },
      "p2": {
        "name": "Yannick Hanfmann",
        "fs1": 0.62,
        "w1s": 0.70,
        "w2s": 0.54,
        "bp_save": 0.61
      },
      "bookmaker_odds": {
        "6-4": 5.1,
        "6-3": 6.8,
        "7-5": 8.2,
        "7-6": 7.4,
        "4-6": 8.8
      },
      "raw_payload": {
        "source": "your-real-provider-name"
      }
    }
  ]
}
```

## Field notes

- `surface` supports `clay`, `grass`, `hard`, or `indoor`. Unknown values fall back to `hard`.
- Stats must be decimals between 0 and 1.
- `bookmaker_odds` uses decimal odds keyed by first-set score from player 1 perspective.
- Scores like `6-4` mean player 1 wins the first set 6-4.
- Scores like `4-6` mean player 1 loses the first set 4-6.

## Why this adapter shape exists

Most paid sports data APIs have messy or provider-specific formats. This normalized shape lets us plug in any provider by writing one small translation layer instead of rewriting SlipIQ's model engine.

## Next real provider work

When choosing a provider, verify it exposes one of these:

1. First-set correct-score odds directly.
2. First-set winner + set total games as fallback.
3. Raw tennis stat feeds enough to calculate serve/hold inputs.

If first-set correct-score odds are not available, the provider adapter can still return first-set model probabilities, but `bookmaker_odds` will be weaker or incomplete until a stronger market source is added.
