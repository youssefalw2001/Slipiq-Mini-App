#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.ODDS_API_KEY || process.env.ODDS_API_IO_KEY || process.env.ODDSAPI_KEY;
const BASE_URL = process.env.ODDS_API_IO_BASE_URL || 'https://api.odds-api.io/v3';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function boolArg(name, fallback = false) {
  const value = arg(name, fallback ? '1' : '0');
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n')}\n`;
}

function norm(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function includesAny(text, needles) {
  const s = norm(text);
  return needles.some((n) => s.includes(norm(n)));
}

function objectValuesText(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((x) => objectValuesText(x, depth + 1)).join(' ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${objectValuesText(v, depth + 1)}`).join(' ');
  return '';
}

function valueToDecimalOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) return value;
  if (typeof value === 'string') {
    const trimmed = value.replace(',', '.').trim();
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 1) return n;
    const american = Number(trimmed.replace('+', ''));
    if (Number.isFinite(american) && Math.abs(american) >= 100) return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  }
  return null;
}

function getId(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return obj.id ?? obj.eventId ?? obj.event_id ?? obj.eventID ?? obj.key ?? obj.slug ?? obj.uuid ?? '';
}

function getName(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return obj.name ?? obj.title ?? obj.eventName ?? obj.event_name ?? obj.match ?? obj.description ?? obj.label ?? '';
}

function eventName(event) {
  const home = event?.homeTeam ?? event?.home_team ?? event?.home ?? event?.competitors?.home ?? event?.team1 ?? event?.player1;
  const away = event?.awayTeam ?? event?.away_team ?? event?.away ?? event?.competitors?.away ?? event?.team2 ?? event?.player2;
  const homeName = typeof home === 'object' ? getName(home) : home;
  const awayName = typeof away === 'object' ? getName(away) : away;
  if (homeName || awayName) return `${homeName || 'Player 1'} vs ${awayName || 'Player 2'}`;
  return getName(event) || objectValuesText(event).slice(0, 120);
}

function player2FromEvent(event) {
  const candidates = [
    event?.awayTeam,
    event?.away_team,
    event?.away,
    event?.team2,
    event?.player2,
    event?.participants?.[1],
    event?.competitors?.[1],
  ];
  for (const c of candidates) {
    const name = typeof c === 'object' ? getName(c) : c;
    if (name) return String(name);
  }
  const name = eventName(event);
  if (name.includes(' vs ')) return name.split(' vs ')[1].trim();
  return '';
}

async function fetchJson(endpoint, params = {}, required = true) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (API_KEY) url.searchParams.set('apiKey', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const err = `${endpoint} HTTP ${res.status}: ${text.slice(0, 500)}`;
    if (!required) return { ok: false, error: err, data: null };
    throw new Error(err);
  }
  return { ok: true, error: null, data: json };
}

function arrayFromResponse(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data', 'results', 'events', 'sports', 'leagues', 'items']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return Object.values(value).filter((x) => x && typeof x === 'object');
}

function oddsArrayFromResponse(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data', 'odds', 'markets', 'bookmakers', 'results']) {
    if (Array.isArray(value[key])) return value[key];
  }
  const out = [];
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(walk);
    const text = objectValuesText(x);
    if (includesAny(text, ['bet365', 'correct score', 'winner', '9-12', '9 12', 'total games', 'exact games', '4-6', '4 6'])) out.push(x);
    Object.values(x).forEach((v) => {
      if (v && typeof v === 'object') walk(v);
    });
  }
  walk(value);
  return [...new Set(out)];
}

function looksLikeBook(item, bookmaker) {
  return includesAny(objectValuesText(item), [bookmaker]);
}

function looksLikeExact46(item) {
  const text = objectValuesText(item);
  const s = norm(text);
  const has46 = s.includes('4 6') || s.includes('4-6');
  return has46 && includesAny(s, ['correct score', 'score', 'set score', 'exact score', 'first set', '1st set']);
}

function looksLikePlayer2_9_12(item, player2) {
  const text = objectValuesText(item);
  const s = norm(text);
  const has912 = s.includes('9 12') || s.includes('9-12') || s.includes('9–12');
  if (!has912) return false;
  if (!includesAny(s, ['winner', 'win', 'exact games', 'total games', 'games', 'set winner'])) return false;
  if (includesAny(s, ['player 2', 'p2', 'away', 'second player'])) return true;
  const tokens = norm(player2).split(' ').filter((x) => x.length >= 2);
  const last = tokens.at(-1);
  return Boolean(last && s.includes(last));
}

function extractAnyOdds(item) {
  const directKeys = ['odds', 'price', 'decimal', 'decimalOdds', 'value', 'bookOdds', 'line'];
  for (const key of directKeys) {
    if (item && typeof item === 'object' && item[key] != null) {
      const v = valueToDecimalOdds(item[key]);
      if (v) return v;
    }
  }
  if (item && typeof item === 'object') {
    for (const v of Object.values(item)) {
      const o = valueToDecimalOdds(v);
      if (o) return o;
    }
  }
  return null;
}

async function discoverSportsAndLeagues(debug) {
  const sportsResp = await fetchJson('/sports', {}, false);
  debug.sports_response_ok = sportsResp.ok;
  if (sportsResp.error) debug.sports_error = sportsResp.error;
  const sports = arrayFromResponse(sportsResp.data);
  debug.sports = sports.slice(0, 100).map((s) => ({ id: getId(s), name: getName(s), text: objectValuesText(s).slice(0, 160) }));
  const tennisSports = debug.sports.filter((s) => includesAny(`${s.id} ${s.name} ${s.text}`, ['tennis', 'atp', 'wta']));

  const leaguesResp = await fetchJson('/leagues', { sport: 'tennis' }, false);
  debug.leagues_response_ok = leaguesResp.ok;
  if (leaguesResp.error) debug.leagues_error = leaguesResp.error;
  const leagues = arrayFromResponse(leaguesResp.data);
  debug.leagues = leagues.slice(0, 200).map((l) => ({ id: getId(l), name: getName(l), text: objectValuesText(l).slice(0, 160) }));
  const tennisLeagues = debug.leagues.filter((l) => includesAny(`${l.id} ${l.name} ${l.text}`, ['tennis', 'atp', 'wta', 'challenger', 'itf']));

  return { tennisSports, tennisLeagues };
}

async function fetchEventsForQuery(params, eventLimit) {
  const resp = await fetchJson('/events', params, false);
  if (!resp.ok) return { events: [], error: resp.error };
  return { events: arrayFromResponse(resp.data).slice(0, eventLimit), error: null };
}

async function main() {
  if (!API_KEY) throw new Error('Missing ODDS_API_KEY / ODDS_API_IO_KEY / ODDSAPI_KEY GitHub secret.');

  const outputDir = arg('output-dir', 'artifacts/output/oddsapi-io-player2-9-12-scan');
  const bookmaker = arg('bookmaker', 'Bet365');
  const hoursAhead = Number(arg('hours-ahead', '72')) || 72;
  const eventLimit = Number(arg('event-limit', '500')) || 500;
  const includeLive = boolArg('include-live', false);
  const now = new Date();
  const startsAfter = now.toISOString();
  const startsBefore = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

  const debug = { baseURL: BASE_URL, queryAttempts: [] };
  const errors = [];
  const { tennisSports, tennisLeagues } = await discoverSportsAndLeagues(debug);

  const queries = [];
  const sportValues = ['tennis', 'Tennis', ...tennisSports.map((s) => s.id || s.name).filter(Boolean)];
  for (const sport of [...new Set(sportValues)]) {
    queries.push({ label: `sport:${sport}`, params: { sport, limit: eventLimit, live: includeLive ? undefined : 'false', startsAfter, startsBefore } });
  }
  for (const league of tennisLeagues.slice(0, 30)) {
    const leagueVal = league.id || league.name;
    if (leagueVal) queries.push({ label: `league:${leagueVal}`, params: { league: leagueVal, sport: 'tennis', limit: eventLimit, live: includeLive ? undefined : 'false', startsAfter, startsBefore } });
  }

  const eventsById = new Map();
  for (const q of queries) {
    debug.queryAttempts.push(q);
    const { events, error } = await fetchEventsForQuery(q.params, eventLimit);
    if (error) errors.push({ stage: 'events', label: q.label, error });
    for (const e of events) {
      const text = objectValuesText(e);
      if (!includesAny(text, ['tennis', 'atp', 'wta', 'challenger', 'itf']) && !q.label.includes('tennis')) continue;
      const id = getId(e) || objectValuesText(e).slice(0, 80);
      eventsById.set(id, e);
    }
  }

  const oddsRows = [];
  const rawEventSummaries = [];

  for (const [eventId, event] of eventsById.entries()) {
    const name = eventName(event);
    const player2 = player2FromEvent(event);
    rawEventSummaries.push({ eventId, name, player2, raw: objectValuesText(event).slice(0, 1000) });

    const oddsQueries = [
      { eventId, bookmakers: bookmaker },
      { eventID: eventId, bookmakers: bookmaker },
      { id: eventId, bookmakers: bookmaker },
      { eventId, bookmaker },
    ];
    for (const params of oddsQueries) {
      const resp = await fetchJson('/odds', params, false);
      if (!resp.ok) {
        errors.push({ stage: 'odds', eventId, params, error: resp.error });
        continue;
      }
      const oddsItems = oddsArrayFromResponse(resp.data);
      for (const item of oddsItems) {
        if (!looksLikeBook(item, bookmaker) && bookmaker) continue;
        const exact46 = looksLikeExact46(item);
        const grouped912 = looksLikePlayer2_9_12(item, player2);
        if (!exact46 && !grouped912) continue;
        oddsRows.push({
          eventId,
          event_name: name,
          player2_candidate: player2,
          bookmaker,
          decimal_odds: extractAnyOdds(item),
          is_exact_4_6_candidate: exact46 ? 'true' : 'false',
          is_player2_9_12_candidate: grouped912 ? 'true' : 'false',
          raw_text_sample: objectValuesText(item).slice(0, 1500),
        });
      }
      // If one odds query succeeds for this event, avoid repeating same odds endpoint variants.
      if (oddsItems.length) break;
    }
  }

  const exactRows = oddsRows.filter((r) => r.is_exact_4_6_candidate === 'true');
  const groupedRows = oddsRows.filter((r) => r.is_player2_9_12_candidate === 'true');
  const groupedAtTarget = groupedRows.filter((r) => Number(r.decimal_odds) >= 3.3);

  const summary = {
    mode: 'oddsapi_io_player2_9_12_market_scan_v1',
    checked_at: new Date().toISOString(),
    config: { bookmaker, hoursAhead, eventLimit, includeLive, startsAfter, startsBefore },
    discovered: {
      tennis_sports_found: tennisSports,
      tennis_leagues_found: tennisLeagues,
      events_scanned: eventsById.size,
      candidate_odd_rows: oddsRows.length,
      exact_4_6_candidate_rows: exactRows.length,
      player2_9_12_candidate_rows: groupedRows.length,
      player2_9_12_rows_at_3_30_plus: groupedAtTarget.length,
    },
    errors: errors.slice(0, 100),
    notes: [
      'This scanner is for Odds-API.io base URL https://api.odds-api.io/v3, not SportsGameOdds and not The Odds API v4.',
      'It uses apiKey query-param auth, per Odds-API.io documentation.',
      'The market detection is fuzzy. If no rows are found, inspect raw-event-summaries.json and errors in the summary.',
      'Manual verification of player order is required before betting.'
    ],
    sample_exact_4_6_rows: exactRows.slice(0, 20),
    sample_player2_9_12_rows: groupedRows.slice(0, 20),
    sample_player2_9_12_target_rows: groupedAtTarget.slice(0, 20),
  };

  await fs.mkdir(outputDir, { recursive: true });
  const headers = ['eventId','event_name','player2_candidate','bookmaker','decimal_odds','is_exact_4_6_candidate','is_player2_9_12_candidate','raw_text_sample'];
  await fs.writeFile(path.join(outputDir, 'oddsapi-io-market-scan-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'oddsapi-io-market-candidates.csv'), writeCsv(headers, oddsRows));
  await fs.writeFile(path.join(outputDir, 'raw-event-summaries.json'), `${JSON.stringify(rawEventSummaries.slice(0, 300), null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'debug-discovery.json'), `${JSON.stringify(debug, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
