#!/usr/bin/env node
/*
  First Set Lab / SlipIQ First Set Over/Under Games backtest.

  Reads API Tennis full historical odds warehouse odds_full_long_combined.csv and
  fixtures_full_combined.csv, detects first-set total games Over/Under markets,
  settles them from first_set_score, and reports combined + separate Over/Under
  research lanes.

  Artifact only. No Supabase writes. No Telegram.
*/

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const warehouseDir = params['warehouse-dir'] || 'combined-warehouse';
const outDir = params.out || 'artifacts/output/first-set-ou-backtest';
const bookmakerFilter = String(params.bookmaker || '').toLowerCase();
const minOdds = Number(params['min-odds'] || '1.01');
const maxOdds = Number(params['max-odds'] || '1000');
const oddsPath = path.join(warehouseDir, 'odds_full_long_combined.csv');
const fixturesPath = path.join(warehouseDir, 'fixtures_full_combined.csv');

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
function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}
async function streamCsv(filePath, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line && lineNo > 1) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells; continue; }
    if (!cells.some((c) => c !== '')) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    await onRow(row, lineNo);
  }
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
function decimalToAmerican(decimal) {
  const d = safeNumber(decimal);
  if (!d || d <= 1) return '';
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function totalGames(score) {
  const s = normalizeScore(score);
  const m = s.match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]);
}
function pct(n, d) { return d ? Number(((n / d) * 100).toFixed(2)) : 0; }

function getFirst(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && clean(row[name]) !== '') return row[name];
  }
  return '';
}
function normalizedMarketText(row) {
  return clean([
    getFirst(row, ['market_name','market','odd_type','type','bet_type']),
    getFirst(row, ['selection_name','odd_name','name','label','value','handicap','selection','odd_title']),
    getFirst(row, ['line','total','point','points'])
  ].join(' ')).toLowerCase();
}
function isFirstSetOuMarket(row) {
  const text = normalizedMarketText(row);
  const hasFirstSet = (text.includes('first') || text.includes('1st') || text.includes('set 1') || text.includes('set1')) && text.includes('set');
  const hasTotalGames = (text.includes('total') || text.includes('over') || text.includes('under')) && text.includes('game');
  const hasOu = text.includes('over') || text.includes('under') || /\bo\s*\d/.test(text) || /\bu\s*\d/.test(text);
  const notMatchTotal = !text.includes('match total') && !text.includes('total match');
  return hasFirstSet && hasTotalGames && hasOu && notMatchTotal;
}
function extractSide(row) {
  const text = normalizedMarketText(row);
  if (/\bover\b|\bo\s*\d/i.test(text)) return 'OVER';
  if (/\bunder\b|\bu\s*\d/i.test(text)) return 'UNDER';
  return '';
}
function extractLine(row) {
  const direct = safeNumber(getFirst(row, ['line','total','point','points','handicap']));
  if (direct) return direct;
  const text = normalizedMarketText(row);
  const m = text.match(/(?:over|under|\bo\b|\bu\b)\s*([0-9]+(?:[\.,][0-9]+)?)/i) || text.match(/([0-9]+(?:[\.,][0-9]+)?)\s*(?:games|game)/i);
  return m ? safeNumber(m[1]) : null;
}
function extractOdds(row) {
  return safeNumber(getFirst(row, ['odd','odds','price','odd_value','value_odd','decimal_odds','bookmaker_odd']));
}
function settle(side, line, games) {
  if (!side || !line || games === null) return 'NO_SCORE';
  if (games === line) return 'PUSH';
  if (side === 'OVER') return games > line ? 'WIN' : 'LOSS';
  if (side === 'UNDER') return games < line ? 'WIN' : 'LOSS';
  return 'NO_SCORE';
}
function key(row) {
  return clean(row.event_key) || clean(`${row.event_date}|${row.match_name}`);
}
function summarize(rows) {
  const graded = rows.filter((r) => r.result === 'WIN' || r.result === 'LOSS');
  const wins = graded.filter((r) => r.result === 'WIN').length;
  const losses = graded.filter((r) => r.result === 'LOSS').length;
  const pushes = rows.filter((r) => r.result === 'PUSH').length;
  const units = graded.reduce((sum, r) => sum + Number(r.profit_units || 0), 0);
  return {
    bets: rows.length,
    graded_bets: graded.length,
    wins,
    losses,
    pushes,
    hit_rate_pct: pct(wins, graded.length),
    profit_units: Number(units.toFixed(6)),
    roi_pct: graded.length ? Number(((units / graded.length) * 100).toFixed(2)) : 0,
    avg_decimal_odds: graded.length ? Number((graded.reduce((sum, r) => sum + Number(r.decimal_odds || 0), 0) / graded.length).toFixed(6)) : 0,
  };
}
function groupSummary(rows, groupName, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const k = keyFn(row) || 'UNKNOWN';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return [...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, xs]) => ({ [groupName]: k, ...summarize(xs) }));
}

async function main() {
  if (!fs.existsSync(oddsPath)) {
    console.error(`Missing odds warehouse file: ${oddsPath}`);
    process.exit(2);
  }
  ensureDir(outDir);

  const fixtureScores = new Map();
  if (fs.existsSync(fixturesPath)) {
    console.log('Streaming fixtures for first-set scores...');
    await streamCsv(fixturesPath, (row) => {
      const k = key(row);
      const score = normalizeScore(getFirst(row, ['first_set_score','first_set','set_1_score','set1_score']));
      if (k && score) fixtureScores.set(k, { first_set_score: score, match_name: clean(row.match_name), event_date: clean(row.event_date), tournament_name: clean(row.tournament_name) });
    });
  }

  const rows = [];
  let oddsRows = 0;
  let candidateRows = 0;
  const marketExamples = new Map();

  console.log('Streaming odds_long for first-set O/U markets...');
  await streamCsv(oddsPath, (row) => {
    oddsRows += 1;
    const bookmaker = clean(getFirst(row, ['bookmaker','bookmaker_name','bookmakerName'])) || 'UNKNOWN';
    if (bookmakerFilter && bookmaker.toLowerCase() !== bookmakerFilter) return;
    if (!isFirstSetOuMarket(row)) return;
    candidateRows += 1;
    const side = extractSide(row);
    const line = extractLine(row);
    const odd = extractOdds(row);
    if (!side || !line || !odd || odd < minOdds || odd > maxOdds) return;
    const k = key(row);
    const fixture = fixtureScores.get(k) || {};
    const firstSetScore = normalizeScore(getFirst(row, ['first_set_score','first_set','set_1_score','set1_score']) || fixture.first_set_score || '');
    const games = totalGames(firstSetScore);
    const result = settle(side, line, games);
    const profitUnits = result === 'WIN' ? odd - 1 : result === 'LOSS' ? -1 : 0;
    const marketName = clean(getFirst(row, ['market_name','market','odd_type','type','bet_type'])) || 'UNKNOWN';
    marketExamples.set(marketName, (marketExamples.get(marketName) || 0) + 1);
    rows.push({
      event_key: k,
      event_date: clean(row.event_date || fixture.event_date),
      match_name: clean(row.match_name || fixture.match_name),
      tournament_name: clean(row.tournament_name || fixture.tournament_name),
      bookmaker,
      market_name: marketName,
      lane: side === 'OVER' ? 'OU_FIRST_SET_OVER_RESEARCH' : 'OU_FIRST_SET_UNDER_RESEARCH',
      side,
      line,
      decimal_odds: odd,
      american_odds: decimalToAmerican(odd),
      first_set_score: firstSetScore,
      first_set_total_games: games ?? '',
      result,
      profit_units: Number(profitUnits.toFixed(6)),
    });
  });

  const graded = rows.filter((r) => r.result === 'WIN' || r.result === 'LOSS');
  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'first_set_ou_backtest_from_warehouse',
    source_files: { odds_long: oddsPath, fixtures: fs.existsSync(fixturesPath) ? fixturesPath : null },
    filters: { bookmaker: bookmakerFilter || 'ALL', min_odds: minOdds, max_odds: maxOdds },
    scanned_odds_rows: oddsRows,
    candidate_ou_rows_seen: candidateRows,
    accepted_ou_rows: rows.length,
    graded_rows: graded.length,
    combined_summary: summarize(rows),
    over_summary: summarize(rows.filter((r) => r.side === 'OVER')),
    under_summary: summarize(rows.filter((r) => r.side === 'UNDER')),
    market_examples: [...marketExamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([market_name, rows]) => ({ market_name, rows })),
  };

  writeCsv(path.join(outDir, 'first_set_ou_rows.csv'), rows, ['event_key','event_date','match_name','tournament_name','bookmaker','market_name','lane','side','line','decimal_odds','american_odds','first_set_score','first_set_total_games','result','profit_units']);
  writeCsv(path.join(outDir, 'first_set_ou_by_side.csv'), groupSummary(rows, 'side', (r) => r.side), ['side','bets','graded_bets','wins','losses','pushes','hit_rate_pct','profit_units','roi_pct','avg_decimal_odds']);
  writeCsv(path.join(outDir, 'first_set_ou_by_line.csv'), groupSummary(rows, 'line', (r) => String(r.line)), ['line','bets','graded_bets','wins','losses','pushes','hit_rate_pct','profit_units','roi_pct','avg_decimal_odds']);
  writeCsv(path.join(outDir, 'first_set_ou_by_bookmaker.csv'), groupSummary(rows, 'bookmaker', (r) => r.bookmaker), ['bookmaker','bets','graded_bets','wins','losses','pushes','hit_rate_pct','profit_units','roi_pct','avg_decimal_odds']);
  writeCsv(path.join(outDir, 'first_set_ou_by_month.csv'), groupSummary(rows, 'month', (r) => clean(r.event_date).slice(0, 7)), ['month','bets','graded_bets','wins','losses','pushes','hit_rate_pct','profit_units','roi_pct','avg_decimal_odds']);
  writeJson(path.join(outDir, 'first_set_ou_summary.json'), summary);

  const bySide = groupSummary(rows, 'side', (r) => r.side);
  const byLine = groupSummary(rows, 'line', (r) => String(r.line));
  const byBook = groupSummary(rows, 'bookmaker', (r) => r.bookmaker).sort((a, b) => b.graded_bets - a.graded_bets).slice(0, 20);
  const report = [
    '# First Set Over/Under Games Backtest',
    '',
    `Generated: ${summary.generated_at}`,
    `Bookmaker filter: ${summary.filters.bookmaker}`,
    `Scanned odds rows: ${summary.scanned_odds_rows}`,
    `Candidate O/U rows seen: ${summary.candidate_ou_rows_seen}`,
    `Accepted O/U rows: ${summary.accepted_ou_rows}`,
    `Graded rows: ${summary.graded_rows}`,
    '',
    '## Combined O/U',
    `- Bets: ${summary.combined_summary.graded_bets}`,
    `- Wins/Losses/Pushes: ${summary.combined_summary.wins}W / ${summary.combined_summary.losses}L / ${summary.combined_summary.pushes}P`,
    `- Hit rate: ${summary.combined_summary.hit_rate_pct}%`,
    `- Profit units: ${summary.combined_summary.profit_units}`,
    `- ROI: ${summary.combined_summary.roi_pct}%`,
    '',
    '## Separate lanes',
    ...bySide.map((r) => `- ${r.side}: ${r.graded_bets} graded, ${r.wins}W/${r.losses}L/${r.pushes}P, ${r.profit_units}u, ROI ${r.roi_pct}%`),
    '',
    '## Top lines',
    ...byLine.slice(0, 20).map((r) => `- ${r.line}: ${r.graded_bets} graded, ${r.wins}W/${r.losses}L/${r.pushes}P, ${r.profit_units}u, ROI ${r.roi_pct}%`),
    '',
    '## Top books by volume',
    ...byBook.map((r) => `- ${r.bookmaker}: ${r.graded_bets} graded, ${r.profit_units}u, ROI ${r.roi_pct}%`),
    '',
    '## Read this correctly',
    '- This is a research lane only. Do not mix it into Core + Reverse proof yet.',
    '- Over and Under should be judged separately and together.',
    '- If accepted rows are low, inspect market_examples because API Tennis may label first-set O/U markets differently.',
  ];
  fs.writeFileSync(path.join(outDir, 'first_set_ou_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
