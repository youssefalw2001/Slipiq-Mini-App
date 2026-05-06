# SlipIQ Agent Instructions

These instructions are for Codex or any AI coding agent working in this repository.

## Product

SlipIQ is a Telegram Mini App for first-set tennis probability intelligence and smarter betting slip construction.

**Tagline:** Don't guess. Calculate.

## Main Brand Engine

The flagship feature is **First Set Lab**.

Tennis first-set score probability is the main engine of the brand. NBA and other sports are supporting slip legs only.

The product should feel like a Bloomberg terminal crossed with a sports betting app: serious, smart, dark, data-rich, and mobile-native.

## Important Product Rule

SlipIQ is **not** a tipster service. Do not write copy that promises wins. It is a probability intelligence and decision-support tool.

Never use:

- guaranteed wins
- locks
- risk-free
- easy money
- guaranteed profit
- beat the book every time

Use:

- probability intelligence
- estimated hit rate
- model edge
- fair odds
- expected value
- high variance
- responsible betting
- no guaranteed outcomes

## Stack

Use this stack unless the user explicitly changes it:

- React + Vite
- TypeScript
- Tailwind CSS
- Telegram Web App SDK / @twa-dev/sdk
- React Router
- Zustand
- Recharts
- Supabase/PostgreSQL later
- Telegram Stars payments later

## Build Priority

Do not start with generic boilerplate. The math is the product.

Priority order:

1. Probability engine
2. Static seed data
3. OpportunityCard component
4. Home Feed screen
5. First Set Lab / Match Detail screen
6. Slip Builder
7. Zustand slip store
8. Telegram Mini App integration
9. Supabase schema and persistence
10. Alerts
11. Premium / Telegram Stars
12. Landing page

## MVP Screens

Build these screens in this order:

1. Home Feed — Today's Best Opportunities
2. Match Detail / First Set Lab — Probability Deep Dive
3. Slip Builder
4. My Slips — Tracker & History
5. Alerts — Don't Miss A Window
6. Profile + Premium
7. Onboarding — first launch only

## Design System

Use the Terminal Intelligence design language.

CSS variables:

```css
--bg-primary: #04040b;
--bg-card: #09091a;
--bg-elevated: #0f0f22;
--border: rgba(255,255,255,0.07);
--text-primary: #e8e4d8;
--text-muted: #4a4a6a;
--accent-gold: #FFD700;
--accent-orange: #FF6B35;
--accent-teal: #4ECDC4;
--accent-red: #FF4757;
--accent-green: #2ed573;
--positive: #2ed573;
--negative: #ff4757;
```

Typography:

- Display/data font: DM Mono or JetBrains Mono
- Body font: Sora or Plus Jakarta Sans
- All numbers should use monospace styling

UX requirements:

- Mobile-first, optimized for 375px width
- Dark mode only
- Telegram-style touch interactions
- Haptic feedback on important taps when Telegram SDK is available
- Native Telegram BackButton when inside Telegram
- Skeleton states for async operations
- Offline graceful fallback to cached/static data when possible

## Probability Rules

All math should live in TypeScript utility files, primarily `src/lib/probability.ts`.

Separate these concepts clearly:

- `modelProbability`
- `fairOdds`
- `bookmakerOdds`
- `impliedProbability`
- `edge`
- `expectedValue`

Expected value must use actual bookmaker odds when available:

```ts
expectedValue = modelProbability * bookmakerOdds - 1
```

Do not calculate EV only from internally generated fair odds.

Fair odds:

```ts
fairOdds = 1 / modelProbability
```

Implied probability:

```ts
impliedProbability = 1 / bookmakerOdds
```

Edge:

```ts
edge = modelProbability - impliedProbability
```

## Required Probability Engine Functions

Implement:

- `calcHoldProb(fs1, w1s, w2s, bpSave, surface)`
- `probWinGame(pointWinProbability)`
- `calcSetScoreDist(hold1, hold2)`
- `classifyScore(probability)`
- `fairOddsFromProbability(probability)`
- `impliedProbabilityFromOdds(decimalOdds)`
- `calculateEdge(modelProbability, bookmakerOdds)`
- `calculateExpectedValue(modelProbability, bookmakerOdds)`
- `calcSlip(legs)`

First-set score classes:

- GREEN / ANCHOR: probability > 15%
- YELLOW / MID: probability > 8%
- ORANGE / PUSH: probability > 3%
- RED / LOTTO: otherwise

Slip tiers:

- S: combined odds >= 3000
- A: combined odds >= 500
- B: combined odds >= 100
- C: otherwise

S-tier means high-upside/high-variance, not guaranteed best.

## Seed Data

Use static seed data for the first MVP:

- `src/data/tennisMatches.json`
- `src/data/nbaGames.json`

The first tennis seed must include Rome 2026 Hurkacz vs Hanfmann.

## Before Opening a PR

Always run:

```bash
npm run build
```

If tests exist, run:

```bash
npm run test
```

Each PR must include:

- summary of changes
- major files changed
- screenshots or preview notes for UI work
- known limitations
- whether `npm run build` passed

## What Not To Do

- Do not add real API keys or secrets.
- Do not implement payments before core app logic.
- Do not use misleading betting claims.
- Do not make NBA the main product.
- Do not let generated code hide the probability math in UI components.
- Do not ship without visible responsible-use copy.
