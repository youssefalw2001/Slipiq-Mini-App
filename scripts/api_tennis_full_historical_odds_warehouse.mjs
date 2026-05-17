#!/usr/bin/env node
/*
SlipIQ API Tennis Full Historical Odds Warehouse Exporter

Purpose:
- Pull fixtures + ALL odds markets returned by API Tennis for a date range.
- No strategy filter. No Supabase writes. Artifact-first raw data warehouse.
- Outputs:
  fixtures_full.csv
  odds_full_long.csv
  market_inventory.csv
  first_set_correct_score_wide.csv
  moneyline_favorite.csv
  raw_sample.json
  run_summary.json
  warehouse_report.md

Expected API Tennis odds shape is generally:
{
  match_key: {
    market_name: {
      option_name: {
        bookmaker_name: decimal_odds
      }
    }
  }
}

The exporter is defensive and skips weird non-price nodes instead of failing.
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
const OUT_DIR = params.out || process.env.OUT_DIR || 'artifacts/output/api-tennis-full-historical-odds-warehouse';
const REQUEST_PAUSE_MS = Number(params['request-pause-ms'] ?? process.env.REQUEST_PAUSE_MS ?? '250');
const INCLUDE_RAW_SAMPLE = String(params['include-raw-sample'] ?? process.env.INCLUDE_RAW_SAMPLE ?? 'true').toLowerCase() === 'true';
const RAW_SAMPLE_LIMIT = Number(params['raw-sample-limit'] ?? process.env.RAW_SAMPLE_LIMIT ?? '10');

const dateStart = params['date-start'] || process.env.API_TENNIS_DATE_START;
const dateStop = params['date-stop'] || process.env.API_TENNIS_DATE_STOP;
const eventTypeKeysInput = params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266';
const eventTypeKeys = eventTypeKeysInput
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const includeAllTypes = String(params['include-all-types'] || process.env.API_TENNIS_INCLUDE_ALL_TYPES || 'false').toLowerCase() === 'true';
const warehouseRunId = params['warehouse-run-id'] || process.env.WAREHOUSE_RUN_ID || `api-tennis-warehouse-${Date.now()}`;

if (!apiKey) {
  console.error('Missing API Tennis key. Add API_TENNIS_KEY, APITENNIS_API_KEY, or API_TENNIS_API_KEY.');
  process.exit(2);
}
if (!dateStart || !dateStop) {
  console.error('Missing --date-start and/or --date-stop.');
  process.exit(2);
}

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const nowIso = () => new Date().toISOString();
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeNumber = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
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
function matchName(fixture) {
  const p1 = clean(fixture?.event_first_player);
  const p2 = clean(fixture?.event_second_player);
  return p1 && p2 ? `${p1} vs ${p2}` : clean(fixture?.event_name || fixture?.event_key || 'Unknown match');
}
function getFirstSetScore(fixture) {
  if (!fixture || typeof fixture !== 'object') return '';
  const directKeys = ['event_first_set', 'event_first_set_result', 'first_set_score', 'set_1_score', 'event_set1_result', 'event_set_1_result'];
  for (const key of directKeys) {
    const val = clean(fixture[key]);
    if (/^\d+[:\-]\d+$/.test(val)) return val.replace('-', ':');
  }
  const scores = fixture.scores || fixture.event_scores || fixture.score || fixture.result;
  if (Array.isArray(scores) && scores.length) {
    const s0 = scores[0];
    if (typeof s0 === 'string' && /^\d+[:\-]\d+$/.test(clean(s0))) return clean(s0).replace('-', ':');
    if (s0 && typeof s0 === 'object') {
      for (const key of ['score', 'result', 'set_score']) {
        const val = clean(s0[key]);
        if (/^\d+[:\-]\d+$/.test(val)) return val.replace('-', ':');
      }
      const pairs = [
        [s0.score_first, s0.score_second],
        [s0.home, s0.away],
        [s0.player1, s0.player2],
        [s0.first, s0.second],
      ];
      for (const [a, b] of pairs) {
        if (/^\d+$/.test(clean(a)) && /^\d+$/.test(clean(b))) return `${clean(a)}:${clean(b)}`;
      }
    }
  }
  const finalResult = clean(fixture.event_final_result || fixture.event_result || fixture.final_result);
  const firstToken = finalResult.split(/\s+/)[0];
  if (/^\d+[:\-]\d+$/.test(firstToken)) return firstToken.replace('-', ':');
  return '';
}
function getFinalWinnerSide(fixture) {
  const v = clean(fixture?.event_winner || fixture?.winner || fixture?.event_winner_name);
  const p1 = clean(fixture?.event_first_player);
  const p2 = clean(fixture?.event_second_player);
  if (!v) return '';
  if (v === p1 || v === 'First Player' || v === '1') return 'P1';
  if (v === p2 || v === 'Second Player' || v === '2') return 'P2';
  return v;
}
function fixtureRow(fixture, probeDate, eventTypeKey) {
  return {
    warehouse_run_id: warehouseRunId,
    probe_date: probeDate,
    event_type_key: eventTypeKey,
    event_key: fixture?.event_key ?? '',
    event_date: fixture?.event_date ?? '',
    event_time: fixture?.event_time ?? '',
    player1: clean(fixture?.event_first_player),
    player2: clean(fixture?.event_second_player),
    match_name: matchName(fixture),
    tournament_name: fixture?.tournament_name ?? '',
    tournament_key: fixture?.tournament_key ?? '',
    event_type_type: fixture?.event_type_type ?? '',
    event_status: fixture?.event_status ?? fixture?.event_live ?? '',
    event_final_result: fixture?.event_final_result ?? '',
    first_set_score: getFirstSetScore(fixture),
    final_winner_side: getFinalWinnerSide(fixture),
    round: fixture?.event_round ?? fixture?.tournament_round ?? '',
    surface: fixture?.surface ?? fixture?.event_surface ?? '',
    country: fixture?.country_name ?? fixture?.event_country_name ?? '',
    raw_fixture_json: JSON.stringify(fixture ?? {}),
  };
}

function classifyMarket(marketName) {
  const m = marketName.toLowerCase();
  if (/correct score.*1st|correct score.*first|1st half|first half|1st set|first set/.test(m) && /correct score/.test(m)) return 'FIRST_SET_CORRECT_SCORE';
  if (/correct score/.test(m)) return 'CORRECT_SCORE_OTHER';
  if (/match winner|winner|moneyline|money line|home\/away|1x2/.test(m)) return 'MONEYLINE_OR_WINNER';
  if (/set winner|1st set winner|first set winner/.test(m)) return 'SET_WINNER';
  if (/total/.test(m)) return 'TOTALS';
  if (/handicap|spread/.test(m)) return 'HANDICAP';
  return 'OTHER';
}
function decimalFromMaybe(v) {
  if (typeof v === 'number' || typeof v === 'string') return safeNumber(v);
  if (isObject(v)) {
    for (const key of ['odd', 'odds', 'value', 'price', 'decimal', 'bookmaker_odd']) {
      const n = safeNumber(v[key]);
      if (n) return n;
    }
  }
  return null;
}
function extractOddsRows(oddsResult, fixturesByKey, probeDate, eventTypeKey) {
  const rows = [];
  const oddsObj = isObject(oddsResult) ? oddsResult : {};
  for (const [matchKey, matchOdds] of Object.entries(oddsObj)) {
    if (!isObject(matchOdds)) continue;
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const common = {
      warehouse_run_id: warehouseRunId,
      probe_date: probeDate,
      event_type_key: eventTypeKey,
      event_key: String(matchKey),
      event_date: fixture?.event_date ?? '',
      event_time: fixture?.event_time ?? '',
      player1: clean(fixture?.event_first_player),
      player2: clean(fixture?.event_second_player),
      match_name: matchName(fixture),
      tournament_name: fixture?.tournament_name ?? '',
      event_type_type: fixture?.event_type_type ?? '',
      first_set_score: getFirstSetScore(fixture),
      event_final_result: fixture?.event_final_result ?? '',
    };
    for (const [marketNameRaw, marketPayload] of Object.entries(matchOdds)) {
      const marketName = clean(marketNameRaw);
      const marketType = classifyMarket(marketName);
      if (!isObject(marketPayload)) continue;

      for (const [optionNameRaw, optionPayload] of Object.entries(marketPayload)) {
        const optionName = clean(optionNameRaw);
        if (isObject(optionPayload)) {
          for (const [bookmakerRaw, pricePayload] of Object.entries(optionPayload)) {
            const bookmaker = clean(bookmakerRaw);
            const oddsDecimal = decimalFromMaybe(pricePayload);
            if (!oddsDecimal || oddsDecimal <= 1) continue;
            rows.push({
              ...common,
              market_name: marketName,
              market_type: marketType,
              option_name: optionName,
              bookmaker,
              odds_decimal: oddsDecimal,
              raw_price_json: isObject(pricePayload) ? JSON.stringify(pricePayload) : String(pricePayload),
            });
          }
        } else {
          const oddsDecimal = decimalFromMaybe(optionPayload);
          if (!oddsDecimal || oddsDecimal <= 1) continue;
          rows.push({
            ...common,
            market_name: marketName,
            market_type: marketType,
            option_name: optionName,
            bookmaker: '',
            odds_decimal: oddsDecimal,
            raw_price_json: String(optionPayload),
          });
        }
      }
    }
  }
  return rows;
}

function groupedOdds(values) {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
}
function buildFirstSetWide(oddsRows) {
  const firstSetRows = oddsRows.filter((r) => r.market_type === 'FIRST_SET_CORRECT_SCORE');
  const map = new Map();
  const scoreCols = ['6:0','6:1','6:2','6:3','6:4','7:5','7:6','0:6','1:6','2:6','3:6','4:6','5:7','6:7'];
  for (const r of firstSetRows) {
    const key = `${r.event_key}|${r.bookmaker}|${r.market_name}`;
    if (!map.has(key)) {
      const row = {
        warehouse_run_id: r.warehouse_run_id,
        probe_date: r.probe_date,
        event_type_key: r.event_type_key,
        event_key: r.event_key,
        event_date: r.event_date,
        event_time: r.event_time,
        player1: r.player1,
        player2: r.player2,
        match_name: r.match_name,
        tournament_name: r.tournament_name,
        event_type_type: r.event_type_type,
        bookmaker: r.bookmaker,
        market_name: r.market_name,
        first_set_score: r.first_set_score,
      };
      for (const s of scoreCols) row[`odds_${s.replace(':','_')}`] = '';
      map.set(key, row);
    }
    const row = map.get(key);
    const option = r.option_name.replace('-', ':');
    if (scoreCols.includes(option)) row[`odds_${option.replace(':','_')}`] = r.odds_decimal;
  }
  const out = [...map.values()];
  for (const row of out) {
    row.p1_cluster_odds = groupedOdds([row.odds_6_3, row.odds_6_4, row.odds_7_5]) ?? '';
    row.p2_cluster_odds = groupedOdds([row.odds_3_6, row.odds_4_6, row.odds_5_7]) ?? '';
    row.p1_cluster_win = ['6:3','6:4','7:5'].includes(row.first_set_score) ? 'true' : 'false';
    row.p2_cluster_win = ['3:6','4:6','5:7'].includes(row.first_set_score) ? 'true' : 'false';
    row.both_side_cluster_win = row.p1_cluster_win === 'true' || row.p2_cluster_win === 'true' ? 'true' : 'false';
  }
  return out;
}
function looksLikeP1Option(optionName, row) {
  const o = optionName.toLowerCase();
  const p1 = row.player1.toLowerCase();
  return ['1','home','player 1','player1','first player'].includes(o) || (p1 && o === p1.toLowerCase());
}
function looksLikeP2Option(optionName, row) {
  const o = optionName.toLowerCase();
  const p2 = row.player2.toLowerCase();
  return ['2','away','player 2','player2','second player'].includes(o) || (p2 && o === p2.toLowerCase());
}
function buildMoneylineFavorite(oddsRows) {
  const mlRows = oddsRows.filter((r) => r.market_type === 'MONEYLINE_OR_WINNER');
  const map = new Map();
  for (const r of mlRows) {
    const key = `${r.event_key}|${r.bookmaker}|${r.market_name}`;
    if (!map.has(key)) {
      map.set(key, {
        warehouse_run_id: r.warehouse_run_id,
        probe_date: r.probe_date,
        event_type_key: r.event_type_key,
        event_key: r.event_key,
        event_date: r.event_date,
        event_time: r.event_time,
        player1: r.player1,
        player2: r.player2,
        match_name: r.match_name,
        tournament_name: r.tournament_name,
        event_type_type: r.event_type_type,
        bookmaker: r.bookmaker,
        market_name: r.market_name,
        moneyline_p1: '',
        moneyline_p2: '',
        favorite_side: '',
        favorite_odds: '',
        underdog_odds: '',
        favorite_bucket: '',
      });
    }
    const row = map.get(key);
    if (looksLikeP1Option(r.option_name, row)) row.moneyline_p1 = r.odds_decimal;
    if (looksLikeP2Option(r.option_name, row)) row.moneyline_p2 = r.odds_decimal;
  }
  const out = [...map.values()];
  for (const row of out) {
    const p1 = safeNumber(row.moneyline_p1);
    const p2 = safeNumber(row.moneyline_p2);
    if (p1 && p2) {
      if (p1 < p2) {
        row.favorite_side = 'P1';
        row.favorite_odds = p1;
        row.underdog_odds = p2;
      } else if (p2 < p1) {
        row.favorite_side = 'P2';
        row.favorite_odds = p2;
        row.underdog_odds = p1;
      } else {
        row.favorite_side = 'EVEN';
        row.favorite_odds = p1;
        row.underdog_odds = p2;
      }
      const fav = safeNumber(row.favorite_odds);
      if (fav) {
        if (fav < 1.35) row.favorite_bucket = 'strong_favorite';
        else if (fav < 1.65) row.favorite_bucket = 'favorite';
        else if (fav < 1.95) row.favorite_bucket = 'slight_favorite';
        else row.favorite_bucket = 'near_even';
      }
    }
  }
  return out.filter((r) => r.moneyline_p1 || r.moneyline_p2);
}
function buildMarketInventory(oddsRows) {
  const map = new Map();
  for (const r of oddsRows) {
    const key = `${r.market_name}|${r.market_type}`;
    if (!map.has(key)) {
      map.set(key, {
        market_name: r.market_name,
        market_type: r.market_type,
        rows: 0,
        matches_set: new Set(),
        bookmakers_set: new Set(),
        options_set: new Set(),
        first_date: r.event_date || '',
        last_date: r.event_date || '',
      });
    }
    const item = map.get(key);
    item.rows += 1;
    if (r.event_key) item.matches_set.add(r.event_key);
    if (r.bookmaker) item.bookmakers_set.add(r.bookmaker);
    if (r.option_name) item.options_set.add(r.option_name);
    if (r.event_date && (!item.first_date || r.event_date < item.first_date)) item.first_date = r.event_date;
    if (r.event_date && (!item.last_date || r.event_date > item.last_date)) item.last_date = r.event_date;
  }
  return [...map.values()].map((item) => ({
    market_name: item.market_name,
    market_type: item.market_type,
    rows: item.rows,
    matches: item.matches_set.size,
    bookmakers: item.bookmakers_set.size,
    options: item.options_set.size,
    first_date: item.first_date,
    last_date: item.last_date,
    sample_bookmakers: [...item.bookmakers_set].sort().slice(0, 20).join('|'),
    sample_options: [...item.options_set].sort().slice(0, 50).join('|'),
  })).sort((a, b) => b.rows - a.rows);
}

const fixtureFields = ['warehouse_run_id','probe_date','event_type_key','event_key','event_date','event_time','player1','player2','match_name','tournament_name','tournament_key','event_type_type','event_status','event_final_result','first_set_score','final_winner_side','round','surface','country','raw_fixture_json'];
const oddsFields = ['warehouse_run_id','probe_date','event_type_key','event_key','event_date','event_time','player1','player2','match_name','tournament_name','event_type_type','first_set_score','event_final_result','bookmaker','market_name','market_type','option_name','odds_decimal','raw_price_json'];
const inventoryFields = ['market_name','market_type','rows','matches','bookmakers','options','first_date','last_date','sample_bookmakers','sample_options'];
const wideFields = ['warehouse_run_id','probe_date','event_type_key','event_key','event_date','event_time','player1','player2','match_name','tournament_name','event_type_type','bookmaker','market_name','first_set_score','odds_6_0','odds_6_1','odds_6_2','odds_6_3','odds_6_4','odds_7_5','odds_7_6','odds_0_6','odds_1_6','odds_2_6','odds_3_6','odds_4_6','odds_5_7','odds_6_7','p1_cluster_odds','p2_cluster_odds','p1_cluster_win','p2_cluster_win','both_side_cluster_win'];
const moneylineFields = ['warehouse_run_id','probe_date','event_type_key','event_key','event_date','event_time','player1','player2','match_name','tournament_name','event_type_type','bookmaker','market_name','moneyline_p1','moneyline_p2','favorite_side','favorite_odds','underdog_odds','favorite_bucket'];

async function main() {
  ensureDir(OUT_DIR);
  const summary = {
    generated_at: nowIso(),
    warehouse_run_id: warehouseRunId,
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: includeAllTypes ? ['all'] : eventTypeKeys,
    include_all_types: includeAllTypes,
    fixture_rows: 0,
    odds_long_rows: 0,
    market_count: 0,
    first_set_wide_rows: 0,
    moneyline_rows: 0,
    unique_matches_with_odds: 0,
    unique_bookmakers: 0,
    unique_markets: 0,
    errors: [],
    stop_reason: 'NOT_STARTED',
  };

  const allFixtures = [];
  const allOddsRows = [];
  const rawSamples = [];
  const days = dateRange(dateStart, dateStop);
  const keysToUse = includeAllTypes ? [''] : eventTypeKeys;

  for (const day of days) {
    for (const eventTypeKey of keysToUse) {
      try {
        const apiParams = { date_start: day, date_stop: day };
        if (eventTypeKey) apiParams.event_type_key = eventTypeKey;

        const fixturesResult = await fetchApiTennis('get_fixtures', apiParams);
        await sleep(REQUEST_PAUSE_MS);
        const fixtures = normalizeArray(fixturesResult);
        const fixturesByKey = fixtureMap(fixtures);
        for (const f of fixtures) allFixtures.push(fixtureRow(f, day, eventTypeKey || 'all'));

        const oddsResult = await fetchApiTennis('get_odds', apiParams);
        await sleep(REQUEST_PAUSE_MS);
        const oddsRows = extractOddsRows(oddsResult, fixturesByKey, day, eventTypeKey || 'all');
        allOddsRows.push(...oddsRows);
        if (INCLUDE_RAW_SAMPLE && rawSamples.length < RAW_SAMPLE_LIMIT) {
          rawSamples.push({
            day,
            eventTypeKey: eventTypeKey || 'all',
            fixtures_sample: fixtures.slice(0, 3),
            odds_match_keys_sample: Object.keys(isObject(oddsResult) ? oddsResult : {}).slice(0, 5),
            odds_sample: Object.fromEntries(Object.entries(isObject(oddsResult) ? oddsResult : {}).slice(0, 2)),
          });
        }
      } catch (error) {
        summary.errors.push({ day, eventTypeKey: eventTypeKey || 'all', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const marketInventory = buildMarketInventory(allOddsRows);
  const firstSetWide = buildFirstSetWide(allOddsRows);
  const moneylineFavorite = buildMoneylineFavorite(allOddsRows);

  summary.fixture_rows = allFixtures.length;
  summary.odds_long_rows = allOddsRows.length;
  summary.market_count = marketInventory.length;
  summary.first_set_wide_rows = firstSetWide.length;
  summary.moneyline_rows = moneylineFavorite.length;
  summary.unique_matches_with_odds = new Set(allOddsRows.map((r) => r.event_key)).size;
  summary.unique_bookmakers = new Set(allOddsRows.map((r) => r.bookmaker).filter(Boolean)).size;
  summary.unique_markets = new Set(allOddsRows.map((r) => r.market_name).filter(Boolean)).size;
  summary.stop_reason = 'API_TENNIS_FULL_HISTORICAL_ODDS_WAREHOUSE_COMPLETE';

  writeCsv(path.join(OUT_DIR, 'fixtures_full.csv'), allFixtures, fixtureFields);
  writeCsv(path.join(OUT_DIR, 'odds_full_long.csv'), allOddsRows, oddsFields);
  writeCsv(path.join(OUT_DIR, 'market_inventory.csv'), marketInventory, inventoryFields);
  writeCsv(path.join(OUT_DIR, 'first_set_correct_score_wide.csv'), firstSetWide, wideFields);
  writeCsv(path.join(OUT_DIR, 'moneyline_favorite.csv'), moneylineFavorite, moneylineFields);
  writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
  if (INCLUDE_RAW_SAMPLE) writeJson(path.join(OUT_DIR, 'raw_sample.json'), rawSamples);

  const report = [
    '# API Tennis Full Historical Odds Warehouse',
    '',
    `Generated: ${summary.generated_at}`,
    `Warehouse run id: ${warehouseRunId}`,
    `Date range: ${dateStart} to ${dateStop}`,
    `Event type keys: ${summary.event_type_keys.join(', ')}`,
    `Fixtures: ${summary.fixture_rows}`,
    `Odds long rows: ${summary.odds_long_rows}`,
    `Unique matches with odds: ${summary.unique_matches_with_odds}`,
    `Unique bookmakers: ${summary.unique_bookmakers}`,
    `Unique markets: ${summary.unique_markets}`,
    `First-set correct-score wide rows: ${summary.first_set_wide_rows}`,
    `Moneyline/favorite rows: ${summary.moneyline_rows}`,
    '',
    '## Top markets',
    ...marketInventory.slice(0, 50).map((m) => `- ${m.market_name} [${m.market_type}] rows=${m.rows} matches=${m.matches} books=${m.bookmakers} options=${m.options} sample_options=${m.sample_options}`),
    '',
    '## Errors',
    summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'warehouse_report.md'), report.join('\n'), 'utf8');
}

main().catch((error) => {
  ensureDir(OUT_DIR);
  writeJson(path.join(OUT_DIR, 'run_summary.json'), {
    generated_at: nowIso(),
    warehouse_run_id: warehouseRunId,
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: includeAllTypes ? ['all'] : eventTypeKeys,
    stop_reason: `API_TENNIS_FULL_HISTORICAL_ODDS_WAREHOUSE_FAILED:${error instanceof Error ? error.message : String(error)}`,
  });
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
