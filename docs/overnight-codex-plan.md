# Overnight Codex Plan

Goal: wake up with the main SlipIQ app logic and MVP UI 70-80% complete.

Codex should work in one branch or PR and keep scope focused on the MVP. Do not implement real payments, real data APIs, or production Supabase calls yet.

## Overnight Success Criteria

By the end of the task, the app should:

- build successfully with `npm run build`
- run locally with `npm run dev`
- show a mobile-first SlipIQ app shell
- show a Home Feed with First Set Lab opportunities from static data
- compute tennis first-set score probabilities from the TypeScript engine
- show the top first-set scores with probability bars
- allow adding legs to a slip
- show Slip Builder with combined probability, odds, payout, EV, and tier
- include placeholder screens for My Slips, Alerts, Profile, and Onboarding
- include responsible-use copy

## Work Order

### 1. Project Bootstrap

Create or complete the Vite app:

- React + Vite + TypeScript
- Tailwind CSS
- React Router
- Zustand
- Recharts
- @twa-dev/sdk or safe Telegram WebApp helper

Add scripts:

- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run test` if a test runner is installed

### 2. Core Probability Engine

Create `src/lib/probability.ts`.

Implement:

- `calcHoldProb`
- `probWinGame`
- `calcSetScoreDist`
- `classifyScore`
- `fairOddsFromProbability`
- `impliedProbabilityFromOdds`
- `calculateEdge`
- `calculateExpectedValue`
- `calcSlip`

Important math rule:

```ts
expectedValue = modelProbability * bookmakerOdds - 1
```

Do not compute EV only from internally generated fair odds.

### 3. Types

Create `src/types/index.ts` or similar.

Types needed:

- `Surface`
- `PlayerServeStats`
- `TennisMatch`
- `ScoreOutcome`
- `NbaGame`
- `SlipLeg`
- `SlipSummary`
- `Tier`

### 4. Static Data

Create:

- `src/data/tennisMatches.json`
- `src/data/nbaGames.json`

First tennis seed must include Rome 2026 Hurkacz vs Hanfmann.

Add enough data for the Home Feed to feel real:

- at least 6 tennis matches
- at least 4 NBA supporting legs

### 5. Opportunity Computation

Create `src/lib/opportunities.ts`.

It should:

- load tennis matches
- calculate hold rates
- calculate score distribution
- pick top 2 score outcomes
- calculate fair odds, book odds placeholder, implied probability, edge, EV
- create card-ready opportunity objects

### 6. State Store

Create `src/store/slipStore.ts` using Zustand.

Store should support:

- active legs
- stake
- add leg
- remove leg
- clear slip
- update stake
- derived slip summary using `calcSlip`

### 7. Components

Create:

- `src/components/TierBadge.tsx`
- `src/components/ProbabilityBar.tsx`
- `src/components/OpportunityCard.tsx`
- `src/components/LiveAlertBanner.tsx`
- `src/components/BottomNav.tsx`
- `src/components/ResponsibleNotice.tsx`
- `src/components/SlipLegChip.tsx`

### 8. Screens

Create:

- `src/screens/Home.tsx`
- `src/screens/FirstSetLab.tsx`
- `src/screens/SlipBuilder.tsx`
- `src/screens/MySlips.tsx`
- `src/screens/Alerts.tsx`
- `src/screens/Profile.tsx`
- `src/screens/Onboarding.tsx`

Home should be functional. FirstSetLab and SlipBuilder should be mostly functional. Supporting screens may be polished placeholders.

### 9. Telegram Helper

Create `src/lib/telegram.ts`.

Requirements:

- safe outside Telegram/local browser
- `initTelegramApp()`
- `triggerHaptic()`
- `showBackButton()`
- `hideBackButton()`
- `getTelegramUser()`

### 10. Styling

Create global CSS with:

- CSS variables from `docs/design-system.md`
- font import
- body background
- card styles
- animations for probability bars and alert pulse
- mobile layout utilities

### 11. Build Check

Run:

```bash
npm run build
```

Fix all TypeScript/build errors before ending.

## What Not To Do Overnight

- Do not add real API keys.
- Do not connect live odds APIs.
- Do not implement real Telegram Stars payments.
- Do not implement real Supabase writes unless basic schema only.
- Do not overbuild backend before the MVP app logic works.
- Do not use misleading claims or certainty language.

## PR Requirements

Open one PR titled:

`Build SlipIQ First Set Lab MVP shell`

PR body must include:

- Summary
- What works
- What is placeholder
- How to run locally
- Build/test status
- Next recommended tasks
