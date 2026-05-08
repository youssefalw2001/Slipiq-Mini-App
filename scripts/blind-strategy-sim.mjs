// SlipIQ Blind Strategy Simulation V2 Audit
//
// This script audits frozen strategy rules on historical V3 row CSVs.
// It does NOT tune rules after seeing results. It sorts rows by event_date,
// applies fixed rule functions day by day, and exports daily/monthly/bet-level
// artifacts for manual audit.
//
// V2 audit additions:
//   - Enforces max one score outcome per match by default.
//   - Emits surface, tournament, monthly-surface, and calibration audits.
//   - Emits strategy freeze manifest so another reviewer can see exactly what
//     was tested.
//   - Emits selected-bet samples for manual inspection of suspicious pockets.

import fs from 'node:fs';
import path from 'node:path';

const csvListRaw = process.env.BLIND_SIM_CSVS;
const outputDir = process.env.BLIND_SIM_OUTPUT_DIR ?? 'artifacts/blind-strategy-sim';
const modelModeFilter = process.env.BLIND_SIM_MODEL_MODE ?? 'independent';
const maxPlaysPerDay = Number(process.env.BLIND_SIM_MAX_PLAYS_PER_DAY ?? 5);
const bankrollStart = Number(process.env.BLIND_SIM_BANKROLL_START ?? 100);
const stakeUnits = Number(process.env.BLIND_SIM_STAKE_UNITS ?? 1);
const onePickPerMatch = process.env.BLIND_SIM_ONE_PICK_PER_MATCH !== '0';
const auditSampleSize = Number(process.env.BLIND_SIM_AUDIT_SAMPLE_SIZE ?? 50);

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
    tournament_round: row.tournament_round || '',
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
    freeze: {
      source: 'src/lib/setfoxStrategy.ts SETFOX_RULE',
      rule: 'setfox_passed_default === true',
      notes: ['Legacy strict rule', 'Research only unless audited positive out-of-sample'],
    },
    rule: (row) => row.setfox_passed_default,
  },
  {
    id: 'grass_lab_candidate',
    label: 'Grass Lab Candidate',
    description: 'Research-only walk-forward candidate: grass, odds_5_8, tour_other, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    freeze: {
      surface: 'grass',
      odds_bucket: 'odds_5_8',
      tournament_level: 'tour_other',
      min_model_probability: 0.03,
      min_expected_value: 0,
      min_edge: 0,
      notes: ['Strongest V1 blind-sim candidate', 'Must audit surface classifier before product promotion'],
    },
    rule: (row) => row.surface === 'grass' && row.odds_bucket === 'odds_5_8' && row.tournament_level === 'tour_other' && row.model_probability >= 0.03 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'safer_profile',
    label: 'Safer Profile',
    description: 'Higher hit-rate proxy: singles, non-tiebreak, probability >= 10%, odds <= 8, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    freeze: {
      match_type: 'singles',
      blocked_score_family: 'tiebreak',
      min_model_probability: 0.10,
      max_bookmaker_odds: 8,
      min_expected_value: 0,
      min_edge: 0,
      notes: ['Portfolio proxy, not actual user slip upload simulation'],
    },
    rule: (row) => row.match_type === 'singles' && row.score_family !== 'tiebreak' && row.model_probability >= 0.10 && row.bookmaker_odds <= 8 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'balanced_profile',
    label: 'Balanced Profile',
    description: 'Main product proxy: normal/close singles, probability >= 5%, odds <= 18, positive EV/edge.',
    maxPerDay: maxPlaysPerDay,
    freeze: {
      match_type: 'singles',
      allowed_score_families: ['normal', 'close'],
      min_model_probability: 0.05,
      max_bookmaker_odds: 18,
      min_expected_value: 0,
      min_edge: 0,
      notes: ['Portfolio proxy, not actual user slip upload simulation'],
    },
    rule: (row) => row.match_type === 'singles' && ['normal', 'close'].includes(row.score_family) && row.model_probability >= 0.05 && row.bookmaker_odds <= 18 && row.expected_value >= 0 && row.edge >= 0,
  },
  {
    id: 'moonshot_profile',
    label: 'Moonshot Profile',
    description: 'Higher payout proxy: singles, probability >= 3%, odds 12-30, positive EV/edge, no tiebreak.',
    maxPerDay: Math.max(1, Math.min(maxPlaysPerDay, 3)),
    freeze: {
      match_type: 'singles',
      blocked_score_family: 'tiebreak',
      min_model_probability: 0.03,
      min_bookmaker_odds: 12,
      max_bookmaker_odds: 30,
      min_expected_value: 0,
      min_edge: 0,
      notes: ['High-risk portfolio proxy', 'Should not be product default unless audited positive'],
    },
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
    model_calibration_gap: total ? wins / total - avgProbability : 0,
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

function selectDailyCandidates(rows, strategy) {
  const sorted = rows.filter(strategy.rule).sort((a, b) => score(b) - score(a));
  const selected = [];
  const usedMatches = new Set();
  for (const row of sorted) {
    if (onePickPerMatch && usedMatches.has(row.event_key)) continue;
    selected.push(row);
    usedMatches.add(row.event_key);
    if (selected.length >= strategy.maxPerDay) break;
  }
  return selected;
}

function bucketProbability(value) {
  if (value < 0.05) return 'p00_05';
  if (value < 0.10) return 'p05_10';
  if (value < 0.15) return 'p10_15';
  if (value < 0.20) return 'p15_20';
  if (value < 0.30) return 'p20_30';
  return 'p30_plus';
}

function buildCalibrationRows(selected) {
  return [...groupBy(selected, (row) => bucketProbability(row.model_probability)).entries()].map(([probability_bucket, bets]) => ({
    probability_bucket,
    ...summarizeBets(bets),
  })).sort((a, b) => a.probability_bucket.localeCompare(b.probability_bucket));
}

function summarizeTournamentExamples(selected) {
  return [...groupBy(selected, (row) => `${row.tournament || 'unknown'}|${row.surface || 'unknown'}|${row.tournament_level || 'unknown'}`).entries()]
    .map(([key, bets]) => {
      const [tournament, surface, tournament_level] = key.split('|');
      const summary = summarizeBets(bets);
      return {
        tournament,
        surface,
        tournament_level,
        ...summary,
        sample_events: bets.slice(0, 5).map((row) => ({
          event_date: row.event_date,
          match: row.match,
          score: row.score,
          bookmaker_odds: row.bookmaker_odds,
          won: row.won,
        })),
      };
    })
    .sort((a, b) => b.bets - a.bets || b.profit_units - a.profit_units)
    .slice(0, 25);
}

function buildAuditSamples(selected, strategyId) {
  const sorted = [...selected].sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)) || score(b) - score(a));
  if (sorted.length <= auditSampleSize) return sorted.map((row) => ({ ...row, audit_sample_reason: 'all_selected' }));

  const first = sorted.slice(0, Math.ceil(auditSampleSize / 3)).map((row) => ({ ...row, audit_sample_reason: 'earliest' }));
  const last = sorted.slice(-Math.ceil(auditSampleSize / 3)).map((row) => ({ ...row, audit_sample_reason: 'latest' }));
  const grassSuspiciousMonths = sorted
    .filter((row) => strategyId === 'grass_lab_candidate' && ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'].includes(row.event_date.slice(0, 7)))
    .slice(0, Math.ceil(auditSampleSize / 3))
    .map((row) => ({ ...row, audit_sample_reason: 'grass_offseason_check' }));
  const merged = new Map();
  for (const row of [...first, ...grassSuspiciousMonths, ...last]) merged.set(`${row.strategy_id}|${row.event_key}|${row.score}|${row.audit_sample_reason}`, row);
  return [...merged.values()].slice(0, auditSampleSize);
}

function simulateStrategy(allRows, strategy) {
  const rowsByDay = groupBy(allRows, (row) => row.event_date);
  const selected = [];
  const daily = [];

  for (const [date, rows] of [...rowsByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const candidates = selectDailyCandidates(rows, strategy);
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

  const monthlySurface = [...groupBy(selected, (row) => `${row.event_date.slice(0, 7)}|${row.surface}`).entries()].map(([key, bets]) => {
    const [month, surface] = key.split('|');
    return { strategy_id: strategy.id, month, surface, ...summarizeBets(bets) };
  }).sort((a, b) => a.month.localeCompare(b.month) || a.surface.localeCompare(b.surface));

  const bySurface = [...groupBy(selected, (row) => row.surface).entries()].map(([surface, bets]) => ({ surface, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const byScoreFamily = [...groupBy(selected, (row) => row.score_family).entries()].map(([score_family, bets]) => ({ score_family, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const byOddsBucket = [...groupBy(selected, (row) => row.odds_bucket).entries()].map(([odds_bucket, bets]) => ({ odds_bucket, ...summarizeBets(bets) })).sort((a, b) => b.profit_units - a.profit_units);
  const byTournament = summarizeTournamentExamples(selected);
  const calibration = buildCalibrationRows(selected);
  const drawdown = drawdownFromDaily(daily);

  const positiveMonths = monthly.filter((row) => row.roi_per_bet > 0).length;
  const largestWin = selected.filter((row) => row.won).sort((a, b) => profit(b) - profit(a))[0] ?? null;
  const totalProfit = selected.reduce((sum, row) => sum + profit(row) * stakeUnits, 0);
  const largestWinShare = largestWin && totalProfit > 0 ? (profit(largestWin) * stakeUnits) / totalProfit : 0;
  const duplicateMatchCount = selected.length - new Set(selected.map((row) => `${row.strategy_id}|${row.event_date}|${row.event_key}`)).size;
  const auditSamples = buildAuditSamples(selected, strategy.id);

  return {
    strategy: {
      id: strategy.id,
      label: strategy.label,
      description: strategy.description,
      max_plays_per_day: strategy.maxPerDay,
      freeze: strategy.freeze,
    },
    summary: {
      ...summarizeBets(selected),
      positive_months: positiveMonths,
      total_months: monthly.length,
      max_drawdown_units: drawdown.max_drawdown_units,
      ending_bankroll: drawdown.ending_bankroll,
      largest_single_win_profit_share: largestWinShare,
      duplicate_match_picks_after_guard: duplicateMatchCount,
      warning: selected.length < 100
        ? 'Low sample. Treat as directional research only.'
        : largestWinShare > 0.4
          ? 'One large win contributes heavily to profit. Stability risk is high.'
          : null,
    },
    daily: drawdown.curve,
    monthly,
    monthly_surface: monthlySurface,
    by_surface: bySurface,
    by_score_family: byScoreFamily,
    by_odds_bucket: byOddsBucket,
    by_tournament: byTournament,
    calibration,
    audit_samples: auditSamples,
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
    model_version: 'blind_strategy_sim_v2_audit',
    created_at: new Date().toISOString(),
    csv_paths: csvPaths,
    model_mode_filter: modelModeFilter,
    settings: {
      max_plays_per_day: maxPlaysPerDay,
      stake_units: stakeUnits,
      bankroll_start: bankrollStart,
      one_pick_per_match: onePickPerMatch,
      audit_sample_size: auditSampleSize,
    },
    strategy_freeze_manifest: strategies.map(({ id, label, description, maxPerDay, freeze }) => ({ id, label, description, max_plays_per_day: maxPerDay, freeze })),
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
      'Surface classification is heuristic and must be audited through by_tournament and audit_samples before product claims.',
      'Do not market as guaranteed profit. Use as research and validation input.',
    ],
    audit_questions_to_answer: [
      'Does one-pick-per-match materially reduce Grass Lab ROI?',
      'Are Grass Lab tournaments genuinely grass events or surface-classifier false positives?',
      'Is the model probability calibrated, or is it overconfident versus observed hit rate?',
      'Does profit come from stable months or one narrow time pocket?',
      'Would a real user have access to the same odds before match start?',
    ],
    strategies: results.map(({ strategy, summary, monthly, monthly_surface, by_surface, by_score_family, by_odds_bucket, by_tournament, calibration, audit_samples }) => ({
      strategy,
      summary,
      monthly,
      monthly_surface,
      by_surface,
      by_score_family,
      by_odds_bucket,
      by_tournament,
      calibration,
      audit_samples,
    })),
  };

  fs.writeFileSync(path.join(outputDir, 'blind-sim-summary.json'), JSON.stringify(report, null, 2));

  const allDaily = results.flatMap((result) => result.daily);
  writeCsv(path.join(outputDir, 'blind-sim-daily.csv'), allDaily, [
    'strategy_id', 'event_date', 'bets', 'wins', 'profit_units', 'bankroll', 'drawdown_units',
  ]);

  const allMonthly = results.flatMap((result) => result.monthly);
  writeCsv(path.join(outputDir, 'blind-sim-monthly.csv'), allMonthly, [
    'strategy_id', 'month', 'bets', 'wins', 'losses', 'hit_rate', 'staked_units', 'profit_units', 'roi_per_bet', 'average_odds', 'average_model_probability', 'average_expected_value', 'model_calibration_gap',
  ]);

  const allMonthlySurface = results.flatMap((result) => result.monthly_surface);
  writeCsv(path.join(outputDir, 'blind-sim-monthly-surface.csv'), allMonthlySurface, [
    'strategy_id', 'month', 'surface', 'bets', 'wins', 'losses', 'hit_rate', 'staked_units', 'profit_units', 'roi_per_bet', 'average_odds', 'average_model_probability', 'average_expected_value', 'model_calibration_gap',
  ]);

  const allAuditSamples = results.flatMap((result) => result.audit_samples);
  writeCsv(path.join(outputDir, 'blind-sim-audit-samples.csv'), allAuditSamples, [
    'strategy_id', 'strategy_label', 'audit_sample_reason', 'model_mode', 'event_date', 'event_key', 'match', 'tournament', 'tournament_round', 'surface', 'tournament_level', 'match_type', 'score', 'score_family', 'odds_bucket', 'model_probability', 'bookmaker_odds', 'edge', 'expected_value', 'won', 'setfox_passed_default',
  ]);

  const allBets = results.flatMap((result) => result.bets);
  writeCsv(path.join(outputDir, 'blind-sim-bets.csv'), allBets, [
    'strategy_id', 'strategy_label', 'model_mode', 'event_date', 'event_key', 'match', 'tournament', 'tournament_round', 'surface', 'tournament_level', 'match_type', 'score', 'score_family', 'odds_bucket', 'model_probability', 'bookmaker_odds', 'edge', 'expected_value', 'won', 'setfox_passed_default',
  ]);

  console.log('SlipIQ Blind Strategy Simulation V2 Audit report:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote artifacts to ${outputDir}`);
}

main();
