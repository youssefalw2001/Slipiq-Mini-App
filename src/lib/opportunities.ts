import matches from '../data/tennisMatches.json';
import {
  calcHoldProb,
  calcSetScoreDist,
  calculateEdge,
  calculateExpectedValue,
  fairOddsFromProbability,
  impliedProbabilityFromOdds,
  probWinGame,
  classifyScore,
} from './probability';
import { evaluateSetFox } from './setfoxFilter';
import {
  classifyOddsBucket,
  classifyScoreFamily,
  type MatchType,
  type TournamentLevel,
} from './setfoxStrategy';
import type { FirstSetOpportunity, ScoreOutcome, SlipLeg, TennisMatch } from '../types';

export const tennisMatches = matches as TennisMatch[];

function inferTournamentLevel(tournament: string): TournamentLevel {
  const text = tournament.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}

function inferMatchType(player1: string, player2: string): MatchType {
  return player1.includes('/') || player2.includes('/') ? 'doubles' : 'singles';
}

function buildOutcome(match: TennisMatch, score: string, modelProbability: number): ScoreOutcome {
  const seededMarketOdds = match.bookmakerOdds[score];
  const hasMarketOdds = Number.isFinite(seededMarketOdds) && seededMarketOdds > 1;
  const bookmakerOdds = hasMarketOdds ? seededMarketOdds : null;
  const impliedProbability = bookmakerOdds ? impliedProbabilityFromOdds(bookmakerOdds) : null;
  const edge = bookmakerOdds ? calculateEdge(modelProbability, bookmakerOdds) : null;
  const expectedValue = bookmakerOdds ? calculateExpectedValue(modelProbability, bookmakerOdds) : null;
  const tournamentLevel = match.tournamentLevel ?? inferTournamentLevel(match.tournament);
  const matchType = match.matchType ?? inferMatchType(match.player1, match.player2);
  const scoreFamily = classifyScoreFamily(score);
  const oddsBucket = bookmakerOdds ? classifyOddsBucket(bookmakerOdds) : 'odds_30_plus';
  const setfox = evaluateSetFox({
    score,
    modelProbability,
    bookmakerOdds,
    edge,
    expectedValue,
    scoreFamily,
    oddsBucket,
    tournamentLevel,
    matchType,
  });

  return {
    score,
    modelProbability,
    fairOdds: fairOddsFromProbability(modelProbability),
    bookmakerOdds,
    impliedProbability,
    edge,
    expectedValue,
    classLabel: classifyScore(modelProbability),
    hasMarketOdds,
    setfox: { passed: setfox.passed, ruleVersion: setfox.ruleVersion, rejections: setfox.rejections },
  };
}

export const opportunities: FirstSetOpportunity[] = tennisMatches.map((match) => {
  const p1PointStrength = calcHoldProb(
    match.player1Stats.fs1,
    match.player1Stats.w1s,
    match.player1Stats.w2s,
    match.player1Stats.bpSave,
    match.surface,
  );
  const p2PointStrength = calcHoldProb(
    match.player2Stats.fs1,
    match.player2Stats.w1s,
    match.player2Stats.w2s,
    match.player2Stats.bpSave,
    match.surface,
  );

  const hold1 = probWinGame(p1PointStrength);
  const hold2 = probWinGame(p2PointStrength);
  const distribution = calcSetScoreDist(hold1, hold2);
  const outcomes = Object.entries(distribution)
    .map(([score, probability]) => buildOutcome(match, score, probability))
    .sort((a, b) => b.modelProbability - a.modelProbability);

  return {
    ...match,
    hold1,
    hold2,
    outcomes,
    top: outcomes.slice(0, 2),
    setfoxPassedCount: outcomes.filter((outcome) => outcome.setfox.passed).length,
  };
});

export function legFromOutcome(matchId: string, score: string): SlipLeg | undefined {
  const match = opportunities.find((opportunity) => opportunity.id === matchId);
  const outcome = match?.outcomes.find((item) => item.score === score);

  if (!match || !outcome || !outcome.bookmakerOdds) return undefined;

  return {
    id: `${matchId}-${score}`,
    label: `${match.player1} vs ${match.player2} ${score}`,
    sport: 'tennis',
    odds: outcome.bookmakerOdds,
    modelProbability: outcome.modelProbability,
    eventId: matchId,
    setfoxPassed: outcome.setfox.passed,
    setfoxRuleVersion: outcome.setfox.ruleVersion,
  };
}
