// Single source of truth for SetFox Strict Mode rules.
// Both the live data-refresh function and the frontend filter import these
// constants so the badge on screen always matches the row written to
// live_setfox_signals.
//
// IMPORTANT: This rule is research-grade until the walk-forward V3 workflow
// produces 5+ positive test folds with > 80 total test bets and overfit risk
// below 0.5. Until then the badge in the UI says "Research" not "Validated".

export type ScoreFamily = 'tiebreak' | 'blowout' | 'clear' | 'normal' | 'close';
export type OddsBucket =
  | 'odds_1_5'
  | 'odds_5_8'
  | 'odds_8_12'
  | 'odds_12_18'
  | 'odds_18_30'
  | 'odds_30_plus';
export type TournamentLevel = 'slam' | 'tour_premium' | 'tour_other' | 'challenger' | 'itf';
export type MatchType = 'singles' | 'doubles';

export interface SetFoxInput {
  score: string;
  modelProbability: number;
  bookmakerOdds: number | null;
  edge: number | null;
  expectedValue: number | null;
  scoreFamily: ScoreFamily;
  oddsBucket: OddsBucket;
  tournamentLevel: TournamentLevel | 'unknown';
  matchType: MatchType;
}

export interface SetFoxRule {
  version: string;
  blockTiebreak: boolean;
  blockDoubles: boolean;
  allowedScoreFamilies: ReadonlyArray<ScoreFamily>;
  allowedTournamentLevels: ReadonlyArray<TournamentLevel>;
  allowedOddsBuckets: ReadonlyArray<OddsBucket>;
  minProbability: number;
  minEv: number;
  minEdge: number;
  maxOdds: number;
}

export type SetFoxRejection =
  | 'no_market_odds'
  | 'tiebreak_blocked'
  | 'doubles_blocked'
  | 'score_family_blocked'
  | 'tournament_level_blocked'
  | 'odds_bucket_blocked'
  | 'odds_above_cap'
  | 'probability_below_min'
  | 'ev_below_min'
  | 'edge_below_min';

export interface SetFoxResult {
  passed: boolean;
  ruleVersion: string;
  rejections: SetFoxRejection[];
}

// V3 default. Research-grade. Reflects the strongest pocket from the existing
// 3-window consensus run (ITF / normal score family / x12-18 odds / no
// tiebreaks / no doubles). Not yet walk-forward validated.
export const SETFOX_RULE: SetFoxRule = {
  version: 'setfox.v3.research.itf-normal-12to18',
  blockTiebreak: true,
  blockDoubles: true,
  allowedScoreFamilies: ['normal'],
  allowedTournamentLevels: ['itf'],
  allowedOddsBuckets: ['odds_12_18'],
  minProbability: 0.03,
  minEv: 0,
  minEdge: 0,
  maxOdds: 18,
};

export function classifyScoreFamily(score: string): ScoreFamily {
  if (score === '7-6' || score === '6-7') return 'tiebreak';
  const [a, b] = score.split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'close';
  const diff = Math.abs(a - b);
  if (diff >= 4) return 'blowout';
  if (diff === 3) return 'clear';
  if (diff === 2) return 'normal';
  return 'close';
}

export function classifyOddsBucket(odds: number): OddsBucket {
  if (odds < 5) return 'odds_1_5';
  if (odds < 8) return 'odds_5_8';
  if (odds < 12) return 'odds_8_12';
  if (odds < 18) return 'odds_12_18';
  if (odds < 30) return 'odds_18_30';
  return 'odds_30_plus';
}
