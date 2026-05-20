# SlipIQ / First Set Lab

**First Set Lab** is a private tennis first-set price-intelligence system powered by **SlipIQ**.

It is not a traditional tipster project. The product is built around live scanning, timestamped signal receipts, Supabase proof tracking, automatic settlement, and disciplined risk language.

```txt
Brand: First Set Lab
Engine: SlipIQ
Positioning: The hedge fund of tennis markets
Core niche: tennis first-set derivative markets
Main live markets:
- First-set correct-score clusters
- Grand Slam first-set winner comfort signals
- Shadow-tracked research lanes
```

---

## Current Production Strategy State

```txt
LIVE TELEGRAM BOOK:
- Bet365 only

SHADOW-TRACKED BOOKS:
- 1xBet
- 10Bet

Reason:
- Bet365 currently shows the strongest live execution quality.
- 1xBet remains tracked internally in Supabase for research validation.
- Telegram delivery for 1xBet is paused until enough clean live proof exists.
```

Current production focus:

```txt
- High-quality Bet365 exact-score clusters
- Grand Slam first-set edges
- Deduped proof tracking
- Lower-noise premium Telegram delivery
- Confidence-layer positioning instead of fake guarantees
```

---

## Stripe + Telegram Access Flow

The `/checkout` route is built for a no-code Stripe Payment Links flow:

```txt
User selects Core or Quant on the website
→ site opens the matching Stripe Payment Link
→ Stripe completes checkout
→ Stripe redirects the buyer to the matching Telegram invite URL
```

Configure these environment variables in Vercel/Netlify before deploying:

```txt
VITE_STRIPE_CORE_CHECKOUT_URL=https://buy.stripe.com/...
VITE_STRIPE_QUANT_CHECKOUT_URL=https://buy.stripe.com/...
VITE_TELEGRAM_PROOF_VAULT_URL=https://t.me/...
VITE_TELEGRAM_CORE_INVITE_URL=https://t.me/+...
VITE_TELEGRAM_QUANT_INVITE_URL=https://t.me/+...
```

Stripe setup:

```txt
1. Create a Core Terminal subscription payment link.
2. Create a Quant Terminal subscription payment link.
3. In each payment link, set After payment / Confirmation behavior to redirect.
4. Redirect Core buyers to the Core Telegram invite link.
5. Redirect Quant buyers to the Quant Telegram invite link.
6. Enable Stripe email receipts.
7. Rotate Telegram private invite links if leaked.
```

Important:

```txt
This Payment Links version is fast to launch and low-code.
For stricter access control later, add a Stripe webhook + Telegram Bot flow that approves or removes users automatically based on subscription status.
```

---

## Personal Operator Strategy ($1K Lab)

This is the private operator framework used for aggressive-but-controlled bankroll growth simulations.

```txt
Objective:
Compound a smaller bankroll without relying on unrealistic all-in behavior.
```

Core framework:

```txt
Execution:
- Bet365 only
- Focus on S-tier and strongest A-tier opportunities
- Prioritize exact-score clusters over random volume

Risk:
- Standard aggressive model: 4% to 5% flat risk
- Extreme simulation model: 8% risk cap
- Never full-bankroll all-in

Selection:
- Prefer stacked exact-score edges
- Prefer Grand Slam environments
- Prefer clean market pricing
- Avoid forcing action during weak boards

Growth model:
- Flat staking during instability
- Controlled compounding during strong runs
- Reduce size during drawdown periods
```

Parlay framework:

```txt
- Parlays are treated as controlled high-volatility overlays.
- Only combine independently strong S-tier ideas.
- Never force parlays for entertainment.
- Parlays should remain a small percentage of total exposure.
```

Important:

```txt
The personal operator framework is experimental and high-risk.
It is not public staking guidance.
```

---

## Operator Rule

```txt
Ledger updates instantly.
Signals send through the duplicate guard.
Recaps wait until the proof window is meaningful.
Research tracks silently before it sells.
```
