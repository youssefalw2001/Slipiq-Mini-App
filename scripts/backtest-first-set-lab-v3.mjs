// SlipIQ First Set Lab Backtest V3
//
// Differences from V2:
//   - Two model modes: 'coupled' (v2 behavior, uses 1st-set winner market to
//     bias serve stats) and 'independent' (no cross-market signal at all).
//     Independent mode lets us measure how much of any apparent edge is real
//     tennis structure vs. cross-market price disagreement.
//   - Hard tiebreak block toggle (BACKTEST_BLOCK_TIEBREAK, default true).
//   - Doubles toggle (BACKTEST_INCLUDE_DOUBLES, default false).
//   - Tournament -> surface map + improved regex fallback.
//   - Tags every row with window_id and model_mode so walk-forward / consensus
//     scripts can split cleanly without filename juggling.
//   - Emits setfox_passed_default with the v3 default Strict Mode rule so the
//     live data-refresh function can be validated against the same logic.
//
// V3 still uses heuristic player stats. It does not solve the circularity by
// itself; it only exposes the circularity for measurement. The independent
// mode is the honest baseline.

import fs from 'node:fs';
import path from 'node:path';

const apiKey = process.env.API_TENNIS_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';

const config = {
  dateStart: process.env.BACKTEST_DATE_START,
  dateStop: process.env.BACKTEST_DATE_STOP,
  windowId: process.env.BACKTEST_WINDOW_ID ?? '',
  minProbability: Number(process.env.BACKTEST_MIN_PROBABILITY ?? 0.03),
  minEv: Number(process.env.BACKTEST_MIN_EV ?? 0),
  minEdge: Number(process.env.BACKTEST_MIN_EDGE ?? 0),
  chunkDays: Number(process.env.BACKTEST_CHUNK_DAYS ?? 3),
  modelMode: (process.env.BACKTEST_MODEL_MODE ?? 'coupled').toLowerCase(),
  blockTiebreak: process.env.BACKTEST_BLOCK_TIEBREAK !== '0',
  includeDoubles: process.env.BACKTEST_INCLUDE_DOUBLES === '1',
  outputDir: process.env.BACKTEST_OUTPUT_DIR ?? 'artifacts/backtests-v3',
};

if (!apiKey) {
  console.error('Missing API_TENNIS_KEY environment variable.');
  process.exit(1);
}

if (!['coupled', 'independent'].includes(config.modelMode)) {
  console.error(`BACKTEST_MODEL_MODE must be 'coupled' or 'independent', got '${config.modelMode}'.`);
  process.exit(1);
}

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isoDate = (offsetDays = 0) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const minDate = (a, b) => (new Date(`${a}T00:00:00Z`) <= new Date(`${b}T00:00:00Z`) ? a : b);
const isAfter = (a, b) => new Date(`${a}T00:00:00Z`) > new Date(`${b}T00:00:00Z`);

config.dateStart ??= isoDate(-30);
config.dateStop ??= isoDate(-1);
config.chunkDays = Number.isFinite(config.chunkDays) && config.chunkDays > 0 ? Math.floor(config.chunkDays) : 3;
config.windowId ||= `${config.dateStart}_to_${config.dateStop}_${config.modelMode}`;

function buildDateChunks(start, stop, sizeDays) {
  const chunks = [];
  let cursor = start;
  while (!isAfter(cursor, stop)) {
    const chunkStop = minDate(addDays(cursor, sizeDays - 1), stop);
    chunks.push({ date_start: cursor, date_stop: chunkStop });
    cursor = addDays(chunkStop, 1);
  }
  return chunks;
}

function calcHoldProb(fs1, w1s, w2s, bpSave, surface = 'hard') {
  const surfaceAdj = { clay: -0.035, grass: 0.055, hard: 0, indoor: 0.035 };
  const rawPointWin = fs1 * w1s + (1 - fs1) * w2s;
  const adjusted = rawPointWin * 0.85 + bpSave * 0.15;
  return clamp(adjusted + (surfaceAdj[surface] ?? 0), 0.45, 0.95);
}

function probWinGame(pointWinProbability) {
  const p = clamp(pointWinProbability, 0.001, 0.999);
  const q = 1 - p;
  const deuceWin = (p * p) / (p * p + q * q);
  return clamp(p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2 + 20 * p ** 3 * q ** 3 * deuceWin, 0.001, 0.999);
}

function tiebreakWinProbability(hold1, hold2, surface) {
  const surfaceBias = surface === 'grass' || surface === 'indoor' ? 0.03 : surface === 'clay' ? -0.02 : 0;
  return clamp(0.5 + (hold1 - hold2) * 0.65 + surfaceBias * Math.sign(hold1 - hold2 || 1), 0.05, 0.95);
}

function calcSetScoreDist(hold1, hold2, surface = 'hard') {
  const p1Hold = clamp(hold1, 0.001, 0.999);
  const p2Hold = clamp(hold2, 0.001, 0.999);
  const memo = new Map();

  const terminal = (g1, g2) => {
    if (g1 === 6 && g2 === 6) return null;
    if ((g1 >= 6 || g2 >= 6) && Math.abs(g1 - g2) >= 2) return `${g1}-${g2}`;
    return null;
  };

  const merge = (target, source, weight) => {
    for (const [score, probability] of Object.entries(source)) target[score] = (target[score] ?? 0) + probability * weight;
  };

  const walk = (g1, g2, server) => {
    const finished = terminal(g1, g2);
    if (finished) return { [finished]: 1 };
    if (g1 === 6 && g2 === 6) {
      const tbP1 = tiebreakWinProbability(p1Hold, p2Hold, surface);
      return { '7-6': tbP1, '6-7': 1 - tbP1 };
    }
    const key = `${g1}:${g2}:${server}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const p1WinsGame = server === 0 ? p1Hold : 1 - p2Hold;
    const nextServer = server === 0 ? 1 : 0;
    const out = {};
    merge(out, walk(g1 + 1, g2, nextServer), p1WinsGame);
    merge(out, walk(g1, g2 + 1, nextServer), 1 - p1WinsGame);
    memo.set(key, out);
    return out;
  };

  const dist = walk(0, 0, 0);
  const total = Object.values(dist).reduce((sum, probability) => sum + probability, 0);
  return Object.fromEntries(Object.entries(dist).map(([score, probability]) => [score, probability / total]).sort((a, b) => b[1] - a[1]));
}

function parseDecimalOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
  }
  return null;
}

function bestDecimalOdds(value) {
  const direct = parseDecimalOdds(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const odds = value.map(bestDecimalOdds).filter((item) => typeof item === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  if (value && typeof value === 'object') {
    const odds = Object.values(value).map(bestDecimalOdds).filter((item) => typeof item === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  return null;
}

function normalizeScore(score) {
  return String(score ?? '').trim().replace(':', '-');
}

function extractCorrectScoreOdds(matchOdds) {
  const market = matchOdds?.['Correct Score 1st Half'];
  if (!market || typeof market !== 'object') return {};
  const odds = {};
  for (const [score, rawValue] of Object.entries(market)) {
    const normalized = normalizeScore(score);
    if (!/^\d+-\d+$/.test(normalized)) continue;
    const decimalOdds = bestDecimalOdds(rawValue);
    if (decimalOdds) odds[normalized] = decimalOdds;
  }
  return odds;
}

function impliedFirstSetEdge(matchOdds) {
  const market = matchOdds?.['Home/Away (1st Set)'];
  if (!market || typeof market !== 'object') return 0;
  const entries = Object.entries(market);
  if (entries.length < 2) return 0;
  const homeEntry = entries.find(([label]) => /home|1|first/i.test(label)) ?? entries[0];
  const awayEntry = entries.find(([label]) => /away|2|second/i.test(label)) ?? entries[1];
  const homeOdds = bestDecimalOdds(homeEntry[1]);
  const awayOdds = bestDecimalOdds(awayEntry[1]);
  if (!homeOdds || !awayOdds) return 0;
  const homeImplied = 1 / homeOdds;
  const awayImplied = 1 / awayOdds;
  const total = homeImplied + awayImplied;
  return total > 0 ? homeImplied / total - 0.5 : 0;
}

const TOURNAMENT_SURFACE_HINTS = [
  { surface: 'grass', re: /wimbledon|halle|queen|stuttgart|eastbourne|nottingham|mallorca|hertogenbosch|bad homburg|birmingham|berlin|newport|grass/i },
  { surface: 'clay', re: /madrid|rome|monte carlo|barcelona|munich|estoril|geneva|bastad|gstaad|kitzb|hamburg|umag|marrakech|houston|cordoba|córdoba|buenos aires|rio open|santiago|roland garros|french open|palermo|lausanne|bogota|bogotá|ostrava .*clay|clay/i },
  { surface: 'indoor', re: /rotterdam|marseille|basel|vienna|stockholm|metz|antwerp|paris masters|bercy|sofia|st petersburg|linz|astana indoor|indoor|hard.*indoor/i },
];

function inferSurface(fixture) {
  const text = `${fixture.tournament_name ?? ''} ${fixture.tournament_round ?? ''} ${fixture.event_type_type ?? ''}`;
  for (const { surface, re } of TOURNAMENT_SURFACE_HINTS) if (re.test(text)) return surface;
  return 'hard';
}

function tournamentLevel(fixture) {
  const text = `${fixture.tournament_name ?? ''} ${fixture.tournament_round ?? ''}`.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}

function isDoubles(fixture) {
  return String(fixture.event_first_player ?? '').includes('/') || String(fixture.event_second_player ?? '').includes('/');
}

function scoreFamily(score) {
  if (score === '7-6' || score === '6-7') return 'tiebreak';
  const [a, b] = score.split('-').map(Number);
  const diff = Math.abs(a - b);
  if (diff >= 4) return 'blowout';
  if (diff === 3) return 'clear';
  if (diff === 2) return 'normal';
  return 'close';
}

function oddsBucket(odds) {
  if (odds < 5) return 'odds_1_5';
  if (odds < 8) return 'odds_5_8';
  if (odds < 12) return 'odds_8_12';
  if (odds < 18) return 'odds_12_18';
  if (odds < 30) return 'odds_18_30';
  return 'odds_30_plus';
}

function estimatedPlayerStats(side, firstSetEdge, surface, level) {
  // In 'independent' mode firstSetEdge is forced to 0 by the caller, so the
  // resulting stats are tournament-level + surface priors only. This is still
  // a heuristic, but it removes the cross-market loop that contaminates EV
  // when comparing to the correct-score market.
  const sign = side === 'p1' ? 1 : -1;
  const adjustment = clamp(firstSetEdge * sign, -0.07, 0.07);
  const levelStability = level === 'itf' ? -0.015 : level === 'challenger' ? -0.008 : level === 'slam' || level === 'tour_premium' ? 0.008 : 0;
  const surfaceServe = surface === 'grass' ? 0.025 : surface === 'indoor' ? 0.018 : surface === 'clay' ? -0.018 : 0;
  return {
    fs1: clamp(0.63 + adjustment * 0.35 + surfaceServe * 0.25, 0.52, 0.76),
    w1s: clamp(0.72 + adjustment + surfaceServe + levelStability, 0.58, 0.86),
    w2s: clamp(0.52 + adjustment * 0.75 + surfaceServe * 0.55 + levelStability, 0.42, 0.68),
    bpSave: clamp(0.60 + adjustment * 0.75 + levelStability, 0.45, 0.76),
  };
}

function looksLikeTennisSet(a, b) {
  return (a === 6 && b <= 7) || (b === 6 && a <= 7) || (a === 7 && b >= 5 && b <= 6) || (b === 7 && a >= 5 && a <= 6);
}

function parseFirstSetScore(fixture) {
  if (Array.isArray(fixture.scores)) {
    const firstSet = fixture.scores.find((score) => String(score?.score_set) === '1') ?? fixture.scores[0];
    const a = Number(firstSet?.score_first);
    const b = Number(firstSet?.score_second);
    if (Number.isFinite(a) && Number.isFinite(b) && looksLikeTennisSet(a, b)) return `${a}-${b}`;
  }
  return null;
}

async function fetchApiTennis(method, params = {}, attempt = 1) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    if (attempt < 3 && response.status >= 500) {
      console.warn(`${method} ${params.date_start ?? ''}-${params.date_stop ?? ''} HTTP ${response.status}; retrying attempt ${attempt + 1}/3`);
      await sleep(700 * attempt);
      return fetchApiTennis(method, params, attempt + 1);
    }
    throw new Error(`${method} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') {
    const body = JSON.stringify(payload).slice(0, 1000);
    const noData = /no\s*(event|match|odd|data)|not\s*found|empty/i.test(body);
    if (noData) return method === 'get_odds' ? {} : [];
    throw new Error(`${method} returned unsuccessful payload: ${body}`);
  }
  return payload.result;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((item) => item && typeof item === 'object');
}

async function fetchHistoricalData() {
  const chunks = buildDateChunks(config.dateStart, config.dateStop, config.chunkDays);
  const fixtures = [];
  const oddsResult = {};
  const chunkErrors = [];
  console.log(`Fetching ${chunks.length} chunks of ${config.chunkDays} day(s).`);

  for (const chunk of chunks) {
    const label = `${chunk.date_start} to ${chunk.date_stop}`;
    try {
      console.log(`Fetching fixtures: ${label}`);
      fixtures.push(...normalizeArray(await fetchApiTennis('get_fixtures', chunk)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chunkErrors.push({ method: 'get_fixtures', ...chunk, error: message });
      console.warn(`Skipping fixture chunk ${label}: ${message}`);
      continue;
    }

    try {
      console.log(`Fetching odds: ${label}`);
      const chunkOdds = await fetchApiTennis('get_odds', chunk);
      if (chunkOdds && typeof chunkOdds === 'object') Object.assign(oddsResult, chunkOdds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chunkErrors.push({ method: 'get_odds', ...chunk, error: message });
      console.warn(`Skipping odds chunk ${label}: ${message}`);
    }
    await sleep(250);
  }
  return { fixtures, oddsResult, chunkErrors };
}

function fixtureName(fixture) {
  return `${fixture.event_first_player ?? 'Player 1'} vs ${fixture.event_second_player ?? 'Player 2'}`;
}

function runModel(matchOdds, fixture) {
  const surface = inferSurface(fixture);
  const level = tournamentLevel(fixture);
  const rawFirstSetEdge = impliedFirstSetEdge(matchOdds);
  const firstSetEdge = config.modelMode === 'independent' ? 0 : rawFirstSetEdge;
  const p1 = estimatedPlayerStats('p1', firstSetEdge, surface, level);
  const p2 = estimatedPlayerStats('p2', firstSetEdge, surface, level);
  const p1PointStrength = calcHoldProb(p1.fs1, p1.w1s, p1.w2s, p1.bpSave, surface);
  const p2PointStrength = calcHoldProb(p2.fs1, p2.w1s, p2.w2s, p2.bpSave, surface);
  const hold1 = probWinGame(p1PointStrength);
  const hold2 = probWinGame(p2PointStrength);
  return { dist: calcSetScoreDist(hold1, hold2, surface), firstSetEdge, rawFirstSetEdge, hold1, hold2, surface, level };
}

// SetFox v3 default Strict Mode rule. Mirrors src/lib/setfoxStrategy.ts.
// Treat as research-grade until the walk-forward optimizer produces fresh
// proof; this constant is here so the backtest CSV carries a passed/failed
// column for downstream scanner-stats validation.
const SETFOX_DEFAULT = {
  block_tiebreak: true,
  block_doubles: true,
  allowed_score_families: new Set(['normal']),
  allowed_tournament_levels: new Set(['itf']),
  allowed_odds_buckets: new Set(['odds_12_18']),
  min_probability: 0.03,
  min_ev: 0,
  min_edge: 0,
  max_odds: 18,
};

function setfoxPasses(row) {
  if (SETFOX_DEFAULT.block_tiebreak && row.score_family === 'tiebreak') return false;
  if (SETFOX_DEFAULT.block_doubles && row.match_type === 'doubles') return false;
  if (!SETFOX_DEFAULT.allowed_score_families.has(row.score_family)) return false;
  if (!SETFOX_DEFAULT.allowed_tournament_levels.has(row.tournament_level)) return false;
  if (!SETFOX_DEFAULT.allowed_odds_buckets.has(row.odds_bucket)) return false;
  if (row.bookmaker_odds > SETFOX_DEFAULT.max_odds) return false;
  if (row.model_probability < SETFOX_DEFAULT.min_probability) return false;
  if (row.expected_value < SETFOX_DEFAULT.min_ev) return false;
  if (row.edge < SETFOX_DEFAULT.min_edge) return false;
  return true;
}

function scoreRowsForMatch({ fixture, eventKey, matchOdds }) {
  const actualScore = parseFirstSetScore(fixture);
  const bookmakerOdds = extractCorrectScoreOdds(matchOdds);
  if (!actualScore || Object.keys(bookmakerOdds).length === 0) return [];

  const doublesMatch = isDoubles(fixture);
  if (doublesMatch && !config.includeDoubles) return [];

  const model = runModel(matchOdds, fixture);
  const matchType = doublesMatch ? 'doubles' : 'singles';

  return Object.entries(bookmakerOdds).flatMap(([score, odds]) => {
    const family = scoreFamily(score);
    if (config.blockTiebreak && family === 'tiebreak') return [];

    const probability = model.dist[score] ?? 0.001;
    const impliedProbability = 1 / odds;
    const edge = probability - impliedProbability;
    const expectedValue = probability * odds - 1;
    const won = score === actualScore;
    const qualified = probability >= config.minProbability && expectedValue >= config.minEv && edge >= config.minEdge;

    const row = {
      window_id: config.windowId,
      model_mode: config.modelMode,
      event_key: eventKey,
      match: fixtureName(fixture),
      tournament: fixture.tournament_name ?? '',
      tournament_round: fixture.tournament_round ?? '',
      tournament_level: model.level,
      match_type: matchType,
      surface: model.surface,
      event_date: fixture.event_date ?? '',
      score,
      score_family: family,
      odds_bucket: oddsBucket(odds),
      actual_first_set_score: actualScore,
      model_probability: probability,
      fair_odds: 1 / probability,
      bookmaker_odds: odds,
      implied_probability: impliedProbability,
      edge,
      expected_value: expectedValue,
      won,
      qualified,
      profit_units: qualified ? (won ? odds - 1 : -1) : 0,
      first_set_edge: model.firstSetEdge,
      raw_first_set_edge: model.rawFirstSetEdge,
      hold1: model.hold1,
      hold2: model.hold2,
      setfox_passed_default: false,
    };
    row.setfox_passed_default = setfoxPasses(row);
    return [row];
  });
}

function evaluate(rows) {
  const bets = rows.length;
  const wins = rows.filter((row) => row.won).length;
  const profit = rows.reduce((sum, row) => sum + (row.won ? row.bookmaker_odds - 1 : -1), 0);
  return {
    bets,
    wins,
    profit,
    roi: bets ? profit / bets : 0,
    hit_rate: bets ? wins / bets : 0,
    average_odds: bets ? rows.reduce((sum, row) => sum + row.bookmaker_odds, 0) / bets : 0,
  };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] ?? 'unknown';
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return [...groups.entries()].map(([name, group]) => ({ key: name, ...evaluate(group) })).sort((a, b) => b.roi - a.roi);
}

function summarize(rows) {
  const matches = new Set(rows.map((row) => row.event_key));
  const qualified = rows.filter((row) => row.qualified);
  const setfoxPassed = rows.filter((row) => row.setfox_passed_default);
  const actualRows = rows.filter((row) => row.score === row.actual_first_set_score);
  const brier = actualRows.length ? actualRows.reduce((sum, row) => sum + (1 - row.model_probability) ** 2, 0) / actualRows.length : null;
  const logLoss = actualRows.length ? actualRows.reduce((sum, row) => sum - Math.log(clamp(row.model_probability, 0.0001, 0.9999)), 0) / actualRows.length : null;

  return {
    model_version: 'v3_walkforward_research',
    window_id: config.windowId,
    model_mode: config.modelMode,
    date_start: config.dateStart,
    date_stop: config.dateStop,
    filters: {
      min_probability: config.minProbability,
      min_ev: config.minEv,
      min_edge: config.minEdge,
      chunk_days: config.chunkDays,
      block_tiebreak: config.blockTiebreak,
      include_doubles: config.includeDoubles,
    },
    matches_tested: matches.size,
    market_rows_tested: rows.length,
    qualified_bets: qualified.length,
    qualified_metrics: evaluate(qualified),
    setfox_default_passed_bets: setfoxPassed.length,
    setfox_default_metrics: evaluate(setfoxPassed),
    brier_score_actual_outcome_probability: brier,
    log_loss_actual_outcome_probability: logLoss,
    surface_breakdown: groupBy(qualified, 'surface'),
    score_family_breakdown: groupBy(qualified, 'score_family'),
    odds_bucket_breakdown: groupBy(qualified, 'odds_bucket'),
    match_type_breakdown: groupBy(qualified, 'match_type'),
    tournament_level_breakdown: groupBy(qualified, 'tournament_level'),
  };
}

function writeOutputs(summary, rows) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const stamp = `${config.windowId}`.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const summaryPath = path.join(config.outputDir, `first-set-lab-v3-summary-${stamp}.json`);
  const rowsPath = path.join(config.outputDir, `first-set-lab-v3-rows-${stamp}.csv`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const columns = [
    'window_id', 'model_mode', 'event_key', 'match', 'tournament', 'tournament_round', 'tournament_level',
    'match_type', 'surface', 'event_date', 'score', 'score_family', 'odds_bucket', 'actual_first_set_score',
    'model_probability', 'fair_odds', 'bookmaker_odds', 'implied_probability', 'edge', 'expected_value',
    'won', 'qualified', 'profit_units', 'first_set_edge', 'raw_first_set_edge', 'hold1', 'hold2',
    'setfox_passed_default',
  ];
  const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','))].join('\n');
  fs.writeFileSync(rowsPath, csv);
  return { summaryPath, rowsPath };
}

async function main() {
  console.log('SlipIQ First Set Lab Backtest V3');
  console.log(`Window: ${config.windowId} (${config.dateStart} to ${config.dateStop})`);
  console.log(`Mode: ${config.modelMode} | block_tiebreak=${config.blockTiebreak} | include_doubles=${config.includeDoubles}`);

  const { fixtures, oddsResult, chunkErrors } = await fetchHistoricalData();
  const fixtureByKey = new Map(fixtures.map((fixture) => [String(fixture.event_key), fixture]));
  const rows = [];
  let matchesWithOdds = 0;
  let matchesWithResults = 0;

  for (const [eventKey, matchOdds] of Object.entries(oddsResult ?? {})) {
    const fixture = fixtureByKey.get(String(eventKey));
    if (!fixture || !matchOdds || typeof matchOdds !== 'object') continue;
    if (Object.keys(extractCorrectScoreOdds(matchOdds)).length > 0) matchesWithOdds += 1;
    if (parseFirstSetScore(fixture)) matchesWithResults += 1;
    rows.push(...scoreRowsForMatch({ fixture, eventKey, matchOdds }));
  }

  const summary = summarize(rows);
  summary.fixtures_returned = fixtures.length;
  summary.matches_with_correct_score_odds = matchesWithOdds;
  summary.matches_with_parseable_first_set_result = matchesWithResults;
  summary.chunk_errors = chunkErrors;
  summary.warning = rows.length === 0
    ? 'No rows were testable. Try chunk_days=1 and a shorter recent range.'
    : 'V3 adds model_mode tagging (coupled vs independent) and a window_id column. Independent mode is the honest baseline; coupled mode mixes correct-score market with first-set-winner market signal.';

  const output = writeOutputs(summary, rows);
  console.log('Backtest V3 summary:');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${output.summaryPath}`);
  console.log(`Wrote ${output.rowsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
