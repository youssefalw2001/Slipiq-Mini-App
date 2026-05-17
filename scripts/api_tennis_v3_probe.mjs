#!/usr/bin/env node
/*
SlipIQ API-Tennis V3 probe.

Read-only test:
- get_fixtures for upcoming tennis matches
- get_odds for pre-match odds
- get_live_odds for live odds inventory
- find Correct Score 1st Half markets
- extract Player 2 scores: 3:6 / 4:6 / 5:7
- calculate grouped P2 9-12 odds per bookmaker

Outputs artifacts for deciding whether API-Tennis should replace/supplement OddsPortal.
*/

import fs from 'node:fs';
import path from 'node:path';

const apiKey = process.env.API_TENNIS_KEY || process.env.APITENNIS_API_KEY || process.env.API_TENNIS_API_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';
const OUT_DIR = process.env.OUT_DIR || 'artifacts/output/api-tennis-v3-probe';
const TARGET_MARKET = 'Correct Score 1st Half';
const P2_SCORES = ['3:6', '4:6', '5:7'];
const P1_SCORES = ['6:3', '6:4', '7:5'];

if (!apiKey) {
  console.error('Missing API_TENNIS_KEY / APITENNIS_API_KEY / API_TENNIS_API_KEY secret.');
  process.exit(2);
}

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const nowIso = () => new Date().toISOString();
const isoDate = (offsetDays = 0) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const normalizeArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
};
const safeFloat = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const groupedOdds = (values) => {
  const nums = values.map(safeFloat);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
};
const csvEscape = (v) => {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
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

const dateStart = process.env.API_TENNIS_DATE_START || process.argv.find((a) => a.startsWith('--date-start='))?.split('=')[1] || isoDate(0);
const dateStop = process.env.API_TENNIS_DATE_STOP || process.argv.find((a) => a.startsWith('--date-stop='))?.split('=')[1] || isoDate(2);
const eventTypeKeysRaw = process.env.API_TENNIS_EVENT_TYPE_KEYS || process.argv.find((a) => a.startsWith('--event-type-keys='))?.split('=')[1] || '265,266';
const eventTypeKeys = eventTypeKeysRaw.split(',').map((s) => s.trim()).filter(Boolean);
const includeAllTypes = (process.env.API_TENNIS_INCLUDE_ALL_TYPES || '').toLowerCase() === 'true';

const fetchApiTennis = async (method, params = {}) => {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} returned non-JSON HTTP ${response.status}: ${text.slice(0, 700)}`);
  }
  if (!response.ok || String(payload.success) !== '1') {
    throw new Error(`${method} failed HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return payload.result;
};

const fixtureFields = [
  'event_key', 'event_date', 'event_time', 'event_first_player', 'event_second_player', 'event_type_type',
  'tournament_name', 'tournament_key', 'tournament_round', 'event_live', 'event_status', 'event_final_result',
];

const simplifyFixture = (fixture) => {
  const row = {};
  for (const f of fixtureFields) row[f] = fixture?.[f] ?? '';
  return row;
};

const marketInventoryFields = ['match_key', 'market_name', 'outcome_count', 'sample_outcomes'];
const v3Fields = [
  'scraped_at', 'match_key', 'event_date', 'event_time', 'event_first_player', 'event_second_player', 'event_type_type',
  'tournament_name', 'bookmaker', 'p2_3_6_decimal', 'p2_4_6_decimal', 'p2_5_7_decimal', 'p2_grouped_9_12',
  'p1_6_3_decimal', 'p1_6_4_decimal', 'p1_7_5_decimal', 'p1_grouped_9_12', 'v3_4_6_trigger', 'bookmaker_count_for_market',
];
const liveFields = [
  'match_key', 'event_date', 'event_time', 'event_first_player', 'event_second_player', 'event_status', 'event_type_type',
  'tournament_name', 'odd_name', 'type', 'value', 'suspended', 'upd', 'target_like',
];

const getOddsObject = (oddsResult) => {
  if (!oddsResult || typeof oddsResult !== 'object') return {};
  return oddsResult;
};

const fixtureMapByKey = (fixtures) => {
  const map = new Map();
  for (const fixture of fixtures) {
    if (fixture?.event_key !== undefined) map.set(String(fixture.event_key), fixture);
  }
  return map;
};

const extractMarketInventory = (oddsResult) => {
  const rows = [];
  for (const [matchKey, matchOdds] of Object.entries(getOddsObject(oddsResult))) {
    if (!matchOdds || typeof matchOdds !== 'object') continue;
    for (const [marketName, market] of Object.entries(matchOdds)) {
      if (!market || typeof market !== 'object') continue;
      rows.push({
        match_key: matchKey,
        market_name: marketName,
        outcome_count: Object.keys(market).length,
        sample_outcomes: Object.keys(market).slice(0, 12).join(' | '),
      });
    }
  }
  return rows;
};

const extractV3Rows = (oddsResult, fixturesByKey) => {
  const rows = [];
  for (const [matchKey, matchOdds] of Object.entries(getOddsObject(oddsResult))) {
    const market = matchOdds?.[TARGET_MARKET];
    if (!market || typeof market !== 'object') continue;
    const bookmakers = new Set();
    for (const score of [...P2_SCORES, ...P1_SCORES]) {
      const scoreObj = market[score];
      if (scoreObj && typeof scoreObj === 'object') {
        for (const bookmaker of Object.keys(scoreObj)) bookmakers.add(bookmaker);
      }
    }
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    for (const bookmaker of [...bookmakers].sort()) {
      const p2Vals = P2_SCORES.map((s) => market?.[s]?.[bookmaker]);
      const p1Vals = P1_SCORES.map((s) => market?.[s]?.[bookmaker]);
      const p2Grouped = groupedOdds(p2Vals);
      const p1Grouped = groupedOdds(p1Vals);
      if (!p2Grouped && !p1Grouped) continue;
      const p46 = safeFloat(market?.['4:6']?.[bookmaker]);
      rows.push({
        scraped_at: nowIso(),
        match_key: matchKey,
        event_date: fixture.event_date || '',
        event_time: fixture.event_time || '',
        event_first_player: fixture.event_first_player || '',
        event_second_player: fixture.event_second_player || '',
        event_type_type: fixture.event_type_type || '',
        tournament_name: fixture.tournament_name || '',
        bookmaker,
        p2_3_6_decimal: safeFloat(p2Vals[0]) ?? '',
        p2_4_6_decimal: safeFloat(p2Vals[1]) ?? '',
        p2_5_7_decimal: safeFloat(p2Vals[2]) ?? '',
        p2_grouped_9_12: p2Grouped ?? '',
        p1_6_3_decimal: safeFloat(p1Vals[0]) ?? '',
        p1_6_4_decimal: safeFloat(p1Vals[1]) ?? '',
        p1_7_5_decimal: safeFloat(p1Vals[2]) ?? '',
        p1_grouped_9_12: p1Grouped ?? '',
        v3_4_6_trigger: p46 && p46 >= 6.25 && p46 < 7 ? 'true' : 'false',
        bookmaker_count_for_market: bookmakers.size,
      });
    }
  }
  return rows;
};

const extractLiveRows = (liveResult) => {
  const rows = [];
  const resultObj = liveResult && typeof liveResult === 'object' ? liveResult : {};
  for (const [matchKey, match] of Object.entries(resultObj)) {
    const odds = Array.isArray(match?.live_odds) ? match.live_odds : [];
    for (const odd of odds) {
      const oddName = clean(odd.odd_name);
      const type = clean(odd.type);
      const targetLike = /correct score|1st set|first set|set 1|3:6|4:6|5:7/i.test(`${oddName} ${type}`);
      rows.push({
        match_key: matchKey,
        event_date: match.event_date || '',
        event_time: match.event_time || '',
        event_first_player: match.event_first_player || '',
        event_second_player: match.event_second_player || '',
        event_status: match.event_status || '',
        event_type_type: match.event_type_type || '',
        tournament_name: match.tournament_name || '',
        odd_name: oddName,
        type,
        value: odd.value ?? '',
        suspended: odd.suspended ?? '',
        upd: odd.upd ?? '',
        target_like: targetLike ? 'true' : 'false',
      });
    }
  }
  return rows;
};

const fetchCombined = async (method, baseParams) => {
  const chunks = [];
  const errors = [];
  const keysToUse = includeAllTypes ? [''] : eventTypeKeys;
  for (const eventTypeKey of keysToUse) {
    try {
      const params = { ...baseParams };
      if (eventTypeKey) params.event_type_key = eventTypeKey;
      const result = await fetchApiTennis(method, params);
      chunks.push({ eventTypeKey: eventTypeKey || 'all', result });
    } catch (error) {
      errors.push({ method, eventTypeKey, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { chunks, errors };
};

const mergeFixtureChunks = (chunks) => {
  const map = new Map();
  for (const chunk of chunks) {
    for (const fixture of normalizeArray(chunk.result)) {
      if (fixture?.event_key !== undefined) map.set(String(fixture.event_key), fixture);
    }
  }
  return [...map.values()];
};

const mergeOddsChunks = (chunks) => {
  const merged = {};
  for (const chunk of chunks) {
    const obj = getOddsObject(chunk.result);
    for (const [matchKey, matchOdds] of Object.entries(obj)) merged[matchKey] = matchOdds;
  }
  return merged;
};

const run = async () => {
  ensureDir(OUT_DIR);
  const summary = {
    generated_at: nowIso(),
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: includeAllTypes ? ['all'] : eventTypeKeys,
    api_key_present: Boolean(apiKey),
    fixture_count: 0,
    odds_match_count: 0,
    market_inventory_rows: 0,
    v3_rows: 0,
    v3_rows_with_p2_grouped: 0,
    v3_signal_rows_330_plus: 0,
    v3_signal_rows_350_plus: 0,
    live_rows: 0,
    live_target_like_rows: 0,
    errors: [],
    stop_reason: 'NOT_STARTED',
  };

  try {
    const fixturesFetch = await fetchCombined('get_fixtures', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...fixturesFetch.errors);
    const fixtures = mergeFixtureChunks(fixturesFetch.chunks);
    summary.fixture_count = fixtures.length;
    const fixturesByKey = fixtureMapByKey(fixtures);

    const oddsFetch = await fetchCombined('get_odds', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...oddsFetch.errors);
    const oddsResult = mergeOddsChunks(oddsFetch.chunks);
    summary.odds_match_count = Object.keys(oddsResult).length;

    let liveResult = {};
    try {
      liveResult = await fetchApiTennis('get_live_odds', {});
    } catch (error) {
      summary.errors.push({ method: 'get_live_odds', error: error instanceof Error ? error.message : String(error) });
    }

    const fixtureRows = fixtures.map(simplifyFixture);
    const marketRows = extractMarketInventory(oddsResult);
    const v3Rows = extractV3Rows(oddsResult, fixturesByKey);
    const liveRows = extractLiveRows(liveResult);

    writeCsv(path.join(OUT_DIR, 'api_tennis_fixtures.csv'), fixtureRows, fixtureFields);
    writeCsv(path.join(OUT_DIR, 'api_tennis_market_inventory.csv'), marketRows, marketInventoryFields);
    writeCsv(path.join(OUT_DIR, 'api_tennis_v3_grouped_odds.csv'), v3Rows, v3Fields);
    writeCsv(path.join(OUT_DIR, 'api_tennis_live_odds_inventory.csv'), liveRows, liveFields);
    writeJson(path.join(OUT_DIR, 'api_tennis_odds_raw_sample.json'), oddsResult);

    summary.market_inventory_rows = marketRows.length;
    summary.v3_rows = v3Rows.length;
    summary.v3_rows_with_p2_grouped = v3Rows.filter((r) => r.p2_grouped_9_12 !== '').length;
    summary.v3_signal_rows_330_plus = v3Rows.filter((r) => safeFloat(r.p2_grouped_9_12) >= 3.3).length;
    summary.v3_signal_rows_350_plus = v3Rows.filter((r) => safeFloat(r.p2_grouped_9_12) >= 3.5).length;
    summary.live_rows = liveRows.length;
    summary.live_target_like_rows = liveRows.filter((r) => r.target_like === 'true').length;
    summary.stop_reason = 'API_TENNIS_V3_PROBE_COMPLETE';

    const topRows = v3Rows
      .filter((r) => safeFloat(r.p2_grouped_9_12))
      .sort((a, b) => safeFloat(b.p2_grouped_9_12) - safeFloat(a.p2_grouped_9_12))
      .slice(0, 20);

    const report = [
      '# API Tennis V3 Probe',
      '',
      `Generated: ${summary.generated_at}`,
      `Date range: ${dateStart} to ${dateStop}`,
      `Event type keys: ${summary.event_type_keys.join(', ')}`,
      `Fixtures: ${summary.fixture_count}`,
      `Odds matches: ${summary.odds_match_count}`,
      `Market inventory rows: ${summary.market_inventory_rows}`,
      `V3 bookmaker rows: ${summary.v3_rows}`,
      `P2 grouped rows: ${summary.v3_rows_with_p2_grouped}`,
      `P2 grouped >= 3.30: ${summary.v3_signal_rows_330_plus}`,
      `P2 grouped >= 3.50: ${summary.v3_signal_rows_350_plus}`,
      `Live odds rows: ${summary.live_rows}`,
      `Live target-like rows: ${summary.live_target_like_rows}`,
      '',
      '## Top P2 grouped odds',
      ...topRows.map((r) => `- ${r.event_first_player} vs ${r.event_second_player} | ${r.tournament_name} | ${r.bookmaker} | 3:6=${r.p2_3_6_decimal} 4:6=${r.p2_4_6_decimal} 5:7=${r.p2_5_7_decimal} grouped=${r.p2_grouped_9_12}`),
      '',
      '## Errors',
      summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None',
    ];
    fs.writeFileSync(path.join(OUT_DIR, 'api_tennis_v3_report.md'), report.join('\n'), 'utf8');
    writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
  } catch (error) {
    summary.stop_reason = `API_TENNIS_V3_PROBE_FAILED:${error instanceof Error ? error.message : String(error)}`;
    writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
    throw error;
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
