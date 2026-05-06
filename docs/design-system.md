# SlipIQ Design System

## Design Language

**Terminal Intelligence**

SlipIQ should feel like a serious sports analytics terminal: dark, sharp, data-rich, mobile-first, and premium. Avoid generic startup gradients.

## Colors

```css
:root {
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
}
```

## Typography

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Sora:wght@400;600;700&display=swap');
```

Use:

- Body: Sora
- Data and display: DM Mono
- Percentages, odds, probabilities, payouts, and ranks use monospace

## Components

### Tier Badge

Small uppercase pill.

- B-tier: teal
- A-tier: orange
- S-tier: gold
- C-tier: muted gray

### Opportunity Card

Card requirements:

- dark card background
- subtle elevated gradient
- 3px left border using tier color
- match name + sport icon
- surface/venue badge
- key stat line
- top two probability bars
- odds chip
- edge chip
- Add button

### Probability Bar

- horizontal bar
- animated fill on mount
- exact probability label
- color based on score class or tier
- should feel like meaningful data loading

### Alert Banner

- full-width card
- pulsing gold border
- alert icon
- title, subtext, CTA
- dismissible later

### Slip Leg Chip

- sport icon
- leg label
- decimal odds
- probability
- risk/tier color dot

## Motion

Use minimal, serious motion:

- cards slide up with slight stagger
- probability bars fill in 600ms ease-out
- tier badge pulses once on first render
- live alert banner drops from top and pulses every 2s
- tier transitions use smooth color transitions

## Mobile Rules

- Design for 375px width first
- Bottom nav always reachable
- Primary CTAs should be thumb-friendly
- Keep dense data readable with clear spacing
- Dark mode only

## Copy Tone

Use confident, measured language:

- Calculate first-set probabilities
- Compare model odds to market odds
- Build smarter slips
- Understand risk before adding a leg

Avoid exaggerated certainty or profit claims.
