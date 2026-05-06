import { SlipLeg, SlipSummary, Tier } from '../types';

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));

export const calcHoldProb = (fs1: number, w1s: number, w2s: number, bpSave: number, surface: string) => {
  const surfAdj = surface === 'clay' ? -0.015 : surface === 'grass' ? 0.02 : 0;
  const servePointsWon = fs1 * w1s + (1 - fs1) * w2s;
  return clamp(servePointsWon * 0.78 + bpSave * 0.2 + surfAdj, 0.45, 0.95);
};

export const probWinGame = (p: number) => {
  const q = 1 - p;
  const preDeuce = p ** 4 * (1 + 4 * q + 10 * q * q);
  const deuceReach = 20 * p ** 3 * q ** 3;
  const deuceWin = (p * p) / (1 - 2 * p * q);
  return clamp(preDeuce + deuceReach * deuceWin);
};

type ScoreMap = Record<string, number>;
const scoreKeys = ['6-0','6-1','6-2','6-3','6-4','7-5','7-6','0-6','1-6','2-6','3-6','4-6','5-7','6-7'];

export const calcSetScoreDist = (hold1: number, hold2: number): ScoreMap => {
  const memo = new Map<string, ScoreMap>();
  const rec = (g1: number, g2: number, server: 1 | 2): ScoreMap => {
    const key = `${g1}-${g2}-${server}`;
    if (memo.has(key)) return memo.get(key)!;

    if (g1 >= 6 || g2 >= 6) {
      const diff = Math.abs(g1 - g2);
      const max = Math.max(g1, g2);
      const min = Math.min(g1, g2);
      const terminal = (max === 6 && diff >= 2 && min <= 4) || (max === 7 && (min === 5 || min === 6));
      if (terminal) {
        const out: ScoreMap = {};
        out[`${g1}-${g2}`] = 1;
        return out;
      }
    }

    if (g1 === 6 && g2 === 6) {
      const pTb = 0.5 + (hold1 - hold2) * 0.35;
      const p1 = clamp(pTb, 0.05, 0.95);
      return { '7-6': p1, '6-7': 1 - p1 };
    }

    const pWinGame = server === 1 ? hold1 : 1 - hold2;
    const nextServer: 1 | 2 = server === 1 ? 2 : 1;
    const winMap = rec(g1 + 1, g2, nextServer);
    const loseMap = rec(g1, g2 + 1, nextServer);
    const out: ScoreMap = {};

    for (const [k, v] of Object.entries(winMap)) out[k] = (out[k] ?? 0) + pWinGame * v;
    for (const [k, v] of Object.entries(loseMap)) out[k] = (out[k] ?? 0) + (1 - pWinGame) * v;
    memo.set(key, out);
    return out;
  };

  const raw = rec(0, 0, 1);
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const normalized: ScoreMap = {};
  for (const s of scoreKeys) normalized[s] = (raw[s] ?? 0) / total;
  return normalized;
};

export const classifyScore = (p: number) => (p > 0.15 ? 'GREEN / ANCHOR' : p > 0.08 ? 'YELLOW / MID' : p > 0.03 ? 'ORANGE / PUSH' : 'RED / LOTTO');
export const fairOddsFromProbability = (p: number) => 1 / clamp(p, 0.001, 1);
export const impliedProbabilityFromOdds = (o: number) => 1 / Math.max(o, 1.01);
export const calculateEdge = (modelProbability: number, bookmakerOdds: number | null) => (bookmakerOdds ? modelProbability - impliedProbabilityFromOdds(bookmakerOdds) : 0);
export const calculateExpectedValue = (modelProbability: number, bookmakerOdds: number | null) => (bookmakerOdds ? modelProbability * bookmakerOdds - 1 : 0);

const tier = (o: number): Tier => (o >= 3000 ? 'S' : o >= 500 ? 'A' : o >= 100 ? 'B' : 'C');
export const calcSlip = (legs: SlipLeg[], stake = 10): SlipSummary => {
  const combinedOdds = legs.reduce((a, l) => a * l.odds, 1);
  const hitRate = legs.reduce((a, l) => a * l.modelProbability, 1);
  return { combinedOdds, hitRate, expectedValue: hitRate * combinedOdds - 1, payout: stake * combinedOdds, tier: tier(combinedOdds) };
};
