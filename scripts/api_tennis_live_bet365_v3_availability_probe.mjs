#!/usr/bin/env node
/*
SlipIQ API Tennis live bet365 V3 availability probe.

Purpose:
- Scan current/upcoming API Tennis odds right now.
- Focus on one bookmaker, default bet365.
- Check whether first-set correct-score V3 candidates exist live/upcoming.
- Help compare live availability vs historical warehouse assumptions.

Read-only. Does not place bets. Does not write Supabase. Does not send Telegram.
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
const OUT_DIR = params.out || 'artifacts/output/api-tennis-live-bet365-v3-availability-probe';
const MARKET_NAME = params.market || 'Correct Score 1st Half';
const TARGET_BOOKMAKER = params.bookmaker || 'bet365';
const TARGET_BOOKMAKER_LC = TARGET_BOOKMAKER.toLowerCase();
const MIN_GROUPED = Number(params['min-grouped'] ?? '3.05');
const A_GROUPED = Number(params['a-grouped'] ?? '3.20');
const S_GROUPED = Number(params['s-grouped'] ?? '3.30');
const TRIGGER_MIN = Number(params['trigger-min'] ?? '6.25');
const TRIGGER_MAX = Number(params['trigger-max'] ?? '6.99');
const EXPECTED_MIN_CANDIDATES = Number(params['expected-min-candidates'] ?? '1');
const P2_SCORES = ['3:6', '4:6', '5:7'];

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const now = new Date();
const nowIso = () => new Date().toISOString();
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const safeNumber = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoDate = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const dateStart = params['date-start'] || process.env.API_TENNIS_DATE_START || isoDate(0);
const dateStop = params['date-stop'] || process.env.API_TENNIS_DATE_STOP || isoDate(2);
const eventTypeKeys = (params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266').split(',').map((s) => s.trim()).filter(Boolean);
const includeAllTypes = String(params['include-all-types'] || process.env.API_TENNIS_INCLUDE_ALL_TYPES || 'false').toLowerCase() === 'true';

if (!apiKey) {
  console.error('Missing API Tennis key. Add API_TENNIS_KEY, APITENNIS_API_KEY, or API_TENNIS_API_KEY.');
  process.exit(2);
}

const groupedOdds = (values) => {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + (1 / v), 0);
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

async function fetchApiTennis(method, apiParams = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(apiParams)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} non-JSON ${res.status}: ${text.slice(0, 800)}`); }
  if (!res.ok || String(payload.success) !== '1') throw new Error(`${method} failed HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1600)}`);
  return payload.result;
}

async function fetchCombined(method, baseParams) {
  const chunks = [];
  const errors = [];
  const keys = includeAllTypes ? [''] : eventTypeKeys;
  for (const eventTypeKey of keys) {
    try {
      const p = { ...baseParams };
      if (eventTypeKey) p.event_type_key = eventTypeKey;
      chunks.push({ eventTypeKey: eventTypeKey || 'all', result: await fetchApiTennis(method, p) });
    } catch (err) {
      errors.push({ method, eventTypeKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { chunks, errors };
}
function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
}
function mergeFixtures(chunks) {
  const map = new Map();
  for (const chunk of chunks) {
    for (const fixture of normalizeArray(chunk.result)) {
      if (fixture?.event_key !== undefined) map.set(String(fixture.event_key), fixture);
    }
  }
  return [...map.values()];
}
function mergeOdds(chunks) {
  const merged = {};
  for (const chunk of chunks) {
    const result = chunk.result && typeof chunk.result === 'object' ? chunk.result : {};
    for (const [matchKey, odds] of Object.entries(result)) merged[matchKey] = odds;
  }
  return merged;
}
function fixtureMap(fixtures) {
  const map = new Map();
  for (const f of fixtures) if (f?.event_key !== undefined) map.set(String(f.event_key), f);
  return map;
}
function startsAtIso(fixture) {
  const date = clean(fixture?.event_date);
  const time = clean(fixture?.event_time || '00:00');
  if (!date) return null;
  const d = new Date(`${date}T${time.length === 5 ? time + ':00' : time}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function minutesToStart(fixture) {
  const start = startsAtIso(fixture);
  if (!start) return '';
  return Math.round((new Date(start).getTime() - now.getTime()) / 60000);
}
function matchName(fixture) {
  const p1 = clean(fixture?.event_first_player);
  const p2 = clean(fixture?.event_second_player);
  return p1 && p2 ? `${p1} vs ${p2}` : clean(fixture?.event_name || fixture?.event_key || 'Unknown match');
}
function eventStatus(fixture) {
  return clean(fixture?.event_status || fixture?.event_live || fixture?.event_final_result || fixture?.event_status_info || fixture?.event_key);
}
function valueForBook(scoreObj, targetLc) {
  if (!scoreObj || typeof scoreObj !== 'object') return { bookmaker: '', value: null };
  for (const [book, value] of Object.entries(scoreObj)) {
    if (book.toLowerCase() === targetLc) return { bookmaker: book, value: safeNumber(value) };
  }
  return { bookmaker: '', value: null };
}
function allBookmakersForMarket(market) {
  const s = new Set();
  for (const score of P2_SCORES) {
    const scoreObj = market?.[score];
    if (scoreObj && typeof scoreObj === 'object') for (const b of Object.keys(scoreObj)) s.add(b);
  }
  return [...s].sort();
}
function classify(row) {
  const trigger = row.v3_exact_4_6_trigger === 'true';
  const grouped = safeNumber(row.p2_grouped_9_12);
  if (!trigger) return 'NO_V3_TRIGGER';
  if (!grouped) return 'V3_TRIGGER_GROUP_UNAVAILABLE';
  if (grouped >= S_GROUPED) return 'S_TIER_LIVE_V3';
  if (grouped >= A_GROUPED) return 'A_TIER_LIVE_V3';
  if (grouped >= MIN_GROUPED) return 'B_TIER_LIVE_V3';
  return 'V3_TRIGGER_PRICE_TOO_LOW';
}
function extractRows(oddsResult, fixturesByKey) {
  const rows = [];
  const marketBookCounts = {};
  for (const [matchKey, matchOdds] of Object.entries(oddsResult)) {
    const market = matchOdds?.[MARKET_NAME];
    if (!market || typeof market !== 'object') continue;
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const books = allBookmakersForMarket(market);
    for (const b of books) marketBookCounts[b] = (marketBookCounts[b] || 0) + 1;
    const found = P2_SCORES.map((score) => valueForBook(market?.[score], TARGET_BOOKMAKER_LC));
    const actualBook = found.find((x) => x.bookmaker)?.bookmaker || TARGET_BOOKMAKER;
    const p2_3_6 = found[0].value;
    const p2_4_6 = found[1].value;
    const p2_5_7 = found[2].value;
    const grouped = groupedOdds([p2_3_6, p2_4_6, p2_5_7]);
    const row = {
      scanned_at: nowIso(),
      match_key: String(matchKey),
      event_date: fixture.event_date || '',
      event_time: fixture.event_time || '',
      starts_at: startsAtIso(fixture) || '',
      minutes_to_start: minutesToStart(fixture),
      event_status: eventStatus(fixture),
      player1: clean(fixture.event_first_player),
      player2: clean(fixture.event_second_player),
      match_name: matchName(fixture),
      event_type_type: fixture.event_type_type || '',
      tournament_name: fixture.tournament_name || '',
      target_bookmaker: TARGET_BOOKMAKER,
      actual_bookmaker: actualBook,
      all_bookmakers_seen: books.join('|'),
      has_target_bookmaker: found.some((x) => x.bookmaker) ? 'true' : 'false',
      p2_3_6_decimal: p2_3_6 ?? '',
      p2_4_6_decimal: p2_4_6 ?? '',
      p2_5_7_decimal: p2_5_7 ?? '',
      p2_grouped_9_12: grouped ?? '',
      has_all_three_p2_scores: p2_3_6 && p2_4_6 && p2_5_7 ? 'true' : 'false',
      v3_exact_4_6_trigger: p2_4_6 && p2_4_6 >= TRIGGER_MIN && p2_4_6 <= TRIGGER_MAX ? 'true' : 'false',
    };
    row.candidate_class = classify(row);
    row.is_candidate = ['B_TIER_LIVE_V3', 'A_TIER_LIVE_V3', 'S_TIER_LIVE_V3'].includes(row.candidate_class) ? 'true' : 'false';
    rows.push(row);
  }
  return { rows, marketBookCounts };
}

const fields = [
  'scanned_at', 'match_key', 'event_date', 'event_time', 'starts_at', 'minutes_to_start', 'event_status',
  'player1', 'player2', 'match_name', 'event_type_type', 'tournament_name', 'target_bookmaker', 'actual_bookmaker',
  'has_target_bookmaker', 'all_bookmakers_seen', 'p2_3_6_decimal', 'p2_4_6_decimal', 'p2_5_7_decimal', 'p2_grouped_9_12',
  'has_all_three_p2_scores', 'v3_exact_4_6_trigger', 'candidate_class', 'is_candidate'
];

async function main() {
  ensureDir(OUT_DIR);
  const summary = {
    generated_at: nowIso(),
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: includeAllTypes ? ['all'] : eventTypeKeys,
    market_name: MARKET_NAME,
    target_bookmaker: TARGET_BOOKMAKER,
    trigger_min: TRIGGER_MIN,
    trigger_max: TRIGGER_MAX,
    min_grouped: MIN_GROUPED,
    a_grouped: A_GROUPED,
    s_grouped: S_GROUPED,
    expected_min_candidates: EXPECTED_MIN_CANDIDATES,
    fixture_count: 0,
    odds_match_count: 0,
    target_book_rows: 0,
    target_book_rows_with_all_three_scores: 0,
    strict_v3_trigger_rows: 0,
    playable_candidate_rows: 0,
    candidate_threshold_met: false,
    class_counts: {},
    market_book_counts: {},
    errors: [],
    interpretation: ''
  };
  try {
    const fixtureFetch = await fetchCombined('get_fixtures', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...fixtureFetch.errors);
    const fixtures = mergeFixtures(fixtureFetch.chunks);
    const fixturesByKey = fixtureMap(fixtures);
    summary.fixture_count = fixtures.length;

    const oddsFetch = await fetchCombined('get_odds', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...oddsFetch.errors);
    const oddsResult = mergeOdds(oddsFetch.chunks);
    summary.odds_match_count = Object.keys(oddsResult).length;

    const { rows, marketBookCounts } = extractRows(oddsResult, fixturesByKey);
    const targetRows = rows.filter((r) => r.has_target_bookmaker === 'true');
    const candidates = targetRows.filter((r) => r.is_candidate === 'true');
    const classCounts = {};
    for (const r of targetRows) classCounts[r.candidate_class] = (classCounts[r.candidate_class] || 0) + 1;

    summary.market_book_counts = marketBookCounts;
    summary.target_book_rows = targetRows.length;
    summary.target_book_rows_with_all_three_scores = targetRows.filter((r) => r.has_all_three_p2_scores === 'true').length;
    summary.strict_v3_trigger_rows = targetRows.filter((r) => r.v3_exact_4_6_trigger === 'true').length;
    summary.playable_candidate_rows = candidates.length;
    summary.candidate_threshold_met = candidates.length >= EXPECTED_MIN_CANDIDATES;
    summary.class_counts = classCounts;
    summary.interpretation = candidates.length >= EXPECTED_MIN_CANDIDATES
      ? `Live ${TARGET_BOOKMAKER} V3 availability was found. Historical availability is more believable, but timing still needs repeated snapshots.`
      : `No/low live ${TARGET_BOOKMAKER} V3 availability in this snapshot. One scan is not enough to reject historical data; repeat across days and compare to historical odds.`;

    writeCsv(path.join(OUT_DIR, 'bet365_v3_live_all_target_rows.csv'), targetRows, fields);
    writeCsv(path.join(OUT_DIR, 'bet365_v3_live_candidates.csv'), candidates, fields);
    writeJson(path.join(OUT_DIR, 'bet365_v3_live_probe_summary.json'), summary);

    const lines = [
      '# API Tennis Live bet365 V3 Availability Probe',
      '',
      `Generated: ${summary.generated_at}`,
      `Date range: ${dateStart} to ${dateStop}`,
      `Market: ${MARKET_NAME}`,
      `Target bookmaker: ${TARGET_BOOKMAKER}`,
      `V3 trigger: 4:6 odds ${TRIGGER_MIN}-${TRIGGER_MAX}`,
      `Playable grouped floor: ${MIN_GROUPED}`,
      '',
      '## Counts',
      `Fixtures: ${summary.fixture_count}`,
      `Odds matches: ${summary.odds_match_count}`,
      `${TARGET_BOOKMAKER} rows: ${summary.target_book_rows}`,
      `${TARGET_BOOKMAKER} rows with all 3 P2 scores: ${summary.target_book_rows_with_all_three_scores}`,
      `Strict V3 trigger rows: ${summary.strict_v3_trigger_rows}`,
      `Playable candidate rows: ${summary.playable_candidate_rows}`,
      `Threshold met: ${summary.candidate_threshold_met}`,
      '',
      '## Class counts',
      '```json',
      JSON.stringify(summary.class_counts, null, 2),
      '```',
      '',
      '## Candidates',
      ...(candidates.length ? candidates.map((r) => `- ${r.candidate_class} | ${r.match_name} | ${r.actual_bookmaker} | ${r.tournament_name} | starts ${r.event_date} ${r.event_time} UTC | minutes_to_start=${r.minutes_to_start} | 3:6=${r.p2_3_6_decimal} 4:6=${r.p2_4_6_decimal} 5:7=${r.p2_5_7_decimal} grouped=${r.p2_grouped_9_12}`) : ['None']),
      '',
      '## Interpretation',
      summary.interpretation,
      '',
      '## Errors',
      summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None',
    ];
    fs.writeFileSync(path.join(OUT_DIR, 'bet365_v3_live_probe_report.md'), lines.join('\n'), 'utf8');
  } catch (err) {
    summary.errors.push({ fatal: err instanceof Error ? err.message : String(err) });
    writeJson(path.join(OUT_DIR, 'bet365_v3_live_probe_summary.json'), summary);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
