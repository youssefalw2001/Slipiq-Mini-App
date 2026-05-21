# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

It is not a traditional tipster project. The product is built around:

```txt
- Live market scanning
- Tennis first-set edge detection
- Timestamped signal receipts
- Supabase proof tracking
- Automatic settlement
- Telegram signal delivery
- Duplicate suppression
- Long-term ROI tracking
- Research shadow lanes
```

---

# Identity

```txt
Brand: First Set Lab
Engine: SlipIQ
Positioning: The hedge fund of tennis markets
Core niche: tennis first-set derivative markets
```

Main live focus:

```txt
- Tennis first-set exact-score clusters
- Grand Slam first-set winner comfort edges
- Market inefficiency detection
- Historical edge tracking
- Confidence-layer signal delivery
```

---

# Current Live Production Strategy

## LIVE TELEGRAM DELIVERY

```txt
Bookmaker:
- Bet365 only
```

## SHADOW / RESEARCH MODE

```txt
Tracked internally only:
- 1xBet
- 10Bet
```

Reason:

```txt
Bet365 currently shows the strongest live execution quality.
Research books remain active internally for historical comparison and future validation.
```

Current production philosophy:

```txt
- Lower volume
- Higher signal quality
- Exact-score focus
- Cleaner Telegram experience
- Reduced market noise
- Long-term edge over hype
```

---

# Signal Architecture

## Signal Types

```txt
S-Tier:
Highest model edge + strongest pricing inefficiency.

A-Tier:
Strong edge with lower volatility.

Comfort:
Safer directional first-set winner style positions.

Research:
Shadow-tracked experimental lanes.
```

## Main Markets

```txt
- 1st Set Correct Score
- First-set winner comfort signals
- Grand Slam exact-score clusters
```

## Exact-Score Philosophy

SlipIQ focuses heavily on exact-score clustering because tennis first-set markets are often mispriced during:

```txt
- Serve dominance mismatches
- Surface-adjusted hold-rate gaps
- Slam environments
- Fatigue/travel asymmetry
- Lower-liquidity derivatives
```

---

# Live Workflow (A → Z)

## 1. Market Scan

The engine continuously scans tennis markets and live books.

Main inputs:

```txt
- Match environment
- Surface context
- Player profile
- Market pricing
- Historical score behavior
- Odds inefficiencies
```

---

## 2. Signal Generation

Signals are generated when:

```txt
- Edge threshold is passed
- Historical profile aligns
- Odds are acceptable
- Confidence layer validates the setup
```

Signals include:

```txt
- Match
- Score cluster
- Odds
- Historical edge
- Break-even percentage
- Sample size
- Confidence language
```

---

## 3. Duplicate Guard

Before sending:

```txt
- Duplicate signals are checked
- Similar score clusters are filtered
- Telegram spam is reduced
```

This keeps the channels:

```txt
- Cleaner
- More premium
- Easier to trust
```

---

## 4. Telegram Delivery

Current routing:

```txt
Bet365 → Telegram
Research books → internal only
```

Delivery lanes:

```txt
- Core
- Quant/VIP
- Proof Vault
```

Telegram messages contain:

```txt
- Signal
- Odds
- Historical edge
- Sample size
- Confidence layer
- Timestamped receipt
```

---

## 5. Settlement Engine

After matches finish:

```txt
- Signals auto-settle
- Wins/losses update
- ROI recalculates
- Proof Vault refreshes
```

Tracked metrics:

```txt
- ROI
- Profit units
- Hit rate
- Average odds
- Historical edge
- Bookmaker performance
```

---

## 6. Research Layer

Experimental systems remain active internally.

Purpose:

```txt
- Compare bookmakers
- Test new score models
- Validate comfort systems
- Track hidden historical edge
```

Research lanes are NOT pushed publicly until:

```txt
- Sample size grows
- Edge stabilizes
- ROI validates live
```

---

# Infrastructure

## Backend

```txt
- Supabase
- PostgreSQL
- Edge Functions
```

## Frontend

```txt
- React
- Vite
- Tailwind
- Telegram Mini App architecture
```

## Delivery

```txt
- Telegram Bot API
- Telegram private channels
- Whop/Stripe onboarding flow
```

---

# Proof Vault System

The Proof Vault is designed to create transparent historical receipts.

Tracked live:

```txt
- Settled signals
- Wins/losses
- ROI windows
- Historical edge
- Market performance
```

Important:

```txt
No deleted losses.
No fake win-rate inflation.
No edited receipts.
```

---

# Testing Framework

## How New Systems Are Tested

New strategies begin in:

```txt
Research mode
```

Workflow:

```txt
1. Run internally
2. Save to Supabase
3. Track settlement silently
4. Measure ROI + hit rate
5. Compare bookmaker quality
6. Promote only if statistically healthy
```

This prevents:

```txt
- Emotional strategy changes
- Overfitting
- Fake hot streaks
- Public overexposure
```

---

# Confidence Layer Philosophy

The confidence layer is NOT fake certainty.

Purpose:

```txt
- Explain edge quality
- Communicate historical strength
- Reduce emotional betting behavior
- Position signals intelligently
```

The system focuses on:

```txt
- Long-term ROI
- Statistical edge
- Market discipline
- Consistency over hype
```

---

# Stripe + Telegram Access Flow

The `/checkout` route is built for a no-code Stripe Payment Links flow:

```txt
User selects Core or Quant on the website
→ site opens the matching Stripe Payment Link
→ Stripe completes checkout
→ Stripe redirects the buyer to the matching Telegram invite URL
```

Environment variables:

```txt
VITE_STRIPE_CORE_CHECKOUT_URL=https://buy.stripe.com/...
VITE_STRIPE_QUANT_CHECKOUT_URL=https://buy.stripe.com/...
VITE_TELEGRAM_PROOF_VAULT_URL=https://t.me/...
VITE_TELEGRAM_CORE_INVITE_URL=https://t.me/+...
VITE_TELEGRAM_QUANT_INVITE_URL=https://t.me/+...
```

---

# Personal Operator Strategy ($1K Lab)

This is the private operator framework used for aggressive-but-controlled bankroll simulations.

## Core Framework

```txt
Execution:
- Bet365 only
- Focus on S-tier and strongest A-tier opportunities
- Prioritize exact-score clusters

Risk:
- Standard aggressive model: 4–5%
- Extreme simulation model: 8% max risk
- Never full-bankroll all-in
```

Selection philosophy:

```txt
- Prefer stacked exact-score edges
- Prefer Grand Slam environments
- Prefer clean pricing
- Avoid weak boards
```

Growth philosophy:

```txt
- Controlled compounding
- Flat staking during instability
- Reduced exposure during drawdowns
```

---

# Parlay Layer

Parlays are treated as:

```txt
Controlled high-volatility overlays
```

Rules:

```txt
- Only combine strong S-tier setups
- Never force entertainment parlays
- Keep exposure controlled
- Use selectively during strong environments
```

---

# Operator Rule

```txt
Ledger updates instantly.
Signals send through the duplicate guard.
Recaps wait until the proof window is meaningful.
Research tracks silently before it sells.
```
