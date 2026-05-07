import type { SetFoxRejection, SetFoxResult } from './setfoxFilter';
import { SETFOX_RULE, type SetFoxInput } from './setfoxStrategy';

const REJECTION_COPY: Record<SetFoxRejection, string> = {
  no_market_odds: 'No bookmaker odds for this score',
  tiebreak_blocked: 'Tiebreak scores (7-6 / 6-7) are hard-blocked: historically negative ROI',
  doubles_blocked: 'Doubles dynamics differ from singles; not modelled in v3',
  score_family_blocked: 'Score family is outside the current research pocket',
  tournament_level_blocked: 'Tournament tier is outside the current research pocket',
  odds_bucket_blocked: 'Odds outside the validated x12-18 band',
  odds_above_cap: 'Odds above the strict-mode cap',
  probability_below_min: 'Model probability below the strict-mode floor',
  ev_below_min: 'Expected value below the strict-mode floor',
  edge_below_min: 'Edge vs. implied probability below the strict-mode floor',
};

export function explainSetFox(input: SetFoxInput, result: SetFoxResult): string {
  if (result.passed) {
    const odds = input.bookmakerOdds ?? 0;
    return `SetFox pass · ${input.score} at ×${odds.toFixed(2)} · ${input.tournamentLevel.toUpperCase()} · normal-shape first set · tiebreak risk filtered`;
  }
  const reasons = result.rejections.map((reason) => REJECTION_COPY[reason]).filter(Boolean);
  return reasons.length > 0 ? `SetFox reject: ${reasons[0]}` : 'SetFox reject';
}

// Returns a short rule manifest the UI can show under the badge.
export function setfoxManifest(): string[] {
  return [
    `Rule: ${SETFOX_RULE.version}`,
    `Allowed tier: ${SETFOX_RULE.allowedTournamentLevels.join(', ').toUpperCase()}`,
    `Allowed shape: ${SETFOX_RULE.allowedScoreFamilies.join(', ')}`,
    `Allowed odds: ${SETFOX_RULE.allowedOddsBuckets.join(', ')} (max ×${SETFOX_RULE.maxOdds})`,
    `Min model probability: ${(SETFOX_RULE.minProbability * 100).toFixed(0)}%`,
    'Tiebreak scores blocked',
    'Doubles excluded',
  ];
}

export function setfoxConfidenceBadge(): { label: string; tone: 'research' | 'watchlist' | 'validated' } {
  return { label: 'Research mode', tone: 'research' };
}
