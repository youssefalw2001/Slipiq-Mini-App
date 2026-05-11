#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import SportsGameOdds from 'sports-odds-api';

const API_KEY = process.env.SPORTS_ODDS_API_KEY_HEADER || process.env.SPORTSGAMEODDS_API_KEY || process.env.SPORTS_GAME_ODDS_API_KEY;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function boolArg(name, fallback = false) {
  const value = arg(name, fallback ? '1' : '0');
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function splitList(value) {
  return String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
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

function valueToDecimalOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.').trim());
    if (Number.isFinite(n) && n > 1) return n;
    const american = Number(value.replace('+', '').trim());
    if (Number.isFinite(american) && Math.abs(american) >= 100) return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  }
  return null;
}

function objectValuesText(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((x) => objectValuesText(x, depth + 1)).join(' ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${objectValuesText(v, depth + 1)}`).join(' ');
  return '';
}

function player2FromEvent(event) {
  const away = event?.teams?.away?.names?.long || event?.teams?.away?.names?.medium || event?.teams?.away?.names?.short;
  const home = event?.teams?.home?.names?.long || event?.teams?.home?.names?.medium || event?.teams?.home?.names?.short;
  const players = event?.players && typeof event.players === 'object' ? Object.values(event.players) : [];
  const names = players.map((p) => p?.name || [p?.firstName, p?.lastName].filter(Boolean).join(' ')).filter(Boolean);
  return away || names[1] || home || '';
}

function eventName(event) {
  const away = event?.teams?.away?.names?.long || event?.teams?.away?.names?.medium || event?.teams?.away?.names?.short;
  const home = event?.teams?.home?.names?.long || event?.teams?.home?.names?.medium || event?.teams?.home?.names?.short;
  if (away || home) return `${away || 'Away'} vs ${home || 'Home'}`;
  const players = event?.players && typeof event.players === 'object' ? Object.values(event.players) : [];
  const names = players.map((p) => p?.name || [p?.firstName, p?.lastName].filter(Boolean).join(' ')).filter(Boolean);
  return names.length ? names.join(' vs ') : event?.eventID || 'Unknown event';
}

function extractBookOdds(odd, bookmakerID) {
  const books = odd?.byBookmaker && typeof odd.byBookmaker === 'object' ? Object.entries(odd.byBookmaker) : [];
  const wanted = norm(bookmakerID);
  for (const [bookKey, book] of books) {
    const bookText = `${bookKey} ${book?.bookmakerID ?? ''}`;
    if (wanted && !norm(bookText).includes(wanted)) continue;
    const odds = valueToDecimalOdds(book?.odds);
    if (odds) return { odds, bookmakerID: book?.bookmakerID || bookKey, available: book?.available };
  }
  return { odds: null, bookmakerID: '', available: false };
}

function looksLikePlayer2_9_12(odd, player2) {
  const text = objectValuesText(odd);
  const s = norm(text);
  const has912 = /\b9\s*12\b/.test(s) || s.includes('9 12') || s.includes('9-12') || s.includes('9–12');
  if (!has912) return false;
  const hasWinnerOrGames = includesAny(s, ['winner', 'win', 'exact games', 'total games', 'games', 'set winner']);
  if (!hasWinnerOrGames) return false;
  if (includesAny(s, ['player 2', 'p2', 'away', 'second player'])) return true;
  if (!player2) return true;
  const p = norm(player2).split(' ').filter((x) => x.length >= 2);
  const last = p.at(-1);
  return Boolean(last && s.includes(last));
}

function looksLikeExact46(odd) {
  const text = objectValuesText(odd);
  const s = norm(text);
  const has46 = /\b4\s*6\b/.test(s) || s.includes('4-6') || s.includes('4 6');
  if (!has46) return false;
  return includesAny(s, ['correct score', 'score', 'set score', 'exact score', 'first set', '1st set', 'period']);
}

function candidateOddRows(event, bookmakerID) {
  const rows = [];
  const odds = event?.odds && typeof event.odds === 'object' ? Object.entries(event.odds) : [];
  const player2 = player2FromEvent(event);
  const name = eventName(event);
  for (const [oddKey, odd] of odds) {
    const book = extractBookOdds(odd, bookmakerID);
    const exact46 = looksLikeExact46(odd);
    const grouped912 = looksLikePlayer2_9_12(odd, player2);
    if (!exact46 && !grouped912) continue;
    rows.push({
      eventID: event.eventID,
      event_name: name,
      sportID: event.sportID,
      leagueID: event.leagueID,
      startsAt: event?.status?.startsAt,
      live: event?.status?.live,
      started: event?.status?.started,
      oddsAvailable: event?.status?.oddsAvailable,
      player2_candidate: player2,
      odd_key: oddKey,
      oddID: odd?.oddID,
      marketName: odd?.marketName,
      betTypeID: odd?.betTypeID,
      periodID: odd?.periodID,
      sideID: odd?.sideID,
      playerID: odd?.playerID,
      book: book.bookmakerID,
      book_available: book.available,
      decimal_odds: book.odds,
      is_exact_4_6_candidate: exact46 ? 'true' : 'false',
      is_player2_9_12_candidate: grouped912 ? 'true' : 'false',
      raw_text_sample: objectValuesText(odd).slice(0, 1000),
    });
  }
  return rows;
}

async function collectPages(iterable, limit) {
  const rows = [];
  for await (const item of iterable) {
    rows.push(item);
    if (rows.length >= limit) break;
  }
  return rows;
}

async function main() {
  if (!API_KEY) throw new Error('Missing SPORTS_ODDS_API_KEY_HEADER GitHub secret / environment variable.');

  const outputDir = arg('output-dir', 'artifacts/output/sportsgameodds-player2-9-12-scan');
  const bookmakerID = arg('bookmaker', 'bet365');
  const hoursAhead = Number(arg('hours-ahead', '24')) || 24;
  const eventLimit = Number(arg('event-limit', '100')) || 100;
  const maxLeagues = Number(arg('max-leagues', '12')) || 12;
  const manualLeagueIDs = splitList(arg('league-ids', ''));
  const manualEventIDs = splitList(arg('event-ids', ''));
  const includeLive = boolArg('include-live', false);
  const client = new SportsGameOdds({ apiKeyParam: API_KEY, timeout: 60000, maxRetries: 2 });

  const now = new Date();
  const startsAfter = now.toISOString();
  const startsBefore = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

  const debug = { authMode: 'apiKeyParam', sports: [], leagues: [], queryAttempts: [] };
  const errors = [];

  try {
    const sportsResp = await client.sports.get();
    const sports = Array.isArray(sportsResp?.data) ? sportsResp.data : Array.isArray(sportsResp) ? sportsResp : Object.values(sportsResp ?? {});
    debug.sports = sports.map((s) => ({ sportID: s?.sportID, name: s?.name || s?.displayName || s?.sportName || objectValuesText(s).slice(0, 100) }));
  } catch (e) {
    debug.sports_error = e instanceof Error ? e.message : String(e);
  }

  try {
    const leaguesResp = await client.leagues.get({ sportID: 'TENNIS' });
    const leagues = Array.isArray(leaguesResp?.data) ? leaguesResp.data : Array.isArray(leaguesResp) ? leaguesResp : Object.values(leaguesResp ?? {});
    debug.leagues = leagues
      .map((l) => ({ leagueID: l?.leagueID, sportID: l?.sportID, name: l?.name || l?.displayName || l?.leagueName || objectValuesText(l).slice(0, 100), enabled: l?.enabled }))
      .filter((l) => l.leagueID);
  } catch (e) {
    debug.leagues_error = e instanceof Error ? e.message : String(e);
  }

  const autoLeagueIDs = debug.leagues
    .filter((l) => includesAny(`${l.leagueID} ${l.name} ${l.sportID}`, ['tennis', 'atp', 'wta', 'challenger', 'itf', 'utr']) || l.sportID === 'TENNIS')
    .map((l) => l.leagueID)
    .filter(Boolean)
    .slice(0, maxLeagues);

  const leagueIDs = manualLeagueIDs.length ? manualLeagueIDs : autoLeagueIDs;

  const eventQueries = [];
  if (manualEventIDs.length) {
    eventQueries.push({ label: 'manual-event-ids', params: { eventIDs: manualEventIDs.join(','), bookmakerID, includeAltLines: true } });
  }
  for (const leagueID of leagueIDs) {
    eventQueries.push({
      label: `league:${leagueID}`,
      params: { leagueID, bookmakerID, oddsAvailable: true, started: includeLive ? undefined : false, startsAfter, startsBefore, includeAltLines: true, limit: 100 },
    });
  }

  const events = new Map();
  const matches = [];

  for (const query of eventQueries) {
    try {
      debug.queryAttempts.push({ label: query.label, params: query.params });
      const got = await collectPages(client.events.get(query.params), eventLimit);
      for (const event of got) {
        if (!events.has(event.eventID)) events.set(event.eventID, event);
      }
    } catch (e) {
      errors.push({ query: query.label, error: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const event of events.values()) matches.push(...candidateOddRows(event, bookmakerID));

  const eventSummaries = [...events.values()].map((event) => ({
    eventID: event.eventID,
    event_name: eventName(event),
    sportID: event.sportID,
    leagueID: event.leagueID,
    startsAt: event?.status?.startsAt,
    odds_count: event?.odds && typeof event.odds === 'object' ? Object.keys(event.odds).length : 0,
    player2_candidate: player2FromEvent(event),
  }));

  const exactRows = matches.filter((r) => r.is_exact_4_6_candidate === 'true');
  const groupedRows = matches.filter((r) => r.is_player2_9_12_candidate === 'true');
  const groupedAtTarget = groupedRows.filter((r) => Number(r.decimal_odds) >= 3.3);

  const summary = {
    mode: 'sportsgameodds_player2_9_12_market_scan_v3_league_mode',
    checked_at: new Date().toISOString(),
    config: { bookmakerID, hoursAhead, eventLimit, maxLeagues, manualLeagueIDs, manualEventIDs, includeLive, startsAfter, startsBefore },
    discovered: {
      sports_matching_tennis: debug.sports.filter((s) => String(s.sportID).includes('TENNIS') || includesAny(`${s.sportID} ${s.name}`, ['tennis'])),
      tennis_like_leagues: debug.leagues,
      queried_league_ids: leagueIDs,
      events_scanned: events.size,
      candidate_odd_rows: matches.length,
      exact_4_6_candidate_rows: exactRows.length,
      player2_9_12_candidate_rows: groupedRows.length,
      player2_9_12_rows_at_3_30_plus: groupedAtTarget.length,
    },
    errors,
    notes: [
      'League-mode scanner for SportsGameOdds free-trial tiers requiring leagueID or eventID.',
      'Uses SportsGameOdds apiKeyParam authentication.',
      'If leagues are discovered but no events are scanned, rerun with specific league_ids from debug-discovery.json.',
      'Verify player order manually before betting.'
    ],
    sample_exact_4_6_rows: exactRows.slice(0, 20),
    sample_player2_9_12_rows: groupedRows.slice(0, 20),
    sample_player2_9_12_target_rows: groupedAtTarget.slice(0, 20),
  };

  await fs.mkdir(outputDir, { recursive: true });
  const headers = ['eventID','event_name','sportID','leagueID','startsAt','live','started','oddsAvailable','player2_candidate','odd_key','oddID','marketName','betTypeID','periodID','sideID','playerID','book','book_available','decimal_odds','is_exact_4_6_candidate','is_player2_9_12_candidate','raw_text_sample'];
  await fs.writeFile(path.join(outputDir, 'sportsgameodds-market-scan-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'sportsgameodds-market-candidates.csv'), writeCsv(headers, matches));
  await fs.writeFile(path.join(outputDir, 'raw-events-sample.json'), `${JSON.stringify(eventSummaries.slice(0, 200), null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'debug-discovery.json'), `${JSON.stringify(debug, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
