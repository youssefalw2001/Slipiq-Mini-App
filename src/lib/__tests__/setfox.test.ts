import { describe, expect, it } from 'vitest';
import {
  accumulateScannerStats,
  emptyScannerStats,
  evaluateSetFox,
} from '../setfoxFilter';
import { classifyOddsBucket, classifyScoreFamily, type SetFoxInput } from '../setfoxStrategy';
import { explainSetFox } from '../setfoxExplain';
import { pickPreferredOutcome } from '../setfoxPreferOutcome';
import type { FirstSetOpportunity, ScoreOutcome } from '../../types';

function input(overrides: Partial<SetFoxInput> = {}): SetFoxInput {
  return {
    score: '6-4',
    modelProbability: 0.06,
    bookmakerOdds: 14,
    edge: 0.01,
    expectedValue: 0.02,
    scoreFamily: 'normal',
    oddsBucket: 'odds_12_18',
    tournamentLevel: 'itf',
    matchType: 'singles',
    ...overrides,
  };
}

describe('classifyScoreFamily', () => {
  it('maps tiebreak scores', () => {
    expect(classifyScoreFamily('7-6')).toBe('tiebreak');
    expect(classifyScoreFamily('6-7')).toBe('tiebreak');
  });

  it('maps blowouts and clear scores', () => {
    expect(classifyScoreFamily('6-1')).toBe('blowout');
    expect(classifyScoreFamily('6-2')).toBe('blowout');
    expect(classifyScoreFamily('6-3')).toBe('clear');
  });

  it('maps normal and close scores', () => {
    expect(classifyScoreFamily('6-4')).toBe('normal');
    expect(classifyScoreFamily('7-5')).toBe('normal');
    expect(classifyScoreFamily('1-2')).toBe('close');
  });
});

describe('classifyOddsBucket', () => {
  it('places odds in the correct bucket', () => {
    expect(classifyOddsBucket(14)).toBe('odds_12_18');
    expect(classifyOddsBucket(8)).toBe('odds_8_12');
    expect(classifyOddsBucket(40)).toBe('odds_30_plus');
  });
});

describe('evaluateSetFox', () => {
  it('passes the canonical research pocket', () => {
    const result = evaluateSetFox(input());
    expect(result.passed).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it('blocks tiebreak scores even when other criteria pass', () => {
    const result = evaluateSetFox(input({ score: '7-6', scoreFamily: 'tiebreak' }));
    expect(result.passed).toBe(false);
    expect(result.rejections).toContain('tiebreak_blocked');
  });

  it('blocks doubles', () => {
    const result = evaluateSetFox(input({ matchType: 'doubles' }));
    expect(result.passed).toBe(false);
    expect(result.rejections).toContain('doubles_blocked');
  });

  it('rejects odds outside the validated band', () => {
    const result = evaluateSetFox(input({ bookmakerOdds: 30, oddsBucket: 'odds_18_30' }));
    expect(result.passed).toBe(false);
    expect(result.rejections).toContain('odds_above_cap');
    expect(result.rejections).toContain('odds_bucket_blocked');
  });

  it('rejects when there is no market odds at all', () => {
    const result = evaluateSetFox(input({ bookmakerOdds: null, edge: null, expectedValue: null }));
    expect(result.passed).toBe(false);
    expect(result.rejections).toContain('no_market_odds');
  });
});

describe('accumulateScannerStats', () => {
  it('counts passed and rejected rows', () => {
    let stats = emptyScannerStats();
    stats = accumulateScannerStats(stats, evaluateSetFox(input()));
    stats = accumulateScannerStats(stats, evaluateSetFox(input({ score: '7-6', scoreFamily: 'tiebreak' })));
    stats = accumulateScannerStats(stats, evaluateSetFox(input({ matchType: 'doubles' })));
    expect(stats.totalScanned).toBe(3);
    expect(stats.passed).toBe(1);
    expect(stats.rejected).toBe(2);
    expect(stats.tiebreakBlocked).toBe(1);
    expect(stats.rejectionsByReason.tiebreak_blocked).toBe(1);
    expect(stats.rejectionsByReason.doubles_blocked).toBe(1);
  });
});

describe('explainSetFox', () => {
  it('produces a positive blurb on pass', () => {
    const result = evaluateSetFox(input());
    expect(explainSetFox(input(), result)).toContain('SetFox pass');
  });

  it('explains why a row was rejected', () => {
    const tiebreak = input({ score: '7-6', scoreFamily: 'tiebreak' });
    const result = evaluateSetFox(tiebreak);
    expect(explainSetFox(tiebreak, result)).toContain('Tiebreak');
  });
});

function makeOutcome(score: string, overrides: Partial<ScoreOutcome> & { passed: boolean }): ScoreOutcome {
  return {
    score,
    modelProbability: 0.1,
    fairOdds: 10,
    bookmakerOdds: overrides.bookmakerOdds ?? 12,
    impliedProbability: 1 / (overrides.bookmakerOdds ?? 12),
    edge: 0.01,
    expectedValue: 0.05,
    classLabel: { tier: 'YELLOW', label: 'MID' },
    hasMarketOdds: true,
    setfox: {
      passed: overrides.passed,
      ruleVersion: 'setfox.v3.research.itf-normal-12to18',
      rejections: [],
    },
    ...overrides,
  };
}

function makeOpportunity(outcomes: ScoreOutcome[]): FirstSetOpportunity {
  const top = [...outcomes].sort((a, b) => b.modelProbability - a.modelProbability).slice(0, 2);
  return {
    id: 'test-match',
    tournament: 'Test Open',
    surface: 'hard',
    player1: 'P1',
    player2: 'P2',
    player1Stats: { fs1: 0.65, w1s: 0.72, w2s: 0.55, bpSave: 0.62 },
    player2Stats: { fs1: 0.63, w1s: 0.7, w2s: 0.54, bpSave: 0.6 },
    bookmakerOdds: {},
    hold1: 0.7,
    hold2: 0.65,
    outcomes,
    top,
    setfoxPassedCount: outcomes.filter((outcome) => outcome.setfox.passed).length,
  };
}

describe('pickPreferredOutcome', () => {
  it('prefers a SetFox-passed outcome over a higher-probability non-SetFox outcome', () => {
    const opportunity = makeOpportunity([
      makeOutcome('6-2', { modelProbability: 0.18, bookmakerOdds: 4, expectedValue: -0.1, passed: false }),
      makeOutcome('6-4', { modelProbability: 0.05, bookmakerOdds: 14, expectedValue: 0.07, passed: true }),
    ]);
    const result = pickPreferredOutcome(opportunity);
    expect(result?.outcome.score).toBe('6-4');
    expect(result?.isSetfox).toBe(true);
  });

  it('chooses the highest-EV outcome among multiple SetFox passes', () => {
    const opportunity = makeOpportunity([
      makeOutcome('6-4', { modelProbability: 0.06, bookmakerOdds: 12, expectedValue: 0.04, passed: true }),
      makeOutcome('4-6', { modelProbability: 0.04, bookmakerOdds: 17, expectedValue: 0.12, passed: true }),
    ]);
    const result = pickPreferredOutcome(opportunity);
    expect(result?.outcome.score).toBe('4-6');
    expect(result?.isSetfox).toBe(true);
  });

  it('falls back to top-of-card when no outcome passes SetFox', () => {
    const opportunity = makeOpportunity([
      makeOutcome('6-2', { modelProbability: 0.2, bookmakerOdds: 4, expectedValue: -0.1, passed: false }),
      makeOutcome('6-3', { modelProbability: 0.12, bookmakerOdds: 6, expectedValue: -0.05, passed: false }),
    ]);
    const result = pickPreferredOutcome(opportunity);
    expect(result?.outcome.score).toBe('6-2');
    expect(result?.isSetfox).toBe(false);
  });

  it('returns null when nothing has bookmaker odds', () => {
    const opportunity = makeOpportunity([
      makeOutcome('6-4', { modelProbability: 0.06, bookmakerOdds: null, expectedValue: null, edge: null, passed: false, hasMarketOdds: false }),
    ]);
    expect(pickPreferredOutcome(opportunity)).toBeNull();
  });
});
