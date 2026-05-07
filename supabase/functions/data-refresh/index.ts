import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Surface = 'clay' | 'grass' | 'hard' | 'indoor';
type DataProvider = 'manual_seed' | 'external_normalized' | 'api_tennis';

type TournamentLevel = 'slam' | 'tour_premium' | 'tour_other' | 'challenger' | 'itf';
type ScoreFamily = 'tiebreak' | 'blowout' | 'clear' | 'normal' | 'close';
type OddsBucket = 'odds_1_5' | 'odds_5_8' | 'odds_8_12' | 'odds_12_18' | 'odds_18_30' | 'odds_30_plus';
type MatchType = 'singles' | 'doubles';
type SetFoxRejection =
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

// Mirrors src/lib/setfoxStrategy.ts. Keep in sync. Both production paths use
// this rule so the live badge always matches the row written to
// live_setfox_signals.
const SETFOX_RULE = {
  version: 'setfox.v3.research.itf-normal-12to18',
  blockTiebreak: true,
  blockDoubles: true,
  allowedScoreFamilies: new Set<ScoreFamily>(['normal']),
  allowedTournamentLevels: new Set<TournamentLevel>(['itf']),
  allowedOddsBuckets: new Set<OddsBucket>(['odds_12_18']),
  minProbability: 0.03,
  minEv: 0,
  minEdge: 0,
  maxOdds: 18,
};

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
  tournament_level?: TournamentLevel;
  match_type?: MatchType;
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

function classifyScoreFamily(score: string): ScoreFamily {
  if (score === '7-6' || score === '6-7') return 'tiebreak';
  const [a, b] = score.split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'close';
  const diff = Math.abs(a - b);
  if (diff >= 4) return 'blowout';
  if (diff === 3) return 'clear';
  if (diff === 2) return 'normal';
  return 'close';
}

function classifyOddsBucket(odds: number): OddsBucket {
  if (odds < 5) return 'odds_1_5';
  if (odds < 8) return 'odds_5_8';
  if (odds < 12) return 'odds_8_12';
  if (odds < 18) return 'odds_12_18';
  if (odds < 30) return 'odds_18_30';
  return 'odds_30_plus';
}

function classifyTournamentLevel(name: string): TournamentLevel {
  const text = name.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}

function classifyMatchType(p1Name: string, p2Name: string): MatchType {
  return p1Name.includes('/') || p2Name.includes('/') ? 'doubles' : 'singles';
}

interface SetFoxEvalInput {
  score: string;
  modelProbability: number;
  bookmakerOdds: number | null;
  edge: number | null;
  expectedValue: number | null;
  scoreFamily: ScoreFamily;
  oddsBucket: OddsBucket;
  tournamentLevel: TournamentLevel;
  matchType: MatchType;
}

function evaluateSetFox(input: SetFoxEvalInput) {
  const rejections: SetFoxRejection[] = [];
  if (input.bookmakerOdds === null || !Number.isFinite(input.bookmakerOdds) || input.bookmakerOdds <= 1) rejections.push('no_market_odds');
  if (SETFOX_RULE.blockTiebreak && input.scoreFamily === 'tiebreak') rejections.push('tiebreak_blocked');
  if (SETFOX_RULE.blockDoubles && input.matchType === 'doubles') rejections.push('doubles_blocked');
  if (!SETFOX_RULE.allowedScoreFamilies.has(input.scoreFamily)) rejections.push('score_family_blocked');
  if (!SETFOX_RULE.allowedTournamentLevels.has(input.tournamentLevel)) rejections.push('tournament_level_blocked');
  if (!SETFOX_RULE.allowedOddsBuckets.has(input.oddsBucket)) rejections.push('odds_bucket_blocked');
  if (input.bookmakerOdds !== null && input.bookmakerOdds > SETFOX_RULE.maxOdds) rejections.push('odds_above_cap');
  if (input.modelProbability < SETFOX_RULE.minProbability) rejections.push('probability_below_min');
  if ((input.expectedValue ?? -Infinity) < SETFOX_RULE.minEv) rejections.push('ev_below_min');
  if ((input.edge ?? -Infinity) < SETFOX_RULE.minEdge) rejections.push('edge_below_min');
  return { passed: rejections.length === 0, rejections, ruleVersion: SETFOX_RULE.version };
}

function parseDecimalOdds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
  }
  return null;
}

function bestDecimalOdds(value: unknown): number | null {
  const direct = parseDecimalOdds(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    const odds = value.map(bestDecimalOdds).filter((item): item is number => typeof item === 'number');
    return odds.length ? Math.max(...odds) : null;
  }

  if (value && typeof value === 'object') {
    const odds = Object.values(value).map(bestDecimalOdds).filter((item): item is number => typeof item === 'number');
    return odds.length ? Math.max(...odds) : null;
  }

  return null;
}

function normalizeScore(score: string) {
  return score.trim().replace(':', '-');
}

function getText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function apiTennisTimestamp(fixture: Record<string, unknown>) {
  const date = getText(fixture.event_date, isoDate(0));
  const time = getText(fixture.event_time, '12:00');
  return `${date}T${time.length === 5 ? `${time}:00` : time}Z`;
}

function estimatedPlayerStats(name: string, side: 'p1' | 'p2', firstSetEdge = 0): PlayerStats {
  const sign = side === 'p1' ? 1 : -1;
  const adjustment = clamp(firstSetEdge * sign, -0.06, 0.06);
  return {
    name,
    fs1: clamp(0.63 + adjustment * 0.35, 0.52, 0.76),
    w1s: clamp(0.72 + adjustment, 0.58, 0.86),
    w2s: clamp(0.52 + adjustment * 0.75, 0.42, 0.68),
    bp_save: clamp(0.60 + adjustment * 0.75, 0.45, 0.76),
  };
}

function impliedFirstSetEdge(matchOdds: Record<string, unknown>) {
  const market = matchOdds['Home/Away (1st Set)'];
  if (!market || typeof market !== 'object') return 0;
  const entries = Object.entries(market as Record<string, unknown>);
  if (entries.length < 2) return 0;

  const homeEntry = entries.find(([label]) => /home|1|first/i.test(label)) ?? entries[0];
  const awayEntry = entries.find(([label]) => /away|2|second/i.test(label)) ?? entries[1];
  const homeOdds = bestDecimalOdds(homeEntry[1]);
  const awayOdds = bestDecimalOdds(awayEntry[1]);
  if (!homeOdds || !awayOdds) return 0;

  const homeImplied = 1 / homeOdds;
  const awayImplied = 1 / awayOdds;
  const total = homeImplied + awayImplied;
  if (total <= 0) return 0;
  return homeImplied / total - 0.5;
}

function extractCorrectScoreOdds(matchOdds: Record<string, unknown>) {
  const market = matchOdds['Correct Score 1st Half'];
  if (!market || typeof market !== 'object') return {};

  const odds: Record<string, number> = {};
  for (const [score, rawValue] of Object.entries(market as Record<string, unknown>)) {
    const normalizedScore = normalizeScore(score);
    if (!/^\d+-\d+$/.test(normalizedScore)) continue;
    const decimalOdds = bestDecimalOdds(rawValue);
    if (decimalOdds) odds[normalizedScore] = decimalOdds;
  }

  return odds;
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

async function fetchApiTennis(method: string, params: Record<string, string>) {
  const apiKey = Deno.env.get('API_TENNIS_KEY');
  if (!apiKey) throw new Error('API_TENNIS_KEY is required for api_tennis provider');

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

async function fetchApiTennisMatches(): Promise<TennisModelMatch[]> {
  const dateStart = Deno.env.get('API_TENNIS_DATE_START') ?? isoDate(0);
  const dateStop = Deno.env.get('API_TENNIS_DATE_STOP') ?? isoDate(2);
  const fixtures = normalizeArray(await fetchApiTennis('get_fixtures', { date_start: dateStart, date_stop: dateStop }));
  const oddsResult = await fetchApiTennis('get_odds', { date_start: dateStart, date_stop: dateStop });
  const fixtureByKey = new Map(fixtures.map((fixture) => [String(fixture.event_key), fixture]));
  const matches: TennisModelMatch[] = [];

  for (const [eventKey, rawMatchOdds] of Object.entries(oddsResult as Record<string, unknown>)) {
    if (!rawMatchOdds || typeof rawMatchOdds !== 'object') continue;
    const matchOdds = rawMatchOdds as Record<string, unknown>;
    const bookmakerOdds = extractCorrectScoreOdds(matchOdds);
    if (Object.keys(bookmakerOdds).length === 0) continue;

    const fixture = fixtureByKey.get(String(eventKey)) ?? {};
    const p1Name = getText(fixture.event_first_player, getText((matchOdds as Record<string, unknown>).event_first_player, 'Player 1'));
    const p2Name = getText(fixture.event_second_player, getText((matchOdds as Record<string, unknown>).event_second_player, 'Player 2'));
    if (p1Name === 'Player 1' || p2Name === 'Player 2') continue;

    const firstSetEdge = impliedFirstSetEdge(matchOdds);
    const tournamentName = getText(fixture.tournament_name, 'Tennis');
    const tournamentLevel = classifyTournamentLevel(tournamentName);
    const matchType = classifyMatchType(p1Name, p2Name);
    const match: TennisModelMatch = {
      id: `api-tennis-${eventKey}`,
      tournament: tournamentName,
      surface: 'hard',
      starts_at: apiTennisTimestamp(fixture),
      p1: estimatedPlayerStats(p1Name, 'p1', firstSetEdge),
      p2: estimatedPlayerStats(p2Name, 'p2', firstSetEdge),
      bookmaker_odds: bookmakerOdds,
      bookmaker: 'API-Tennis',
      tournament_level: tournamentLevel,
      match_type: matchType,
      raw_payload: {
        provider: 'api_tennis',
        event_key: eventKey,
        fixture,
        markets: matchOdds,
        tournament_level: tournamentLevel,
        match_type: matchType,
        date_start: dateStart,
        date_stop: dateStop,
        stat_source: 'estimated_from_market_defaults_v1',
      },
    };
    validateMatch(match);
    matches.push(match);
  }

  return matches.slice(0, 20);
}

async function getProviderMatches(provider: DataProvider) {
  if (provider === 'external_normalized') return fetchExternalNormalizedMatches();
  if (provider === 'api_tennis') return fetchApiTennisMatches();
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
  let setfoxPassedCount = 0;
  const scannerStats = {
    total_scanned: 0,
    passed: 0,
    rejected: 0,
    tiebreak_blocked: 0,
    rejections_by_reason: {
      no_market_odds: 0,
      tiebreak_blocked: 0,
      doubles_blocked: 0,
      score_family_blocked: 0,
      tournament_level_blocked: 0,
      odds_bucket_blocked: 0,
      odds_above_cap: 0,
      probability_below_min: 0,
      ev_below_min: 0,
      edge_below_min: 0,
    } as Record<SetFoxRejection, number>,
  };

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

      const tournamentLevel: TournamentLevel = match.tournament_level ?? classifyTournamentLevel(match.tournament);
      const matchType: MatchType = match.match_type ?? classifyMatchType(match.p1.name, match.p2.name);

      for (const [score, probability] of topOutcomes) {
        const bookmakerOdds = match.bookmaker_odds[score] ?? null;
        const fairOdds = 1 / probability;
        const edge = bookmakerOdds ? probability - 1 / bookmakerOdds : null;
        const expectedValue = bookmakerOdds ? probability * bookmakerOdds - 1 : null;
        const scoreFamily = classifyScoreFamily(score);
        const oddsBucket = bookmakerOdds ? classifyOddsBucket(bookmakerOdds) : 'odds_30_plus';
        const setfox = evaluateSetFox({
          score,
          modelProbability: probability,
          bookmakerOdds,
          edge,
          expectedValue,
          scoreFamily,
          oddsBucket,
          tournamentLevel,
          matchType,
        });

        scannerStats.total_scanned += 1;
        if (setfox.passed) {
          scannerStats.passed += 1;
        } else {
          scannerStats.rejected += 1;
          for (const reason of setfox.rejections) {
            scannerStats.rejections_by_reason[reason] += 1;
            if (reason === 'tiebreak_blocked') scannerStats.tiebreak_blocked += 1;
          }
        }

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

        const { data: opportunity, error: opportunityError } = await supabase.from('opportunities').insert({
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
          explanation: provider === 'api_tennis'
            ? 'First Set Lab model from estimated serve strength, market-implied first-set edge, and API-Tennis first-set correct-score odds.'
            : 'First Set Lab model from serve strength, hold probability, surface context, and market price comparison.',
          raw_payload: {
            score,
            hold1,
            hold2,
            p1PointStrength,
            p2PointStrength,
            provider,
            score_family: scoreFamily,
            odds_bucket: oddsBucket,
            tournament_level: tournamentLevel,
            match_type: matchType,
            setfox: { passed: setfox.passed, rejections: setfox.rejections, rule_version: setfox.ruleVersion },
            sourceMatch: match.raw_payload ?? null,
          },
        }).select('id').single();
        if (opportunityError) throw opportunityError;
        opportunityCount += 1;

        if (setfox.passed) {
          setfoxPassedCount += 1;
          await supabase.from('live_setfox_signals').insert({
            model_run_id: modelRunId,
            match_id: match.id,
            opportunity_id: opportunity?.id ?? null,
            rule_version: setfox.ruleVersion,
            passed: true,
            rejections: [],
            score,
            score_family: scoreFamily,
            odds_bucket: oddsBucket,
            tournament_level: tournamentLevel,
            match_type: matchType,
            surface: match.surface,
            model_probability: probability,
            fair_odds: fairOdds,
            signal_odds: bookmakerOdds,
            opening_odds: bookmakerOdds,
            edge,
            expected_value: expectedValue,
            raw_payload: {
              hold1,
              hold2,
              p1PointStrength,
              p2PointStrength,
              tournament: match.tournament,
              p1: match.p1.name,
              p2: match.p2.name,
            },
          });
        }
      }
    }

    await supabase.from('setfox_scanner_runs').insert({
      model_run_id: modelRunId,
      rule_version: SETFOX_RULE.version,
      total_scanned: scannerStats.total_scanned,
      passed: scannerStats.passed,
      rejected: scannerStats.rejected,
      tiebreak_blocked: scannerStats.tiebreak_blocked,
      rejections_by_reason: scannerStats.rejections_by_reason,
    });

    await supabase
      .from('model_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        metadata: {
          opportunityCount,
          provider,
          matchCount: matches.length,
          setfox_rule_version: SETFOX_RULE.version,
          setfox_passed: setfoxPassedCount,
          setfox_total_scanned: scannerStats.total_scanned,
        },
      })
      .eq('id', modelRunId);

    return { modelRunId, opportunityCount, setfoxPassedCount, scannerStats, provider, matchCount: matches.length };
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

async function getLatestScannerRun(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('setfox_scanner_runs')
    .select('*')
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

function getDataProvider(): DataProvider {
  const provider = Deno.env.get('SLIPIQ_DATA_PROVIDER') ?? 'manual_seed';
  if (provider === 'external_normalized' || provider === 'api_tennis') return provider;
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
      const [opportunities, scannerRun] = await Promise.all([
        getLatestOpportunities(supabase),
        getLatestScannerRun(supabase),
      ]);
      return Response.json({ opportunities, scanner: scannerRun }, { headers: corsHeaders });
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
