#!/usr/bin/env node
/*
SlipIQ API-Tennis live V3 signal scanner.

Production path:
- API Tennis get_fixtures + get_odds
- extract Correct Score 1st Half
- calculate P2 3:6 / 4:6 / 5:7 grouped odds per bookmaker
- pick best bookmaker per match
- classify Official V3 / Price Lab / Watchlist
- optionally write price checks + signals to Supabase
- optionally send Telegram alerts

Read-only odds source. This does not place bets.
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
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_VIP_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const baseUrl = 'https://api.api-tennis.com/tennis/';

const OUT_DIR = params.out || process.env.OUT_DIR || 'artifacts/output/api-tennis-live-v3-signal-scanner';
const DRY_RUN = String(params['dry-run'] ?? process.env.DRY_RUN ?? 'true').toLowerCase() === 'true';
const WRITE_SUPABASE = String(params['write-supabase'] ?? process.env.WRITE_SUPABASE ?? 'false').toLowerCase() === 'true' && !DRY_RUN;
const SEND_TELEGRAM = String(params['send-telegram'] ?? process.env.SEND_TELEGRAM ?? 'false').toLowerCase() === 'true' && !DRY_RUN;
const MIN_GROUPED = Number(params['min-grouped'] ?? process.env.MIN_GROUPED ?? '3.30');
const IDEAL_GROUPED = Number(params['ideal-grouped'] ?? process.env.IDEAL_GROUPED ?? '3.50');
const LIMIT_SIGNALS = Number(params['limit-signals'] ?? process.env.LIMIT_SIGNALS ?? '25');
const MARKET_NAME = 'Correct Score 1st Half';
const P2_SCORES = ['3:6', '4:6', '5:7'];
const P1_SCORES = ['6:3', '6:4', '7:5'];
const SIGNAL_TABLE = 'private_v3_signal_log';
const PRICE_TABLE = 'private_v3_price_checks';

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

const dateStart = params['date-start'] || process.env.API_TENNIS_DATE_START || isoDate(0);
const dateStop = params['date-stop'] || process.env.API_TENNIS_DATE_STOP || isoDate(2);
const eventTypeKeys = (params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266').split(',').map((s) => s.trim()).filter(Boolean);
const includeAllTypes = String(params['include-all-types'] || process.env.API_TENNIS_INCLUDE_ALL_TYPES || 'false').toLowerCase() === 'true';

if (!apiKey) {
  console.error('Missing API Tennis key. Add API_TENNIS_KEY, APITENNIS_API_KEY, or API_TENNIS_API_KEY.');
  process.exit(2);
}

async function fetchApiTennis(method, params = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} non-JSON ${res.status}: ${text.slice(0, 500)}`); }
  if (!res.ok || String(payload.success) !== '1') {
    throw new Error(`${method} failed HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
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
  const priceLab = Boolean(grouped && grouped >= IDEAL_GROUPED);
  const playable = Boolean(grouped && grouped >= MIN_GROUPED);

  if (strictV3 && playable && grouped >= IDEAL_GROUPED) return 'OFFICIAL_V3_A_PLUS';
  if (strictV3 && playable) return 'OFFICIAL_V3';
  if (priceLab) return 'PRICE_LAB_A';
  if (playable) return 'WATCHLIST_PRICE';
  return 'REJECT';
}
function signalReady(signalClass) {
  return ['OFFICIAL_V3_A_PLUS', 'OFFICIAL_V3', 'PRICE_LAB_A'].includes(signalClass);
}
function candidateBucket(signalClass) {
  if (signalClass === 'OFFICIAL_V3_A_PLUS') return 'A_PLUS';
  if (signalClass === 'OFFICIAL_V3') return 'A';
  if (signalClass === 'PRICE_LAB_A') return 'PRICE_LAB';
  if (signalClass === 'WATCHLIST_PRICE') return 'WATCHLIST';
  return 'REJECT';
}
function extractBookmakerRows(oddsResult, fixturesByKey) {
  const rows = [];
  for (const [matchKey, matchOdds] of Object.entries(oddsResult)) {
    const market = matchOdds?.[MARKET_NAME];
    if (!market || typeof market !== 'object') continue;
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const bookmakers = new Set();
    for (const score of [...P2_SCORES, ...P1_SCORES]) {
      const scoreObj = market?.[score];
      if (scoreObj && typeof scoreObj === 'object') for (const b of Object.keys(scoreObj)) bookmakers.add(b);
    }
    for (const bookmaker of [...bookmakers].sort()) {
      const p2Vals = scoreValues(market, P2_SCORES, bookmaker);
      const p1Vals = scoreValues(market, P1_SCORES, bookmaker);
      const p2Grouped = groupedOdds(p2Vals);
      const p1Grouped = groupedOdds(p1Vals);
      if (!p2Grouped && !p1Grouped) continue;
      const row = {
        scraped_at: nowIso(),
        match_key: String(matchKey),
        event_date: fixture.event_date || '',
        event_time: fixture.event_time || '',
        starts_at: startsAtIso(fixture) || '',
        player1: clean(fixture.event_first_player),
        player2: clean(fixture.event_second_player),
        match_name: matchName(fixture),
        event_type_type: fixture.event_type_type || '',
        tournament_name: fixture.tournament_name || '',
        bookmaker,
        p2_3_6_decimal: p2Vals[0] ?? '',
        p2_4_6_decimal: p2Vals[1] ?? '',
        p2_5_7_decimal: p2Vals[2] ?? '',
        p2_grouped_9_12: p2Grouped ?? '',
        p1_6_3_decimal: p1Vals[0] ?? '',
        p1_6_4_decimal: p1Vals[1] ?? '',
        p1_7_5_decimal: p1Vals[2] ?? '',
        p1_grouped_9_12: p1Grouped ?? '',
        bookmaker_count_for_market: bookmakers.size,
      };
      row.v3_exact_4_6_trigger = safeNumber(row.p2_4_6_decimal) >= 6.25 && safeNumber(row.p2_4_6_decimal) < 7.00 ? 'true' : 'false';
      row.signal_class = classify(row);
      row.candidate_bucket = candidateBucket(row.signal_class);
      row.official_signal_ready = signalReady(row.signal_class) ? 'true' : 'false';
      rows.push(row);
    }
  }
  return rows;
}
function bestRowsByMatch(bookmakerRows) {
  const byMatch = new Map();
  for (const row of bookmakerRows) {
    const grouped = safeNumber(row.p2_grouped_9_12);
    if (!grouped || grouped < MIN_GROUPED) continue;
    const existing = byMatch.get(row.match_key);
    const existingGrouped = existing ? safeNumber(existing.p2_grouped_9_12) : 0;
    if (!existing || grouped > existingGrouped) byMatch.set(row.match_key, row);
  }
  return [...byMatch.values()].sort((a, b) => safeNumber(b.p2_grouped_9_12) - safeNumber(a.p2_grouped_9_12)).slice(0, LIMIT_SIGNALS);
}

async function supabaseRequest(method, route, body) {
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing Supabase env');
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${route} failed ${res.status}: ${text}`);
  return data;
}
async function findExistingSignal(row) {
  const ext = `api-tennis:${row.match_key}:${row.bookmaker}`;
  const route = `${SIGNAL_TABLE}?source=eq.api_tennis&sportsbook=eq.${encodeURIComponent(row.bookmaker)}&external_match_id=eq.${encodeURIComponent(ext)}&select=id,telegram_alert_sent_at&limit=1`;
  const data = await supabaseRequest('GET', route);
  return Array.isArray(data) && data.length ? data[0] : null;
}
function signalPayload(row, scannerRunId) {
  const grouped = safeNumber(row.p2_grouped_9_12);
  const p46 = safeNumber(row.p2_4_6_decimal);
  const signalClass = row.signal_class;
  const ready = signalReady(signalClass);
  return {
    source: 'api_tennis',
    sportsbook: row.bookmaker,
    external_match_id: `api-tennis:${row.match_key}:${row.bookmaker}`,
    match_name: row.match_name,
    tournament: row.tournament_name || null,
    starts_at: row.starts_at || null,
    player1: row.player1 || null,
    player2: row.player2,
    odds_p2_6_3: safeNumber(row.p2_3_6_decimal),
    odds_p2_6_4: p46,
    odds_p2_7_5: safeNumber(row.p2_5_7_decimal),
    reconstructed_p2_9_12_odds: grouped,
    v3_trigger_price: p46,
    signal_class: signalClass,
    execution_status: ready ? 'new' : 'watchlist',
    manual_confirmed: false,
    result_status: 'pending',
    auto_price_confirmed: true,
    auto_price_confirmed_at: nowIso(),
    verified_grouped_odds: grouped,
    price_verification_source: 'api_tennis_get_odds',
    synthetic_filter_pass: signalClass.startsWith('OFFICIAL_V3'),
    synthetic_filter_reason: signalClass.startsWith('OFFICIAL_V3') ? 'Strict 4:6 V3 trigger plus grouped price floor.' : 'API Tennis price-based signal; not strict historical V3 trigger.',
    synthetic_signal_tier: signalClass,
    official_signal_ready: ready,
    strategy_family: signalClass.startsWith('OFFICIAL_V3') ? 'V3_STRICT' : 'PRICE_LAB',
    candidate_bucket: row.candidate_bucket,
    v3_exact_4_6_trigger: row.v3_exact_4_6_trigger === 'true',
    grouped_price_floor: MIN_GROUPED,
    paper_trade_ready: ready,
    paper_trade_notes: ready ? 'Ready for paper tracking / Telegram signal.' : 'Watchlist only.',
    scanner_run_id: scannerRunId,
    raw_payload: { row, source: 'api_tennis', market: MARKET_NAME, target_scores: P2_SCORES, min_grouped: MIN_GROUPED, ideal_grouped: IDEAL_GROUPED },
  };
}
function pricePayload(row, signalId, scannerRunId) {
  const grouped = safeNumber(row.p2_grouped_9_12);
  const signalClass = row.signal_class;
  return {
    signal_id: signalId,
    check_source: 'api_tennis_get_odds',
    sportsbook: row.bookmaker,
    external_match_id: `api-tennis:${row.match_key}:${row.bookmaker}`,
    match_name: row.match_name,
    player2: row.player2,
    odds_p2_6_3: safeNumber(row.p2_3_6_decimal),
    odds_p2_6_4: safeNumber(row.p2_4_6_decimal),
    odds_p2_7_5: safeNumber(row.p2_5_7_decimal),
    reconstructed_p2_9_12_odds: grouped,
    price_age_seconds: 0,
    is_fresh: true,
    is_playable: grouped >= MIN_GROUPED,
    raw_payload: { row, source: 'api_tennis', market: MARKET_NAME },
    scanner_run_id: scannerRunId,
    synthetic_filter_pass: signalClass.startsWith('OFFICIAL_V3'),
    synthetic_signal_tier: signalClass,
    official_signal_ready: signalReady(signalClass),
    strategy_family: signalClass.startsWith('OFFICIAL_V3') ? 'V3_STRICT' : 'PRICE_LAB',
    candidate_bucket: row.candidate_bucket,
    v3_exact_4_6_trigger: row.v3_exact_4_6_trigger === 'true',
    grouped_price_floor: MIN_GROUPED,
    paper_trade_ready: signalReady(signalClass),
    paper_trade_notes: signalReady(signalClass) ? 'Ready for paper tracking.' : 'Watchlist only.',
  };
}
function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function formatSignal(row) {
  return [
    `🎾 <b>SlipIQ First Set Lab</b>`,
    ``,
    `<b>${escapeHtml(row.signal_class)}</b>`,
    `<b>Match:</b> ${escapeHtml(row.match_name)}`,
    `<b>Tournament:</b> ${escapeHtml(row.tournament_name)}`,
    `<b>Start:</b> ${escapeHtml(`${row.event_date} ${row.event_time} UTC`)}`,
    ``,
    `<b>Market:</b> 1st Set Correct Score`,
    `<b>Target:</b> Player 2 wins 3:6 / 4:6 / 5:7`,
    `<b>Book observed:</b> ${escapeHtml(row.bookmaker)}`,
    ``,
    `3:6 = ${row.p2_3_6_decimal}`,
    `4:6 = ${row.p2_4_6_decimal}`,
    `5:7 = ${row.p2_5_7_decimal}`,
    `<b>Grouped odds:</b> ${Number(row.p2_grouped_9_12).toFixed(2)}`,
    ``,
    `<b>Minimum playable:</b> ${MIN_GROUPED.toFixed(2)}`,
    `<b>Ideal:</b> ${IDEAL_GROUPED.toFixed(2)}+`,
    `<b>Rule:</b> Play only if your book still gives grouped ≥ ${MIN_GROUPED.toFixed(2)}.`,
    ``,
    `No bet placed automatically.`,
  ].join('\n');
}
async function sendTelegram(text) {
  if (!telegramBotToken || !telegramChatId) return { skipped: true, reason: 'missing Telegram secrets' };
  const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Telegram failed ${res.status}: ${body}`);
  return JSON.parse(body);
}

const signalFields = [
  'scraped_at', 'match_key', 'event_date', 'event_time', 'starts_at', 'player1', 'player2', 'match_name', 'event_type_type',
  'tournament_name', 'bookmaker', 'p2_3_6_decimal', 'p2_4_6_decimal', 'p2_5_7_decimal', 'p2_grouped_9_12',
  'p1_6_3_decimal', 'p1_6_4_decimal', 'p1_7_5_decimal', 'p1_grouped_9_12', 'bookmaker_count_for_market',
  'v3_exact_4_6_trigger', 'signal_class', 'candidate_bucket', 'official_signal_ready',
];

async function main() {
  ensureDir(OUT_DIR);
  const scannerRunId = `api-tennis-live-v3-${Date.now()}`;
  const summary = {
    generated_at: nowIso(),
    scanner_run_id: scannerRunId,
    date_start: dateStart,
    date_stop: dateStop,
    event_type_keys: includeAllTypes ? ['all'] : eventTypeKeys,
    dry_run: DRY_RUN,
    write_supabase: WRITE_SUPABASE,
    send_telegram: SEND_TELEGRAM,
    min_grouped: MIN_GROUPED,
    ideal_grouped: IDEAL_GROUPED,
    fixture_count: 0,
    odds_match_count: 0,
    bookmaker_rows: 0,
    candidate_rows: 0,
    signals_inserted: 0,
    price_checks_inserted: 0,
    telegram_sent: 0,
    skipped_existing: 0,
    errors: [],
    stop_reason: 'NOT_STARTED',
  };

  try {
    const fixturesFetch = await fetchCombined('get_fixtures', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...fixturesFetch.errors);
    const fixtures = mergeFixtures(fixturesFetch.chunks);
    const fixturesByKey = fixtureMap(fixtures);
    summary.fixture_count = fixtures.length;

    const oddsFetch = await fetchCombined('get_odds', { date_start: dateStart, date_stop: dateStop });
    summary.errors.push(...oddsFetch.errors);
    const oddsResult = mergeOdds(oddsFetch.chunks);
    summary.odds_match_count = Object.keys(oddsResult).length;

    const bookmakerRows = extractBookmakerRows(oddsResult, fixturesByKey);
    const candidates = bestRowsByMatch(bookmakerRows);
    summary.bookmaker_rows = bookmakerRows.length;
    summary.candidate_rows = candidates.length;

    writeCsv(path.join(OUT_DIR, 'api_tennis_all_bookmaker_rows.csv'), bookmakerRows, signalFields);
    writeCsv(path.join(OUT_DIR, 'api_tennis_signal_candidates.csv'), candidates, signalFields);

    const processed = [];
    if (WRITE_SUPABASE && (!supabaseUrl || !supabaseKey)) throw new Error('WRITE_SUPABASE requested but Supabase secrets are missing.');

    for (const row of candidates) {
      const record = { match: row.match_name, bookmaker: row.bookmaker, grouped: row.p2_grouped_9_12, signal_class: row.signal_class };
      if (DRY_RUN || !WRITE_SUPABASE) {
        processed.push({ ...record, action: 'dry_run' });
        continue;
      }
      const existing = await findExistingSignal(row);
      if (existing?.id) {
        summary.skipped_existing += 1;
        processed.push({ ...record, action: 'skipped_existing', signal_id: existing.id });
        continue;
      }
      const inserted = await supabaseRequest('POST', SIGNAL_TABLE, [signalPayload(row, scannerRunId)]);
      const signal = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!signal?.id) throw new Error(`No signal id returned for ${row.match_name}`);
      summary.signals_inserted += 1;
      await supabaseRequest('POST', PRICE_TABLE, [pricePayload(row, signal.id, scannerRunId)]);
      summary.price_checks_inserted += 1;
      let telegram = { skipped: true };
      if (SEND_TELEGRAM && signalReady(row.signal_class)) {
        try {
          telegram = await sendTelegram(formatSignal(row));
          summary.telegram_sent += 1;
          await supabaseRequest('PATCH', `${SIGNAL_TABLE}?id=eq.${signal.id}`, { telegram_alert_sent_at: nowIso(), execution_status: 'alerted', last_alert_error: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await supabaseRequest('PATCH', `${SIGNAL_TABLE}?id=eq.${signal.id}`, { last_alert_error: msg });
          telegram = { error: msg };
        }
      }
      processed.push({ ...record, action: 'inserted', signal_id: signal.id, telegram });
    }

    writeJson(path.join(OUT_DIR, 'processed.json'), processed);
    summary.stop_reason = 'API_TENNIS_LIVE_V3_SCANNER_COMPLETE';

    const report = [
      '# API Tennis Live V3 Signal Scanner',
      '',
      `Generated: ${summary.generated_at}`,
      `Scanner run id: ${scannerRunId}`,
      `Date range: ${dateStart} to ${dateStop}`,
      `Dry run: ${DRY_RUN}`,
      `Write Supabase: ${WRITE_SUPABASE}`,
      `Send Telegram: ${SEND_TELEGRAM}`,
      `Fixtures: ${summary.fixture_count}`,
      `Odds matches: ${summary.odds_match_count}`,
      `Bookmaker rows: ${summary.bookmaker_rows}`,
      `Candidate rows: ${summary.candidate_rows}`,
      `Signals inserted: ${summary.signals_inserted}`,
      `Price checks inserted: ${summary.price_checks_inserted}`,
      `Telegram sent: ${summary.telegram_sent}`,
      '',
      '## Candidates',
      ...candidates.map((r) => `- ${r.signal_class} | ${r.match_name} | ${r.bookmaker} | ${r.tournament_name} | 3:6=${r.p2_3_6_decimal} 4:6=${r.p2_4_6_decimal} 5:7=${r.p2_5_7_decimal} grouped=${r.p2_grouped_9_12}`),
      '',
      '## Errors',
      summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None',
    ];
    fs.writeFileSync(path.join(OUT_DIR, 'api_tennis_live_v3_report.md'), report.join('\n'), 'utf8');
    writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
  } catch (err) {
    summary.stop_reason = `API_TENNIS_LIVE_V3_SCANNER_FAILED:${err instanceof Error ? err.message : String(err)}`;
    writeJson(path.join(OUT_DIR, 'run_summary.json'), summary);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
