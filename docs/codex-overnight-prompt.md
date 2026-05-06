# Copy/Paste Prompt for Codex Overnight Build

Paste this into Codex after selecting the repository `youssefalw2001/Slipiq-Mini-App`.

---

You are building SlipIQ, a Telegram Mini App for first-set tennis probability intelligence and smarter slip construction.

Read and follow these files first:

- `AGENTS.md`
- `README.md`
- `TODO.md`
- `docs/product-brief.md`
- `docs/design-system.md`
- `docs/first-set-lab.md`
- `docs/overnight-codex-plan.md`

Goal: create a working MVP shell with 70-80% of the main app logic complete.

Do not implement real payments, live data APIs, or production Supabase writes tonight. Focus on the working frontend, core probability engine, static data, state store, and main screens.

## Required Work

1. Initialize/complete the React + Vite + TypeScript project.
2. Install/configure Tailwind CSS.
3. Add React Router, Zustand, Recharts, and Telegram Web App SDK support.
4. Create the app folder structure under `src/`.
5. Implement the First Set Lab probability engine in `src/lib/probability.ts`.
6. Implement static seed data:
   - `src/data/tennisMatches.json`
   - `src/data/nbaGames.json`
7. Add at least 6 tennis matches, including Rome 2026 Hurkacz vs Hanfmann.
8. Add at least 4 NBA support legs.
9. Create `src/lib/opportunities.ts` to generate computed First Set Lab cards from seed data.
10. Create a Zustand store for the slip builder.
11. Build the core components:
   - `TierBadge`
   - `ProbabilityBar`
   - `OpportunityCard`
   - `LiveAlertBanner`
   - `BottomNav`
   - `ResponsibleNotice`
   - `SlipLegChip`
12. Build the screens:
   - Home
   - FirstSetLab / Match Detail
   - SlipBuilder
   - MySlips placeholder
   - Alerts placeholder
   - Profile placeholder
   - Onboarding placeholder
13. Add Telegram helper utilities that safely work outside Telegram local development.
14. Add Terminal Intelligence styling, animations, and mobile-first layout.
15. Add responsible-use disclaimer language.
16. Run `npm run build` and fix every error.
17. Open a PR titled `Build SlipIQ First Set Lab MVP shell`.

## Critical Product Rules

First Set Lab is the flagship feature. Tennis first-set score probability is the brand engine. NBA and other sports are supporting legs only.

Never use exaggerated certainty or profit claims.

EV must use bookmaker odds when available:

```ts
expectedValue = modelProbability * bookmakerOdds - 1
```

Keep model probability, fair odds, bookmaker odds, implied probability, edge, and EV separate.

S-tier means high-upside/high-variance, not guaranteed best.

## Definition of Done

The PR is acceptable if:

- `npm run build` passes
- app opens locally
- Home Feed shows First Set Lab opportunities from static seed data
- Opportunity cards show hold rates, top scores, probability bars, fair odds/book odds, edge, and tier
- tapping an opportunity opens First Set Lab detail page
- Add to Slip works
- Slip Builder calculates combined probability, odds, payout, EV, and tier
- placeholders exist for My Slips, Alerts, Profile, and Onboarding
- copy is responsible and does not promise outcomes

## PR Body Must Include

- Summary of changes
- What works
- What is still placeholder
- How to run locally
- Whether `npm run build` passed
- Next recommended tasks
