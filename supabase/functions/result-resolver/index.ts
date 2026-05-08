import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-slipiq-refresh-secret',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

type ProofStatus = 'pending' | 'won' | 'lost' | 'void';

type OpportunityRow = {
  id: string;
  created_at?: string | null;
  match_id: string;
  label: string;
  sport: string;
  bookmaker_odds: number | null;
  raw_payload: {
    score?: string;
    score_family?: string;
    odds_bucket?: string;
    tournament_level?: string;
    match_type?: string;
    provider?: string;
    sourceMatch?: {
      event_key?: string | number;
      fixture?: Record<string, unknown>;
    } | null;
  } | null;
  matches?: {
    id: string;
    status: string | null;
    starts_at?: string | null;
    raw_payload?: Record<string, unknown> | null;
  } | null;
};

type ResolvedSignal = {
  opportunity_id: string;
  match_id: string;
  selected_score: string;
  actual_score: string | null;
  status: ProofStatus;
  profit_units: number;
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

function isoDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function normalizeArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
}

function getText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeScore(score: string) {
  return score.trim().replace(':', '-');
}

function selectedScore(row: OpportunityRow) {
  return row.raw_payload?.score ?? row.label.match(/(\d-\d)$/)?.[1] ?? '';
}

function apiTennisEventKey(row: OpportunityRow) {
  const fromRaw = row.raw_payload?.sourceMatch?.event_key;
  if (fromRaw) return String(fromRaw);

  const matchRaw = row.matches?.raw_payload as Record<string, unknown> | null | undefined;
  const rawPayload = matchRaw?.raw_payload as Record<string, unknown> | undefined;
  const eventKey = rawPayload?.event_key ?? matchRaw?.event_key;
  return eventKey ? String(eventKey) : null;
}

function isScoreHunterOpportunity(row: OpportunityRow) {
  const raw = row.raw_payload ?? {};
  const odds = Number(row.bookmaker_odds ?? 0);
  const score = selectedScore(row);
  const isTiebreak = score === '7-6' || score === '6-7' || raw.score_family === 'tiebreak';

  return row.sport === 'tennis'
    && !isTiebreak
    && odds >= 5
    && odds < 8
    && raw.tournament_level === 'tour_other'
    && (raw.match_type ?? 'singles') === 'singles';
}

async function fetchApiTennis(method: string, params: Record<string, string>) {
  const apiKey = Deno.env.get('API_TENNIS_KEY');
  if (!apiKey) throw new Error('API_TENNIS_KEY is required for result resolver');

  const url = new URL('https://api.api-tennis.com/tennis/');
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`API-Tennis ${method} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);

  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') throw new Error(`API-Tennis ${method} returned unsuccessful payload: ${JSON.stringify(payload).slice(0, 500)}`);
  return payload.result;
}

function extractFirstSetScore(fixture: Record<string, unknown>) {
  const eventFinalResult = getText(fixture.event_final_result);
  const eventFirstSet = getText(fixture.event_first_set);
  const eventSetResult = getText(fixture.event_set_result);

  const candidates = [eventFirstSet, eventSetResult, eventFinalResult];
  for (const candidate of candidates) {
    const match = candidate.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (match) return `${match[1]}-${match[2]}`;
  }

  return null;
}

function isFixtureFinished(fixture: Record<string, unknown>) {
  const status = `${getText(fixture.event_status)} ${getText(fixture.event_result)} ${getText(fixture.event_final_result)}`.toLowerCase();
  return /finished|ended|retired|walkover|w\/o|cancelled|postponed|abandoned/.test(status) || Boolean(extractFirstSetScore(fixture));
}

function isVoidFixture(fixture: Record<string, unknown>) {
  const status = `${getText(fixture.event_status)} ${getText(fixture.event_result)} ${getText(fixture.event_final_result)}`.toLowerCase();
  return /retired|walkover|w\/o|cancelled|postponed|abandoned/.test(status);
}

function resolveRow(row: OpportunityRow, fixtureByEventKey: Map<string, Record<string, unknown>>): ResolvedSignal {
  const score = selectedScore(row);
  const odds = Number(row.bookmaker_odds ?? 0);
  const eventKey = apiTennisEventKey(row);
  const fixture = eventKey ? fixtureByEventKey.get(eventKey) : null;

  if (!fixture) {
    return {
      opportunity_id: row.id,
      match_id: row.match_id,
      selected_score: score,
      actual_score: null,
      status: 'pending',
      profit_units: 0,
      note: 'No finished fixture found yet. Kept pending.',
    };
  }

  if (!isFixtureFinished(fixture)) {
    return {
      opportunity_id: row.id,
      match_id: row.match_id,
      selected_score: score,
      actual_score: null,
      status: 'pending',
      profit_units: 0,
      note: 'Fixture not finished yet. Kept pending.',
    };
  }

  if (isVoidFixture(fixture)) {
    return {
      opportunity_id: row.id,
      match_id: row.match_id,
      selected_score: score,
      actual_score: extractFirstSetScore(fixture),
      status: 'void',
      profit_units: 0,
      note: 'Fixture status indicates void/retired/cancelled handling. Flat 1u stake returned.',
    };
  }

  const actualScore = extractFirstSetScore(fixture);
  if (!actualScore) {
    return {
      opportunity_id: row.id,
      match_id: row.match_id,
      selected_score: score,
      actual_score: null,
      status: 'pending',
      profit_units: 0,
      note: 'Fixture finished but first-set score was not parseable. Kept pending for manual review.',
    };
  }

  const won = normalizeScore(actualScore) === normalizeScore(score);
  return {
    opportunity_id: row.id,
    match_id: row.match_id,
    selected_score: score,
    actual_score: actualScore,
    status: won ? 'won' : 'lost',
    profit_units: won ? odds - 1 : -1,
    note: won ? 'Resolved as win from API-Tennis first-set score.' : 'Resolved as loss from API-Tennis first-set score.',
  };
}

async function fetchCandidateRows(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, created_at, match_id, label, sport, bookmaker_odds, raw_payload, matches(id, status, starts_at, raw_payload)')
    .eq('sport', 'tennis')
    .not('bookmaker_odds', 'is', null)
    .order('created_at', { ascending: false })
    .limit(750);

  if (error) throw error;
  return ((data ?? []) as OpportunityRow[]).filter(isScoreHunterOpportunity);
}

async function upsertResults(supabase: ReturnType<typeof createClient>, results: ResolvedSignal[]) {
  if (results.length === 0) return;

  const rows = results.map((result) => ({
    opportunity_id: result.opportunity_id,
    match_id: result.match_id,
    strategy: 'score_hunter_candidate',
    selected_score: result.selected_score,
    actual_score: result.actual_score,
    status: result.status,
    profit_units: result.profit_units,
    note: result.note,
    resolved_at: result.status === 'pending' ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('score_hunter_results')
    .upsert(rows, { onConflict: 'opportunity_id' });

  if (error) throw error;
}

async function runResolver() {
  const supabase = getSupabase();
  const dateStart = Deno.env.get('RESULT_RESOLVER_DATE_START') ?? isoDate(-4);
  const dateStop = Deno.env.get('RESULT_RESOLVER_DATE_STOP') ?? isoDate(1);
  const candidates = await fetchCandidateRows(supabase);
  const eventKeys = new Set(candidates.map(apiTennisEventKey).filter((item): item is string => Boolean(item)));

  const fixtures = normalizeArray(await fetchApiTennis('get_fixtures', { date_start: dateStart, date_stop: dateStop }));
  const fixtureByEventKey = new Map(
    fixtures
      .map((fixture) => [String(fixture.event_key), fixture] as const)
      .filter(([eventKey]) => eventKeys.has(eventKey)),
  );

  const results = candidates.map((row) => resolveRow(row, fixtureByEventKey));
  await upsertResults(supabase, results);

  const settled = results.filter((result) => result.status === 'won' || result.status === 'lost');
  const wins = settled.filter((result) => result.status === 'won').length;
  const profitUnits = results.reduce((sum, result) => sum + result.profit_units, 0);

  return {
    ok: true,
    source: 'api_tennis',
    strategy: 'score_hunter_candidate',
    dateStart,
    dateStop,
    candidates: candidates.length,
    eventKeys: eventKeys.size,
    fixtures: fixtureByEventKey.size,
    settled: settled.length,
    wins,
    hitRate: settled.length > 0 ? wins / settled.length : null,
    profitUnits,
    pending: results.filter((result) => result.status === 'pending').length,
    voided: results.filter((result) => result.status === 'void').length,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
    }

    const expectedSecret = Deno.env.get('SLIPIQ_REFRESH_SECRET');
    if (expectedSecret) {
      const suppliedSecret = req.headers.get('x-slipiq-refresh-secret');
      if (suppliedSecret !== expectedSecret) {
        return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
      }
    }

    const summary = await runResolver();
    return Response.json(summary, { headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
