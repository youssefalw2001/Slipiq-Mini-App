import { describe, expect, it } from 'vitest';
import {
  accumulateScannerStats,
  emptyScannerStats,
  evaluateSetFox,
} from '../setfoxFilter';
import { classifyOddsBucket, classifyScoreFamily, type SetFoxInput } from '../setfoxStrategy';
import { explainSetFox } from '../setfoxExplain';

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
