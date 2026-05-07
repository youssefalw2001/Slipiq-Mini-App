import type { FirstSetOpportunity, ScoreOutcome } from '../types';

export interface PreferredOutcome {
  outcome: ScoreOutcome;
  isSetfox: boolean;
}

// Prefer the highest-EV SetFox-passed outcome that has bookmaker odds. Fall
// back to the top-by-probability outcome with bookmaker odds. Returns null if
// nothing in the opportunity has market odds.
export function pickPreferredOutcome(opportunity: FirstSetOpportunity): PreferredOutcome | null {
  const setfoxCandidates = opportunity.outcomes.filter(
    (outcome) => outcome.setfox.passed && outcome.bookmakerOdds !== null,
  );
  if (setfoxCandidates.length > 0) {
    const best = setfoxCandidates.reduce((leader, candidate) =>
      (candidate.expectedValue ?? -Infinity) > (leader.expectedValue ?? -Infinity) ? candidate : leader,
    );
    return { outcome: best, isSetfox: true };
  }

  const fallback = opportunity.top.find((outcome) => outcome.bookmakerOdds);
  return fallback ? { outcome: fallback, isSetfox: false } : null;
}
