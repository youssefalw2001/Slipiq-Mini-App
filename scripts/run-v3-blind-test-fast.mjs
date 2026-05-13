#!/usr/bin/env node
/*!
 * SlipIQ V3 fast blind test runner.
 *
 * Runs the existing read-only first-set scanner over a random historical window,
 * then settles Player 2 & 9-12 using actual first-set score.
 *
 * This does not log in and does not place bets.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const MIN_DATE = params.min_date || '2026-01-01';
const MAX_DATE = params.max_date || '2026-05-12';
const startDateInput = params.start_date || '';
const endDateInput = params.end_date || '';
const windowDays = Math.max(1, Number.parseInt(params.window_days || '7', 10));
const seed = params.seed || `${Date.now()}`;
const bookmaker = (params.bookmaker || 'bet365').toLowerCase();
const leagues = params.leagues || '';
const threshold = Number.parseFloat(params.threshold || '3.3');
const targetThreshold = Number.parseFloat(params.target_threshold || '3.5');
const requestDelay = params.request_delay || params['request-delay'] || '1.25';
const perDayRuntimeMinutes = Number.parseFloat(params.per_day_runtime_minutes || '3');
const sampleLimit = Number.parseInt(params.sample_limit || '40', 10);
const outDir = params.out || 'artifacts/output/v3-blind-test-fast';

fs.mkdirSync(outDir, { recursive: true });

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateOnly(d);
}

function daysBetween(a, b) {
  return Math.floor((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function rng() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseWindow() {
  if (startDateInput) {
    const end = endDateInput || addDays(startDateInput, windowDays - 1);
    return { start: startDateInput, end, mode: 'manual' };
  }
  const maxStart = addDays(MAX_DATE, -(windowDays - 1));
  const span = Math.max(0, daysBetween(MIN_DATE, maxStart));
  const rng = mulberry32(hashSeed(seed));
  const offset = Math.floor(rng() * (span + 1));
  const start = addDays(MIN_DATE, offset);
  return { start, end: addDays(start, windowDays - 1), mode: 'random' };
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function newestUpcomingDir() {
  if (!fs.existsSync('.tmp')) return null;
  const dirs = fs.readdirSync('.tmp', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('upcoming-'))
    .map((d) => path.join('.tmp', d.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] || null;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function classifySignal(row) {
  const grouped = num(row.estimated_player2_9_12_odds);
  const p64 = num(row.odds_4_6_decimal);
  if (!grouped || grouped < threshold) return 'REJECT';
  const nearV3 = p64 !== null && p64 >= 6.25 && p64 <= 7.05;
  if (nearV3 && grouped >= targetThreshold) return 'OFFICIAL_V3_TARGET';
  if (nearV3 && grouped >= threshold) return 'OFFICIAL_V3_PLAYABLE';
  if (grouped >= targetThreshold && p64 !== null && p64 > 7.05 && p64 <= 9.0) return 'AGGRESSIVE_V3_TARGET';
  if (grouped >= 5.0) return 'WATCHLIST_LONGSHOT';
  return 'AGGRESSIVE_V3_TARGET';
}

function profitFor(row) {
  const odds = num(row.estimated_player2_9_12_odds) || 0;
  return row.v3_result === 'WIN' ? odds - 1 : -1;
}

function summarize(rows, filterFn = () => true) {
  const plays = rows.filter(filterFn);
  const wins = plays.filter((r) => r.v3_result === 'WIN').length;
  const losses = plays.filter((r) => r.v3_result === 'LOSS').length;
  const settled = wins + losses;
  const avgOdds = settled ? plays.reduce((s, r) => s + (num(r.estimated_player2_9_12_odds) || 0), 0) / settled : 0;
  const profit = plays.reduce((s, r) => s + profitFor(r), 0);
  let longestLosingStreak = 0;
  let current = 0;
  for (const r of plays.sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)))) {
    if (r.v3_result === 'LOSS') {
      current += 1;
      longestLosingStreak = Math.max(longestLosingStreak, current);
    } else if (r.v3_result === 'WIN') {
      current = 0;
    }
  }
  return {
    plays: settled,
    wins,
    losses,
    hit_rate: settled ? wins / settled : 0,
    average_odds: avgOdds,
    break_even_rate: avgOdds ? 1 / avgOdds : 0,
    flat_unit_profit: profit,
    roi: settled ? profit / settled : 0,
    longest_losing_streak: longestLosingStreak,
  };
}

const window = chooseWindow();
const dates = [];
for (let d = window.start; d <= window.end; d = addDays(d, 1)) dates.push(d);

const allCandidates = [];
const daySummaries = [];

console.error('[*] SlipIQ V3 blind test fast mode');
console.error(`[*] Window mode: ${window.mode}`);
console.error(`[*] Date window: ${window.start} to ${window.end}`);
console.error(`[*] Seed: ${seed}`);
console.error(`[*] Bookmaker: ${bookmaker}`);
console.error(`[*] Threshold: ${threshold}`);
console.error(`[*] Target threshold: ${targetThreshold}`);
console.error(`[*] Per-day runtime cap: ${perDayRuntimeMinutes} minutes`);
console.error(`[*] Sample limit: ${sampleLimit}`);

for (const date of dates) {
  if (sampleLimit > 0 && allCandidates.length >= sampleLimit) break;

  const args = [
    'scripts/scan-oddsportal-upcoming-firstset.mjs',
    `--date=${date}`,
    `--bookmaker=${bookmaker}`,
    `--threshold=${threshold}`,
    `--request-delay=${requestDelay}`,
    `--max-runtime-minutes=${perDayRuntimeMinutes}`,
  ];
  if (leagues) args.push(`--leagues=${leagues}`);

  console.error(`[*] Scanning blind date ${date}`);
  const result = spawnSync('node', args, { stdio: 'ignore', env: { ...process.env } });
  const latest = newestUpcomingDir();
  const summaryPath = latest ? path.join(latest, 'upcoming_firstset_summary.json') : null;

  if (!summaryPath || !fs.existsSync(summaryPath)) {
    daySummaries.push({ date, status: 'NO_SUMMARY', exit_status: result.status, error: result.error?.message || null });
    continue;
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch (err) {
    daySummaries.push({ date, status: 'BAD_SUMMARY', exit_status: result.status, error: String(err.message || err) });
    continue;
  }

  const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
  const settled = candidates
    .filter((row) => row.first_set_score)
    .map((row) => {
      const resultWin = ['3-6', '4-6', '5-7'].includes(String(row.first_set_score));
      return {
        ...row,
        scan_date: date,
        v3_result: resultWin ? 'WIN' : 'LOSS',
        signal_class: classifySignal(row),
      };
    });

  allCandidates.push(...settled);
  daySummaries.push({
    date,
    status: 'OK',
    exit_status: result.status,
    scraper_timed_out: summary.scraper_timed_out,
    raw_csv_files_scanned: summary.raw_csv_files_scanned,
    candidates_count: candidates.length,
    settled_candidates_count: settled.length,
  });
}

const trimmed = sampleLimit > 0 ? allCandidates.slice(0, sampleLimit) : allCandidates;
const officialRows = trimmed.filter((r) => ['OFFICIAL_V3_TARGET', 'OFFICIAL_V3_PLAYABLE'].includes(r.signal_class));
const targetRows = trimmed.filter((r) => (num(r.estimated_player2_9_12_odds) || 0) >= targetThreshold);

const finalSummary = {
  generated_at: new Date().toISOString(),
  test_type: 'FAST_BLIND_RANDOM_WINDOW',
  window_mode: window.mode,
  seed,
  min_date: MIN_DATE,
  max_date: MAX_DATE,
  selected_start_date: window.start,
  selected_end_date: window.end,
  dates_scanned: dates,
  bookmaker,
  leagues: leagues || null,
  threshold,
  target_threshold: targetThreshold,
  request_delay: requestDelay,
  per_day_runtime_minutes: perDayRuntimeMinutes,
  sample_limit: sampleLimit,
  day_summaries: daySummaries,
  all_playable_summary: summarize(trimmed),
  target_3_50_plus_summary: summarize(targetRows),
  official_v3_only_summary: summarize(officialRows),
  raw_rows_count: trimmed.length,
  warning: 'Read-only blind test from scraped odds/results. This does not prove future profit and does not place bets.',
};

const rowHeaders = [
  'scan_date','match_date','league_name','home_team','away_team','first_set_score','v3_result','signal_class',
  'price_source','odds_3_6_decimal','odds_4_6_decimal','odds_5_7_decimal','estimated_player2_9_12_odds','play_status',
  'bookmaker_3_6','bookmaker_4_6','bookmaker_5_7','match_link'
];
const csv = [
  rowHeaders.join(','),
  ...trimmed.map((row) => rowHeaders.map((h) => csvEscape(row[h])).join(',')),
].join('\n');

fs.writeFileSync(path.join(outDir, 'v3_blind_test_fast_summary.json'), `${JSON.stringify(finalSummary, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'v3_blind_test_fast_rows.csv'), `${csv}\n`);
fs.writeFileSync(path.join(outDir, 'v3_blind_test_fast_readme.txt'), [
  'SlipIQ V3 Blind Test Fast Mode',
  `Window: ${window.start} to ${window.end}`,
  `Seed: ${seed}`,
  `Bookmaker: ${bookmaker}`,
  `Threshold: ${threshold}`,
  '',
  'Main result is in v3_blind_test_fast_summary.json.',
  'Raw settled rows are in v3_blind_test_fast_rows.csv.',
].join('\n'));

console.log(JSON.stringify(finalSummary, null, 2));
process.exit(0);
