#!/usr/bin/env node
/*
  First Set Lab / SlipIQ Live Betfair Checker

  Reads open Core/Reverse/Mirror signals from Supabase, pulls API-Tennis odds for
  each signal date, looks for Betfair first-set correct-score prices for the same
  match, and compares Betfair grouped odds against the Bet365 source grouped odds.

  Artifact-only by default. Optional Supabase write can be added later after the
  output is verified.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const outDir = params.out || 'artifacts/output/live-betfair-checker';
const targetBookmaker = String(params.bookmaker || 'betfair').toLowerCase();
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const apiTennisKey = process.env.API_TENNIS_KEY || process.env.APITENNIS_API_KEY || process.env.API_TENNIS_API_KEY;
const apiBase = 'https://api.api-tennis.com/tennis/';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function safeNumber(v) {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeCsv(filePath, rows, fields) {
  ensureDir(path.dirname(filePath));
  const out = fs.createWriteStream(filePath, 'utf8');
  out.write(fields.join(',') + '\n');
  for (const row of rows) out.write(fields.map((f) => csvEscape(row[f])).join(',') + '\n');
  out.end();
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function groupedOdds(values) {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
}
function decimalToAmerican(decimal) {
  const d = safeNumber(decimal);
  if (!d || d <= 1) return '';
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function parseScoreCluster(v) {
  return clean(v).split('/').map((s) => clean(s)).filter(Boolean);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function normalizeName(v) {
  return clean(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function namesMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const aParts = na.split(' vs ').map((x) => x.trim());
  const bParts = nb.split(' vs ').map((x) => x.trim());
  if (aParts.length === 2 && bParts.length === 2) {
    return (aParts[0] === bParts[0] && aParts[1] === bParts[1]) || (aParts[0] === bParts[1] && aParts[1] === bParts[0]);
  }
  return na.includes(nb) || nb.includes(na);
}

async function supabaseGetOpenSignals() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY');
  }
  const select = [
    'signal_key','event_date','event_time','starts_at','match_name','public_signal_name','strategy_lane',
    'score_cluster','public_target','status','grouped_odds','score_odds_json','updated_at'
  ].join(',');
  const lanes = ['CORE_P1_ATP_GS_BET365','CORE_P2_GS_REVERSE_STRETCH_BET365','CORE_P1_MIRROR_WTA_OTHER'].join(',');
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/live_signal_unique_results?select=${encodeURIComponent(select)}&status=eq.open&event_date=gte.${new Date().toISOString().slice(0,10)}&strategy_lane=in.(${lanes})&order=event_date.asc,event_time.asc`;
  const res = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase open signals fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function apiTennis(method, args) {
  const url = new URL(apiBase);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiTennisKey);
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && clean(v) !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API Tennis ${method} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.success === 0) throw new Error(`API Tennis ${method} error: ${JSON.stringify(json)}`);
  return Array.isArray(json.result) ? json.result : [];
}

function getEventIdFromSignalKey(signalKey) {
  const first = clean(signalKey).split(':')[0];
  return /^\d+$/.test(first) ? first : '';
}

function getMatchNameFromFixture(fixture) {
  return clean(fixture.event_name) || clean(`${fixture.event_first_player || fixture.event_home_player || ''} vs ${fixture.event_second_player || fixture.event_away_player || ''}`);
}

function flattenOddsRows(raw) {
  const rows = [];
  const walk = (node, ctx = {}) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const next = { ...ctx };
    for (const [k, v] of Object.entries(node)) {
      const lk = k.toLowerCase();
      if (lk.includes('bookmaker')) next.bookmaker = typeof v === 'object' ? clean(v.bookmaker_name || v.name || v.value) : clean(v);
      if (lk.includes('market') || lk.includes('type')) next.market = typeof v === 'object' ? clean(v.name || v.value || v.market_name) : clean(v);
      if (['odd_name','name','label','value','handicap','score','selection','odd_title'].includes(lk)) next.selection = clean(v);
      if (['odd','odds','price','odd_value','value_odd'].includes(lk)) next.odd = safeNumber(v);
      if (lk.includes('score') && typeof v !== 'object') next.selection = clean(v);
    }
    if (next.bookmaker && next.odd && next.selection) rows.push(next);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, next);
  };
  walk(raw);
  return rows;
}

function extractBookScoreOdds(rawOdds, scoreCluster) {
  const flat = flattenOddsRows(rawOdds);
  const scoreMap = new Map();
  for (const row of flat) {
    if (!normalizeName(row.bookmaker).includes(normalizeName(targetBookmaker))) continue;
    const market = normalizeName(row.market);
    const selection = clean(row.selection).replace('-', ':');
    const isFirstSetCorrectScore = market.includes('first') && market.includes('score');
    const score = scoreCluster.find((s) => selection === s || selection.includes(s));
    if (isFirstSetCorrectScore && score && row.odd && row.odd > 1) {
      const prev = scoreMap.get(score);
      if (!prev || row.odd > prev) scoreMap.set(score, row.odd);
    }
  }
  return Object.fromEntries(scoreMap.entries());
}

async function main() {
  ensureDir(outDir);
  if (!apiTennisKey) throw new Error('Missing API_TENNIS_KEY / APITENNIS_API_KEY / API_TENNIS_API_KEY');

  const signals = await supabaseGetOpenSignals();
  const dates = [...new Set(signals.map((s) => s.event_date).filter(Boolean))].sort();
  const fixturesByDate = new Map();
  const oddsByEventId = new Map();
  const rows = [];
  const errors = [];

  for (const date of dates) {
    try {
      const fixtures = await apiTennis('get_fixtures', { date_start: date, date_stop: date });
      fixturesByDate.set(date, fixtures);
      await sleep(250);
    } catch (error) {
      errors.push({ stage: 'fixtures', date, error: String(error.message || error) });
      fixturesByDate.set(date, []);
    }
  }

  for (const signal of signals) {
    const scoreCluster = parseScoreCluster(signal.score_cluster);
    const sourceGrouped = safeNumber(signal.grouped_odds);
    const eventIdFromKey = getEventIdFromSignalKey(signal.signal_key);
    const fixtures = fixturesByDate.get(signal.event_date) || [];
    const fixture = fixtures.find((f) => clean(f.event_key) === eventIdFromKey || clean(f.event_key) === clean(signal.event_key)) || fixtures.find((f) => namesMatch(getMatchNameFromFixture(f), signal.match_name));
    const eventKey = clean(fixture?.event_key || eventIdFromKey);
    let rawOdds = null;
    let bookOdds = {};
    let status = 'MISSING_EVENT';
    let targetGrouped = null;

    if (eventKey) {
      try {
        if (!oddsByEventId.has(eventKey)) {
          const odds = await apiTennis('get_odds', { event_key: eventKey });
          oddsByEventId.set(eventKey, odds);
          await sleep(250);
        }
        rawOdds = oddsByEventId.get(eventKey);
        bookOdds = extractBookScoreOdds(rawOdds, scoreCluster);
        const prices = scoreCluster.map((score) => bookOdds[score]);
        targetGrouped = groupedOdds(prices);
        if (!Object.keys(bookOdds).length) status = 'BETFAIR_MISSING_MARKET';
        else if (!targetGrouped) status = 'BETFAIR_INCOMPLETE_SCORES';
        else if (targetGrouped >= sourceGrouped) status = 'BETFAIR_PLAYABLE';
        else status = 'BETFAIR_WORSE_PRICE';
      } catch (error) {
        status = 'ERROR';
        errors.push({ stage: 'odds', event_key: eventKey, match_name: signal.match_name, error: String(error.message || error) });
      }
    }

    rows.push({
      event_date: signal.event_date,
      event_time: signal.event_time,
      match_name: signal.match_name,
      lane: signal.public_signal_name,
      strategy_lane: signal.strategy_lane,
      target_scores: scoreCluster.join('/'),
      bet365_grouped_decimal: sourceGrouped,
      bet365_grouped_american: decimalToAmerican(sourceGrouped),
      target_bookmaker: targetBookmaker,
      target_grouped_decimal: targetGrouped || '',
      target_grouped_american: targetGrouped ? decimalToAmerican(targetGrouped) : '',
      price_delta_decimal: targetGrouped ? Number((targetGrouped - sourceGrouped).toFixed(6)) : '',
      status,
      event_key: eventKey,
      found_scores_json: JSON.stringify(bookOdds),
    });
  }

  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'live_betfair_checker',
    target_bookmaker: targetBookmaker,
    open_signals_checked: rows.length,
    status_counts: counts,
    playable: rows.filter((r) => r.status === 'BETFAIR_PLAYABLE').length,
    worse_price: rows.filter((r) => r.status === 'BETFAIR_WORSE_PRICE').length,
    missing_or_incomplete: rows.filter((r) => ['BETFAIR_MISSING_MARKET','BETFAIR_INCOMPLETE_SCORES','MISSING_EVENT'].includes(r.status)).length,
    errors,
  };

  writeCsv(path.join(outDir, 'live_betfair_checker_rows.csv'), rows, ['event_date','event_time','match_name','lane','strategy_lane','target_scores','bet365_grouped_decimal','bet365_grouped_american','target_bookmaker','target_grouped_decimal','target_grouped_american','price_delta_decimal','status','event_key','found_scores_json']);
  writeJson(path.join(outDir, 'live_betfair_checker_summary.json'), summary);
  const report = [
    '# Live Betfair Checker',
    '',
    `Generated: ${summary.generated_at}`,
    `Open signals checked: ${summary.open_signals_checked}`,
    `Target bookmaker: ${targetBookmaker}`,
    '',
    '## Status counts',
    ...Object.entries(counts).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Playable signals',
    ...rows.filter((r) => r.status === 'BETFAIR_PLAYABLE').map((r) => `- ${r.match_name} ${r.target_scores}: Bet365 ${r.bet365_grouped_american}, ${targetBookmaker} ${r.target_grouped_american}`),
    '',
    '## Read this correctly',
    `- ${targetBookmaker} is playable only when it has all target scores and grouped odds >= Bet365 grouped odds.`,
    '- Missing or incomplete markets should be skipped, not estimated.',
    '- This workflow checks prices only; it does not place bets.',
  ];
  fs.writeFileSync(path.join(outDir, 'live_betfair_checker_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
