# SlipIQ Data + API Setup

This pass adds the production data foundation for SlipIQ.

## What exists now

- `supabase/schema.sql` creates the core production tables.
- `supabase/functions/data-refresh/index.ts` adds a Supabase Edge Function.
- `src/lib/liveData.ts` lets the frontend read the live data API.
- Home Feed now prefers live data and safely falls back to local seed data.

## Tables

Core tables:

- `users`
- `matches`
- `player_stat_snapshots`
- `odds_snapshots`
- `model_runs`
- `opportunities`
- `slips`
- `alert_preferences`
- `subscriptions`

## Edge Function

Function path:

```txt
supabase/functions/data-refresh/index.ts
```

Behavior:

- `GET` returns latest opportunities for the app feed.
- `POST` runs a data/model refresh.
- `POST` can be protected with `SLIPIQ_REFRESH_SECRET`.
- The first implementation uses `manual_seed` provider data so the pipeline can be tested before paying for odds APIs.

## Supabase environment variables

Set these in Supabase Edge Function secrets:

```txt
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SLIPIQ_REFRESH_SECRET=make_a_long_random_secret
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend code or Render public environment variables.

## Render environment variable

After deploying the Supabase Edge Function, set this on Render:

```txt
VITE_SLIPIQ_DATA_API_URL=https://YOUR_PROJECT_REF.supabase.co/functions/v1/data-refresh
```

Then redeploy the Render app.

If this value is missing, SlipIQ still works from local seed data.

## First setup steps

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Deploy the Edge Function:
   ```txt
   supabase functions deploy data-refresh
   ```
4. Add the function secrets.
5. Run the first refresh:
   ```txt
   curl -X POST \
     -H "x-slipiq-refresh-secret: YOUR_SECRET" \
     https://YOUR_PROJECT_REF.supabase.co/functions/v1/data-refresh
   ```
6. Confirm the feed:
   ```txt
   curl https://YOUR_PROJECT_REF.supabase.co/functions/v1/data-refresh
   ```
7. Add `VITE_SLIPIQ_DATA_API_URL` to Render.
8. Redeploy Render.

## Real provider integration next

The Edge Function is intentionally structured so the seed provider can be replaced by a real provider.

Next provider adapter should fetch:

- tennis schedule
- player serve stats
- surface stats
- first-set correct-score odds if available
- first-set winner / totals as backup markets
- NBA support legs

The provider output should normalize into:

```txt
match
player stat snapshots
odds snapshots
opportunities
```

## Important launch note

Do not market live opportunities until the provider is connected and the daily refresh job is running successfully. The current function proves the pipeline and database shape, but it still uses seed data until a real odds/stat provider is configured.
