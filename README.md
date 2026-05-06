# SlipIQ Mini App

**SlipIQ** is a Telegram Mini App for first-set tennis probability intelligence and smarter betting slip construction.

**Tagline:** Don't guess. Calculate.

## Flagship Feature

The core product is **First Set Lab**: a tennis first-set probability engine that turns serve stats, hold probability, surface adjustment, break pressure, fair odds, bookmaker odds, and expected value into clear slip-building intelligence.

NBA and other sports can be used as supporting slip legs, but the brand wedge is tennis first-set intelligence.

## Product Positioning

SlipIQ is not a tipster service and does not promise guaranteed outcomes. It is a probability decision-support tool that helps users understand:

- which first-set tennis scores are mathematically live
- how model probability compares to market odds
- whether a leg has edge
- how a leg changes a parlay's payout, hit rate, and risk
- whether a slip is B-tier, A-tier, or S-tier

## Tech Stack

- React + Vite
- TypeScript
- Tailwind CSS
- Telegram Web App SDK
- Zustand
- Recharts
- Supabase/PostgreSQL later
- Telegram Stars payments later

## MVP Priority

Do not start with generic boilerplate. The math is the product.

Build order:

1. First Set Lab probability engine
2. Static seed data
3. Opportunity Card
4. Home Feed
5. First Set Lab / Match Detail
6. Slip Builder
7. Telegram Mini App integration
8. Supabase persistence
9. Alerts
10. Premium / Telegram Stars

## Local Commands

```bash
npm install
npm run dev
npm run build
npm run test
```

## Responsible Product Rule

Never use language such as guaranteed wins, locks, risk-free, or easy money. Use probability intelligence, estimated hit rate, model edge, fair odds, expected value, and responsible decision support.
