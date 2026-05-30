#!/usr/bin/env node
/*
  First Set Lab / SlipIQ
  Walk-forward optimizer for Optimized VIP Protected 3 staking overlays.

  Input is the row CSV produced by:
    scripts/backtest-optimized-vip-risk-filter-from-warehouse.mjs

  It does not change lane rules or score groups. It only tests staking overlays.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const rowsPath = args.rows || 'artifacts/output/optimized-vip-risk-filter-blind-backtest/optimized_vip_risk_filter_all_rows.csv';
const outDir = args.out || 'artifacts/output/optimized-vip-walk-forward-optimization';
const initialTrain = Number(args['initial-train'] || '300') || 300;
const testSize = Number(args['test-size'] || '100') || 100;
const stepSize = Number(args['step-size'] || String(testSize)) || testSize;
const objective = args.objective || 'profit_then_drawdown';
const bankroll = Number(args.bankroll || '3000') || 3000;
const riskPcts = String(args['risk-pcts'] || '0.03,0.05').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0 && v < 1);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function num(v) { if (v === undefined || v === null || clean(v) === '') return 0; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function bool(v) { return ['true','1','yes'].includes(clean(v).toLowerCase()); }
function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(file, rows, fields) { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]; const nx = text[i + 1];
    if (q) {
      if (ch === '"' && nx === '"') { cell += '"'; i += 1; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function normalizeRows(rawRows) {
  return rawRows.map((r, index) => ({
    ...r,
    seq: index + 1,
    target_grouped_odds_num: num(r.target_grouped_odds),
    group_profit_units_num: num(r.group_profit_units || r.baseline_unit_result),
    pocket_count_num: num(r.pocket_count),
    pocket_booster_1u_units_num: num(r.pocket_booster_1u_units),
    has_booster: num(r.pocket_count) > 0,
    is_win: clean(r.result) === 'WIN',
  })).sort((a, b) => `${a.event_date} ${a.event_time} ${a.event_key} ${a.lane_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key} ${b.lane_key}`));
}

function candidateKey(c) {
  return `u${c.under225_base}_n${c.no_booster_base}_bb${c.booster_base}_ba${c.booster_add}_s${c.strong_booster_add}`;
}

function makeCandidates() {
  const candidates = [];
  const under225Base = [0, 0.25, 0.5, 1];
  const noBoosterBase = [0.25, 0.5, 0.75, 1];
  const boosterBase = [0.75, 1];
  const boosterAdd = [0.25, 0.5, 0.75];
  const strongAdd = [0.25, 0.5, 0.75, 1.0];

  for (const u of under225Base) {
    for (const n of noBoosterBase) {
      for (const bb of boosterBase) {
        for (const ba of boosterAdd) {
          for (const sa of strongAdd) {
            if (sa < ba) continue;
            candidates.push({
              candidate_key: '',
              label: 'grid',
              under225_base: u,
              no_booster_base: n,
              booster_base: bb,
              booster_add: ba,
              strong_booster_add: sa,
            });
          }
        }
      }
    }
  }

  const benchmarks = [
    { label: 'benchmark_raw_vip_booster', under225_base: 1, no_booster_base: 1, booster_base: 1, booster_add: 0.5, strong_booster_add: 0.5 },
    { label: 'benchmark_balanced_v2', under225_base: 0.5, no_booster_base: 0.5, booster_base: 1, booster_add: 0.5, strong_booster_add: 0.5 },
    { label: 'benchmark_skip_under225', under225_base: 0, no_booster_base: 0.5, booster_base: 1, booster_add: 0.5, strong_booster_add: 0.5 },
  ];

  const all = [...benchmarks, ...candidates].map((c) => ({ ...c, candidate_key: c.label.startsWith('benchmark') ? c.label : candidateKey(c) }));
  const seen = new Set();
  return all.filter((c) => { if (seen.has(c.candidate_key)) return false; seen.add(c.candidate_key); return true; });
}

function isStrong(row) {
  return row.has_booster && row.target_grouped_odds_num >= 3.25 && row.target_grouped_odds_num < 4.0;
}

function rowResult(row, candidate) {
  const grouped = row.group_profit_units_num;
  const pocket1u = row.pocket_booster_1u_units_num;
  const pocketCount = row.pocket_count_num;
  let baseStake = 0;
  let boosterStake = 0;

  if (row.target_grouped_odds_num < 2.25) {
    baseStake = candidate.under225_base;
    boosterStake = row.has_booster ? Math.min(candidate.under225_base, candidate.booster_add) : 0;
  } else if (row.has_booster) {
    baseStake = candidate.booster_base;
    boosterStake = isStrong(row) ? candidate.strong_booster_add : candidate.booster_add;
  } else {
    baseStake = candidate.no_booster_base;
  }

  const unit = baseStake * grouped + boosterStake * pocket1u;
  const stakeUnits = baseStake + boosterStake * pocketCount;
  return { unit, stakeUnits, active: stakeUnits > 0 };
}

function summarize(rows, candidate) {
  let units = 0;
  let staked = 0;
  let activeRows = 0;
  let wins = 0;
  let losses = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDdUnits = 0;
  let streak = 0;
  let worstStreak = 0;
  for (const row of rows) {
    const r = rowResult(row, candidate);
    units += r.unit;
    staked += r.stakeUnits;
    if (r.active) {
      activeRows += 1;
      if (row.is_win) wins += 1; else losses += 1;
      if (r.unit < 0) streak += 1; else streak = 0;
      worstStreak = Math.max(worstStreak, streak);
    }
    cumulative += r.unit;
    peak = Math.max(peak, cumulative);
    maxDdUnits = Math.max(maxDdUnits, peak - cumulative);
  }
  return {
    rows: rows.length,
    active_rows: activeRows,
    track_only_rows: rows.length - activeRows,
    wins,
    losses,
    hit_rate_pct: activeRows ? Number(((wins / activeRows) * 100).toFixed(2)) : 0,
    profit_units: Number(units.toFixed(6)),
    staked_units: Number(staked.toFixed(6)),
    roi_on_staked_pct: staked ? Number(((units / staked) * 100).toFixed(2)) : 0,
    max_drawdown_units: Number(maxDdUnits.toFixed(6)),
    worst_losing_streak: worstStreak,
    first_date: rows[0]?.event_date || '',
    last_date: rows[rows.length - 1]?.event_date || '',
  };
}

function scoreMetric(summary) {
  if (objective === 'roi') return summary.roi_on_staked_pct;
  if (objective === 'risk_adjusted') return summary.profit_units - 0.75 * summary.max_drawdown_units;
  return summary.profit_units - 0.15 * summary.max_drawdown_units;
}

function pickBest(rows, candidates) {
  return candidates
    .map((c) => ({ ...c, ...summarize(rows, c) }))
    .filter((r) => r.active_rows >= Math.min(50, Math.max(10, Math.floor(rows.length * 0.15))))
    .sort((a, b) => {
      const sa = scoreMetric(a);
      const sb = scoreMetric(b);
      if (sb !== sa) return sb - sa;
      if (b.profit_units !== a.profit_units) return b.profit_units - a.profit_units;
      return a.max_drawdown_units - b.max_drawdown_units;
    })[0];
}

function folds(rows) {
  const out = [];
  let trainEnd = initialTrain;
  let fold = 1;
  while (trainEnd < rows.length) {
    const testEnd = Math.min(rows.length, trainEnd + testSize);
    if (testEnd - trainEnd < Math.max(20, Math.floor(testSize * 0.4))) break;
    out.push({
      fold,
      train: rows.slice(0, trainEnd),
      test: rows.slice(trainEnd, testEnd),
      train_start: rows[0]?.event_date || '',
      train_end: rows[trainEnd - 1]?.event_date || '',
      test_start: rows[trainEnd]?.event_date || '',
      test_end: rows[testEnd - 1]?.event_date || '',
    });
    trainEnd += stepSize;
    fold += 1;
  }
  return out;
}

function compound(rows, candidate, riskPct) {
  let bank = bankroll;
  let peak = bankroll;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  for (const row of rows) {
    const r = rowResult(row, candidate);
    if (!r.active) continue;
    const pnl = bank * riskPct * r.unit;
    bank += pnl;
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak ? (peak - bank) / peak : 0);
    if (r.unit < 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  return { risk_pct: riskPct, final_bankroll: Number(bank.toFixed(2)), net_profit: Number((bank - bankroll).toFixed(2)), return_pct: Number(((bank / bankroll - 1) * 100).toFixed(2)), max_drawdown_pct: Number((maxDd * 100).toFixed(2)), worst_losing_streak: worstStreak };
}

function main() {
  if (!fs.existsSync(rowsPath)) {
    console.error(`Missing rows CSV: ${rowsPath}`);
    process.exit(2);
  }
  ensureDir(outDir);
  const rows = normalizeRows(parseCsv(fs.readFileSync(rowsPath, 'utf8')));
  const candidates = makeCandidates();
  const foldDefs = folds(rows);
  if (!foldDefs.length) {
    console.error(`Not enough rows for walk-forward. Rows=${rows.length}, initial_train=${initialTrain}, test_size=${testSize}`);
    process.exit(3);
  }

  const benchmarkKeys = ['benchmark_raw_vip_booster','benchmark_balanced_v2','benchmark_skip_under225'];
  const benchmarkCandidates = candidates.filter((c) => benchmarkKeys.includes(c.candidate_key));
  const selectedRows = [];
  const benchmarkFoldRows = [];
  const topTrainRows = [];
  const selectedTestSignals = [];

  for (const f of foldDefs) {
    const scored = candidates.map((c) => ({ fold: f.fold, ...c, ...summarize(f.train, c), score: Number(scoreMetric(summarize(f.train, c)).toFixed(6)) }))
      .sort((a, b) => b.score - a.score);
    topTrainRows.push(...scored.slice(0, 25));
    const best = pickBest(f.train, candidates);
    const trainSummary = summarize(f.train, best);
    const testSummary = summarize(f.test, best);
    selectedRows.push({
      fold: f.fold,
      objective,
      train_start: f.train_start,
      train_end: f.train_end,
      test_start: f.test_start,
      test_end: f.test_end,
      candidate_key: best.candidate_key,
      label: best.label,
      under225_base: best.under225_base,
      no_booster_base: best.no_booster_base,
      booster_base: best.booster_base,
      booster_add: best.booster_add,
      strong_booster_add: best.strong_booster_add,
      train_profit_units: trainSummary.profit_units,
      train_staked_units: trainSummary.staked_units,
      train_roi_on_staked_pct: trainSummary.roi_on_staked_pct,
      train_max_drawdown_units: trainSummary.max_drawdown_units,
      test_rows: testSummary.rows,
      test_active_rows: testSummary.active_rows,
      test_wins: testSummary.wins,
      test_losses: testSummary.losses,
      test_profit_units: testSummary.profit_units,
      test_staked_units: testSummary.staked_units,
      test_roi_on_staked_pct: testSummary.roi_on_staked_pct,
      test_max_drawdown_units: testSummary.max_drawdown_units,
      test_worst_losing_streak: testSummary.worst_losing_streak,
    });
    for (const row of f.test) {
      const rr = rowResult(row, best);
      selectedTestSignals.push({ fold: f.fold, candidate_key: best.candidate_key, event_date: row.event_date, event_time: row.event_time, match_name: row.match_name, lane_key: row.lane_key, target_grouped_odds: row.target_grouped_odds, pocket_count: row.pocket_count, result: row.result, unit_result: Number(rr.unit.toFixed(6)), staked_units: Number(rr.stakeUnits.toFixed(6)) });
    }
    for (const b of benchmarkCandidates) {
      benchmarkFoldRows.push({ fold: f.fold, benchmark: b.candidate_key, test_start: f.test_start, test_end: f.test_end, ...summarize(f.test, b) });
    }
  }

  const allCandidateSummary = candidates.map((c) => ({ ...c, ...summarize(rows, c) })).sort((a, b) => b.profit_units - a.profit_units);
  const selectedAggregate = summarize(selectedTestSignals.map((r) => ({ ...r, is_win: r.result === 'WIN', target_grouped_odds_num: num(r.target_grouped_odds), group_profit_units_num: num(r.unit_result), pocket_count_num: num(r.pocket_count), pocket_booster_1u_units_num: 0, has_booster: false })), { under225_base: 1, no_booster_base: 1, booster_base: 1, booster_add: 0, strong_booster_add: 0 });

  const benchmarkAggregateRows = [];
  for (const b of benchmarkCandidates) {
    const combinedTests = foldDefs.flatMap((f) => f.test);
    benchmarkAggregateRows.push({ benchmark: b.candidate_key, ...summarize(combinedTests, b) });
  }

  const compoundRows = [];
  for (const b of benchmarkCandidates) {
    const combinedTests = foldDefs.flatMap((f) => f.test);
    for (const risk of riskPcts) compoundRows.push({ strategy: b.candidate_key, ...compound(combinedTests, b, risk) });
  }

  writeCsv(path.join(outDir, 'walk_forward_selected_folds.csv'), selectedRows, ['fold','objective','train_start','train_end','test_start','test_end','candidate_key','label','under225_base','no_booster_base','booster_base','booster_add','strong_booster_add','train_profit_units','train_staked_units','train_roi_on_staked_pct','train_max_drawdown_units','test_rows','test_active_rows','test_wins','test_losses','test_profit_units','test_staked_units','test_roi_on_staked_pct','test_max_drawdown_units','test_worst_losing_streak']);
  writeCsv(path.join(outDir, 'walk_forward_top_train_candidates.csv'), topTrainRows, ['fold','candidate_key','label','under225_base','no_booster_base','booster_base','booster_add','strong_booster_add','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','max_drawdown_units','worst_losing_streak','score']);
  writeCsv(path.join(outDir, 'walk_forward_benchmark_folds.csv'), benchmarkFoldRows, ['fold','benchmark','test_start','test_end','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','max_drawdown_units','worst_losing_streak','first_date','last_date']);
  writeCsv(path.join(outDir, 'walk_forward_all_candidate_summary.csv'), allCandidateSummary.slice(0, 200), ['candidate_key','label','under225_base','no_booster_base','booster_base','booster_add','strong_booster_add','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','max_drawdown_units','worst_losing_streak','first_date','last_date']);
  writeCsv(path.join(outDir, 'walk_forward_benchmark_aggregate.csv'), benchmarkAggregateRows, ['benchmark','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','max_drawdown_units','worst_losing_streak','first_date','last_date']);
  writeCsv(path.join(outDir, 'walk_forward_compounding.csv'), compoundRows, ['strategy','risk_pct','final_bankroll','net_profit','return_pct','max_drawdown_pct','worst_losing_streak']);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'optimized_vip_staking_walk_forward_optimization',
    source_rows_csv: rowsPath,
    rows: rows.length,
    candidates: candidates.length,
    objective,
    initial_train: initialTrain,
    test_size: testSize,
    step_size: stepSize,
    folds: foldDefs.length,
    selected_fold_summary: selectedRows,
    selected_test_total_profit_units: Number(selectedRows.reduce((s, r) => s + num(r.test_profit_units), 0).toFixed(6)),
    selected_test_total_staked_units: Number(selectedRows.reduce((s, r) => s + num(r.test_staked_units), 0).toFixed(6)),
    selected_test_roi_on_staked_pct: (() => { const u = selectedRows.reduce((s, r) => s + num(r.test_profit_units), 0); const st = selectedRows.reduce((s, r) => s + num(r.test_staked_units), 0); return st ? Number(((u/st)*100).toFixed(2)) : 0; })(),
    benchmark_aggregate: benchmarkAggregateRows,
    compounding: compoundRows,
    top_all_candidates: allCandidateSummary.slice(0, 20),
    note: 'Use walk-forward results to pick robust staking only. Do not change lane/score model from this optimizer alone.',
  };
  writeJson(path.join(outDir, 'walk_forward_optimization_summary.json'), summary);

  const raw = benchmarkAggregateRows.find((r) => r.benchmark === 'benchmark_raw_vip_booster');
  const bal = benchmarkAggregateRows.find((r) => r.benchmark === 'benchmark_balanced_v2');
  const skip = benchmarkAggregateRows.find((r) => r.benchmark === 'benchmark_skip_under225');
  const report = [
    '# Optimized VIP Walk-Forward Staking Optimization',
    '',
    `Generated: ${summary.generated_at}`,
    `Rows: ${rows.length}`,
    `Candidates tested: ${candidates.length}`,
    `Objective: ${objective}`,
    `Folds: ${foldDefs.length}`,
    `Initial train: ${initialTrain}`,
    `Test size: ${testSize}`,
    '',
    '## Selected Optimizer Test Aggregate',
    `- Profit units: ${summary.selected_test_total_profit_units}`,
    `- Staked units: ${summary.selected_test_total_staked_units}`,
    `- ROI on staked: ${summary.selected_test_roi_on_staked_pct}%`,
    '',
    '## Benchmark Aggregates On The Same Walk-Forward Test Rows',
    `- Raw VIP Booster: ${raw?.profit_units ?? 0}u, ROI ${raw?.roi_on_staked_pct ?? 0}%, active ${raw?.active_rows ?? 0}`,
    `- Balanced v2: ${bal?.profit_units ?? 0}u, ROI ${bal?.roi_on_staked_pct ?? 0}%, active ${bal?.active_rows ?? 0}`,
    `- Skip under 2.25: ${skip?.profit_units ?? 0}u, ROI ${skip?.roi_on_staked_pct ?? 0}%, active ${skip?.active_rows ?? 0}`,
    '',
    '## Fold Picks',
    ...selectedRows.map((r) => `- Fold ${r.fold} ${r.test_start} to ${r.test_end}: ${r.candidate_key}, test ${r.test_profit_units}u, ROI ${r.test_roi_on_staked_pct}%, ${r.test_wins}W/${r.test_losses}L`),
    '',
    '## Notes',
    '- This is a walk-forward staking optimizer only.',
    '- It does not validate new score groups or new strategy lanes.',
    '- If the optimizer fails to beat Raw VIP Booster on test folds, use Raw VIP Booster and stop optimizing.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'walk_forward_optimization_report.md'), report, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
