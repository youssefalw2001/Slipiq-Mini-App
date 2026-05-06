import { describe, expect, it } from 'vitest';
import {
  calcHoldProb,
  calcSetScoreDist,
  calculateEdge,
  calculateExpectedValue,
  calcSlip,
  classifyScore,
  fairOddsFromProbability,
  impliedProbabilityFromOdds,
  probWinGame,
} from '../probability';
import type { SlipLeg } from '../../types';

describe('probability utilities', () => {
  it('bounds hold probability', () => {
    const result = calcHoldProb(0.65, 0.82, 0.66, 0.68, 'clay');
    expect(result).toBeGreaterThanOrEqual(0.45);
    expect(result).toBeLessThanOrEqual(0.95);
  });

  it('calculates game probability', () => {
    expect(probWinGame(0.5)).toBeCloseTo(0.5, 5);
    expect(probWinGame(0.62)).toBeGreaterThan(0.62);
  });

  it('normalizes set score distribution', () => {
    const dist = calcSetScoreDist(0.78, 0.65);
    const total = Object.values(dist).reduce((sum, p) => sum + p, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(dist['6-4']).toBeGreaterThan(0);
    expect(dist['7-6']).toBeGreaterThan(0);
    expect(dist['6-7']).toBeGreaterThan(0);
  });

  it('classifies outcome ranges', () => {
    expect(classifyScore(0.16)).toEqual({ tier: 'GREEN', label: 'ANCHOR' });
    expect(classifyScore(0.1)).toEqual({ tier: 'YELLOW', label: 'MID' });
    expect(classifyScore(0.05)).toEqual({ tier: 'ORANGE', label: 'PUSH' });
    expect(classifyScore(0.02)).toEqual({ tier: 'RED', label: 'LOTTO' });
  });

  it('keeps market math separate', () => {
    expect(fairOddsFromProbability(0.25)).toBeCloseTo(4);
    expect(impliedProbabilityFromOdds(5)).toBeCloseTo(0.2);
    expect(calculateEdge(0.25, 5)).toBeCloseTo(0.05);
    expect(calculateExpectedValue(0.25, 5)).toBeCloseTo(0.25);
  });

  it('summarizes combined legs', () => {
    const legs: SlipLeg[] = [
      { id: 'a', label: 'A', sport: 'tennis', odds: 4, modelProbability: 0.25, eventId: 'm1' },
      { id: 'b', label: 'B', sport: 'nba', odds: 1.5, modelProbability: 0.7, eventId: 'g1' },
    ];
    const summary = calcSlip(legs, 10);
    expect(summary.combinedOdds).toBeCloseTo(6);
    expect(summary.hitRate).toBeCloseTo(0.175);
    expect(summary.payout).toBeCloseTo(60);
    expect(summary.expectedValue).toBeCloseTo(0.05);
  });
});
