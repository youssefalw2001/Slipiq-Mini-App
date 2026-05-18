#!/usr/bin/env node
/*
SlipIQ / First Set Lab settlement script.

Reads open live_signals from Supabase, fetches API Tennis fixtures/results, parses
first-set score, grades each signal, and updates live_signals.

Supports both signal types:
- exact_score_cluster: win if first_set_score is inside score_cluster
- first_set_winner: win if selected_side wins the first set

Important parser rules:
- API Tennis may represent a tiebreak set as score_first="6.3", score_second="7.7".
  That means set score 6:7, tiebreak 3:7. We grade the set score only.
- event_status="Set 1" means the first set is still live, so do not settle yet.
- event_status="Set 2" or later means the first set is complete, so we can settle from scores[0].
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const outDir = params.out || 'artifacts/output/first-set-lab-settlement';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const apiKey = process.env.API_TENNIS_KEY || process.env.APITENNIS_API_KEY || process.env.API_TENNIS_API_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';
const limit = Number(params.limit || process.env.SETTLEMENT_LIMIT || '250');
const maxFutureHours = Number(params['max-future-hours'] || process.env.SETTLEMENT_MAX_FUTURE_HOURS || '1');
const now = new Date();

const VALID_FIRST_SET_SCORES = new Set(['6:0','6:1','6:2','6:3','6:4','7:5','7:6','0:6','1:6','2:6','3:6','4:6','5:7','6:7']);
const P1_WIN_SCORES = new Set(['6:0','6:1','6:2','6:3','6:4','7:5','7:6']);
const P2_WIN_SCORES = new Set(['0:6','1:6','2:6','3:6','4:6','5:7','6:7']);
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
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

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}
if (!apiKey) {
  console.error('Missing API Tennis key.');
  process.exit(2);
}

async function sbFetch(tablePath, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${tablePath}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) throw new Error(`Supabase ${tablePath} failed ${res.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  return payload;
}

async function fetchOpenSignals() {
  const cutoffIso = new Date(now.getTime() + maxFutureHours * 3600 * 1000).toISOString();
  const selected = 'id,signal_key,event_key,event_date,event_time,starts_at,match_name,score_cluster,strategy_lane,status,signal_type,selected_side,public_target';
  const queryPath = `live_signals?select=${selected}&status=eq.open&starts_at=lte.${encodeURIComponent(cutoffIso)}&order=starts_at.asc&limit=${limit}`;
  return await sbFetch(queryPath, { method: 'GET' });
}

async function updateSignal(id, patch) {
  const data = await sbFetch(`live_signals?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return Array.isArray(data) ? data[0] : data;
}

async function fetchApiTennis(method, apiParams = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(apiParams)) {
    if (value !== undefined && value !== null && clean(value) !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} non-JSON ${res.status}: ${text.slice(0, 800)}`); }
  if (!res.ok || String(payload.success) !== '1') throw new Error(`${method} failed HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1600)}`);
  return payload.result;
}

async function fetchFixtureByEvent(signal) {
  try {
    const direct = await fetchApiTennis('get_fixtures', { event_key: signal.event_key });
    const arr = normalizeArray(direct);
    const found = arr.find((x) => clean(x.event_key) === clean(signal.event_key));
    if (found) return found;
  } catch {}

  const date = clean(signal.event_date);
  if (!date) return null;
  const result = await fetchApiTennis('get_fixtures', { date_start: date, date_stop: date });
  return normalizeArray(result).find((x) => clean(x.event_key) === clean(signal.event_key)) || null;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
}

function statusText(fixture) {
  return clean(fixture?.event_status || fixture?.event_status_info || fixture?.event_live).toLowerCase();
}

function hasFirstSetCompleted(fixture) {
  const status = statusText(fixture);
  if (status.includes('set 1') || status.includes('1st set')) return false;
  if (['set 2', 'set 3', 'set 4', 'set 5'].some((s) => status.includes(s))) return true;
  if (['finished', 'finished.', 'ft', 'ended', 'complete', 'completed'].some((s) => status.includes(s))) return true;
  if (clean(fixture?.event_final_result) || clean(fixture?.event_winner)) return true;
  return false;
}

function normalizeScorePart(a, b) {
  const rawA = clean(a);
  const rawB = clean(b);
  const x = Number(rawA.split('.')[0]);
  const y = Number(rawB.split('.')[0]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const score = `${x}:${y}`;
  return VALID_FIRST_SET_SCORES.has(score) ? score : null;
}

function parseScoreString(s) {
  const text = clean(s);
  if (!text) return null;
  const m = text.match(/(^|[^0-9])([0-7])(?:\.[0-9]+)?\s*[:/-]\s*([0-7])(?:\.[0-9]+)?([^0-9]|$)/);
  if (!m) return null;
  return normalizeScorePart(m[2], m[3]);
}

function parseFirstSetScore(fixture) {
  if (!fixture || typeof fixture !== 'object') return null;
  const scores = normalizeArray(fixture.scores || fixture.score || fixture.event_score);
  const set1 = scores.find((s) => {
    const setNo = clean(s?.score_set || s?.set || s?.set_number || s?.number || s?.score_name).toLowerCase();
    return setNo === '1' || setNo === 'set 1' || setNo === '1st set';
  }) || scores[0];
  if (set1 && typeof set1 === 'object') {
    const direct = normalizeScorePart(
      set1.score_first ?? set1.home_score ?? set1.player1_score ?? set1.first ?? set1.score_home,
      set1.score_second ?? set1.away_score ?? set1.player2_score ?? set1.second ?? set1.score_away
    );
    if (direct) return direct;
    const fromStr = parseScoreString(set1.score || set1.set_score || set1.result || set1.name);
    if (fromStr) return fromStr;
  }
  const candidates = [fixture.event_first_set, fixture.event_first_set_score, fixture.event_set_score, fixture.event_final_result, fixture.event_game_result, fixture.event_result, fixture.event_score];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const score = parseScoreString(c);
      if (score) return score;
    }
  }
  return null;
}

function firstSetWinnerSide(firstSetScore) {
  if (P1_WIN_SCORES.has(firstSetScore)) return 'P1';
  if (P2_WIN_SCORES.has(firstSetScore)) return 'P2';
  return null;
}

function gradeWin(signal, firstSetScore) {
  const signalType = clean(signal.signal_type) || 'exact_score_cluster';
  if (signalType === 'first_set_winner') {
    return firstSetWinnerSide(firstSetScore) === clean(signal.selected_side);
  }
  const cluster = clean(signal.score_cluster).split('/').map((s) => clean(s)).filter(Boolean);
  return cluster.includes(firstSetScore);
}

async function main() {
  ensureDir(outDir);
  const summary = {
    generated_at: new Date().toISOString(), open_signals_checked: 0, fixtures_found: 0,
    first_set_completed: 0, settled: 0, still_open: 0, parse_failed: 0,
    winners: 0, losers: 0, by_signal_type: {}, errors: [],
  };
  const rows = [];
  const signals = await fetchOpenSignals();
  summary.open_signals_checked = signals.length;
  for (const signal of signals) {
    const signalType = clean(signal.signal_type) || 'exact_score_cluster';
    summary.by_signal_type[signalType] = (summary.by_signal_type[signalType] || 0) + 1;
    const row = {
      signal_key: signal.signal_key, event_key: signal.event_key, event_date: signal.event_date, event_time: signal.event_time,
      match_name: signal.match_name, strategy_lane: signal.strategy_lane, signal_type: signalType,
      selected_side: signal.selected_side || '', score_cluster: signal.score_cluster || '', public_target: signal.public_target || '',
      fixture_found: 'false', first_set_completed: 'false', first_set_score: '', first_set_winner_side: '', settled_win: '', action: '', error: '',
    };
    try {
      const fixture = await fetchFixtureByEvent(signal);
      if (!fixture) {
        row.action = 'fixture_not_found'; summary.still_open += 1; rows.push(row); continue;
      }
      summary.fixtures_found += 1; row.fixture_found = 'true';
      if (!hasFirstSetCompleted(fixture)) {
        row.action = 'first_set_not_finished'; summary.still_open += 1; rows.push(row); continue;
      }
      summary.first_set_completed += 1; row.first_set_completed = 'true';
      const firstSetScore = parseFirstSetScore(fixture);
      if (!firstSetScore) {
        row.action = 'parse_failed';
        row.error = JSON.stringify({ event_status: fixture.event_status, scores: fixture.scores || fixture.score || fixture.event_score || null }).slice(0, 1000);
        summary.parse_failed += 1; rows.push(row); continue;
      }
      const winnerSide = firstSetWinnerSide(firstSetScore);
      const win = gradeWin(signal, firstSetScore);
      await updateSignal(signal.id, { status: 'settled', first_set_score: firstSetScore, settled_win: win, settled_at: new Date().toISOString() });
      row.first_set_score = firstSetScore;
      row.first_set_winner_side = winnerSide || '';
      row.settled_win = String(win);
      row.action = 'settled';
      summary.settled += 1;
      if (win) summary.winners += 1;
      else summary.losers += 1;
      rows.push(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      row.action = 'error'; row.error = message;
      summary.errors.push({ signal_key: signal.signal_key, event_key: signal.event_key, error: message });
      rows.push(row);
    }
  }
  const fields = ['signal_key','event_key','event_date','event_time','match_name','strategy_lane','signal_type','selected_side','score_cluster','public_target','fixture_found','first_set_completed','first_set_score','first_set_winner_side','settled_win','action','error'];
  writeCsv(path.join(outDir, 'first_set_lab_settlement_log.csv'), rows, fields);
  writeJson(path.join(outDir, 'first_set_lab_settlement_summary.json'), summary);
  const lines = [
    '# First Set Lab Settlement', '', `Generated: ${summary.generated_at}`,
    `Open signals checked: ${summary.open_signals_checked}`, `Fixtures found: ${summary.fixtures_found}`,
    `First sets completed: ${summary.first_set_completed}`, `Settled: ${summary.settled}`,
    `Winners: ${summary.winners}`, `Losers: ${summary.losers}`, `Still open: ${summary.still_open}`,
    `Parse failed: ${summary.parse_failed}`, '', '## Signal types checked', '```json', JSON.stringify(summary.by_signal_type, null, 2), '```',
    '', '## Settled rows',
    ...(rows.filter((r) => r.action === 'settled').length ? rows.filter((r) => r.action === 'settled').map((r) => `- ${r.settled_win === 'true' ? 'WIN' : 'LOSS'} | ${r.match_name} | type=${r.signal_type} | target=${r.public_target || r.score_cluster} | first_set=${r.first_set_score}`) : ['None']),
    '', '## Errors', summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None'
  ];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_settlement_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_settlement_fatal_error.json'), { generated_at: new Date().toISOString(), error: err instanceof Error ? err.stack || err.message : String(err) });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
