import { describe, it, expect } from 'vitest';
import { calcHoldProb, probWinGame, calcSetScoreDist, classifyScore, fairOddsFromProbability, impliedProbabilityFromOdds, calculateEdge, calculateExpectedValue, calcSlip } from '../probability';

describe('probability engine', () => {
  it('calcHoldProb bounded', () => { expect(calcHoldProb(0.7,0.8,0.5,0.7,'hard')).toBeGreaterThanOrEqual(0.45); expect(calcHoldProb(0.7,0.8,0.5,0.7,'hard')).toBeLessThanOrEqual(0.95); });
  it('probWinGame monotonic', () => { expect(probWinGame(0.7)).toBeGreaterThan(probWinGame(0.6)); });
  it('calcSetScoreDist normalized', () => { const dist = calcSetScoreDist(0.8,0.7); const total = Object.values(dist).reduce((a,b)=>a+b,0); expect(total).toBeCloseTo(1,6); });
  it('classifyScore thresholds', () => { expect(classifyScore(0.16)).toContain('GREEN'); expect(classifyScore(0.09)).toContain('YELLOW'); });
  it('odds helpers', () => { expect(fairOddsFromProbability(0.5)).toBeCloseTo(2); expect(impliedProbabilityFromOdds(2)).toBeCloseTo(0.5); expect(calculateEdge(0.55,2)).toBeCloseTo(0.05); expect(calculateExpectedValue(0.55,2)).toBeCloseTo(0.1); });
  it('calcSlip', () => { const s = calcSlip([{id:'1',label:'a',sport:'nba',odds:2,modelProbability:0.5,eventId:'e'}],10); expect(s.combinedOdds).toBe(2); expect(s.payout).toBe(20); });
});
