import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Surface = 'clay' | 'grass' | 'hard' | 'indoor';
type DataProvider = 'manual_seed' | 'external_normalized';

type PlayerStats = {
  name: string;
  fs1: number;
  w1s: number;
  w2s: number;
  bp_save: number;
};

type TennisModelMatch = {
  id: string;
  tournament: string;
  surface: Surface;
  starts_at: string;
  p1: PlayerStats;
  p2: PlayerStats;
  bookmaker_odds: Record<string, number>;
  bookmaker?: string;
  raw_payload?: Record<string, unknown>;
};

type NormalizedProviderPayload = {
  matches: TennisModelMatch[];
};

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-slipiq-refresh-secret',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const seedMatches: TennisModelMatch[] = [
  {
    id: 'rome-2026-hurkacz-hanfmann',
    tournament: 'Rome Masters 2026',
    surface: 'clay',
    starts_at: '2026-05-06T13:00:00Z',
    p1: { name: 'Hubert Hurkacz', fs1: 0.65, w1s: 0.82, w2s: 0.66, bp_save: 0.68 },
    p2: { name: 'Yannick Hanfmann', fs1: 0.62, w1s: 0.7, w2s: 0.54, bp_save: 0.61 },
    bookmaker_odds: { '6-4': 5.1, '6-3': 6.8, '7-5': 8.2, '7-6': 7.4, '4-6': 8.8 },
    bookmaker: 'SeedBook',
  },
  {
    id: 'rome-2026-munar-kopriva',
    tournament: 'Rome Masters 2026',
    surface: 'clay',
    starts_at: '2026-05-06T15:30:00Z',
    p1: { name: 'Jaume Munar', fs1: 0.69, w1s: 0.72, w2s: 0.55, bp_save: 0.62 },
    p2: { name: 'Vit Kopriva', fs1: 0.63, w1s: 0.69, w2s: 0.52, bp_save: 0.58 },
    bookmaker_odds: { '6-4': 5.6, '6-3': 7.1, '7-5': 8.4, '7-6': 7.8, '4-6': 7.6 },
    bookmaker: 'SeedBook',
  },
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeSurface(surface: string): Surface {
  const normalized = surface.toLowerCase();
  if (normalized === 'clay' || normalized === 'grass' || normalized === 'hard' || normalized === 'indoor') return normalized;
  return 'hard';
}

function isFiniteProbability(value: number) {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function validateMatch(match: TennisModelMatch) {
  const statValues = [match.p1.fs1, match.p1.w1s, match.p1.w2s, match.p1.bp_save, match.p2.fs1, match.p2.w1s, match.p2.w2s, match.p2.bp_save];
  if (!match.id || !match.p1?.name || !match.p2?.name) throw new Error('Provider match missing id or player names');
  if (!statValues.every(isFiniteProbability)) throw new Error(`Provider match ${match.id} has invalid player stats`);
  if (!match.bookmaker_odds || Object.keys(match.bookmaker_odds).length === 0) throw new Error(`Provider match ${match.id} has no first-set score odds`);
}

function calcHoldProb(fs1: number, w1s: number, w2s: number, bpSave: number, surface: Surface) {
  const surfaceAdj: Record<Surface, number> = { clay: -0.03, grass: 0.05, hard: 0, indoor: 0.03 };
  const rawPointWin = fs1 * w1s + (1 - fs1) * w2s;
  const adjusted = rawPointWin * 0.85 + bpSave * 0.15;
  return clamp(adjusted + surfaceAdj[surface], 0.45, 0.95);
}

function probWinGame(pointWinProbability: number) {
  const p = clamp(pointWinProbability, 0.001, 0.999);
  const q = 1 - p;
  const deuceWin = (p * p) / (p * p + q * q);
  return clamp(p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2 + 20 * p ** 3 * q ** 3 * deuceWin, 0.001, 0.999);
}

function tiebreakWinProbability(hold1: number, hold2: number) {
  return clamp(0.5 + (hold1 - hold2) * 0.65, 0.05, 0.95);
}

function calcSetScoreDist(hold1: number, hold2: number) {
  const p1Hold = clamp(hold1, 0.001, 0.999);
  const p2Hold = clamp(hold2, 0.001, 0.999);
  const memo = new Map<string, Record<string, number>>();

  const terminal = (g1: number, g2: number) => {
    if (g1 === 6 && g2 === 6) return null;
    if ((g1 >= 6 || g2 >= 6) && Math.abs(g1 - g2) >= 2) return `${g1}-${g2}`;
    return null;
  };

  const merge = (target: Record<string, number>, source: Record<string, number>, weight: number) => {
    for (const [score, probability] of Object.entries(source)) {
      target[score] = (target[score] ?? 0) + probability * weight;
    }
  };

  const walk = (g1: number, g2: number, server: 0 | 1): Record<string, number> => {
    const finished = terminal(g1, g2);
    if (finished) return { [finished]: 1 };

    if (g1 === 6 && g2 === 6) {
      const tbP1 = tiebreakWinProbability(p1Hold, p2Hold);
      return { '7-6': tbP1, '6-7': 1 - tbP1 };
    }

    const key = `${g1}:${g2}:${server}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const p1WinsGame = server === 0 ? p1Hold : 1 - p2Hold;
    const nextServer = server === 0 ? 1 : 0;
    const out: Record<string, number> = {};
    merge(out, walk(g1 + 1, g2, nextServer), p1WinsGame);
    merge(out, walk(g1, g2 + 1, nextServer), 1 - p1WinsGame);
    memo.set(key, out);
    return out;
  };

  const dist = walk(0, 0, 0);
  const total = Object.values(dist).reduce((sum, probability) => sum + probability, 0);
  return Object.fromEntries(Object.entries(dist).map(([score, probability]) => [score, probability / total]));
}

function classifyTier(probability: number, bookmakerOdds: number | null) {
  const ev = bookmakerOdds ? probability * bookmakerOdds - 1 : 0;
  if (ev > 0.1 && bookmakerOdds && bookmakerOdds >= 7) return 'A';
  if (ev > 0.02) return 'B';
  return 'C';
}

async function fetchExternalNormalizedMatches(): Promise<TennisModelMatch[]> {
  const providerUrl = Deno.env.get('SLIPIQ_EXTERNAL_PROVIDER_URL');
  const providerKey = Deno.env.get('SLIPIQ_EXTERNAL_PROVIDER_KEY');

  if (!providerUrl) throw new Error('SLIPIQ_EXTERNAL_PROVIDER_URL is required for external_normalized provider');

  const response = await fetch(providerUrl, {
    headers: {
      accept: 'application/json',
      ...(providerKey ? { authorization: `Bearer ${providerKey}` } : {}),
    },
  });

  if (!response.ok) throw new Error(`External provider failed with HTTP ${response.status}`);

  const payload = (await response.json()) as NormalizedProviderPayload;
  const matches = (payload.matches ?? []).map((match) => ({
    ...match,
    surface: normalizeSurface(match.surface),
  }));

  matches.forEach(validateMatch);
  return matches;
}

async function getProviderMatches(provider: DataProvider) {
  if (provider === 'external_normalized') return fetchExternalNormalizedMatches();
  return seedMatches;
}

async function clearCurrentTennisBoard(supabase: ReturnType<typeof createClient>) {
  await supabase.from('opportunities').delete().eq('sport', 'tennis');
}

async function runRefresh(supabase: ReturnType<typeof createClient>, provider: DataProvider) {
  const matches = await getProviderMatches(provider);
  const { data: modelRun, error: runError } = await supabase
    .from('model_runs')
    .insert({ provider, status: 'started', metadata: { source: provider, matchCount: matches.length } })
    .select('id')
    .single();

  if (runError) throw runError;

  const modelRunId = modelRun.id as string;
  let opportunityCount = 0;

  try {
    await clearCurrentTennisBoard(supabase);

    for (const match of matches) {
      await supabase.from('matches').upsert({
        id: match.id,
        sport: 'tennis',
        tournament: match.tournament,
        surface: match.surface,
        starts_at: match.starts_at,
        status: 'scheduled',
        player_one: match.p1.name,
        player_two: match.p2.name,
        raw_payload: { ...match, provider },
      });

      await supabase.from('player_stat_snapshots').insert([
        {
          match_id: match.id,
          provider,
          player_name: match.p1.name,
          surface: match.surface,
          fs1: match.p1.fs1,
          w1s: match.p1.w1s,
          w2s: match.p1.w2s,
          bp_save: match.p1.bp_save,
          raw_payload: match.p1,
        },
        {
          match_id: match.id,
          provider,
          player_name: match.p2.name,
          surface: match.surface,
          fs1: match.p2.fs1,
          w1s: match.p2.w1s,
          w2s: match.p2.w2s,
          bp_save: match.p2.bp_save,
          raw_payload: match.p2,
        },
      ]);

      const p1PointStrength = calcHoldProb(match.p1.fs1, match.p1.w1s, match.p1.w2s, match.p1.bp_save, match.surface);
      const p2PointStrength = calcHoldProb(match.p2.fs1, match.p2.w1s, match.p2.w2s, match.p2.bp_save, match.surface);
      const hold1 = probWinGame(p1PointStrength);
      const hold2 = probWinGame(p2PointStrength);
      const distribution = calcSetScoreDist(hold1, hold2);
      const topOutcomes = Object.entries(distribution).sort((a, b) => b[1] - a[1]).slice(0, 8);

      for (const [score, probability] of topOutcomes) {
        const bookmakerOdds = match.bookmaker_odds[score] ?? null;
        const fairOdds = 1 / probability;
        const edge = bookmakerOdds ? probability - 1 / bookmakerOdds : null;
        const expectedValue = bookmakerOdds ? probability * bookmakerOdds - 1 : null;

        if (bookmakerOdds) {
          await supabase.from('odds_snapshots').insert({
            match_id: match.id,
            provider,
            bookmaker: match.bookmaker ?? 'UnknownBook',
            market_key: 'first_set_correct_score',
            outcome_label: score,
            decimal_odds: bookmakerOdds,
            raw_payload: { score, bookmakerOdds, provider },
          });
        }

        await supabase.from('opportunities').insert({
          model_run_id: modelRunId,
          match_id: match.id,
          sport: 'tennis',
          label: `${match.p1.name} vs ${match.p2.name} first set ${score}`,
          market_key: 'first_set_correct_score',
          model_probability: probability,
          fair_odds: fairOdds,
          bookmaker_odds: bookmakerOdds,
          edge,
          expected_value: expectedValue,
          risk_label: probability >= 0.15 ? 'anchor' : probability >= 0.08 ? 'mid' : probability >= 0.03 ? 'push' : 'lotto',
          tier: classifyTier(probability, bookmakerOdds),
          explanation: 'First Set Lab model from serve strength, hold probability, surface context, and market price comparison.',
          raw_payload: { score, hold1, hold2, p1PointStrength, p2PointStrength, provider },
        });
        opportunityCount += 1;
      }
    }

    await supabase
      .from('model_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), metadata: { opportunityCount, provider, matchCount: matches.length } })
      .eq('id', modelRunId);

    return { modelRunId, opportunityCount, provider, matchCount: matches.length };
  } catch (error) {
    await supabase
      .from('model_runs')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
      .eq('id', modelRunId);
    throw error;
  }
}

async function getLatestOpportunities(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*, matches(*)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return data ?? [];
}

function getDataProvider(): DataProvider {
  const provider = Deno.env.get('SLIPIQ_DATA_PROVIDER') ?? 'manual_seed';
  if (provider === 'external_normalized') return provider;
  return 'manual_seed';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, { status: 500, headers: corsHeaders });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    if (req.method === 'GET') {
      const opportunities = await getLatestOpportunities(supabase);
      return Response.json({ opportunities }, { headers: corsHeaders });
    }

    if (req.method === 'POST') {
      const refreshSecret = Deno.env.get('SLIPIQ_REFRESH_SECRET');
      if (refreshSecret && req.headers.get('x-slipiq-refresh-secret') !== refreshSecret) {
        return Response.json({ error: 'Unauthorized refresh request' }, { status: 401, headers: corsHeaders });
      }

      const result = await runRefresh(supabase, getDataProvider());
      return Response.json({ ok: true, ...result }, { headers: corsHeaders });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
