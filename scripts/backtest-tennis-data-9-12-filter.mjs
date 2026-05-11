#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';

const execFileAsync = promisify(execFile);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function splitList(value) {
  return String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function num(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n')}\n`;
}

function excelDateToISO(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(value ?? '').trim();
  if (!s) return '';
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${String(year).padStart(4, '0')}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  return s;
}

function sideOdds(row, side) {
  const suffix = side === 'winner' ? 'W' : 'L';
  const preferred = [`B365${suffix}`, `PS${suffix}`, `Max${suffix}`, `Avg${suffix}`, `EX${suffix}`, `LB${suffix}`, `CB${suffix}`, `GB${suffix}`, `IW${suffix}`, `SB${suffix}`];
  for (const key of preferred) {
    const n = num(row[key]);
    if (n && n > 1) return { odds: n, source: key };
  }
  return { odds: null, source: '' };
}

function rank(row, side) {
  const key = side === 'winner' ? 'WRank' : 'LRank';
  return num(row[key]);
}

function bucketOdds(odds) {
  if (!odds) return 'missing';
  if (odds < 1.5) return '<1.50';
  if (odds < 2.0) return '1.50-1.99';
  if (odds < 2.5) return '2.00-2.49';
  if (odds < 3.5) return '2.50-3.49';
  if (odds < 5.0) return '3.50-4.99';
  return '5.00+';
}

function bucketRankGap(rankGapAbs) {
  if (rankGapAbs == null) return 'missing';
  if (rankGapAbs <= 25) return '0-25';
  if (rankGapAbs <= 75) return '26-75';
  if (rankGapAbs <= 150) return '76-150';
  return '151+';
}

function roundGroup(round) {
  const s = String(round ?? '').toUpperCase();
  if (/Q|QUAL/.test(s)) return 'qualifying';
  if (/R128|R64|R32|1ST|2ND|3RD/.test(s)) return 'early';
  if (/R16|4TH|QF/.test(s)) return 'middle';
  if (/SF|F|FINAL/.test(s)) return 'late';
  return s || 'unknown';
}

function firstSetSideScore(row, side) {
  const w1 = num(row.W1);
  const l1 = num(row.L1);
  if (w1 == null || l1 == null) return { sideGames: null, oppGames: null, score: '', total: null, sideWon912: false };
  const sideGames = side === 'winner' ? w1 : l1;
  const oppGames = side === 'winner' ? l1 : w1;
  const total = sideGames + oppGames;
  const sideWon912 = sideGames > oppGames && total >= 9 && total <= 12;
  return { sideGames, oppGames, score: `${sideGames}-${oppGames}`, total, sideWon912 };
}

function makeSideRow(row, side, meta) {
  const sideName = String(side === 'winner' ? row.Winner : row.Loser ?? '').trim();
  const oppName = String(side === 'winner' ? row.Loser : row.Winner ?? '').trim();
  if (!sideName || !oppName) return null;
  const so = sideOdds(row, side);
  const oo = sideOdds(row, side === 'winner' ? 'loser' : 'winner');
  const sr = rank(row, side);
  const or = rank(row, side === 'winner' ? 'loser' : 'winner');
  const score = firstSetSideScore(row, side);
  const sideIsUnderdog = so.odds && oo.odds ? so.odds > oo.odds : null;
  const sideIsFavorite = so.odds && oo.odds ? so.odds < oo.odds : null;
  const rankGap = sr != null && or != null ? sr - or : null;
  const rankGapAbs = rankGap != null ? Math.abs(rankGap) : null;
  return {
    source_file: meta.sourceFile,
    tour: meta.tour,
    year: meta.year,
    date: excelDateToISO(row.Date),
    tournament: row.Tourney ?? row.Tournament ?? row.Location ?? '',
    surface: row.Surface ?? '',
    court: row.Court ?? '',
    series: row.Series ?? '',
    round: row.Round ?? '',
    round_group: roundGroup(row.Round),
    best_of: row['Best of'] ?? row.BestOf ?? '',
    side_role_actual: side,
    side_name: sideName,
    opponent_name: oppName,
    winner: row.Winner ?? '',
    loser: row.Loser ?? '',
    side_rank: sr,
    opponent_rank: or,
    rank_gap_side_minus_opp: rankGap,
    rank_gap_abs_bucket: bucketRankGap(rankGapAbs),
    side_match_odds: so.odds,
    side_odds_source: so.source,
    opponent_match_odds: oo.odds,
    side_odds_bucket: bucketOdds(so.odds),
    side_is_underdog: sideIsUnderdog === null ? '' : String(sideIsUnderdog),
    side_is_favorite: sideIsFavorite === null ? '' : String(sideIsFavorite),
    first_set_score_for_side: score.score,
    first_set_total_games: score.total,
    side_won_first_set_9_12: score.sideWon912 ? 1 : 0,
    raw_w1: row.W1 ?? '',
    raw_l1: row.L1 ?? '',
  };
}

function urlVariants(url) {
  const variants = new Set([url]);
  if (url.startsWith('https://')) variants.add(url.replace('https://', 'http://'));
  if (url.startsWith('http://')) variants.add(url.replace('http://', 'https://'));
  for (const u of [...variants]) {
    if (u.endsWith('.xlsx')) variants.add(u.replace(/\.xlsx$/, '.xls'));
    if (u.endsWith('.xls')) variants.add(u.replace(/\.xls$/, '.xlsx'));
  }
  return [...variants];
}

async function fetchWorkbookViaNode(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*',
    },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`download too small: ${buffer.length} bytes`);
  return XLSX.read(buffer, { type: 'buffer', cellDates: true });
}

async function fetchWorkbookViaCurl(url) {
  const tmp = path.join(os.tmpdir(), `tennis-data-${Date.now()}-${Math.random().toString(16).slice(2)}.xlsx`);
  try {
    await execFileAsync('curl', [
      '-L',
      '--fail',
      '--retry', '3',
      '--connect-timeout', '20',
      '--max-time', '120',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      '-o', tmp,
      url,
    ], { timeout: 150000, maxBuffer: 1024 * 1024 });
    const buffer = await fs.readFile(tmp);
    if (buffer.length < 1000) throw new Error(`curl download too small: ${buffer.length} bytes`);
    return XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function fetchWorkbook(url) {
  const errors = [];
  for (const candidate of urlVariants(url)) {
    try {
      return { workbook: await fetchWorkbookViaNode(candidate), finalUrl: candidate, method: 'node_fetch' };
    } catch (error) {
      errors.push(`${candidate} node_fetch: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return { workbook: await fetchWorkbookViaCurl(candidate), finalUrl: candidate, method: 'curl' };
    } catch (error) {
      errors.push(`${candidate} curl: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join(' | '));
}

function rowsFromWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function generatedSources(years, tours) {
  const out = [];
  for (const year of years) {
    for (const tour of tours) {
      if (tour.toLowerCase() === 'atp') out.push({ year, tour: 'ATP', url: `https://www.tennis-data.co.uk/${year}/${year}.xlsx` });
      if (tour.toLowerCase() === 'wta') out.push({ year, tour: 'WTA', url: `https://www.tennis-data.co.uk/${year}/${year}w.xlsx` });
    }
  }
  return out;
}

function filterDefs() {
  const oddsRanges = [
    ['all_odds', 1.01, 100],
    ['odds_1_50_2_49', 1.50, 2.50],
    ['odds_2_00_3_49', 2.00, 3.50],
    ['odds_2_50_4_99', 2.50, 5.00],
    ['odds_3_50_plus', 3.50, 100],
    ['odds_2_00_plus', 2.00, 100],
  ];
  const sideTypes = [
    ['any_side', () => true],
    ['underdog', (r) => r.side_is_underdog === 'true'],
    ['favorite', (r) => r.side_is_favorite === 'true'],
  ];
  const surfaces = ['ANY', 'Hard', 'Clay', 'Grass', 'Carpet'];
  const defs = [];
  for (const [sideName, sideFn] of sideTypes) {
    for (const [oddsName, min, max] of oddsRanges) {
      for (const surface of surfaces) {
        defs.push({ name: `${sideName}_${oddsName}_${surface.toLowerCase()}`, surface, predicate: (r) => sideFn(r) && Number(r.side_match_odds) >= min && Number(r.side_match_odds) < max && (surface === 'ANY' || String(r.surface) === surface) });
      }
    }
  }
  return defs;
}

function summarizeRows(rows, name = 'all') {
  const bets = rows.length;
  const wins = rows.filter((r) => Number(r.side_won_first_set_9_12) === 1).length;
  const losses = bets - wins;
  const hitRate = bets ? wins / bets : 0;
  return { filter: name, bets, wins, losses, hit_rate: hitRate, break_even_odds: hitRate ? 1 / hitRate : null };
}

function groupKey(row, dims) { return dims.map((d) => row[d] ?? '').join(' | '); }
function groupedSummaries(rows, dims, minRows) {
  const map = new Map();
  for (const row of rows) {
    const key = groupKey(row, dims);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const out = [];
  for (const [key, xs] of map.entries()) {
    if (xs.length < minRows) continue;
    const s = summarizeRows(xs, key);
    const parts = key.split(' | ');
    dims.forEach((dim, i) => { s[dim] = parts[i]; });
    out.push(s);
  }
  return out.sort((a, b) => b.hit_rate - a.hit_rate || b.bets - a.bets);
}

function compoundBacktest(rows, odds, startingBankroll, riskFraction) {
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let currentLossStreak = 0;
  let worstLossStreak = 0;
  const curve = [];
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.tournament).localeCompare(String(b.tournament)) || String(a.side_name).localeCompare(String(b.side_name)));
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const stake = bankroll * riskFraction;
    const win = Number(row.side_won_first_set_9_12) === 1;
    const profit = win ? stake * (odds - 1) : -stake;
    if (win) { wins += 1; currentLossStreak = 0; } else { losses += 1; currentLossStreak += 1; worstLossStreak = Math.max(worstLossStreak, currentLossStreak); }
    bankroll += profit;
    peak = Math.max(peak, bankroll);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - bankroll) / peak : 0);
    curve.push({ index: i + 1, filter: row.filter_name ?? '', date: row.date, tournament: row.tournament, side_name: row.side_name, opponent_name: row.opponent_name, surface: row.surface, side_match_odds: row.side_match_odds, first_set_score_for_side: row.first_set_score_for_side, win: win ? 1 : 0, scenario_grouped_odds: odds, stake: Number(stake.toFixed(2)), profit: Number(profit.toFixed(2)), bankroll_after: Number(bankroll.toFixed(2)), drawdown_pct: Number((peak > 0 ? (peak - bankroll) / peak : 0).toFixed(4)) });
  }
  return { bets: sorted.length, wins, losses, hit_rate: sorted.length ? wins / sorted.length : 0, final_bankroll: bankroll, profit: bankroll - startingBankroll, return_pct: bankroll / startingBankroll - 1, worst_losing_streak: worstLossStreak, max_drawdown_pct: maxDrawdown, curve };
}

function compactBacktest(result) {
  return { bets: result.bets, wins: result.wins, losses: result.losses, hit_rate: Number(result.hit_rate.toFixed(4)), final_bankroll: Number(result.final_bankroll.toFixed(2)), profit: Number(result.profit.toFixed(2)), return_pct: Number(result.return_pct.toFixed(4)), worst_losing_streak: result.worst_losing_streak, max_drawdown_pct: Number(result.max_drawdown_pct.toFixed(4)) };
}

async function main() {
  const years = splitList(arg('years', '2024,2025,2026'));
  const tours = splitList(arg('tours', 'atp,wta'));
  const sourceUrls = splitList(arg('urls', ''));
  const outputDir = arg('output-dir', 'artifacts/output/tennis-data-9-12-filter-backtest');
  const startingBankroll = Number(arg('bankroll', '5000')) || 5000;
  const riskFraction = Number(arg('risk', '0.02')) || 0.02;
  const scenarioOdds = splitList(arg('scenario-odds', '3.00,3.30,3.50,3.60')).map(Number).filter((x) => Number.isFinite(x) && x > 1);
  const minRows = Number(arg('min-rows', '50')) || 50;
  const sources = sourceUrls.length ? sourceUrls.map((url, idx) => ({ year: '', tour: `custom_${idx + 1}`, url })) : generatedSources(years, tours);

  const allRows = [];
  const sourceStatus = [];
  for (const source of sources) {
    try {
      console.log(`Downloading ${source.url}`);
      const downloaded = await fetchWorkbook(source.url);
      const rows = rowsFromWorkbook(downloaded.workbook);
      let sideRows = 0;
      for (const row of rows) {
        const winnerRow = makeSideRow(row, 'winner', { sourceFile: downloaded.finalUrl, tour: source.tour, year: source.year });
        const loserRow = makeSideRow(row, 'loser', { sourceFile: downloaded.finalUrl, tour: source.tour, year: source.year });
        if (winnerRow && winnerRow.first_set_score_for_side) { allRows.push(winnerRow); sideRows += 1; }
        if (loserRow && loserRow.first_set_score_for_side) { allRows.push(loserRow); sideRows += 1; }
      }
      sourceStatus.push({ ...source, ok: true, final_url: downloaded.finalUrl, method: downloaded.method, raw_rows: rows.length, side_rows: sideRows });
    } catch (error) {
      sourceStatus.push({ ...source, ok: false, error: error instanceof Error ? error.message : String(error) });
      console.error(`Failed ${source.url}: ${sourceStatus.at(-1).error}`);
    }
  }

  const usable = allRows.filter((r) => r.side_match_odds && r.first_set_score_for_side);
  const leakFree = usable.filter((r) => r.side_is_underdog !== '' || r.side_is_favorite !== '');
  const summary = { mode: 'tennis_data_9_12_filter_backtest_v2_robust_download', config: { years, tours, sourceUrls, startingBankroll, riskFraction, scenarioOdds, minRows }, warnings: ['Tennis-Data stores rows as Winner/Loser, not bookmaker Player 1/Player 2 order. This tests selected-player first-set 9-12 outcomes, not direct Player 2 listing order.', 'Tennis-Data includes match-winner odds, not direct Player & 9-12 grouped odds. Scenario odds are used for bankroll math.', 'Use this to build filters/confidence score, not to claim direct historical Player 2 & 9-12 market availability.'], sourceStatus, rows: { side_rows_total: allRows.length, side_rows_with_match_odds: usable.length, side_rows_with_pre_match_fav_dog: leakFree.length }, overall: summarizeRows(usable, 'all_selected_sides_with_odds'), underdog: summarizeRows(usable.filter((r) => r.side_is_underdog === 'true'), 'underdog_sides'), favorite: summarizeRows(usable.filter((r) => r.side_is_favorite === 'true'), 'favorite_sides'), best_filters: [], backtests: {} };

  const dimSets = [['side_odds_bucket'], ['surface'], ['tour'], ['round_group'], ['side_is_underdog', 'side_odds_bucket'], ['side_is_underdog', 'surface'], ['side_is_underdog', 'surface', 'side_odds_bucket'], ['side_is_underdog', 'round_group', 'side_odds_bucket'], ['surface', 'round_group', 'side_odds_bucket'], ['rank_gap_abs_bucket', 'side_odds_bucket']];
  const grouped = [];
  for (const dims of dimSets) grouped.push(...groupedSummaries(usable, dims, minRows).map((r) => ({ dimensions: dims.join('+'), ...r })));

  const defs = filterDefs();
  const filterSummaries = [];
  const allCurves = [];
  for (const def of defs) {
    const rows = usable.filter(def.predicate);
    if (rows.length < minRows) continue;
    const s = summarizeRows(rows, def.name);
    filterSummaries.push(s);
    if (!summary.backtests[def.name]) summary.backtests[def.name] = {};
    for (const odds of scenarioOdds) {
      const taggedRows = rows.map((r) => ({ ...r, filter_name: def.name }));
      const bt = compoundBacktest(taggedRows, odds, startingBankroll, riskFraction);
      summary.backtests[def.name][`scenario_${odds}`] = compactBacktest(bt);
      if (odds === 3.5 && filterSummaries.length <= 20) allCurves.push(...bt.curve.map((r) => ({ ...r, filter: def.name })));
    }
  }
  summary.best_filters = filterSummaries.sort((a, b) => b.hit_rate - a.hit_rate || b.bets - a.bets).slice(0, 100);

  await fs.mkdir(outputDir, { recursive: true });
  const sideHeaders = ['source_file','tour','year','date','tournament','surface','court','series','round','round_group','best_of','side_role_actual','side_name','opponent_name','winner','loser','side_rank','opponent_rank','rank_gap_side_minus_opp','rank_gap_abs_bucket','side_match_odds','side_odds_source','opponent_match_odds','side_odds_bucket','side_is_underdog','side_is_favorite','first_set_score_for_side','first_set_total_games','side_won_first_set_9_12','raw_w1','raw_l1'];
  const groupHeaders = ['dimensions','filter','bets','wins','losses','hit_rate','break_even_odds','side_odds_bucket','surface','tour','round_group','side_is_underdog','rank_gap_abs_bucket'];
  const filterHeaders = ['filter','bets','wins','losses','hit_rate','break_even_odds'];
  const curveHeaders = ['filter','index','date','tournament','side_name','opponent_name','surface','side_match_odds','first_set_score_for_side','win','scenario_grouped_odds','stake','profit','bankroll_after','drawdown_pct'];
  await fs.writeFile(path.join(outputDir, 'tennis-data-side-candidates.csv'), writeCsv(sideHeaders, usable));
  await fs.writeFile(path.join(outputDir, 'tennis-data-grouped-filter-summary.csv'), writeCsv(groupHeaders, grouped));
  await fs.writeFile(path.join(outputDir, 'tennis-data-best-filters.csv'), writeCsv(filterHeaders, summary.best_filters));
  await fs.writeFile(path.join(outputDir, 'tennis-data-scenario-3-50-bankroll-curves.csv'), writeCsv(curveHeaders, allCurves));
  await fs.writeFile(path.join(outputDir, 'tennis-data-9-12-filter-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exit(1); });
