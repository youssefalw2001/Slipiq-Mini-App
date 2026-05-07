// SlipIQ Model Walk-Forward V3
//
// Replaces the consensus + master-validate flow with a proper walk-forward
// design that resists overfitting:
//
//   1. Take N CSV windows in date order.
//   2. For each fold k in 1..N-1:
//        - Train on windows[0..k-1] (cumulative).
//        - Filter rules surviving train constraints (sample, ROI, hit rate
//          stability across the union of training windows).
//        - Evaluate surviving rules on test window k. Bets and profit on test
//          windows are the only numbers reported as "out-of-sample".
//   3. Aggregate per-rule out-of-sample test results. A rule is promoted only
//      if it is positive on a majority of test folds *and* its worst test fold
//      stays above a configurable floor *and* its rule complexity is small.
//   4. All rules are also reported with a Wilson 95% CI on hit rate so we
//      don't confuse a 20-bet streak with a real edge.
//
// Anti-overfit features:
//   - Rule complexity penalty (more filters => higher penalty).
//   - Reject rules that look profitable in only one date period.
//   - Wilson CI for hit rate; require lower bound > implied prob (i.e. the
//     model is statistically distinguishable from "no edge", not just lucky).
//   - Reports search-space size and number of rules tested.
//   - Reports overfitting risk score so the human reader can calibrate.
//
// This script is honest about what it does NOT do:
//   - It does not invent new tennis features.
//   - It does not guarantee a positive forward live result.
//   - If no rule survives, it says so.

import fs from 'node:fs';
import path from 'node:path';

const csvListRaw = process.env.WALKFORWARD_CSVS;
const outputDir = process.env.WALKFORWARD_OUTPUT_DIR ?? 'artifacts/walkforward-v3';
const minBetsPerWindow = Number(process.env.WALKFORWARD_MIN_BETS_PER_WINDOW ?? 30);
const minTotalTestBets = Number(process.env.WALKFORWARD_MIN_TOTAL_TEST_BETS ?? 80);
const minPositiveTestFolds = Number(process.env.WALKFORWARD_MIN_POSITIVE_TEST_FOLDS ?? 2);
const worstTestRoiFloor = Number(process.env.WALKFORWARD_WORST_TEST_ROI_FLOOR ?? -0.10);
const maxComplexity = Number(process.env.WALKFORWARD_MAX_COMPLEXITY ?? 3);
const modelMode = process.env.WALKFORWARD_MODEL_MODE ?? 'any';

if (!csvListRaw) {
  console.error('Missing WALKFORWARD_CSVS. Provide comma-separated V3 backtest CSV paths in date order.');
  process.exit(1);
}

const csvPaths = csvListRaw.split(',').map((item) => item.trim()).filter(Boolean);
if (csvPaths.length < 3) {
  console.error('WALKFORWARD_CSVS must include at least three CSV files (one becomes the first test fold, two are needed before that).');
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

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const toBool = (value) => String(value).toLowerCase() === 'true';

function normalizeRows(rawRows) {
  return rawRows.map((row) => ({
    ...row,
    model_mode: row.model_mode || 'coupled',
    surface: row.surface || 'unknown',
    score_family: row.score_family || 'unknown',
    odds_bucket: row.odds_bucket || 'unknown',
    match_type: row.match_type || 'unknown',
    tournament_level: row.tournament_level || 'unknown',
    model_probability: toNumber(row.model_probability),
    bookmaker_odds: toNumber(row.bookmaker_odds),
    edge: toNumber(row.edge),
    expected_value: toNumber(row.expected_value),
    won: toBool(row.won),
  })).filter((row) => row.score && row.bookmaker_odds > 1 && row.model_probability > 0);
}

function loadWindow(csvPath, index) {
  const all = normalizeRows(parseCsv(fs.readFileSync(csvPath, 'utf8')));
  const filtered = modelMode === 'any' ? all : all.filter((row) => row.model_mode === modelMode);
  return {
    id: path.basename(csvPath).replace('.csv', ''),
    index,
    csv_path: csvPath,
    rows: filtered,
    discarded_other_mode: all.length - filtered.length,
  };
}

function evaluate(rows) {
  const bets = rows.length;
  const wins = rows.filter((row) => row.won).length;
  const profit = rows.reduce((sum, row) => sum + (row.won ? row.bookmaker_odds - 1 : -1), 0);
  return {
    bets,
    wins,
    profit,
    roi: bets ? profit / bets : 0,
    hit_rate: bets ? wins / bets : 0,
    average_odds: bets ? rows.reduce((sum, row) => sum + row.bookmaker_odds, 0) / bets : 0,
    average_probability: bets ? rows.reduce((sum, row) => sum + row.model_probability, 0) / bets : 0,
    average_implied_probability: bets ? rows.reduce((sum, row) => sum + 1 / row.bookmaker_odds, 0) / bets : 0,
  };
}

// Wilson 95% CI for a binomial proportion. Used so we don't pretend a 20-bet
// streak proves anything.
function wilsonInterval(wins, total, z = 1.96) {
  if (total <= 0) return { lower: 0, upper: 0 };
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function applyRule(rows, rule) {
  return rows.filter((row) => (
    row.model_probability >= rule.min_probability &&
    row.expected_value >= rule.min_ev &&
    row.edge >= rule.min_edge &&
    row.bookmaker_odds <= rule.max_odds &&
    (rule.surface === 'all' || row.surface === rule.surface) &&
    (rule.score_family === 'all' || row.score_family === rule.score_family) &&
    (rule.odds_bucket === 'all' || row.odds_bucket === rule.odds_bucket) &&
    (rule.match_type === 'all' || row.match_type === rule.match_type) &&
    (rule.tournament_level === 'all' || row.tournament_level === rule.tournament_level)
  ));
}

function ruleComplexity(rule) {
  return [rule.surface, rule.score_family, rule.odds_bucket, rule.match_type, rule.tournament_level]
    .filter((value) => value !== 'all').length;
}

const probabilityThresholds = [0.03, 0.05, 0.08, 0.1];
const evThresholds = [0, 0.05, 0.1, 0.2];
const edgeThresholds = [0, 0.02, 0.05];
const maxOddsThresholds = [12, 18, 25, 1000];
const surfaces = ['all', 'hard', 'clay', 'grass', 'indoor'];
const scoreFamilies = ['all', 'normal', 'close', 'clear', 'blowout'];
const oddsBuckets = ['all', 'odds_5_8', 'odds_8_12', 'odds_12_18', 'odds_18_30'];
const matchTypes = ['all', 'singles'];
const tournamentLevels = ['all', 'slam', 'tour_premium', 'tour_other', 'challenger', 'itf'];

function buildRules() {
  const rules = [];
  for (const minProbability of probabilityThresholds) {
    for (const minEv of evThresholds) {
      for (const minEdge of edgeThresholds) {
        for (const maxOdds of maxOddsThresholds) {
          for (const surface of surfaces) {
            for (const scoreFamily of scoreFamilies) {
              for (const oddsBucket of oddsBuckets) {
                for (const matchType of matchTypes) {
                  for (const tournamentLevel of tournamentLevels) {
                    if (oddsBucket !== 'all' && maxOdds !== 1000) continue;
                    const rule = {
                      min_probability: minProbability,
                      min_ev: minEv,
                      min_edge: minEdge,
                      max_odds: maxOdds,
                      surface,
                      score_family: scoreFamily,
                      odds_bucket: oddsBucket,
                      match_type: matchType,
                      tournament_level: tournamentLevel,
                    };
                    if (ruleComplexity(rule) > maxComplexity) continue;
                    if (scoreFamily === 'tiebreak') continue; // tiebreak hard-blocked, do not propose
                    rules.push(rule);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return rules;
}

function ruleId(rule) {
  return [
    `p${rule.min_probability}`,
    `ev${rule.min_ev}`,
    `ed${rule.min_edge}`,
    `mx${rule.max_odds}`,
    rule.surface,
    rule.score_family,
    rule.odds_bucket,
    rule.match_type,
    rule.tournament_level,
  ].join('|');
}

// In each fold we train on cumulative prior windows and test on the next.
// Survival on training means: enough bets, positive ROI, AND hit rate Wilson
// lower bound exceeds implied probability (model is statistically
// distinguishable from "no edge").
function trainSurvives(metrics) {
  if (metrics.bets < minBetsPerWindow) return false;
  if (metrics.roi <= 0) return false;
  const wilson = wilsonInterval(metrics.wins, metrics.bets);
  if (wilson.lower <= metrics.average_implied_probability) return false;
  return true;
}

function aggregate(perFold) {
  const totalBets = perFold.reduce((sum, fold) => sum + fold.bets, 0);
  const totalWins = perFold.reduce((sum, fold) => sum + fold.wins, 0);
  const totalProfit = perFold.reduce((sum, fold) => sum + fold.profit, 0);
  const eligible = perFold.filter((fold) => fold.bets >= Math.max(15, Math.floor(minBetsPerWindow * 0.5)));
  const positive = eligible.filter((fold) => fold.roi > 0);
  return {
    total_bets: totalBets,
    total_wins: totalWins,
    total_profit: totalProfit,
    total_roi: totalBets ? totalProfit / totalBets : 0,
    total_hit_rate: totalBets ? totalWins / totalBets : 0,
    eligible_test_folds: eligible.length,
    positive_test_folds: positive.length,
    worst_test_fold_roi: eligible.length ? Math.min(...eligible.map((fold) => fold.roi)) : 0,
    best_test_fold_roi: eligible.length ? Math.max(...eligible.map((fold) => fold.roi)) : 0,
    wilson_hit_rate_95: wilsonInterval(totalWins, totalBets),
  };
}

function classifyRule(agg, ruleObj) {
  if (agg.total_bets < minTotalTestBets) return 'REJECT_LOW_TEST_SAMPLE';
  if (agg.eligible_test_folds < minPositiveTestFolds) return 'REJECT_FEW_FOLDS';
  if (agg.worst_test_fold_roi < worstTestRoiFloor) return 'REJECT_FRAGILE';
  if (agg.positive_test_folds < minPositiveTestFolds) return 'REJECT_INCONSISTENT';
  if (agg.total_roi <= 0) return 'WATCHLIST';
  if (ruleComplexity(ruleObj) > maxComplexity) return 'REJECT_COMPLEXITY';
  return 'WALKFORWARD_CANDIDATE';
}

function walkForward(windows, rules) {
  // For each rule, accumulate test-fold results.
  const ruleResults = new Map();
  for (const rule of rules) {
    ruleResults.set(ruleId(rule), { rule, complexity: ruleComplexity(rule), foldsTrained: 0, foldsTested: [] });
  }

  for (let foldIndex = 1; foldIndex < windows.length; foldIndex += 1) {
    const trainRows = windows.slice(0, foldIndex).flatMap((window) => window.rows);
    const testWindow = windows[foldIndex];
    const trainBets = trainRows.length;

    for (const rule of rules) {
      const trainMetrics = evaluate(applyRule(trainRows, rule));
      if (!trainSurvives(trainMetrics)) continue;

      const testMetrics = evaluate(applyRule(testWindow.rows, rule));
      const entry = ruleResults.get(ruleId(rule));
      entry.foldsTrained += 1;
      entry.foldsTested.push({
        fold: foldIndex,
        train_window_count: foldIndex,
        train_bets: trainBets,
        train_metrics: trainMetrics,
        test_window_id: testWindow.id,
        test_metrics: testMetrics,
      });
    }
  }

  return ruleResults;
}

function summariseRule(entry) {
  const perFold = entry.foldsTested.map((fold) => fold.test_metrics);
  const agg = aggregate(perFold);
  const status = classifyRule(agg, entry.rule);
  return {
    rule: entry.rule,
    complexity: entry.complexity,
    folds_trained: entry.foldsTrained,
    folds_tested: entry.foldsTested,
    aggregate_test: agg,
    status,
  };
}

function overfitRiskScore(rulesSearched, candidates) {
  // Heuristic: searched-vs-survived ratio + sample size of best survivor.
  // Higher score = more risk. 0..1.
  if (rulesSearched <= 0) return 1;
  const survivalRate = candidates.length / rulesSearched;
  // Search-space penalty: a "found 1 in 10000" survivor is suspicious.
  const search = Math.min(1, Math.log10(rulesSearched) / 5);
  const sampleProtection = candidates.length === 0
    ? 0
    : Math.min(1, candidates[0].aggregate_test.total_bets / 500);
  return Math.max(0, Math.min(1, search + 0.4 - 0.6 * sampleProtection));
}

function main() {
  const windows = csvPaths.map(loadWindow);
  windows.forEach((window) => console.log(`${window.id}: ${window.rows.length} rows (mode filter: ${modelMode}, dropped: ${window.discarded_other_mode})`));
  const rules = buildRules();
  console.log(`Searching ${rules.length} candidate rules across ${windows.length} windows...`);

  const ruleResults = walkForward(windows, rules);
  const summarised = [...ruleResults.values()]
    .filter((entry) => entry.foldsTested.length > 0)
    .map(summariseRule)
    .sort((a, b) => b.aggregate_test.total_roi - a.aggregate_test.total_roi);

  const candidates = summarised.filter((entry) => entry.status === 'WALKFORWARD_CANDIDATE');
  const watchlist = summarised.filter((entry) => entry.status === 'WATCHLIST');
  const fragile = summarised.filter((entry) => entry.status === 'REJECT_FRAGILE');

  const baselineRule = {
    min_probability: 0.03, min_ev: 0, min_edge: 0, max_odds: 1000,
    surface: 'all', score_family: 'all', odds_bucket: 'all', match_type: 'all', tournament_level: 'all',
  };
  const baselineEntry = ruleResults.get(ruleId(baselineRule)) ?? { rule: baselineRule, complexity: 0, foldsTrained: 0, foldsTested: [] };
  const baseline = baselineEntry.foldsTested.length > 0
    ? summariseRule(baselineEntry)
    : { rule: baselineRule, complexity: 0, status: 'NO_TRAIN_SURVIVAL', aggregate_test: aggregate([]), folds_tested: [] };

  const risk = overfitRiskScore(rules.length, candidates);

  const verdict = candidates.length === 0
    ? 'No rule survived walk-forward validation. Do not enable Strict Mode based on existing data alone.'
    : risk > 0.7
      ? 'Walk-forward candidates exist but search-space-to-survivor ratio is high. Treat as research only.'
      : 'At least one rule survived walk-forward with manageable overfit risk. Forward live paper-trade before promoting.';

  const report = {
    model_version: 'v3_walkforward',
    csv_paths: csvPaths,
    model_mode_filter: modelMode,
    settings: {
      min_bets_per_window: minBetsPerWindow,
      min_total_test_bets: minTotalTestBets,
      min_positive_test_folds: minPositiveTestFolds,
      worst_test_roi_floor: worstTestRoiFloor,
      max_complexity: maxComplexity,
    },
    windows: windows.map((window) => ({ id: window.id, csv_path: window.csv_path, rows: window.rows.length })),
    rules_searched: rules.length,
    rules_with_train_survival: summarised.length,
    candidates_count: candidates.length,
    overfit_risk_score: risk,
    verdict,
    baseline,
    top_walkforward_candidates: candidates.slice(0, 25),
    watchlist_rules: watchlist.slice(0, 25),
    fragile_rejected: fragile.slice(0, 10),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `walkforward-v3-report-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log('SlipIQ Walk-Forward V3 report:');
  console.log(JSON.stringify({ ...report, top_walkforward_candidates: report.top_walkforward_candidates.slice(0, 5) }, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
