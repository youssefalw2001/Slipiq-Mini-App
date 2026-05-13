#!/usr/bin/env node
/*!
 * SlipIQ read-only upcoming first-set scanner.
 *
 * Purpose:
 * - Scrape current/upcoming OddsPortal tennis first-set correct-score odds.
 * - Focus on a target bookmaker, default bet365.
 * - Reconstruct Player 2 & 9-12 odds from P2 3-6 / 4-6 / 5-7.
 * - Output actionable upcoming candidates only; never logs in and never bets.
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

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

const date = params.date || formatDate(new Date());
const threshold = Number.parseFloat(params.threshold || '3.3');
const leagues = params.leagues || '';
const targetBookmaker = (params.bookmaker || 'bet365').toLowerCase();
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

console.error(`[*] SlipIQ bet365 live/upcoming scan`);
console.error(`[*] Date: ${date}`);
console.error(`[*] Leagues: ${leagues || 'all available for date'}`);
console.error(`[*] Target bookmaker: ${targetBookmaker}`);
console.error(`[*] Candidate threshold: ${threshold}`);
console.error(`[*] Max runtime minutes: ${maxRuntimeMinutes > 0 ? maxRuntimeMinutes : 'none'}`);
console.error(`[*] OddsHarvester command: oddsharvester ${cliArgs.join(' ')}`);

const spawnOptions = {
  env: { ...process.env },
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
};
if (maxRuntimeMinutes > 0) {
  spawnOptions.timeout = Math.round(maxRuntimeMinutes * 60 * 1000);
  spawnOptions.killSignal = 'SIGTERM';
}

const result = spawnSync('oddsharvester', cliArgs, spawnOptions);
const stdout = result.stdout || '';
const stderr = result.stderr || '';
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

const scraperTimedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
const scraperExitStatus = result.status;
const scraperSignal = result.signal || null;
const commandLog = [
  `command=oddsharvester ${cliArgs.join(' ')}`,
  `status=${scraperExitStatus}`,
  `signal=${scraperSignal || ''}`,
  `error=${result.error ? String(result.error.stack || result.error.message || result.error) : ''}`,
  '',
  '--- stdout ---',
  stdout,
  '',
  '--- stderr ---',
  stderr,
].join('\n');
fs.writeFileSync(path.join(outDir, 'oddsharvester_run.log'), commandLog);

if (result.error && !scraperTimedOut) console.error('Error running oddsharvester:', result.error);
if (scraperTimedOut) console.error('[!] Partial timeout hit. Parsing any files written so far.');
else if (scraperExitStatus && scraperExitStatus !== 0) console.error(`[!] OddsHarvester exited ${scraperExitStatus}. Parsing partial files.`);

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

function parseMarketEntries(rawMarket) {
  const s = String(rawMarket ?? '').trim();
  if (!s || s === '[]') return [];
  const entries = [];
  const itemRegex = /correct_score['"]?\s*:\s*['"]([^'"]+)['"][\s\S]*?bookmaker_name['"]?\s*:\s*['"]([^'"]*)['"][\s\S]*?period['"]?\s*:\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = itemRegex.exec(s))) {
    const decimal = americanToDecimal(m[1]);
    if (decimal) entries.push({ american: m[1], decimal, bookmaker: m[2], period: m[3] });
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

function firstSetScore(partialResults) {
  const s = String(partialResults ?? '').trim();
  const m = s.match(/^(\d+)\s*[:\-]\s*(\d+)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function parseDateTimeUtc(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = new Date(s.replace(' UTC', 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isActionableUpcoming(row, now = new Date()) {
  const matchDate = parseDateTimeUtc(row.match_date);
  if (!matchDate || matchDate.getTime() <= now.getTime()) return false;
  if (row.first_set_score) return false;
  if (/exhibition/i.test(row.league_name || '')) return false;
  return true;
}

const files = walk(outDir).filter((file) => file.toLowerCase().endsWith('.csv'));
const rows = [];
const bestAnyRows = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) continue;
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  if (!headers.includes('correct_score_3_6_market')) continue;

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((h, j) => [h || `col_${j}`, cells[j] ?? '']));
    const p36 = pickBookmaker(row.correct_score_3_6_market, targetBookmaker);
    const p46 = pickBookmaker(row.correct_score_4_6_market, targetBookmaker);
    const p57 = pickBookmaker(row.correct_score_5_7_market, targetBookmaker);
    const fsScore = firstSetScore(row.partial_results);
    const common = {
      scraped_date: row.scraped_date || '',
      match_date: row.match_date || '',
      league_name: row.league_name || '',
      home_team: row.home_team || '',
      away_team: row.away_team || '',
      first_set_score: fsScore || '',
      player2_9_12_result_win: ['3-6', '4-6', '5-7'].includes(fsScore) ? 'true' : 'false',
      match_link: row.match_link || '',
    };

    const targetGrouped = groupedOdds(p36.selected?.decimal, p46.selected?.decimal, p57.selected?.decimal);
    if (targetGrouped) {
      const parsed = {
        ...common,
        price_source: targetBookmaker,
        odds_3_6_decimal: p36.selected.decimal,
        odds_4_6_decimal: p46.selected.decimal,
        odds_5_7_decimal: p57.selected.decimal,
        odds_3_6_american: p36.selected.american,
        odds_4_6_american: p46.selected.american,
        odds_5_7_american: p57.selected.american,
        bookmaker_3_6: p36.selected.bookmaker,
        bookmaker_4_6: p46.selected.bookmaker,
        bookmaker_5_7: p57.selected.bookmaker,
        estimated_player2_9_12_odds: targetGrouped,
        play_status: targetGrouped >= 3.5 ? 'TARGET_3_50_PLUS' : targetGrouped >= 3.3 ? 'PLAYABLE_3_30_PLUS' : targetGrouped >= 3.0 ? 'CAUTION_3_00_PLUS' : 'REJECT',
      };
      parsed.is_actionable_upcoming = isActionableUpcoming(parsed) ? 'true' : 'false';
      rows.push(parsed);
    }

    const bestGrouped = groupedOdds(p36.bestAny?.decimal, p46.bestAny?.decimal, p57.bestAny?.decimal);
    if (bestGrouped) {
      const parsedBest = {
        ...common,
        price_source: 'best_any_bookmaker',
        odds_3_6_decimal: p36.bestAny.decimal,
        odds_4_6_decimal: p46.bestAny.decimal,
        odds_5_7_decimal: p57.bestAny.decimal,
        bookmaker_3_6: p36.bestAny.bookmaker,
        bookmaker_4_6: p46.bestAny.bookmaker,
        bookmaker_5_7: p57.bestAny.bookmaker,
        estimated_player2_9_12_odds: bestGrouped,
        is_actionable_upcoming: '',
      };
      parsedBest.is_actionable_upcoming = isActionableUpcoming(parsedBest) ? 'true' : 'false';
      bestAnyRows.push(parsedBest);
    }
  }
}

rows.sort((a, b) => b.estimated_player2_9_12_odds - a.estimated_player2_9_12_odds);
bestAnyRows.sort((a, b) => b.estimated_player2_9_12_odds - a.estimated_player2_9_12_odds);
const candidates = rows.filter((row) => row.estimated_player2_9_12_odds >= threshold);
const actionableCandidates = candidates.filter((row) => row.is_actionable_upcoming === 'true');

const summary = {
  generated_at: new Date().toISOString(),
  date,
  leagues: leagues || null,
  target_bookmaker: targetBookmaker,
  threshold,
  max_runtime_minutes: maxRuntimeMinutes || null,
  scraper_timed_out: scraperTimedOut,
  scraper_exit_status: scraperExitStatus,
  scraper_signal: scraperSignal,
  scraper_command: `oddsharvester ${cliArgs.join(' ')}`,
  scraper_log_file: 'oddsharvester_run.log',
  raw_csv_files_scanned: files.length,
  target_bookmaker_rows_with_reconstructed_odds: rows.length,
  target_bookmaker_candidates_count: candidates.length,
  actionable_candidates_count: actionableCandidates.length,
  actionable_candidates: actionableCandidates,
  candidates,
  target_bookmaker_rows_top_50: rows.slice(0, 50),
  best_any_bookmaker_rows_top_25: bestAnyRows.slice(0, 25),
  warning: 'Read-only scan. This does not log in, place bets, or guarantee availability inside your bet365 account. Confirm every price manually before any wager.',
};

fs.writeFileSync(path.join(outDir, 'upcoming_firstset_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

const headers = [
  'match_date','league_name','home_team','away_team','first_set_score','is_actionable_upcoming','price_source',
  'odds_3_6_decimal','odds_4_6_decimal','odds_5_7_decimal','estimated_player2_9_12_odds','play_status',
  'bookmaker_3_6','bookmaker_4_6','bookmaker_5_7','match_link'
];
function writeCsv(fileName, dataRows) {
  const csv = [headers.join(','), ...dataRows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n');
  fs.writeFileSync(path.join(outDir, fileName), `${csv}\n`);
}
writeCsv('bet365_firstset_candidates.csv', candidates);
writeCsv('bet365_firstset_actionable_candidates.csv', actionableCandidates);
writeCsv('best_any_bookmaker_firstset_top.csv', bestAnyRows.slice(0, 100));

console.log(JSON.stringify(summary, null, 2));
process.exit(0);
