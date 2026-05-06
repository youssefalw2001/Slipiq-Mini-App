import matches from '../data/tennisMatches.json';
import { calcHoldProb, calcSetScoreDist, fairOddsFromProbability, impliedProbabilityFromOdds, calculateEdge, calculateExpectedValue, classifyScore, probWinGame } from './probability';
import { SlipLeg, TennisMatch } from '../types';

export const tennisMatches = matches as TennisMatch[];
export const opportunities = tennisMatches.map((m) => {
  const h1 = probWinGame(calcHoldProb(m.player1Stats.fs1, m.player1Stats.w1s, m.player1Stats.w2s, m.player1Stats.bpSave, m.surface));
  const h2 = probWinGame(calcHoldProb(m.player2Stats.fs1, m.player2Stats.w1s, m.player2Stats.w2s, m.player2Stats.bpSave, m.surface));
  const dist = calcSetScoreDist(h1, h2);
  const outcomes = Object.entries(dist).map(([score, p]) => {
    const marketOdds = m.bookmakerOdds[score] ?? null;
    const fairOdds = fairOddsFromProbability(p);
    return {
      score,
      modelProbability: p,
      fairOdds,
      bookmakerOdds: marketOdds,
      impliedProbability: marketOdds ? impliedProbabilityFromOdds(marketOdds) : null,
      edge: calculateEdge(p, marketOdds),
      expectedValue: calculateExpectedValue(p, marketOdds),
      classLabel: classifyScore(p),
      oddsSource: marketOdds ? 'market' : 'synthetic'
    };
  }).sort((a, b) => b.modelProbability - a.modelProbability);
  return { ...m, hold1: h1, hold2: h2, outcomes, top: outcomes.slice(0, 2) };
});

export const legFromOutcome = (matchId: string, score: string): SlipLeg | undefined => {
  const o = opportunities.find((x) => x.id === matchId);
  const oc = o?.outcomes.find((s) => s.score === score);
  if (!o || !oc) return;
  const odds = oc.bookmakerOdds ?? oc.fairOdds;
  return { id: `${matchId}-${score}`, label: `${o.player1} vs ${o.player2} ${score}`, sport: 'tennis', odds, modelProbability: oc.modelProbability, eventId: matchId };
};
