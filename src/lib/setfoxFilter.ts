import {
  SETFOX_RULE,
  type SetFoxInput,
  type SetFoxRejection,
  type SetFoxResult,
  type SetFoxRule,
} from './setfoxStrategy';

export type { SetFoxRejection, SetFoxResult } from './setfoxStrategy';

export function evaluateSetFox(input: SetFoxInput, rule: SetFoxRule = SETFOX_RULE): SetFoxResult {
  const rejections: SetFoxRejection[] = [];

  if (input.bookmakerOdds === null || !Number.isFinite(input.bookmakerOdds) || input.bookmakerOdds <= 1) {
    rejections.push('no_market_odds');
  }
  if (rule.blockTiebreak && input.scoreFamily === 'tiebreak') rejections.push('tiebreak_blocked');
  if (rule.blockDoubles && input.matchType === 'doubles') rejections.push('doubles_blocked');
  if (!rule.allowedScoreFamilies.includes(input.scoreFamily)) rejections.push('score_family_blocked');
  if (input.tournamentLevel === 'unknown' || !rule.allowedTournamentLevels.includes(input.tournamentLevel)) {
    rejections.push('tournament_level_blocked');
  }
  if (!rule.allowedOddsBuckets.includes(input.oddsBucket)) rejections.push('odds_bucket_blocked');
  if (input.bookmakerOdds !== null && input.bookmakerOdds > rule.maxOdds) rejections.push('odds_above_cap');
  if (input.modelProbability < rule.minProbability) rejections.push('probability_below_min');
  if ((input.expectedValue ?? -Infinity) < rule.minEv) rejections.push('ev_below_min');
  if ((input.edge ?? -Infinity) < rule.minEdge) rejections.push('edge_below_min');

  return {
    passed: rejections.length === 0,
    ruleVersion: rule.version,
    rejections,
  };
}

export interface SetFoxScannerStats {
  totalScanned: number;
  passed: number;
  rejected: number;
  rejectionsByReason: Record<SetFoxRejection, number>;
  tiebreakBlocked: number;
}

export function emptyScannerStats(): SetFoxScannerStats {
  return {
    totalScanned: 0,
    passed: 0,
    rejected: 0,
    rejectionsByReason: {
      no_market_odds: 0,
      tiebreak_blocked: 0,
      doubles_blocked: 0,
      score_family_blocked: 0,
      tournament_level_blocked: 0,
      odds_bucket_blocked: 0,
      odds_above_cap: 0,
      probability_below_min: 0,
      ev_below_min: 0,
      edge_below_min: 0,
    },
    tiebreakBlocked: 0,
  };
}

export function accumulateScannerStats(stats: SetFoxScannerStats, result: SetFoxResult): SetFoxScannerStats {
  const next = { ...stats, rejectionsByReason: { ...stats.rejectionsByReason } };
  next.totalScanned += 1;
  if (result.passed) next.passed += 1;
  else next.rejected += 1;
  for (const reason of result.rejections) {
    next.rejectionsByReason[reason] += 1;
    if (reason === 'tiebreak_blocked') next.tiebreakBlocked += 1;
  }
  return next;
}
