# SlipIQ Build Queue

This file is the task queue for Codex. Work top to bottom unless the user assigns a specific task.

## Phase 0 - Repo Setup

- [x] Add README product overview
- [x] Add AGENTS.md
- [x] Add product brief docs
- [x] Add design system docs
- [ ] Initialize React + Vite + TypeScript project
- [ ] Install Tailwind CSS
- [ ] Add React Router
- [ ] Add Zustand
- [ ] Add Recharts
- [ ] Add Telegram Web App SDK package

## Phase 1 - Main App Logic MVP

- [ ] Implement `src/lib/probability.ts`
- [ ] Implement `calcHoldProb`
- [ ] Implement `probWinGame`
- [ ] Implement `calcSetScoreDist`
- [ ] Implement `classifyScore`
- [ ] Implement fair odds, implied probability, edge, and EV helpers
- [ ] Implement `calcSlip`
- [ ] Add TypeScript types for tennis matches, score outcomes, legs, and slips
- [ ] Add static tennis seed data
- [ ] Add static NBA seed data
- [ ] Generate computed First Set Lab opportunities from seed data

## Phase 2 - Core UI

- [ ] Build mobile app shell
- [ ] Add bottom navigation
- [ ] Build `OpportunityCard`
- [ ] Build `ProbabilityBar`
- [ ] Build `TierBadge`
- [ ] Build Home Feed screen
- [ ] Build First Set Lab detail screen
- [ ] Build Slip Builder screen
- [ ] Build Zustand slip store
- [ ] Add Add to Slip behavior
- [ ] Add stake input and quick-select amounts
- [ ] Add live combined odds, hit rate, payout, tier, and EV
- [ ] Add simple suggestions engine

## Phase 3 - Supporting Screens

- [ ] Add My Slips placeholder with active/history tabs
- [ ] Add Alerts placeholder with alert toggles
- [ ] Add Profile/Premium placeholder
- [ ] Add Onboarding placeholder
- [ ] Add responsible-use disclaimer component

## Phase 4 - Telegram Integration

- [ ] Initialize Telegram Web App SDK
- [ ] Set background/header colors
- [ ] Read Telegram user identity when available
- [ ] Add haptic helper
- [ ] Add native BackButton helper
- [ ] Ensure app works outside Telegram for local development

## Phase 5 - Backend Later

- [ ] Add Supabase schema SQL
- [ ] Add Supabase client
- [ ] Save slips
- [ ] Save users
- [ ] Add alert tables
- [ ] Add Telegram Stars payment flow later

## Definition of Done for Overnight MVP

The overnight MVP is successful if:

- `npm run build` passes
- App opens locally
- Home Feed shows First Set Lab cards from seed data
- First Set Lab detail page shows score distribution
- Slip Builder can add/remove legs and calculate combined metrics
- Main app logic is in utilities/stores, not hidden inside UI components
- Product copy avoids exaggerated certainty and includes responsible-use language
