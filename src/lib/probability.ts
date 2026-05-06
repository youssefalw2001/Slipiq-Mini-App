import type { ScoreClass, SlipLeg, SlipSummary, Surface, Tier } from '../types';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export function calcHoldProb(fs1: number, w1s: number, w2s: number, bpSave: number, surface: Surface | string): number {
  const surfaceAdj: Record<string, number> = { clay: -0.03, grass: 0.05, hard: 0, indoor: 0.03 };
  const rawPointWin = fs1 * w1s + (1 - fs1) * w2s;
  const adjusted = rawPointWin * 0.85 + bpSave * 0.15;
  return clamp(adjusted + (surfaceAdj[surface] ?? 0), 0.45, 0.95);
}

export function probWinGame(pointWinProbability: number): number {
  const p = clamp(pointWinProbability, 0.001, 0.999);
  const q = 1 - p;
  const deuceWin = (p * p) / (p * p + q * q);

  const winBeforeDeuce = p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2;
  const reachDeuceAndWin = 20 * p ** 3 * q ** 3 * deuceWin;

  return clamp(winBeforeDeuce + reachDeuceAndWin, 0.001, 0.999);
}

function tiebreakWinProbability(hold1: number, hold2: number): number {
  return clamp(0.5 + (hold1 - hold2) * 0.65, 0.05, 0.95);
}

export function calcSetScoreDist(hold1: number, hold2: number): Record<string, number> {
  const p1Hold = clamp(hold1, 0.001, 0.999);
  const p2Hold = clamp(hold2, 0.001, 0.999);
  const memo = new Map<string, Record<string, number>>();

  const terminal = (g1: number, g2: number): string | null => {
    if (g1 === 6 && g2 === 6) return null;
    if ((g1 >= 6 || g2 >= 6) && Math.abs(g1 - g2) >= 2) return `${g1}-${g2}`;
    return null;
  };

  const merge = (target: Record<string, number>, source: Record<string, number>, weight: number) => {
    for (const [score, probability] of Object.entries(source)) {
      target[score] = (target[score] ?? 0) + probability * weight;
    }
  };

  const walk = (g1: number, g2: number, server: 0 | 1): Record<string, number> => {
    const finished = terminal(g1, g2);
    if (finished) return { [finished]: 1 };

    if (g1 === 6 && g2 === 6) {
      const tbP1 = tiebreakWinProbability(p1Hold, p2Hold);
      return { '7-6': tbP1, '6-7': 1 - tbP1 };
    }

    const key = `${g1}:${g2}:${server}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const p1WinsGame = server === 0 ? p1Hold : 1 - p2Hold;
    const nextServer = server === 0 ? 1 : 0;
    const out: Record<string, number> = {};

    merge(out, walk(g1 + 1, g2, nextServer), p1WinsGame);
    merge(out, walk(g1, g2 + 1, nextServer), 1 - p1WinsGame);

    memo.set(key, out);
    return out;
  };

  const dist = walk(0, 0, 0);
  const total = Object.values(dist).reduce((sum, probability) => sum + probability, 0);
  const normalized: Record<string, number> = {};

  for (const [score, probability] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    normalized[score] = probability / total;
  }

  return normalized;
}

export function classifyScore(probability: number): ScoreClass {
  if (probability > 0.15) return { tier: 'GREEN', label: 'ANCHOR' };
  if (probability > 0.08) return { tier: 'YELLOW', label: 'MID' };
  if (probability > 0.03) return { tier: 'ORANGE', label: 'PUSH' };
  return { tier: 'RED', label: 'LOTTO' };
}

export function fairOddsFromProbability(probability: number): number {
  return 1 / clamp(probability, 0.001, 1);
}

export function impliedProbabilityFromOdds(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return 0;
  return 1 / decimalOdds;
}

export function calculateEdge(modelProbability: number, bookmakerOdds: number): number {
  if (!Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1) return 0;
  return modelProbability - impliedProbabilityFromOdds(bookmakerOdds);
}

export function calculateExpectedValue(modelProbability: number, bookmakerOdds: number): number {
  if (!Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1) return 0;
  return modelProbability * bookmakerOdds - 1;
}

function classifySlipTier(combinedOdds: number): Tier {
  if (combinedOdds >= 3000) return 'S';
  if (combinedOdds >= 500) return 'A';
  if (combinedOdds >= 100) return 'B';
  return 'C';
}

export function calcSlip(legs: SlipLeg[], stake = 10): SlipSummary {
  const safeStake = Number.isFinite(stake) && stake > 0 ? stake : 0;

  if (legs.length === 0) {
    return { combinedOdds: 1, hitRate: 0, expectedValue: 0, payout: 0, tier: 'C', daysToHit: null };
  }

  const combinedOdds = legs.reduce((total, leg) => total * leg.odds, 1);
  const hitRate = legs.reduce((total, leg) => total * leg.modelProbability, 1);
  const expectedValue = hitRate * combinedOdds - 1;
  const daysToHit = hitRate > 0 ? Math.round(1 / hitRate) : null;

  return {
    combinedOdds,
    hitRate,
    expectedValue,
    payout: safeStake * combinedOdds,
    tier: classifySlipTier(combinedOdds),
    daysToHit,
  };
}
