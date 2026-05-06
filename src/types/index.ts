export type Surface = 'clay' | 'hard' | 'grass' | 'indoor';
export type Tier = 'S' | 'A' | 'B' | 'C';
export type Sport = 'tennis' | 'nba';
export type ScoreTier = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

export interface PlayerServeStats {
  fs1: number;
  w1s: number;
  w2s: number;
  bpSave: number;
}

export interface TennisMatch {
  id: string;
  tournament: string;
  surface: Surface;
  player1: string;
  player2: string;
  player1Stats: PlayerServeStats;
  player2Stats: PlayerServeStats;
  bookmakerOdds: Record<string, number>;
}

export interface ScoreClass {
  tier: ScoreTier;
  label: 'ANCHOR' | 'MID' | 'PUSH' | 'LOTTO';
}

export interface ScoreOutcome {
  score: string;
  modelProbability: number;
  fairOdds: number;
  bookmakerOdds: number | null;
  impliedProbability: number | null;
  edge: number | null;
  expectedValue: number | null;
  classLabel: ScoreClass;
  hasMarketOdds: boolean;
}

export interface FirstSetOpportunity extends TennisMatch {
  hold1: number;
  hold2: number;
  outcomes: ScoreOutcome[];
  top: ScoreOutcome[];
}

export interface SlipLeg {
  id: string;
  label: string;
  sport: Sport;
  odds: number;
  modelProbability: number;
  eventId: string;
}

export interface SlipSummary {
  combinedOdds: number;
  hitRate: number;
  expectedValue: number;
  payout: number;
  tier: Tier;
  daysToHit: number | null;
}
