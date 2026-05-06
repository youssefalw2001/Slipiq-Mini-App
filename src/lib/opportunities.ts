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
import type { FirstSetOpportunity, ScoreOutcome, SlipLeg, TennisMatch } from '../types';

export const tennisMatches = matches as TennisMatch[];

function buildOutcome(match: TennisMatch, score: string, modelProbability: number): ScoreOutcome {
  const seededMarketOdds = match.bookmakerOdds[score];
  const hasMarketOdds = Number.isFinite(seededMarketOdds) && seededMarketOdds > 1;
  const bookmakerOdds = hasMarketOdds ? seededMarketOdds : null;
  const impliedProbability = bookmakerOdds ? impliedProbabilityFromOdds(bookmakerOdds) : null;
  const edge = bookmakerOdds ? calculateEdge(modelProbability, bookmakerOdds) : null;
  const expectedValue = bookmakerOdds ? calculateExpectedValue(modelProbability, bookmakerOdds) : null;

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
  };
}
