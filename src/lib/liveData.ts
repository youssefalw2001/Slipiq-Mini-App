import { classifyScore, fairOddsFromProbability } from './probability';
import type { FirstSetOpportunity, ScoreOutcome, Surface } from '../types';

interface LiveOpportunityRow {
  id: string;
  match_id: string;
  sport: 'tennis' | 'nba';
  label: string;
  market_key: string;
  model_probability: number;
  fair_odds: number;
  bookmaker_odds: number | null;
  edge: number | null;
  expected_value: number | null;
  risk_label: string;
  tier: string;
  explanation: string | null;
  raw_payload: {
    score?: string;
    hold1?: number;
    hold2?: number;
    p1PointStrength?: number;
    p2PointStrength?: number;
  } | null;
  matches?: {
    id: string;
    tournament: string | null;
    surface: Surface | null;
    player_one: string | null;
    player_two: string | null;
    raw_payload?: {
      p1?: { fs1: number; w1s: number; w2s: number; bp_save: number };
      p2?: { fs1: number; w1s: number; w2s: number; bp_save: number };
      bookmaker_odds?: Record<string, number>;
    } | null;
  } | null;
}

function normalizeScoreLabel(row: LiveOpportunityRow) {
  if (row.raw_payload?.score) return row.raw_payload.score;
  const fallback = row.label.match(/(\d-\d)$/)?.[1];
  return fallback ?? row.label;
}

function toOutcome(row: LiveOpportunityRow): ScoreOutcome {
  const probability = Number(row.model_probability);
  const bookmakerOdds = row.bookmaker_odds ? Number(row.bookmaker_odds) : null;
  const impliedProbability = bookmakerOdds ? 1 / bookmakerOdds : null;

  return {
    score: normalizeScoreLabel(row),
    modelProbability: probability,
    fairOdds: row.fair_odds ? Number(row.fair_odds) : fairOddsFromProbability(probability),
    bookmakerOdds,
    impliedProbability,
    edge: row.edge === null ? null : Number(row.edge),
    expectedValue: row.expected_value === null ? null : Number(row.expected_value),
    classLabel: classifyScore(probability),
    hasMarketOdds: Boolean(bookmakerOdds),
  };
}

function mapRowsToOpportunities(rows: LiveOpportunityRow[]): FirstSetOpportunity[] {
  const grouped = new Map<string, LiveOpportunityRow[]>();

  for (const row of rows.filter((item) => item.sport === 'tennis')) {
    grouped.set(row.match_id, [...(grouped.get(row.match_id) ?? []), row]);
  }

  return [...grouped.entries()].map(([matchId, matchRows]) => {
    const first = matchRows[0];
    const match = first.matches;
    const raw = match?.raw_payload;
    const outcomes = matchRows.map(toOutcome).sort((a, b) => b.modelProbability - a.modelProbability);

    return {
      id: matchId,
      tournament: match?.tournament ?? 'Live Tennis Board',
      surface: match?.surface ?? 'hard',
      player1: match?.player_one ?? 'Player 1',
      player2: match?.player_two ?? 'Player 2',
      player1Stats: {
        fs1: raw?.p1?.fs1 ?? 0.65,
        w1s: raw?.p1?.w1s ?? 0.72,
        w2s: raw?.p1?.w2s ?? 0.55,
        bpSave: raw?.p1?.bp_save ?? 0.62,
      },
      player2Stats: {
        fs1: raw?.p2?.fs1 ?? 0.63,
        w1s: raw?.p2?.w1s ?? 0.7,
        w2s: raw?.p2?.w2s ?? 0.54,
        bpSave: raw?.p2?.bp_save ?? 0.6,
      },
      bookmakerOdds: raw?.bookmaker_odds ?? {},
      hold1: first.raw_payload?.hold1 ?? 0.68,
      hold2: first.raw_payload?.hold2 ?? 0.64,
      outcomes,
      top: outcomes.slice(0, 2),
    };
  });
}

export async function fetchLiveOpportunities(): Promise<FirstSetOpportunity[] | null> {
  const apiUrl = import.meta.env.VITE_SLIPIQ_DATA_API_URL as string | undefined;
  if (!apiUrl) return null;

  const response = await fetch(apiUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Live data request failed: ${response.status}`);

  const payload = (await response.json()) as { opportunities?: LiveOpportunityRow[] };
  const opportunities = mapRowsToOpportunities(payload.opportunities ?? []);
  return opportunities.length > 0 ? opportunities : null;
}
