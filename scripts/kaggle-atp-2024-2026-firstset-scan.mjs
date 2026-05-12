import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
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
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseDateValue(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function firstSetFromListedScore(score) {
  const s = String(score || '').trim();
  const m = s.match(/(\d+)\s*-\s*(\d+)(?:\s*\(\d+\))?/);
  if (!m) return null;
  return { p1Games: Number(m[1]), p2Games: Number(m[2]), raw: m[0] };
}

function oddsBand(odd) {
  if (odd === null) return 'unknown';
  if (odd < 1.5) return '<1.50';
  if (odd < 2.0) return '1.50-1.99';
  if (odd < 2.5) return '2.00-2.49';
  if (odd < 3.0) return '2.50-2.99';
  if (odd < 3.5) return '3.00-3.49';
  if (odd < 4.0) return '3.50-3.99';
  if (odd < 5.0) return '4.00-4.99';
  return '5.00+';
}

function rankGapBand(rank1, rank2) {
  if (rank1 === null || rank2 === null) return 'unknown';
  const abs = Math.abs(rank2 - rank1);
  if (abs <= 10) return '0-10';
  if (abs <= 25) return '11-25';
  if (abs <= 50) return '26-50';
  if (abs <= 100) return '51-100';
  return '101+';
}

function addGroup(groups, keyParts, row) {
  const key = keyParts.join(' | ');
  if (!groups.has(key)) {
    groups.set(key, {
      filter: key,
      rows: 0,
      wins: 0,
      losses: 0,
      exact_3_6: 0,
      exact_4_6: 0,
      exact_5_7: 0,
      player2_first_set_wins: 0,
    });
  }
  const g = groups.get(key);
  g.rows += 1;
  if (row.player2_9_12_win) g.wins += 1;
  else g.losses += 1;
  if (row.player2_exact_3_6_win) g.exact_3_6 += 1;
  if (row.player2_exact_4_6_win) g.exact_4_6 += 1;
  if (row.player2_exact_5_7_win) g.exact_5_7 += 1;
  if (row.player2_first_set_win) g.player2_first_set_wins += 1;
}

function finalizeGroup(g) {
  g.hit_rate = g.rows ? g.wins / g.rows : 0;
  g.break_even_odds = g.wins ? g.rows / g.wins : null;
  for (const odds of [3.0, 3.3, 3.5, 3.6]) {
    const key = `roi_at_${odds.toFixed(2).replace('.', '_')}`;
    g[key] = g.rows ? ((g.wins * (odds - 1)) - g.losses) / g.rows : 0;
  }
  return g;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || 'data/kaggle-atp/atp_tennis.csv';
  const dateStart = args['date-start'] || '2024-01-01';
  const dateStop = args['date-stop'] || '2026-12-31';
  const outDir = args['out-dir'] || 'output/kaggle-atp-2024-2026';
  const minRows = Number(args['min-rows'] || 50);

  await fs.mkdir(outDir, { recursive: true });
  const raw = await fs.readFile(input, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`No data rows found in ${input}`);

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const required = ['Date', 'Player_1', 'Player_2', 'Winner', 'Score'];
  for (const col of required) {
    if (!(col in idx)) throw new Error(`Missing required column: ${col}`);
  }

  const rows2024To2026 = [];
  const derivedRows = [];
  const groups = new Map();
  const parseErrors = [];

  let sourceRowsTotal = 0;
  let dateFilteredRows = 0;
  let parseableFirstSetRows = 0;
  let player2FirstSetWins = 0;
  let player2NineToTwelveWins = 0;
  let exact36 = 0;
  let exact46 = 0;
  let exact57 = 0;

  for (let lineNo = 1; lineNo < lines.length; lineNo += 1) {
    sourceRowsTotal += 1;
    const cells = parseCsvLine(lines[lineNo]);
    const get = (name) => cells[idx[name]] ?? '';
    const isoDate = parseDateValue(get('Date'));
    if (!isoDate || isoDate < dateStart || isoDate > dateStop) continue;
    dateFilteredRows += 1;

    const baseObj = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    rows2024To2026.push(baseObj);

    const fsSet = firstSetFromListedScore(get('Score'));
    if (!fsSet) {
      parseErrors.push({ lineNo: lineNo + 1, date: isoDate, score: get('Score'), reason: 'first set not parseable' });
      continue;
    }

    const p1First = fsSet.p1Games;
    const p2First = fsSet.p2Games;
    const listedFirstSetScore = `${p1First}-${p2First}`;
    const player2FirstWin = p2First > p1First;
    const player2Exact36 = listedFirstSetScore === '3-6';
    const player2Exact46 = listedFirstSetScore === '4-6';
    const player2Exact57 = listedFirstSetScore === '5-7';
    const player2NineToTwelve = player2Exact36 || player2Exact46 || player2Exact57;

    parseableFirstSetRows += 1;
    if (player2FirstWin) player2FirstSetWins += 1;
    if (player2NineToTwelve) player2NineToTwelveWins += 1;
    if (player2Exact36) exact36 += 1;
    if (player2Exact46) exact46 += 1;
    if (player2Exact57) exact57 += 1;

    const p1 = get('Player_1');
    const p2 = get('Player_2');
    const winner = get('Winner');
    const rank1 = toNumber(get('Rank_1'));
    const rank2 = toNumber(get('Rank_2'));
    const odd1 = toNumber(get('Odd_1'));
    const odd2 = toNumber(get('Odd_2'));
    const player2Underdog = odd1 !== null && odd2 !== null ? odd2 > odd1 : null;
    const player2Favorite = odd1 !== null && odd2 !== null ? odd2 < odd1 : null;

    const row = {
      Date: isoDate,
      Tournament: get('Tournament'),
      Series: get('Series'),
      Court: get('Court'),
      Surface: get('Surface'),
      Round: get('Round'),
      Best_of: get('Best of'),
      Player_1: p1,
      Player_2: p2,
      Winner: winner,
      Rank_1: get('Rank_1'),
      Rank_2: get('Rank_2'),
      Pts_1: get('Pts_1'),
      Pts_2: get('Pts_2'),
      Odd_1: get('Odd_1'),
      Odd_2: get('Odd_2'),
      Score: get('Score'),
      raw_first_set_score: fsSet.raw,
      p1_first_set_games: p1First,
      p2_first_set_games: p2First,
      listed_first_set_score: listedFirstSetScore,
      player2_first_set_win: player2FirstWin,
      player2_9_12_win: player2NineToTwelve,
      player2_exact_3_6_win: player2Exact36,
      player2_exact_4_6_win: player2Exact46,
      player2_exact_5_7_win: player2Exact57,
      player2_is_match_winner: String(winner).trim().toLowerCase() === String(p2).trim().toLowerCase(),
      player2_is_underdog_by_match_odds: player2Underdog,
      player2_is_favorite_by_match_odds: player2Favorite,
      player2_match_odds_band: oddsBand(odd2),
      rank_gap_band_abs: rankGapBand(rank1, rank2),
      rank2_minus_rank1: rank1 !== null && rank2 !== null ? rank2 - rank1 : null,
    };
    derivedRows.push(row);

    const safe = (value, fallback = 'unknown') => String(value || fallback).trim() || fallback;
    addGroup(groups, ['Surface', safe(row.Surface)], row);
    addGroup(groups, ['Series', safe(row.Series)], row);
    addGroup(groups, ['Round', safe(row.Round)], row);
    addGroup(groups, ['P2Odds', row.player2_match_odds_band], row);
    addGroup(groups, ['RankGap', row.rank_gap_band_abs], row);
    addGroup(groups, ['P2Underdog', String(row.player2_is_underdog_by_match_odds)], row);
    addGroup(groups, ['Surface+P2Odds', safe(row.Surface), row.player2_match_odds_band], row);
    addGroup(groups, ['Series+P2Odds', safe(row.Series), row.player2_match_odds_band], row);
    addGroup(groups, ['Surface+P2Underdog', safe(row.Surface), String(row.player2_is_underdog_by_match_odds)], row);
    addGroup(groups, ['Series+P2Underdog', safe(row.Series), String(row.player2_is_underdog_by_match_odds)], row);
    addGroup(groups, ['Surface+Round+P2Odds', safe(row.Surface), safe(row.Round), row.player2_match_odds_band], row);
    addGroup(groups, ['Series+Surface+P2Odds', safe(row.Series), safe(row.Surface), row.player2_match_odds_band], row);
  }

  const filteredHeaders = headers;
  const filteredCsv = [
    filteredHeaders.join(','),
    ...rows2024To2026.map((r) => filteredHeaders.map((h) => csvEscape(r[h])).join(',')),
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'atp_tennis_2024_2026.csv'), filteredCsv);

  const derivedHeaders = [
    'Date', 'Tournament', 'Series', 'Court', 'Surface', 'Round', 'Best_of',
    'Player_1', 'Player_2', 'Winner', 'Rank_1', 'Rank_2', 'Pts_1', 'Pts_2',
    'Odd_1', 'Odd_2', 'Score', 'raw_first_set_score', 'p1_first_set_games',
    'p2_first_set_games', 'listed_first_set_score', 'player2_first_set_win',
    'player2_9_12_win', 'player2_exact_3_6_win', 'player2_exact_4_6_win',
    'player2_exact_5_7_win', 'player2_is_match_winner',
    'player2_is_underdog_by_match_odds', 'player2_is_favorite_by_match_odds',
    'player2_match_odds_band', 'rank_gap_band_abs', 'rank2_minus_rank1',
  ];
  const derivedCsv = [
    derivedHeaders.join(','),
    ...derivedRows.map((r) => derivedHeaders.map((h) => csvEscape(r[h])).join(',')),
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'player2-firstset-2024-2026-derived.csv'), derivedCsv);

  const grouped = [...groups.values()]
    .map(finalizeGroup)
    .filter((g) => g.rows >= minRows)
    .sort((a, b) => (b.roi_at_3_50 - a.roi_at_3_50) || (b.hit_rate - a.hit_rate) || (b.rows - a.rows));

  const groupedHeaders = [
    'filter', 'rows', 'wins', 'losses', 'hit_rate', 'break_even_odds',
    'exact_3_6', 'exact_4_6', 'exact_5_7', 'player2_first_set_wins',
    'roi_at_3_00', 'roi_at_3_30', 'roi_at_3_50', 'roi_at_3_60',
  ];
  const groupedCsv = [
    groupedHeaders.join(','),
    ...grouped.map((g) => groupedHeaders.map((h) => csvEscape(g[h])).join(',')),
  ].join('\n');
  await fs.writeFile(path.join(outDir, 'player2-9-12-best-filters-2024-2026.csv'), groupedCsv);

  const summary = {
    generated_at: new Date().toISOString(),
    dataset_input: input,
    date_start: dateStart,
    date_stop: dateStop,
    source_rows_total: sourceRowsTotal,
    filtered_rows_2024_2026: dateFilteredRows,
    parseable_first_set_rows: parseableFirstSetRows,
    player2_first_set_wins: player2FirstSetWins,
    player2_first_set_win_rate: parseableFirstSetRows ? player2FirstSetWins / parseableFirstSetRows : 0,
    player2_9_12_wins: player2NineToTwelveWins,
    player2_9_12_losses: parseableFirstSetRows - player2NineToTwelveWins,
    player2_9_12_hit_rate: parseableFirstSetRows ? player2NineToTwelveWins / parseableFirstSetRows : 0,
    exact_3_6_wins: exact36,
    exact_4_6_wins: exact46,
    exact_5_7_wins: exact57,
    break_even_odds_all_rows: player2NineToTwelveWins ? parseableFirstSetRows / player2NineToTwelveWins : null,
    scenario_all_rows: Object.fromEntries([3.0, 3.3, 3.5, 3.6].map((odds) => [
      odds.toFixed(2),
      {
        odds,
        roi_per_flat_unit: parseableFirstSetRows
          ? ((player2NineToTwelveWins * (odds - 1)) - (parseableFirstSetRows - player2NineToTwelveWins)) / parseableFirstSetRows
          : 0,
      },
    ])),
    best_filters_count_min_rows: minRows,
    best_filters_top_25: grouped.slice(0, 25),
    parse_error_count: parseErrors.length,
    parse_errors_sample: parseErrors.slice(0, 25),
    important_correction: 'Kaggle Score is treated as listed Player_1-Player_2 order, not winner-loser order.',
    important_limitations: [
      'This dataset has match-winner odds only, not real Player 2 & 9-12 odds.',
      'This scan is an outcome/filter layer, not historical market-price proof.',
      'Use this with V3/Ultra 4-6 triggers later; do not treat every row as a SlipIQ bet.',
    ],
  };
  await fs.writeFile(path.join(outDir, 'kaggle-atp-2024-2026-firstset-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
