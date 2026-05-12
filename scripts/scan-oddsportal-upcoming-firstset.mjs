#!/usr/bin/env node
/*!
 * SlipIQ OddsPortal upcoming scanner
 *
 * Scrapes upcoming tennis matches from OddsPortal via the oddsharvester CLI.
 * It targets 1st-set correct-score markets for 3-6, 4-6, and 5-7, then
 * reconstructs Player 2 & 9-12 grouped odds.
 *
 * Read-only scanner: it does not log in to books and does not place bets.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const params = {};
for (const arg of args) {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  if (match) params[match[1]] = match[2];
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

const date = params.date || formatDate(new Date());
const threshold = Number.parseFloat(params.threshold || '3.5');
const leagues = params.leagues || '';
const requestDelay = params['request-delay'] || '1.25';
const maxRuntimeMinutes = Number.parseFloat(params['max-runtime-minutes'] || '0');
const outDir = path.join('.tmp', `upcoming-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

const markets = ['correct_score_3_6', 'correct_score_4_6', 'correct_score_5_7'];
const cliArgs = [
  'upcoming',
  '-s', 'tennis',
  '-d', date.replaceAll('-', ''),
  '-m', markets.join(','),
  '--period', '1st_set',
  '-f', 'csv',
  '-o', path.join(outDir, 'oddsportal_upcoming_firstset'),
  '--headless',
  '--request-delay', requestDelay,
  '--concurrency', '1',
];

if (leagues) cliArgs.push('-l', leagues);

console.error(`[*] Scraping upcoming first-set odds for ${date}`);
console.error(`[*] Leagues: ${leagues || 'all available for date'}`);
console.error(`[*] Threshold: ${threshold}`);
console.error(`[*] Max runtime minutes: ${maxRuntimeMinutes > 0 ? maxRuntimeMinutes : 'none'}`);

const spawnOptions = {
  stdio: 'inherit',
  env: { ...process.env },
};
if (maxRuntimeMinutes > 0) {
  spawnOptions.timeout = Math.round(maxRuntimeMinutes * 60 * 1000);
  spawnOptions.killSignal = 'SIGTERM';
}

const result = spawnSync('oddsharvester', cliArgs, spawnOptions);
const scraperTimedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
const scraperExitStatus = result.status;
const scraperSignal = result.signal || null;

if (result.error && !scraperTimedOut) {
  console.error('Error running oddsharvester:', result.error);
}
if (scraperTimedOut) {
  console.error('[!] OddsHarvester hit the partial-scan timeout. Parsing any files written so far.');
} else if (scraperExitStatus && scraperExitStatus !== 0) {
  console.error(`[!] OddsHarvester exited with status ${scraperExitStatus}. Parsing any files written so far.`);
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

function extractBestMarketOdds(rawMarket) {
  const s = String(rawMarket ?? '').trim();
  if (!s || s === '[]') return { decimal: null, american: null, bookmaker: null, period: null };

  const entries = [];
  const itemRegex = /correct_score['"]?\s*:\s*['"]([^'"]+)['"][\s\S]*?bookmaker_name['"]?\s*:\s*['"]([^'"]*)['"][\s\S]*?period['"]?\s*:\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = itemRegex.exec(s))) {
    const decimal = americanToDecimal(m[1]);
    if (decimal) entries.push({ american: m[1], decimal, bookmaker: m[2], period: m[3] });
  }

  if (!entries.length) {
    const fallbackRegex = /[+\-]\d{3,4}|\b\d+(?:\.\d+)?\b/g;
    const candidates = [...s.matchAll(fallbackRegex)]
      .map((x) => ({ american: x[0], decimal: americanToDecimal(x[0]), bookmaker: null, period: null }))
      .filter((x) => x.decimal && x.decimal > 1.01 && x.decimal < 150);
    entries.push(...candidates);
  }

  entries.sort((a, b) => b.decimal - a.decimal);
  return entries[0] || { decimal: null, american: null, bookmaker: null, period: null };
}

function groupedOdds(a, b, c) {
  if (!a || !b || !c) return null;
  const implied = 1 / a + 1 / b + 1 / c;
  return implied > 0 ? 1 / implied : null;
}

function firstSetScore(partialResults) {
  const s = String(partialResults ?? '').trim();
  const m = s.match(/^(\d+)\s*[:\-]\s*(\d+)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

const files = walk(outDir).filter((file) => file.toLowerCase().endsWith('.csv'));
const rows = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) continue;
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  if (!headers.includes('correct_score_3_6_market')) continue;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((h, j) => [h || `col_${j}`, cells[j] ?? '']));
    const m36 = extractBestMarketOdds(row.correct_score_3_6_market);
    const m46 = extractBestMarketOdds(row.correct_score_4_6_market);
    const m57 = extractBestMarketOdds(row.correct_score_5_7_market);
    const reconstructed = groupedOdds(m36.decimal, m46.decimal, m57.decimal);
    if (!reconstructed) continue;

    const fsScore = firstSetScore(row.partial_results);
    rows.push({
      scraped_date: row.scraped_date || '',
      match_date: row.match_date || '',
      league_name: row.league_name || '',
      home_team: row.home_team || '',
      away_team: row.away_team || '',
      first_set_score: fsScore || '',
      player2_9_12_result_win: ['3-6', '4-6', '5-7'].includes(fsScore) ? 'true' : 'false',
      odds_3_6_decimal: m36.decimal,
      odds_4_6_decimal: m46.decimal,
      odds_5_7_decimal: m57.decimal,
      odds_3_6_american: m36.american,
      odds_4_6_american: m46.american,
      odds_5_7_american: m57.american,
      bookmaker_3_6: m36.bookmaker,
      bookmaker_4_6: m46.bookmaker,
      bookmaker_5_7: m57.bookmaker,
      period_3_6: m36.period,
      period_4_6: m46.period,
      period_5_7: m57.period,
      estimated_player2_9_12_odds: reconstructed,
      play_status: reconstructed >= 3.5 ? 'TARGET_3_50_PLUS' : reconstructed >= 3.3 ? 'PLAYABLE_3_30_PLUS' : reconstructed >= 3.0 ? 'CAUTION_3_00_PLUS' : 'REJECT',
      match_link: row.match_link || '',
    });
  }
}

rows.sort((a, b) => b.estimated_player2_9_12_odds - a.estimated_player2_9_12_odds);
const candidates = rows.filter((row) => row.estimated_player2_9_12_odds >= threshold);

const summary = {
  generated_at: new Date().toISOString(),
  date,
  leagues: leagues || null,
  threshold,
  max_runtime_minutes: maxRuntimeMinutes || null,
  scraper_timed_out: scraperTimedOut,
  scraper_exit_status: scraperExitStatus,
  scraper_signal: scraperSignal,
  raw_csv_files_scanned: files.length,
  rows_with_reconstructed_odds: rows.length,
  candidates_count: candidates.length,
  candidates,
  all_rows_top_50: rows.slice(0, 50),
  warning: 'Read-only scan. This does not place bets. Confirm prices manually before any wager. If scraper_timed_out=true, this is partial output only.',
};

fs.writeFileSync(path.join(outDir, 'upcoming_firstset_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const headers = [
  'match_date','league_name','home_team','away_team','odds_3_6_decimal','odds_4_6_decimal','odds_5_7_decimal',
  'estimated_player2_9_12_odds','play_status','bookmaker_3_6','bookmaker_4_6','bookmaker_5_7','match_link'
];
const csv = [headers.join(','), ...candidates.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n');
fs.writeFileSync(path.join(outDir, 'upcoming_firstset_candidates.csv'), `${csv}\n`);

console.log(JSON.stringify(summary, null, 2));

// Always exit 0 so GitHub uploads partial artifacts even if the scraper timed out
// or exited non-zero after writing some files.
process.exit(0);
