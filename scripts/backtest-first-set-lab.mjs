import fs from 'node:fs';
import path from 'node:path';

const apiKey = process.env.API_TENNIS_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';

const config = {
  dateStart: process.env.BACKTEST_DATE_START,
  dateStop: process.env.BACKTEST_DATE_STOP,
  minProbability: Number(process.env.BACKTEST_MIN_PROBABILITY ?? 0.03),
  minEv: Number(process.env.BACKTEST_MIN_EV ?? 0),
  minEdge: Number(process.env.BACKTEST_MIN_EDGE ?? 0),
  chunkDays: Number(process.env.BACKTEST_CHUNK_DAYS ?? 3),
  outputDir: process.env.BACKTEST_OUTPUT_DIR ?? 'artifacts/backtests',
};

if (!apiKey) {
  console.error('Missing API_TENNIS_KEY environment variable.');
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
  const surfaceAdj = { clay: -0.03, grass: 0.05, hard: 0, indoor: 0.03 };
  const rawPointWin = fs1 * w1s + (1 - fs1) * w2s;
  const adjusted = rawPointWin * 0.85 + bpSave * 0.15;
  return clamp(adjusted + (surfaceAdj[surface] ?? 0), 0.45, 0.95);
}

function probWinGame(pointWinProbability) {
  const p = clamp(pointWinProbability, 0.001, 0.999);
  const q = 1 - p;
  const deuceWin = (p * p) / (p * p + q * q);
  const winBeforeDeuce = p ** 4 + 4 * p ** 4 * q + 10 * p ** 4 * q ** 2;
  const reachDeuceAndWin = 20 * p ** 3 * q ** 3 * deuceWin;
  return clamp(winBeforeDeuce + reachDeuceAndWin, 0.001, 0.999);
}

function tiebreakWinProbability(hold1, hold2) {
  return clamp(0.5 + (hold1 - hold2) * 0.65, 0.05, 0.95);
}

function calcSetScoreDist(hold1, hold2) {
  const p1Hold = clamp(hold1, 0.001, 0.999);
  const p2Hold = clamp(hold2, 0.001, 0.999);
  const memo = new Map();

  const terminal = (g1, g2) => {
    if (g1 === 6 && g2 === 6) return null;
    if ((g1 >= 6 || g2 >= 6) && Math.abs(g1 - g2) >= 2) return `${g1}-${g2}`;
    return null;
  };

  const merge = (target, source, weight) => {
    for (const [score, probability] of Object.entries(source)) {
      target[score] = (target[score] ?? 0) + probability * weight;
    }
  };

  const walk = (g1, g2, server) => {
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

function estimatedPlayerStats(side, firstSetEdge = 0) {
  const sign = side === 'p1' ? 1 : -1;
  const adjustment = clamp(firstSetEdge * sign, -0.06, 0.06);
  return {
    fs1: clamp(0.63 + adjustment * 0.35, 0.52, 0.76),
    w1s: clamp(0.72 + adjustment, 0.58, 0.86),
    w2s: clamp(0.52 + adjustment * 0.75, 0.42, 0.68),
    bpSave: clamp(0.60 + adjustment * 0.75, 0.45, 0.76),
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

  const candidateFields = [
    fixture.event_first_set_result,
    fixture.event_first_set,
    fixture.event_1st_set,
    fixture.event_first_set_score,
    fixture.event_result,
    fixture.event_score,
  ].filter(Boolean).map(String);

  for (const field of candidateFields) {
    const normalized = field.replace(/[()\[\]]/g, ' ').replace(/:/g, '-');
    const matches = [...normalized.matchAll(/(\d{1,2})\s*-\s*(\d{1,2})/g)];
    for (const match of matches) {
      const a = Number(match[1]);
      const b = Number(match[2]);
      if (looksLikeTennisSet(a, b)) return `${a}-${b}`;
    }
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
      const chunkFixtures = normalizeArray(await fetchApiTennis('get_fixtures', chunk));
      fixtures.push(...chunkFixtures);
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

function runModel(matchOdds) {
  const firstSetEdge = impliedFirstSetEdge(matchOdds);
  const p1 = estimatedPlayerStats('p1', firstSetEdge);
  const p2 = estimatedPlayerStats('p2', firstSetEdge);
  const p1PointStrength = calcHoldProb(p1.fs1, p1.w1s, p1.w2s, p1.bpSave, 'hard');
  const p2PointStrength = calcHoldProb(p2.fs1, p2.w1s, p2.w2s, p2.bpSave, 'hard');
  const hold1 = probWinGame(p1PointStrength);
  const hold2 = probWinGame(p2PointStrength);
  return { dist: calcSetScoreDist(hold1, hold2), firstSetEdge, hold1, hold2 };
}

function scoreRowsForMatch({ fixture, eventKey, matchOdds }) {
  const actualScore = parseFirstSetScore(fixture);
  const bookmakerOdds = extractCorrectScoreOdds(matchOdds);
  if (!actualScore || Object.keys(bookmakerOdds).length === 0) return [];

  const model = runModel(matchOdds);
  return Object.entries(bookmakerOdds).map(([score, odds]) => {
    const probability = model.dist[score] ?? 0.001;
    const impliedProbability = 1 / odds;
    const edge = probability - impliedProbability;
    const expectedValue = probability * odds - 1;
    const won = score === actualScore;
    const qualified = probability >= config.minProbability && expectedValue >= config.minEv && edge >= config.minEdge;

    return {
      event_key: eventKey,
      match: fixtureName(fixture),
      tournament: fixture.tournament_name ?? '',
      event_date: fixture.event_date ?? '',
      score,
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
      hold1: model.hold1,
      hold2: model.hold2,
    };
  });
}

function summarize(rows) {
  const matches = new Set(rows.map((row) => row.event_key));
  const qualified = rows.filter((row) => row.qualified);
  const wins = qualified.filter((row) => row.won);
  const profit = qualified.reduce((sum, row) => sum + row.profit_units, 0);
  const roi = qualified.length ? profit / qualified.length : 0;
  const averageOdds = qualified.length ? qualified.reduce((sum, row) => sum + row.bookmaker_odds, 0) / qualified.length : 0;
  const hitRate = qualified.length ? wins.length / qualified.length : 0;

  const actualRows = rows.filter((row) => row.score === row.actual_first_set_score);
  const brier = actualRows.length
    ? actualRows.reduce((sum, row) => sum + (1 - row.model_probability) ** 2, 0) / actualRows.length
    : null;
  const logLoss = actualRows.length
    ? actualRows.reduce((sum, row) => sum - Math.log(clamp(row.model_probability, 0.0001, 0.9999)), 0) / actualRows.length
    : null;

  const byScore = new Map();
  for (const row of qualified) {
    const bucket = byScore.get(row.score) ?? { score: row.score, bets: 0, wins: 0, profit: 0 };
    bucket.bets += 1;
    bucket.wins += row.won ? 1 : 0;
    bucket.profit += row.profit_units;
    byScore.set(row.score, bucket);
  }

  return {
    date_start: config.dateStart,
    date_stop: config.dateStop,
    filters: {
      min_probability: config.minProbability,
      min_ev: config.minEv,
      min_edge: config.minEdge,
      chunk_days: config.chunkDays,
    },
    matches_tested: matches.size,
    market_rows_tested: rows.length,
    qualified_bets: qualified.length,
    wins: wins.length,
    hit_rate: hitRate,
    total_profit_units: profit,
    roi_per_bet: roi,
    average_odds: averageOdds,
    brier_score_actual_outcome_probability: brier,
    log_loss_actual_outcome_probability: logLoss,
    best_scores: [...byScore.values()]
      .map((item) => ({ ...item, roi: item.bets ? item.profit / item.bets : 0, hit_rate: item.bets ? item.wins / item.bets : 0 }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10),
  };
}

function writeOutputs(summary, rows) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const stamp = `${config.dateStart}_to_${config.dateStop}`;
  const summaryPath = path.join(config.outputDir, `first-set-lab-summary-${stamp}.json`);
  const rowsPath = path.join(config.outputDir, `first-set-lab-rows-${stamp}.csv`);

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const columns = [
    'event_key',
    'match',
    'tournament',
    'event_date',
    'score',
    'actual_first_set_score',
    'model_probability',
    'fair_odds',
    'bookmaker_odds',
    'implied_probability',
    'edge',
    'expected_value',
    'won',
    'qualified',
    'profit_units',
    'first_set_edge',
    'hold1',
    'hold2',
  ];

  const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','))].join('\n');
  fs.writeFileSync(rowsPath, csv);

  return { summaryPath, rowsPath };
}

async function main() {
  console.log('SlipIQ First Set Lab Backtest v1');
  console.log(`Range: ${config.dateStart} to ${config.dateStop}`);
  console.log(`Filters: probability >= ${config.minProbability}, EV >= ${config.minEv}, edge >= ${config.minEdge}`);

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
    ? 'No rows were testable. API-Tennis may not provide historical odds/results for this range, or result parsing needs provider-specific fields. Try chunk_days=1 and a shorter recent range.'
    : rows.some((row) => row.first_set_edge !== 0)
      ? null
      : 'Model v1 uses estimated serve inputs and may be underpowered until real rolling serve stats are added.';

  const output = writeOutputs(summary, rows);
  console.log('Backtest summary:');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${output.summaryPath}`);
  console.log(`Wrote ${output.rowsPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
