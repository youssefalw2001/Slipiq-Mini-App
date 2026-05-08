import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
};

type ProofStatus = 'pending' | 'won' | 'lost' | 'void';

type OpportunityRow = {
  id: string;
  created_at?: string | null;
  match_id: string;
  label: string;
  sport: string;
  model_probability: number;
  bookmaker_odds: number | null;
  edge: number | null;
  expected_value: number | null;
  raw_payload: {
    score?: string;
    score_family?: string;
    odds_bucket?: string;
    tournament_level?: string;
    match_type?: string;
    sourceMatch?: Record<string, unknown> | null;
  } | null;
  matches?: {
    id: string;
    tournament: string | null;
    surface: string | null;
    player_one: string | null;
    player_two: string | null;
    starts_at?: string | null;
  } | null;
};

type ProofSignal = {
  id: string;
  foundAt: string;
  match: string;
  tournament: string;
  score: string;
  odds: number;
  signalStrength: number;
  status: ProofStatus;
  result: string | null;
  profitUnits: number;
  note: string;
};

function getSupabase() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

function scoreHunterScore(row: OpportunityRow) {
  return Number(row.expected_value ?? 0) * 1000 + Number(row.edge ?? 0) * 100 + Number(row.model_probability ?? 0) * 10;
}

function isScoreHunterCandidate(row: OpportunityRow) {
  const raw = row.raw_payload ?? {};
  const odds = Number(row.bookmaker_odds ?? 0);
  const score = raw.score ?? '';
  const isTiebreak = score === '7-6' || score === '6-7' || raw.score_family === 'tiebreak';

  return row.sport === 'tennis'
    && !isTiebreak
    && odds >= 5
    && odds < 8
    && raw.tournament_level === 'tour_other'
    && (raw.match_type ?? 'singles') === 'singles'
    && Number(row.model_probability ?? 0) >= 0.03
    && Number(row.expected_value ?? -Infinity) >= 0
    && Number(row.edge ?? -Infinity) >= 0;
}

function normalizeSignal(row: OpportunityRow): ProofSignal {
  const match = row.matches;
  const score = row.raw_payload?.score ?? row.label.match(/(\d-\d)$/)?.[1] ?? 'N/A';
  const playerOne = match?.player_one ?? 'Player 1';
  const playerTwo = match?.player_two ?? 'Player 2';
  const surface = match?.surface ? ` · surface flag: ${match.surface}` : '';

  return {
    id: row.id,
    foundAt: row.created_at ?? new Date().toISOString(),
    match: `${playerOne} vs ${playerTwo}`,
    tournament: match?.tournament ?? 'Score Hunter Board',
    score,
    odds: Number(row.bookmaker_odds ?? 0),
    signalStrength: Number(row.model_probability ?? 0),
    status: 'pending',
    result: null,
    profitUnits: 0,
    note: `Live paper signal from Supabase opportunities. One-pick-per-match guard applied.${surface}`,
  };
}

function selectOnePerMatch(rows: OpportunityRow[]) {
  const bestByMatch = new Map<string, OpportunityRow>();

  for (const row of rows.filter(isScoreHunterCandidate)) {
    const current = bestByMatch.get(row.match_id);
    if (!current || scoreHunterScore(row) > scoreHunterScore(current)) bestByMatch.set(row.match_id, row);
  }

  return [...bestByMatch.values()]
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, 50);
}

async function getProofSignals(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, created_at, match_id, label, sport, model_probability, bookmaker_odds, edge, expected_value, raw_payload, matches(id, tournament, surface, player_one, player_two, starts_at)')
    .eq('sport', 'tennis')
    .not('bookmaker_odds', 'is', null)
    .order('created_at', { ascending: false })
    .limit(750);

  if (error) throw error;

  return selectOnePerMatch((data ?? []) as OpportunityRow[]).map(normalizeSignal);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (req.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
    }

    const supabase = getSupabase();
    const signals = await getProofSignals(supabase);

    return Response.json(
      {
        ok: true,
        source: 'supabase_opportunities',
        strategy: 'score_hunter_candidate',
        status: 'paper_tracking_only',
        signals,
        limitations: [
          'Rows are paper tracking signals only; SlipIQ does not place bets.',
          'Results are pending until the result resolver is connected.',
          'Surface labels are included only as an audit flag, not a public claim.',
        ],
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
