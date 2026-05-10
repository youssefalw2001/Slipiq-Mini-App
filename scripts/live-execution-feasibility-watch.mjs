#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const apiKey = process.env.API_TENNIS_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n')}\n`;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((v) => v && typeof v === 'object');
}

async function fetchApi(method, params = {}, attempt = 1) {
  if (!apiKey) throw new Error('Missing API_TENNIS_KEY');
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    if (attempt < 3 && res.status >= 500) {
      await sleep(700 * attempt);
      return fetchApi(method, params, attempt + 1);
    }
    throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') {
    const body = JSON.stringify(payload).slice(0, 800);
    if (/no\s*(event|match|odd|data)|not\s*found|empty/i.test(body)) return method === 'get_odds' ? {} : [];
    throw new Error(`${method} unsuccessful: ${body}`);
  }
  return payload.result;
}

function parseDecimalOdds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) && n > 1 ? n : null;
  }
  return null;
}

function bestDecimalOdds(value) {
  const direct = parseDecimalOdds(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const odds = value.map(bestDecimalOdds).filter((x) => typeof x === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  if (value && typeof value === 'object') {
    const odds = Object.values(value).map(bestDecimalOdds).filter((x) => typeof x === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  return null;
}

function extractCorrectScoreOdds(matchOdds) {
  const market = matchOdds?.['Correct Score 1st Half'];
  if (!market || typeof market !== 'object') return {};
  const out = {};
  for (const [rawScore, rawValue] of Object.entries(market)) {
    const score = String(rawScore ?? '').trim().replace(':', '-');
    if (!/^\d+-\d+$/.test(score)) continue;
    const odds = bestDecimalOdds(rawValue);
    if (odds) out[score] = odds;
  }
  return out;
}

function isDoubles(fixture) {
  return String(fixture.event_first_player ?? '').includes('/') || String(fixture.event_second_player ?? '').includes('/');
}

function matchName(fixture) {
  return `${fixture.event_first_player ?? 'Player 1'} vs ${fixture.event_second_player ?? 'Player 2'}`;
}

function tournamentLevel(fixture) {
  const text = `${fixture.tournament_name ?? ''} ${fixture.tournament_round ?? ''}`.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}

function parseStart(fixture) {
  const date = String(fixture.event_date ?? '').slice(0, 10);
  const time = String(fixture.event_time ?? fixture.event_start_time ?? '').trim();
  if (!date) return null;
  if (/^\d{1,2}:\d{2}/.test(time)) return new Date(`${date}T${time.slice(0, 5)}:00Z`);
  return new Date(`${date}T00:00:00Z`);
}

function leadMinutes(fixture, observedAt) {
  const start = parseStart(fixture);
  if (!start || Number.isNaN(start.getTime())) return null;
  return Math.round((start.getTime() - observedAt.getTime()) / 60000);
}

function leadBucket(m) {
  if (m === null || !Number.isFinite(m)) return 'unknown';
  if (m < 0) return 'past_start';
  if (m < 30) return 'lead_0_29';
  if (m < 60) return 'lead_30_59';
  if (m < 120) return 'lead_60_119';
  if (m < 240) return 'lead_120_239';
  if (m < 300) return 'lead_240_299';
  if (m < 360) return 'lead_300_359';
  return 'lead_360_plus';
}

function bandTag(odds) {
  if (odds >= 6.5 && odds < 7.0) return 'ultra_v1_650_699';
  if (odds >= 6.25 && odds < 7.0) return 'official_v3_strict_625_699';
  if (odds >= 6.0 && odds < 7.0) return 'official_v3_600_699';
  if (odds >= 5.5 && odds <= 7.5) return 'official_v2_scanner_550_750';
  return 'outside_tracked_range';
}

async function runCycle(cycle, dateStart, dateStop, maxFixtures, scorelines) {
  const observedAt = new Date();
  const fixtures = normalizeArray(await fetchApi('get_fixtures', { date_start: dateStart, date_stop: dateStop }));
  const oddsResult = await fetchApi('get_odds', { date_start: dateStart, date_stop: dateStop });
  const fixtureByKey = new Map(fixtures.map((f) => [String(f.event_key), f]));
  const rows = [];
  let oddsMatchesSeen = 0;
  let eligibleTourOtherSingles = 0;

  for (const [eventKey, matchOdds] of Object.entries(oddsResult ?? {})) {
    oddsMatchesSeen += 1;
    const fixture = fixtureByKey.get(String(eventKey));
    if (!fixture || isDoubles(fixture)) continue;
    const level = tournamentLevel(fixture);
    if (level !== 'tour_other') continue;
    eligibleTourOtherSingles += 1;
    if (eligibleTourOtherSingles > maxFixtures) break;
    const correctScores = extractCorrectScoreOdds(matchOdds);
    const lead = leadMinutes(fixture, observedAt);
    for (const scoreline of scorelines) {
      const odds = correctScores[scoreline];
      if (!odds) continue;
      rows.push({
        cycle,
        observed_at: observedAt.toISOString(),
        date_start: dateStart,
        date_stop: dateStop,
        event_key: eventKey,
        event_date: fixture.event_date ?? '',
        event_time: fixture.event_time ?? fixture.event_start_time ?? '',
        lead_minutes: lead,
        lead_bucket: leadBucket(lead),
        match: matchName(fixture),
        tournament: fixture.tournament_name ?? '',
        tournament_round: fixture.tournament_round ?? '',
        tournament_level: level,
        scoreline,
        odds,
        band_tag: bandTag(odds),
        official_v3_strict: scoreline === '4-6' && odds >= 6.25 && odds < 7.0 ? 'true' : 'false',
        ultra_v1: scoreline === '4-6' && odds >= 6.5 && odds < 7.0 ? 'true' : 'false',
        executable_pre_start: lead !== null && lead > 0 ? 'true' : 'false',
        preferred_lead_120_299: lead !== null && lead >= 120 && lead <= 299 ? 'true' : 'false',
      });
    }
  }
  return { rows, fixturesLoaded: fixtures.length, oddsMatchesSeen, eligibleTourOtherSingles };
}

function summarize(rows, cycleSummaries, config) {
  const count = (predicate) => rows.filter(predicate).length;
  const uniqueStrict = new Set(rows.filter((r) => r.official_v3_strict === 'true').map((r) => r.event_key)).size;
  const uniqueUltra = new Set(rows.filter((r) => r.ultra_v1 === 'true').map((r) => r.event_key)).size;
  const byLeadBucket = {};
  const byBand = {};
  for (const row of rows) {
    byLeadBucket[row.lead_bucket] = (byLeadBucket[row.lead_bucket] ?? 0) + 1;
    byBand[row.band_tag] = (byBand[row.band_tag] ?? 0) + 1;
  }
  return {
    ok: cycleSummaries.every((x) => x.ok),
    mode: 'live_execution_feasibility_watch_v1',
    note: 'Research observation only. No betting, no Telegram alert, no external execution.',
    config,
    cycle_summaries: cycleSummaries,
    observations_logged: rows.length,
    official_v3_strict_observations: count((r) => r.official_v3_strict === 'true'),
    official_v3_strict_unique_matches: uniqueStrict,
    official_v3_strict_pre_start: count((r) => r.official_v3_strict === 'true' && r.executable_pre_start === 'true'),
    official_v3_strict_preferred_lead_120_299: count((r) => r.official_v3_strict === 'true' && r.preferred_lead_120_299 === 'true'),
    ultra_v1_observations: count((r) => r.ultra_v1 === 'true'),
    ultra_v1_unique_matches: uniqueUltra,
    by_lead_bucket: byLeadBucket,
    by_band: byBand,
    examples: rows.filter((r) => r.official_v3_strict === 'true').slice(0, 20),
    verdict: uniqueStrict > 0 ? 'OFFICIAL_V3_STRICT_ODDS_VISIBLE_LIVE_PRE_MATCH_CHECK_ROWS' : 'NO_OFFICIAL_V3_STRICT_CANDIDATES_FOUND_THIS_RUN',
  };
}

async function main() {
  const dateStart = arg('date-start', isoDate(0));
  const dateStop = arg('date-stop', isoDate(1));
  const cycles = Number(arg('cycles', '1')) || 1;
  const intervalSeconds = Number(arg('interval-seconds', '0')) || 0;
  const maxFixtures = Number(arg('max-fixtures', '250')) || 250;
  const scorelines = String(arg('scorelines', '4-6,3-6,6-4,6-3')).split(',').map((x) => x.trim()).filter(Boolean);
  const outputDir = arg('output-dir', 'artifacts/output/live-execution-feasibility-watch');
  const rows = [];
  const cycleSummaries = [];

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    try {
      const result = await runCycle(cycle, dateStart, dateStop, maxFixtures, scorelines);
      rows.push(...result.rows);
      cycleSummaries.push({ cycle, ok: true, ...result, rows: undefined, observations: result.rows.length });
    } catch (error) {
      cycleSummaries.push({ cycle, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    if (cycle < cycles && intervalSeconds > 0) await sleep(intervalSeconds * 1000);
  }

  const config = { dateStart, dateStop, cycles, intervalSeconds, maxFixtures, scorelines };
  const summary = summarize(rows, cycleSummaries, config);
  const headers = ['cycle','observed_at','date_start','date_stop','event_key','event_date','event_time','lead_minutes','lead_bucket','match','tournament','tournament_round','tournament_level','scoreline','odds','band_tag','official_v3_strict','ultra_v1','executable_pre_start','preferred_lead_120_299'];
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'live-execution-feasibility-observations.csv'), writeCsv(headers, rows));
  await fs.writeFile(path.join(outputDir, 'live-execution-feasibility-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
