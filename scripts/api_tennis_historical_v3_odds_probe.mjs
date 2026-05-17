#!/usr/bin/env node
/*
SlipIQ API-Tennis historical V3 odds probe.

Purpose:
- Test whether API Tennis get_odds returns historical first-set correct-score odds for past dates.
- Extract Correct Score 1st Half market.
- Extract Player 2 3:6 / 4:6 / 5:7 grouped odds per bookmaker.
- Join with fixtures where possible.
- Try to parse first-set score for historical hit-rate research.

This is a probe, not a production backfill. It does not write to Supabase by default.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const apiKey = process.env.API_TENNIS_KEY || process.env.APITENNIS_API_KEY || process.env.API_TENNIS_API_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';
const OUT_DIR = params.out || process.env.OUT_DIR || 'artifacts/output/api-tennis-historical-v3-odds-probe';
const MARKET_NAME = 'Correct Score 1st Half';
const P2_SCORES = ['3:6', '4:6', '5:7'];
const P1_SCORES = ['6:3', '6:4', '7:5'];

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const nowIso = () => new Date().toISOString();
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const isoDate = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const safeNumber = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const groupedOdds = (values) => {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
};
const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const writeCsv = (filePath, rows, fields) => {
  ensureDir(path.dirname(filePath));
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvEscape(row[f])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};
const writeJson = (filePath, data) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};
const dateRange = (start, stop) => {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  const end = new Date(`${stop}T00:00:00Z`);
  while (!Number.isNaN(d.getTime()) && d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

const dateStart = params['date-start'] || process.env.API_TENNIS_DATE_START || isoDate(-7);
const dateStop = params['date-stop'] || process.env.API_TENNIS_DATE_STOP || isoDate(-1);
const eventTypeKeys = (params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266').split(',').map((s) => s.trim()).filter(Boolean);
const chunkMode = (params['chunk-mode'] || process.env.API_TENNIS_CHUNK_MODE || 'daily').toLowerCase();
const includeRawSample = String(params['include-raw-sample'] || process.env.INCLUDE_RAW_SAMPLE || 'true').toLowerCase() === 'true';
const minGrouped = Number(params['min-grouped'] || process.env.MIN_GROUPED || '3.30');
const idealGrouped = Number(params['ideal-grouped'] || process.env.IDEAL_GROUPED || '3.50');

if (!apiKey) {
  console.error('Missing API Tennis key. Add API_TENNIS_KEY, APITENNIS_API_KEY, or API_TENNIS_API_KEY.');
  process.exit(2);
}

async function fetchApiTennis(method, apiParams = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(apiParams)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} non-JSON HTTP ${res.status}: ${text.slice(0, 700)}`);
  }
  if (!res.ok || String(payload.success) !== '1') {
    throw new Error(`${method} failed HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return payload.result;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
}
function fixtureMap(fixtures) {
  const map = new Map();
  for (const f of fixtures) {
    if (f?.event_key !== undefined) map.set(String(f.event_key), f);
  }
  return map;
}
function getFirstSetScore(fixture) {
  if (!fixture || typeof fixture !== 'object') return '';

  const directKeys = [
    'event_first_set',
    'event_first_set_result',
    'first_set_score',
    'set_1_score',
    'event_set1_result',
    'event_set_1_result',
  ];
  for (const key of directKeys) {
    const val = clean(fixture[key]);
    if (/^\d+[:\-]\d+$/.test(val)) return val.replace('-', ':');
  }

  const scores = fixture.scores || fixture.event_scores || fixture.score || fixture.result;
  if (Array.isArray(scores) && scores.length) {
    const s0 = scores[0];
    if (typeof s0 === 'string' && /^\d+[:\-]\d+$/.test(clean(s0))) return clean(s0).replace('-', ':');
    if (s0 && typeof s0 === 'object') {
      const vals = [s0.score_first, s0.score_second, s0.home, s0.away, s0.player1, s0.player2, s0.first, s0.second].map(clean);
      for (let i = 0; i < vals.length - 1; i++) {
        if (/^\d+$/.test(vals[i]) && /^\d+$/.test(vals[i + 1])) return `${vals[i]}:${vals[i + 1]}`;
      }
      for (const key of ['score', 'result', 'set_score']) {
        const val = clean(s0[key]);
        if (/^\d+[:\-]\d+$/.test(val)) return val.replace('-', ':');
      }
    }
  }

  const finalResult = clean(fixture.event_final_result || fixture.event_result || fixture.final_result);
  const firstToken = finalResult.split(/\s+/)[0];
  if (/^\d+[:\-]\d+$/.test(firstToken)) return firstToken.replace('-', ':');

  return '';
}
function matchName(fixture) {
  const p1 = clean(fixture?.event_first_player);
  const p2 = clean(fixture?.event_second_player);
  return p1 && p2 ? `${p1} vs ${p2}` : clean(fixture?.event_name || fixture?.event_key || 'Unknown match');
}
function scoreValues(market, scores, bookmaker) {
  return scores.map((s) => safeNumber(market?.[s]?.[bookmaker]));
}
function classify(row) {
  const grouped = safeNumber(row.p2_grouped_9_12);
  const p46 = safeNumber(row.p2_4_6_decimal);
  const strictV3 = Boolean(p46 && p46 >= 6.25 && p46 < 7.00);
  const priceLab = Boolean(grouped && grouped >= idealGrouped);
  const playable = Boolean(grouped && grouped >= minGrouped);
  if (strictV3 && playable && grouped >= idealGrouped) return 'OFFICIAL_V3_A_PLUS';
  if (strictV3 && playable) return 'OFFICIAL_V3';
  if (priceLab) return 'PRICE_LAB_A';
  if (playable) return 'WATCHLIST_PRICE';
  return 'REJECT';
}
function resultFromScore(score) {
  if (!score) return 'unknown';
  return P2_SCORES.includes(score) ? 'won' : 'lost';
}

function extractRows(oddsResult, fixturesByKey, probeDate, eventTypeKey) {
  const rows = [];
  const oddsObj = oddsResult && typeof oddsResult === 'object' ? oddsResult : {};
  for (const [matchKey, matchOdds] of Object.entries(oddsObj)) {
    const market = matchOdds?.[MARKET_NAME];
    if (!market || typeof market !== 'object') continue;
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const bookmakers = new Set();
    for (const score of [...P2_SCORES, ...P1_SCORES]) {
      const scoreObj = market?.[score];
      if (scoreObj && typeof scoreObj === 'object') {
        for (const bookmaker of Object.keys(scoreObj)) bookmakers.add(bookmaker);
      }
    }
    const firstSetScore = getFirstSetScore(fixture);
    for (const bookmaker of [...bookmakers].sort()) {
      const p2Vals = scoreValues(market, P2_SCORES, bookmaker);
      const p1Vals = scoreValues(market, P1_SCORES, bookmaker);
      const p2Grouped = groupedOdds(p2Vals);
      const p1Grouped = groupedOdds(p1Vals);
      if (!p2Grouped && !p1Grouped) continue;
      const row = {
        probe_date: probeDate,
        event_type_key: eventTypeKey,
        match_key: String(matchKey),
        event_date: fixture.event_date || '',
        event_time: fixture.event_time || '',
        player1: clean(fixture.event_first_player),
        player2: clean(fixture.event_second_player),
        match_name: matchName(fixture),
        tournament_name: fixture.tournament_name || '',
        event_type_type: fixture.event_type_type || '',
        event_status: fixture.event_status || fixture.event_live || '',
        event_final_result: fixture.event_final_result || '',
        first_set_score: firstSetScore,
        result_status: resultFromScore(firstSetScore),
        bookmaker,
        p2_3_6_decimal: p2Vals[0] ?? '',
        p2_4_6_decimal: p2Vals[1] ?? '',
        p2_5_7_decimal: p2Vals[2] ?? '',
        p2_grouped_9_12: p2Grouped ?? '',
        p1_6_3_decimal: p1Vals[0] ?? '',
        p1_6_4_decimal: p1Vals[1] ?? '',
        p1_7_5_decimal: p1Vals[2] ?? '',
        p1_grouped_9_12: p1Grouped ?? '',
        v3_exact_4_6_trigger: safeNumber(p2Vals[1]) >= 6.25 && safeNumber(p2Vals[1]) < 7.00 ? 'true' : 'false',
      };
      row.signal_class = classify(row);
      rows.push(row);
    }
  }
  return rows;
}

const fields = [
  'probe_date', 'event_type_key', 'match_key', 'event_date', 'event_time', 'player1', 'player2', 'match_name',
  'tournament_name', 'event_type_type', 'event_status', 'event_final_result', 'first_set_score', 'result_status',
  'bookmaker', 'p2_3_6_decimal', 'p2_4_6_decimal', 'p2_5_7_decimal', 'p2_grouped_9_12',
  'p1_6_3_decimal', 'p1_6_4_decimal', 'p1_7_5_decimal', 'p1_grouped_9_12', 'v3_exact_4_6_trigger', 'signal_class',
];

async function run() {
  ensureDir(OUT_DIR);
  const summary = {
    generated_at: nowIso(),
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: eventTypeKeys,
    chunk_mode: chunkMode,
    min_grouped: minGrouped,
    ideal_grouped: idealGrouped,
    fixture_count: 0,
    odds_match_count: 0,
    v3_rows: 0,
    rows_with_first_set_score: 0,
    p2_grouped_rows: 0,
    p2_grouped_330_plus: 0,
    p2_grouped_350_plus: 0,
    strict_v3_rows: 0,
    settled_wins: 0,
    settled_losses: 0,
    settled_hit_rate: null,
    errors: [],
    stop_reason: 'NOT_STARTED',
  };

  const allFixtures = [];
  const allRows = [];
  const rawSamples = [];
  const chunks = chunkMode === 'range' ? [{ start: dateStart, stop: dateStop, label: `${dateStart}_to_${dateStop}` }] : dateRange(dateStart, dateStop).map((d) => ({ start: d, stop: d, label: d }));

  for (const chunk of chunks) {
    for (const eventTypeKey of eventTypeKeys) {
      try {
        const apiParams = { date_start: chunk.start, date_stop: chunk.stop, event_type_key: eventTypeKey };
        const fixturesResult = await fetchApiTennis('get_fixtures', apiParams);
        const fixtures = normalizeArray(fixturesResult);
        const fixturesByKey = fixtureMap(fixtures);
        allFixtures.push(...fixtures.map((f) => ({
          probe_date: chunk.label,
          event_type_key: eventTypeKey,
          event_key: f.event_key || '',
          event_date: f.event_date || '',
          event_time: f.event_time || '',
          player1: clean(f.event_first_player),
          player2: clean(f.event_second_player),
          match_name: matchName(f),
          tournament_name: f.tournament_name || '',
          event_type_type: f.event_type_type || '',
          event_final_result: f.event_final_result || '',
          first_set_score: getFirstSetScore(f),
        })));

        const oddsResult = await fetchApiTennis('get_odds', apiParams);
        const oddsObj = oddsResult && typeof oddsResult === 'object' ? oddsResult : {};
        summary.odds_match_count += Object.keys(oddsObj).length;
        const rows = extractRows(oddsObj, fixturesByKey, chunk.label, eventTypeKey);
        allRows.push(...rows);
        if (includeRawSample && rawSamples.length < 5) {
          rawSamples.push({ chunk: chunk.label, eventTypeKey, odds_sample: Object.fromEntries(Object.entries(oddsObj).slice(0, 2)), fixtures_sample: fixtures.slice(0, 2) });
        }
      } catch (error) {
        summary.errors.push({ chunk: chunk.label, eventTypeKey, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  summary.fixture_count = allFixtures.length;
  summary.v3_rows = allRows.length;
  summary.rows_with_first_set_score = allRows.filter((r) => r.first_set_score).length;
  summary.p2_grouped_rows = allRows.filter((r) => safeNumber(r.p2_grouped_9_12)).length;
  summary.p2_grouped_330_plus = allRows.filter((r) => safeNumber(r.p2_grouped_9_12) >= 3.3).length;
  summary.p2_grouped_350_plus = allRows.filter((r) => safeNumber(r.p2_grouped_9_12) >= 3.5).length;
  summary.strict_v3_rows = allRows.filter((r) => r.v3_exact_4_6_trigger === 'true').length;
  summary.settled_wins = allRows.filter((r) => r.result_status === 'won').length;
  summary.settled_losses = allRows.filter((r) => r.result_status === 'lost').length;
  const settled = summary.settled_wins + summary.settled_losses;
  summary.settled_hit_rate = settled ? Number((summary.settled_wins / settled).toFixed(6)) : null;
  summary.stop_reason = 'API_TENNIS_HISTORICAL_V3_PROBE_COMPLETE';

  writeCsv(path.join(OUT_DIR, 'api_tennis_historical_v3_rows.csv'), allRows, fields);
  writeCsv(path.join(OUT_DIR, 'api_tennis_historical_fixtures.csv'), allFixtures, [
    'probe_date', 'event_type_key', 'event_key', 'event_date', 'event_time', 'player1', 'player2', 'match_name', 'tournament_name', 'event_type_type', 'event_final_result', 'first_set_score',
  ]);
  writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
  if (includeRawSample) writeJson(path.join(OUT_DIR, 'api_tennis_historical_raw_sample.json'), rawSamples);

  const topRows = allRows
    .filter((r) => safeNumber(r.p2_grouped_9_12))
    .sort((a, b) => safeNumber(b.p2_grouped_9_12) - safeNumber(a.p2_grouped_9_12))
    .slice(0, 25);
  const report = [
    '# API Tennis Historical V3 Odds Probe',
    '',
    `Generated: ${summary.generated_at}`,
    `Date range: ${dateStart} to ${dateStop}`,
    `Event type keys: ${eventTypeKeys.join(', ')}`,
    `Chunk mode: ${chunkMode}`,
    `Fixtures: ${summary.fixture_count}`,
    `Odds matches: ${summary.odds_match_count}`,
    `Historical V3 bookmaker rows: ${summary.v3_rows}`,
    `Rows with first-set score parsed: ${summary.rows_with_first_set_score}`,
    `P2 grouped rows: ${summary.p2_grouped_rows}`,
    `P2 grouped >= 3.30: ${summary.p2_grouped_330_plus}`,
    `P2 grouped >= 3.50: ${summary.p2_grouped_350_plus}`,
    `Strict V3 trigger rows: ${summary.strict_v3_rows}`,
    `Settled wins/losses from parsed first-set scores: ${summary.settled_wins}/${summary.settled_losses}`,
    `Parsed-set hit rate: ${summary.settled_hit_rate ?? 'n/a'}`,
    '',
    '## Top grouped rows',
    ...topRows.map((r) => `- ${r.event_date} | ${r.match_name} | ${r.bookmaker} | ${r.tournament_name} | score=${r.first_set_score || 'unknown'} | result=${r.result_status} | 3:6=${r.p2_3_6_decimal} 4:6=${r.p2_4_6_decimal} 5:7=${r.p2_5_7_decimal} grouped=${r.p2_grouped_9_12} | class=${r.signal_class}`),
    '',
    '## Errors',
    summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'api_tennis_historical_v3_report.md'), report.join('\n'), 'utf8');
}

run().catch((error) => {
  ensureDir(OUT_DIR);
  writeJson(path.join(OUT_DIR, 'run_summary.json'), {
    generated_at: nowIso(),
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: eventTypeKeys,
    stop_reason: `API_TENNIS_HISTORICAL_V3_PROBE_FAILED:${error instanceof Error ? error.message : String(error)}`,
  });
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
