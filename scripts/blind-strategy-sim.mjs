// SlipIQ Blind Strategy Simulation
//
// This script audits frozen strategy rules on historical V3 row CSVs.
// It does NOT tune rules after seeing results. It sorts rows by event_date,
// applies fixed rule functions day by day, and exports daily/monthly/bet-level
// artifacts for manual audit.
//
// Use this after scripts/backtest-first-set-lab-v3.mjs has generated one or
// more CSV files. The CSV rows already contain model probabilities, odds,
// results, surface, score family, odds bucket, tournament level, and the
// SetFox Strict pass flag.

import fs from 'node:fs';
import path from 'node:path';

const csvListRaw = process.env.BLIND_SIM_CSVS;
const outputDir = process.env.BLIND_SIM_OUTPUT_DIR ?? 'artifacts/blind-strategy-sim';
const modelModeFilter = process.env.BLIND_SIM_MODEL_MODE ?? 'independent';
const maxPlaysPerDay = Number(process.env.BLIND_SIM_MAX_PLAYS_PER_DAY ?? 5);
const bankrollStart = Number(process.env.BLIND_SIM_BANKROLL_START ?? 100);
const stakeUnits = Number(process.env.BLIND_SIM_STAKE_UNITS ?? 1);

if (!csvListRaw) {
  console.error('Missing BLIND_SIM_CSVS. Provide comma-separated backtest V3 row CSV paths.');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current || row.length) {
    row.push(current);
    rows.push(row);
  }

  const [headers, ...data] = rows;
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBool(value) {
  return String(value).toLowerCase() === 'true';
}

function normalizeRows(rawRows, sourceFile) {
  return rawRows.map((row) => ({
    ...row,
    source_file: sourceFile,
    model_mode: row.model_mode || 'unknown',
    event_key: String(row.event_key ?? ''),
    event_date: String(row.event_date ?? ''),
    match: row.match || '',
    tournament: row.tournament || '',
    surface: row.surface || 'unknown',
    score: row.score || '',
    score_family: row.score_family || 'unknown',
    odds_bucket: row.odds_bucket || 'unknown',
    tournament_level: row.tournament_level || 'unknown',
    match_type: row.match_type || 'unknown',
    model_probability: toNumber(row.model_probability),
    bookmaker_odds: toNumber(row.bookmaker_odds),
    edge: toNumber(row.edge),
    expected_value: toNumber(row.expected_value),
    won: toBool(row.won),
    setfox_passed_default: toBool(row.setfox_passed_default),
  })).filter((row) => row.event_key && row.event_date && row.score && row.bookmaker_odds > 1 && row.model_probability > 0);
}

function loadRows(csvPaths) {
  const rows = [];
  for (const csvPath of csvPaths) {
    const text = fs.readFileSync(csvPath, 'utf8');
    rows.push(...normalizeRows(parseCsv(text), path.basename(csvPath)));
  }
  const dedupe = new Map();
  for (const row of rows) {
    const key = [row.model_mode, row.event_key, row.score, row.bookmaker_odds, row.source_file].join('|');
    dedupe.set(key, row);
  }
  return [...dedupe.values()].sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || a.event_key.localeCompare(b.event_key));
}

function profit(row) {
  return row.won ? row.bookmaker_odds - 1 : -1;
}

function score(row) {
  return row.expected_value * 1000 + row.edge * 100 + row.model_probability * 10;
}

const strategies = [
  {
    id: 'setfox_strict',
    label: 'SetFox Strict',
    description: 'Frozen live strict rule from src/lib/setfoxStrategy.ts.',
    maxPerDay: maxPlaysPerDay,
    rule: (row) => row.setfox_passed_default,
  },
  {
    id: 'grass_lab_candidate',
    label: 'Grass Lab Candidate',
    description: 'Research-only walk-forward candidate: grass, odds_5_8, tour_other, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    rule: (row) => row.surface === 'grass' && row.odds_bucket === 'odds_5_8' && row.tournament_level === 'tour_other' && row.model_probability >= 0.03 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'safer_profile',
    label: 'Safer Profile',
    description: 'Higher hit-rate proxy: singles, non-tiebreak, probability >= 10%, odds <= 8, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    rule: (row) => row.match_type === 'singles' && row.score_family !== 'tiebreak' && row.model_probability >= 0.10 && row.bookmaker_odds <= 8 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'balanced_profile',
    label: 'Balanced Profile',
    description: 'Main product proxy: normal/close singles, probability >= 5%, odds <= 18, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    rule: (row) => row.match_type === 'singles' && ['normal', 'close'].includes(row.score_family) && row.model_probability >= 0.05 && row.bookmaker_odds <= 18 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'moonshot_profile',
    label: 'Moonshot Profile',
    description: 'Higher payout proxy: singles, probability >= 3%, odds 12-30, positive EV/edge, no tiebreak.',
    maxPerDay: Math.max(1, Math.min(maxPlaysPerDay, 3)),
    rule: (row) => row.match_type === 'singles' && row.score_family !== 'tiebreak' && row.model_probability >= 0.03 && row.bookmaker_odds >= 12 && row.bookmaker_odds <= 30 && row.expected_value >= 0 && row.edge >= 0,
  },
];

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function summarizeBets(bets) {
  const total = bets.length;
  const wins = bets.filter((row) => row.won).length;
  const totalProfit = bets.reduce((sum, row) => sum + profit(row) * stakeUnits, 0);
  const staked = total * stakeUnits;
  const avgOdds = total ? bets.reduce((sum, row) => sum + row.bookmaker_odds, 0) / total : 0;
  const avgProbability = total ? bets.reduce((sum, row) => sum + row.model_probability, 0) / total : 0;
  const avgEv = total ? bets.reduce((sum, row) => sum + row.expected_value, 0) / total : 0;
  return {
    bets: total,
    wins,
    losses: total - wins,
    hit_rate: total ? wins / total : 0,
    staked_units: staked,
    profit_units: totalProfit,
    roi_per_bet: staked ? totalProfit / staked : 0,
    average_odds: avgOdds,
    average_model_probability: avgProbability,
    average_expected_value: avgEv,
  };
}

function drawdownFromDaily(dailyRows) {
  let bankroll = bankrollStart;
  let peak = bankrollStart;
  let maxDrawdown = 0;
  const curve = [];
  for (const row of dailyRows) {
    bankroll += row.profit_units;
    peak = Math.max(peak, bankroll);
    const drawdown = peak - bankroll;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({ ...row, bankroll, drawdown_units: drawdown });
  }
  return { max_drawdown_units: maxDrawdown, ending_bankroll: bankroll, curve };
}

function simulateStrategy(allRows, strategy) {
  const rowsByDay = groupBy(allRows, (row) => row.event_date);
  const selected = [];
  const daily = [];

  for (const [date, rows] of [...rowsByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const candidates = rows.filter(strategy.rule).sort((a, b) => score(b) - score(a)).slice(0, strategy.maxPerDay);
    selected.push(...candidates.map((row) => ({ ...row, strategy_id: strategy.id, strategy_label: strategy.label })));
    daily.push({
      strategy_id: strategy.id,
      event_date: date,
      bets: candidates.length,
      wins: candidates.filter((row) => row.won).length,
      profit_units: candidates.reduce((sum, row) => sum + profit(row) * stakeUnits, 0),
    });
  }

  const monthly = [...groupBy(selected, (row) => row.event_date.slice(0, 7)).entries()].map(([month, bets]) => ({
    strategy_id: strategy.id,
    month,
    ...summarizeBets(bets),
  })).sort((a, b) => a.month.localeCompare(b.month));

  const bySurface = [...groupBy(selected, (row) => row.surface).entries()].map(([surface, bets]) => ({ surface, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const byScoreFamily = [...groupBy(selected, (row) => row.score_family).entries()].map(([score_family, bets]) => ({ score_family, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const byOddsBucket = [...groupBy(selected, (row) => row.odds_bucket).entries()].map(([odds_bucket, bets]) => ({ odds_bucket, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const drawdown = drawdownFromDaily(daily);

  const positiveMonths = monthly.filter((row) => row.roi_per_bet > 0).length;
  const largestWin = selected.filter((row) => row.won).sort((a, b) => profit(b) - profit(a))[0] ?? null;
  const totalProfit = selected.reduce((sum, row) => sum + profit(row) * stakeUnits, 0);
  const largestWinShare = largestWin && totalProfit > 0 ? (profit(largestWin) * stakeUnits) / totalProfit : 0;

  return {
    strategy: {
      id: strategy.id,
      label: strategy.label,
      description: strategy.description,
      max_plays_per_day: strategy.maxPerDay,
    },
    summary: {
      ...summarizeBets(selected),
      positive_months: positiveMonths,
      total_months: monthly.length,
      max_drawdown_units: drawdown.max_drawdown_units,
      ending_bankroll: drawdown.ending_bankroll,
      largest_single_win_profit_share: largestWinShare,
      warning: selected.length < 100
        ? 'Low sample. Treat as directional research only.'
        : largestWinShare > 0.4
          ? 'One large win contributes heavily to profit. Stability risk is high.'
          : null,
    },
    daily: drawdown.curve,
    monthly,
    by_surface: bySurface,
    by_score_family: byScoreFamily,
    by_odds_bucket: byOddsBucket,
    bets: selected,
  };
}

function escapeCsv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function writeCsv(filePath, rows, columns) {
  const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','))].join('\n');
  fs.writeFileSync(filePath, csv);
}

function main() {
  const csvPaths = csvListRaw.split(',').map((item) => item.trim()).filter(Boolean);
  const rows = loadRows(csvPaths).filter((row) => modelModeFilter === 'any' || row.model_mode === modelModeFilter);

  fs.mkdirSync(outputDir, { recursive: true });
  const results = strategies.map((strategy) => simulateStrategy(rows, strategy));

  const report = {
    model_version: 'blind_strategy_sim_v1',
    created_at: new Date().toISOString(),
    csv_paths: csvPaths,
    model_mode_filter: modelModeFilter,
    settings: {
      max_plays_per_day: maxPlaysPerDay,
      stake_units: stakeUnits,
      bankroll_start: bankrollStart,
    },
    data: {
      rows_loaded: rows.length,
      first_date: rows[0]?.event_date ?? null,
      last_date: rows.at(-1)?.event_date ?? null,
      unique_matches: new Set(rows.map((row) => row.event_key)).size,
    },
    important_limitations: [
      'This is historical blind simulation, not live execution proof.',
      'Historical odds may not equal the exact user-available price at bet time.',
      'Safer/Balanced/Moonshot are portfolio proxies, not actual user-uploaded slips.',
      'Do not market as guaranteed profit. Use as research and validation input.',
    ],
    strategies: results.map(({ strategy, summary, monthly, by_surface, by_score_family, by_odds_bucket }) => ({
      strategy,
      summary,
      monthly,
      by_surface,
      by_score_family,
      by_odds_bucket,
    })),
  };

  fs.writeFileSync(path.join(outputDir, 'blind-sim-summary.json'), JSON.stringify(report, null, 2));

  const allDaily = results.flatMap((result) => result.daily);
  writeCsv(path.join(outputDir, 'blind-sim-daily.csv'), allDaily, [
    'strategy_id', 'event_date', 'bets', 'wins', 'profit_units', 'bankroll', 'drawdown_units',
  ]);

  const allMonthly = results.flatMap((result) => result.monthly);
  writeCsv(path.join(outputDir, 'blind-sim-monthly.csv'), allMonthly, [
    'strategy_id', 'month', 'bets', 'wins', 'losses', 'hit_rate', 'staked_units', 'profit_units', 'roi_per_bet', 'average_odds', 'average_model_probability', 'average_expected_value',
  ]);

  const allBets = results.flatMap((result) => result.bets);
  writeCsv(path.join(outputDir, 'blind-sim-bets.csv'), allBets, [
    'strategy_id', 'strategy_label', 'model_mode', 'event_date', 'event_key', 'match', 'tournament', 'surface', 'tournament_level', 'match_type', 'score', 'score_family', 'odds_bucket', 'model_probability', 'bookmaker_odds', 'edge', 'expected_value', 'won', 'setfox_passed_default',
  ]);

  console.log('SlipIQ Blind Strategy Simulation report:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote artifacts to ${outputDir}`);
}

main();
