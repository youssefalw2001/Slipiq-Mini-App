import { classifyScore, fairOddsFromProbability } from './probability';
import { evaluateSetFox } from './setfoxFilter';
import {
  classifyOddsBucket,
  classifyScoreFamily,
  type MatchType,
  type SetFoxRejection,
  type SetFoxResult,
  type TournamentLevel,
} from './setfoxStrategy';

const ALL_REJECTIONS = new Set<SetFoxRejection>([
  'no_market_odds',
  'tiebreak_blocked',
  'doubles_blocked',
  'score_family_blocked',
  'tournament_level_blocked',
  'odds_bucket_blocked',
  'odds_above_cap',
  'probability_below_min',
  'ev_below_min',
  'edge_below_min',
]);

function safeRejections(values: unknown): SetFoxRejection[] {
  if (!Array.isArray(values)) return [];
  const out: SetFoxRejection[] = [];
  for (const value of values) if (typeof value === 'string' && ALL_REJECTIONS.has(value as SetFoxRejection)) out.push(value as SetFoxRejection);
  return out;
}
import type { FirstSetOpportunity, ScannerStats, ScoreOutcome, Surface } from '../types';

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
    score_family?: string;
    odds_bucket?: string;
    tournament_level?: TournamentLevel;
    match_type?: MatchType;
    setfox?: { passed?: boolean; rule_version?: string; rejections?: string[] };
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
      tournament_level?: TournamentLevel;
      match_type?: MatchType;
    } | null;
  } | null;
}

interface LiveScannerRow {
  rule_version: string;
  total_scanned: number;
  passed: number;
  rejected: number;
  tiebreak_blocked: number;
  captured_at: string;
}

interface LiveResponsePayload {
  opportunities?: LiveOpportunityRow[];
  scanner?: LiveScannerRow | null;
}

export interface LiveFeedResult {
  opportunities: FirstSetOpportunity[];
  scanner: ScannerStats | null;
}

function normalizeScoreLabel(row: LiveOpportunityRow) {
  if (row.raw_payload?.score) return row.raw_payload.score;
  const fallback = row.label.match(/(\d-\d)$/)?.[1];
  return fallback ?? row.label;
}

function toOutcome(row: LiveOpportunityRow, tournamentLevel: TournamentLevel, matchType: MatchType): ScoreOutcome {
  const probability = Number(row.model_probability);
  const bookmakerOdds = row.bookmaker_odds ? Number(row.bookmaker_odds) : null;
  const impliedProbability = bookmakerOdds ? 1 / bookmakerOdds : null;
  const score = normalizeScoreLabel(row);
  const scoreFamily = classifyScoreFamily(score);
  const oddsBucket = bookmakerOdds ? classifyOddsBucket(bookmakerOdds) : 'odds_30_plus';
  // Trust the SetFox flag the edge function computed if present, otherwise
  // recompute locally (e.g. seed/manual rows).
  const persisted = row.raw_payload?.setfox;
  const setfox: SetFoxResult = persisted && typeof persisted.passed === 'boolean' && persisted.rule_version
    ? {
        passed: persisted.passed,
        ruleVersion: persisted.rule_version,
        rejections: safeRejections(persisted.rejections),
      }
    : evaluateSetFox({
        score,
        modelProbability: probability,
        bookmakerOdds,
        edge: row.edge,
        expectedValue: row.expected_value,
        scoreFamily,
        oddsBucket,
        tournamentLevel,
        matchType,
      });

  return {
    score,
    modelProbability: probability,
    fairOdds: row.fair_odds ? Number(row.fair_odds) : fairOddsFromProbability(probability),
    bookmakerOdds,
    impliedProbability,
    edge: row.edge === null ? null : Number(row.edge),
    expectedValue: row.expected_value === null ? null : Number(row.expected_value),
    classLabel: classifyScore(probability),
    hasMarketOdds: Boolean(bookmakerOdds),
    setfox,
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
    const tournamentLevel: TournamentLevel = first.raw_payload?.tournament_level ?? raw?.tournament_level ?? 'tour_other';
    const matchType: MatchType = first.raw_payload?.match_type ?? raw?.match_type ?? 'singles';
    const outcomes = matchRows
      .map((row) => toOutcome(row, tournamentLevel, matchType))
      .sort((a, b) => b.modelProbability - a.modelProbability);

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
      tournamentLevel,
      matchType,
      hold1: first.raw_payload?.hold1 ?? 0.68,
      hold2: first.raw_payload?.hold2 ?? 0.64,
      outcomes,
      top: outcomes.slice(0, 2),
      setfoxPassedCount: outcomes.filter((outcome) => outcome.setfox.passed).length,
    };
  });
}

function mapScanner(row: LiveScannerRow | null | undefined): ScannerStats | null {
  if (!row) return null;
  return {
    ruleVersion: row.rule_version,
    totalScanned: Number(row.total_scanned ?? 0),
    passed: Number(row.passed ?? 0),
    rejected: Number(row.rejected ?? 0),
    tiebreakBlocked: Number(row.tiebreak_blocked ?? 0),
    capturedAt: row.captured_at ?? null,
  };
}

export async function fetchLiveOpportunities(): Promise<LiveFeedResult | null> {
  const apiUrl = import.meta.env.VITE_SLIPIQ_DATA_API_URL as string | undefined;
  if (!apiUrl) return null;

  const response = await fetch(apiUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Live data request failed: ${response.status}`);

  const payload = (await response.json()) as LiveResponsePayload;
  const opportunities = mapRowsToOpportunities(payload.opportunities ?? []);
  if (opportunities.length === 0) return null;
  return { opportunities, scanner: mapScanner(payload.scanner ?? null) };
}
