# First Set Lab

First Set Lab is SlipIQ's flagship feature and the main engine of the brand.

## Core Idea

Many users understand regular match picks, but fewer understand tennis first-set score probability. First Set Lab turns serve data and hold probability into a score-distribution view that helps users understand which first-set outcomes are mathematically live.

## Inputs

For each tennis player:

- first serve in percentage (`fs1`)
- win percentage on first serve (`w1s`)
- win percentage on second serve (`w2s`)
- break point save percentage (`bp_save`)
- surface performance
- ranking and tournament context for display

## Core Calculations

### 1. Estimate Hold Probability

Use serve stats and surface adjustment to estimate each player's probability of holding serve.

### 2. Convert Point Strength to Game Strength

Use tennis scoring logic to estimate game-winning probability.

### 3. Model First-Set Score Distribution

Use dynamic programming / Markov-style state transitions to estimate outcomes such as:

- P1 6-2
- P1 6-3
- P1 6-4
- P1 7-5
- P1 7-6
- P2 6-2
- P2 6-3
- P2 6-4
- P2 7-5
- P2 7-6

### 4. Compare to Market

For each outcome:

- model probability
- fair odds
- bookmaker odds, when available or seeded
- implied probability
- edge
- expected value

Expected value:

```ts
expectedValue = modelProbability * bookmakerOdds - 1
```

## Output Labels

Score outcome classes:

- GREEN / ANCHOR: probability > 15%
- YELLOW / MID: probability > 8%
- ORANGE / PUSH: probability > 3%
- RED / LOTTO: otherwise

## UI Output

First Set Lab should show:

- serve dominance score
- estimated hold rates
- top score probabilities
- full score distribution
- fair odds vs book odds
- edge percentage
- EV indicator
- Add to Slip button

## Brand Message

Most apps show numbers. SlipIQ explains the probability behind the number.

Use messaging like:

- First-set tennis intelligence for smarter slips
- See the math before you add the leg
- Compare model probability to market odds
- Understand risk before you build the slip

Do not use certainty or guaranteed-outcome language.
