#!/usr/bin/env node
/*!
 * SlipIQ V3 fast blind test runner.
 *
 * Uses OddsHarvester historic mode, filters a blind historical date window,
 * reconstructs Player 2 & 9-12 from P2 3-6 / 4-6 / 5-7, then settles from
 * actual first-set score.
 *
 * Read-only. This does not log in and does not place bets.
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

const MIN_DATE = params.min_date || '2026-05-06';
const MAX_DATE = params.max_date || '2026-05-12';
const startDateInput = params.start_date || '';
const endDateInput = params.end_date || '';
const windowDays = Math.max(1, Number.parseInt(params.window_days || '7', 10));
const seed = params.seed || `${Date.now()}`;
const bookmaker = (params.bookmaker || 'bet365').toLowerCase();
const leagues = params.leagues || 'atp-rome,wta-rome';
const season = params.season || 'current';
const maxPages = Number.parseInt(params.max_pages || '3', 10);
const threshold = Number.parseFloat(params.threshold || '3.3');
const targetThreshold = Number.parseFloat(params.target_threshold || '3.5');
const requestDelay = params.request_delay || params['request-delay'] || '1.25';
const maxRuntimeMinutes = Number.parseFloat(params.max_runtime_minutes || params.per_day_runtime_minutes || '20');
const sampleLimit = Number.parseInt(params.sample_limit || '40', 10);
const outDir = params.out || 'artifacts/output/v3-blind-test-fast';
const tmpDir = path.join('.tmp', `historic-blind-${Date.now()}`);

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

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

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function americanToDecimal(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s === '[]') return null;
  const n = Number(s.replace('+', '').replace(',', ''));
  if (!Number.isFinite(n)) return null;
  if (s.startsWith('+') || n >= 100) return 1 + n / 100;
  if (s.startsWith('-') || n <= -100) return 1 + 100 / Math.abs(n);
  return n > 1 ? n : null;
}

function decimalFromAny(value) {
  const direct = num(value);
  if (direct && direct > 1) return direct;
  return americanToDecimal(value);
}

function parseMarketEntries(rawMarket) {
  const s = String(rawMarket ?? '').trim();
  if (!s || s === '[]') return [];
  const entries = [];
  const itemRegex = /correct_score['"]?\s*:\s*['"]([^'"]+)['"][\s\S]*?bookmaker_name['"]?\s*:\s*['"]([^'"]*)['"][\s\S]*?period['"]?\s*:\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = itemRegex.exec(s))) {
    const decimal = decimalFromAny(m[1]);
    if (decimal) entries.push({ american: m[1], decimal, bookmaker: m[2], period: m[3] });
  }
  if (!entries.length) {
    // Fallback for simpler outputs containing a plain price.
    const decimal = decimalFromAny(s);
    if (decimal) entries.push({ american: s, decimal, bookmaker: 'unknown', period: '' });
  }
  return entries.sort((a, b) => b.decimal - a.decimal);
}

function pickBookmaker(rawMarket, target) {
  const entries = parseMarketEntries(rawMarket);
  const targetEntry = entries.find((e) => String(e.bookmaker || '').toLowerCase().includes(target));
  return {
    selected: targetEntry || null,
    bestAny: entries[0] || null,
    bookmakerCount: entries.length,
  };
}

function groupedOdds(a, b, c) {
  if (!a || !b || !c) return null;
  const implied = 1 / a + 1 / b + 1 / c;
  return implied > 0 ? 1 / implied : null;
}

function firstSetScore(row) {
  const candidates = [row.partial_results, row.set_scores, row.score, row.result, row.full_time_score, row.match_result];
  for (const raw of candidates) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const m = s.match(/(\d+)\s*[:\-]\s*(\d+)/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return '';
}

function parseDateOnly(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const d = new Date(s.replace(' UTC', 'Z'));
  if (!Number.isNaN(d.getTime())) return toDateOnly(d);
  const m = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return '';
}

function inWindow(rowDate, window) {
  const d = parseDateOnly(rowDate);
  return d && d >= window.start && d <= window.end;
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
  for (const r of [...plays].sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)))) {
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

function column(row, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return '';
}

const window = chooseWindow();

console.error('[*] SlipIQ V3 blind test fast mode - historic');
console.error(`[*] Window mode: ${window.mode}`);
console.error(`[*] Date window: ${window.start} to ${window.end}`);
console.error(`[*] Seed: ${seed}`);
console.error(`[*] Leagues: ${leagues}`);
console.error(`[*] Season: ${season}`);
console.error(`[*] Bookmaker: ${bookmaker}`);
console.error(`[*] Threshold: ${threshold}`);
console.error(`[*] Target threshold: ${targetThreshold}`);
console.error(`[*] Runtime cap: ${maxRuntimeMinutes} minutes`);
console.error(`[*] Sample limit: ${sampleLimit}`);

const markets = ['correct_score_3_6', 'correct_score_4_6', 'correct_score_5_7'];
const cliArgs = [
  'historic',
  '-s', 'tennis',
  '-l', leagues,
  '--season', season,
  '-m', markets.join(','),
  '--period', '1st_set',
  '-f', 'csv',
  '-o', path.join(tmpDir, 'oddsportal_historic_firstset'),
  '--headless',
  '--request-delay', requestDelay,
  '--concurrency', '1',
  '--max-pages', String(maxPages),
];

const spawnOptions = { stdio: 'inherit', env: { ...process.env } };
if (maxRuntimeMinutes > 0) {
  spawnOptions.timeout = Math.round(maxRuntimeMinutes * 60 * 1000);
  spawnOptions.killSignal = 'SIGTERM';
}
const result = spawnSync('oddsharvester', cliArgs, spawnOptions);
const scraperTimedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');

const files = walk(tmpDir).filter((file) => file.toLowerCase().endsWith('.csv'));
const allRows = [];
const skippedFiles = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) continue;
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const hasNeeded = headers.includes('correct_score_3_6_market') || headers.includes('correct_score_3_6');
  if (!hasNeeded) {
    skippedFiles.push({ file, reason: 'missing correct score columns', headers: headers.slice(0, 40) });
    continue;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((h, j) => [h || `col_${j}`, cells[j] ?? '']));
    const matchDate = column(row, 'match_date', 'date', 'event_date', 'start_time');
    if (!inWindow(matchDate, window)) continue;

    const p36 = pickBookmaker(column(row, 'correct_score_3_6_market', 'correct_score_3_6'), bookmaker);
    const p46 = pickBookmaker(column(row, 'correct_score_4_6_market', 'correct_score_4_6'), bookmaker);
    const p57 = pickBookmaker(column(row, 'correct_score_5_7_market', 'correct_score_5_7'), bookmaker);
    const grouped = groupedOdds(p36.selected?.decimal, p46.selected?.decimal, p57.selected?.decimal);
    const fsScore = firstSetScore(row);
    if (!grouped || grouped < threshold || !fsScore) continue;

    const parsed = {
      scan_date: parseDateOnly(matchDate),
      match_date: matchDate || '',
      league_name: column(row, 'league_name', 'league', 'competition_name', 'tournament') || '',
      home_team: column(row, 'home_team', 'home', 'player1', 'participant_1') || '',
      away_team: column(row, 'away_team', 'away', 'player2', 'participant_2') || '',
      first_set_score: fsScore,
      v3_result: ['3-6', '4-6', '5-7'].includes(fsScore) ? 'WIN' : 'LOSS',
      price_source: bookmaker,
      odds_3_6_decimal: p36.selected.decimal,
      odds_4_6_decimal: p46.selected.decimal,
      odds_5_7_decimal: p57.selected.decimal,
      estimated_player2_9_12_odds: grouped,
      play_status: grouped >= targetThreshold ? 'TARGET_3_50_PLUS' : 'PLAYABLE_3_30_PLUS',
      bookmaker_3_6: p36.selected.bookmaker,
      bookmaker_4_6: p46.selected.bookmaker,
      bookmaker_5_7: p57.selected.bookmaker,
      match_link: column(row, 'match_link', 'url', 'event_url') || '',
    };
    parsed.signal_class = classifySignal(parsed);
    allRows.push(parsed);
  }
}

allRows.sort((a, b) => String(a.match_date).localeCompare(String(b.match_date)));
const trimmed = sampleLimit > 0 ? allRows.slice(0, sampleLimit) : allRows;
const officialRows = trimmed.filter((r) => ['OFFICIAL_V3_TARGET', 'OFFICIAL_V3_PLAYABLE'].includes(r.signal_class));
const targetRows = trimmed.filter((r) => (num(r.estimated_player2_9_12_odds) || 0) >= targetThreshold);

const finalSummary = {
  generated_at: new Date().toISOString(),
  test_type: 'FAST_BLIND_HISTORIC_RANDOM_WINDOW',
  window_mode: window.mode,
  seed,
  min_date: MIN_DATE,
  max_date: MAX_DATE,
  selected_start_date: window.start,
  selected_end_date: window.end,
  bookmaker,
  leagues,
  season,
  max_pages: maxPages,
  threshold,
  target_threshold: targetThreshold,
  request_delay: requestDelay,
  max_runtime_minutes: maxRuntimeMinutes,
  sample_limit: sampleLimit,
  scraper_timed_out: scraperTimedOut,
  scraper_exit_status: result.status,
  scraper_signal: result.signal || null,
  raw_csv_files_scanned: files.length,
  skipped_files: skippedFiles,
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
  `Leagues: ${leagues}`,
  `Season: ${season}`,
  `Threshold: ${threshold}`,
  '',
  'Main result is in v3_blind_test_fast_summary.json.',
  'Raw settled rows are in v3_blind_test_fast_rows.csv.',
].join('\n'));

console.log(JSON.stringify(finalSummary, null, 2));
process.exit(0);
