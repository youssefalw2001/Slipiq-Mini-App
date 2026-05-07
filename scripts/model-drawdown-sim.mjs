// SlipIQ Monte Carlo drawdown simulator.
//
// Given a CSV of backtest rows (V2 or V3) and a rule definition, this script:
//   1. Filters rows to those that pass the rule.
//   2. Bootstraps N sample paths by resampling those rows with replacement.
//   3. For each path, simulates a flat-stake bankroll and tracks max drawdown,
//      longest losing streak, terminal bankroll, and bankroll after 50/100/200
//      bets.
//   4. Reports percentile distributions so we can answer questions like
//      "what's the 10th-percentile bankroll after 100 bets at 1u flat?".
//
// This is not a CLV-aware simulator yet. It assumes the historical sample is
// representative. If your sample has survivorship bias (e.g. you only kept
// rows from rules that already worked) the output will be optimistic. Use it
// as a stress test, not a forecast.
//
// Honest disclaimers baked into the report:
//   - Bootstrap resampling exaggerates positive paths if the underlying sample
//     itself was hand-picked. Always run on full v3 backtest CSVs first, then
//     re-run with the rule applied to compare.

import fs from 'node:fs';
import path from 'node:path';

const inputCsv = process.env.DRAWDOWN_INPUT_CSV;
const outputDir = process.env.DRAWDOWN_OUTPUT_DIR ?? 'artifacts/drawdown-sim';
const paths = Number(process.env.DRAWDOWN_PATHS ?? 10000);
const startingBankroll = Number(process.env.DRAWDOWN_BANKROLL ?? 1000);
const stake = Number(process.env.DRAWDOWN_STAKE ?? 10);
const checkpoints = (process.env.DRAWDOWN_CHECKPOINTS ?? '50,100,200').split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
const seed = Number(process.env.DRAWDOWN_SEED ?? 42);

const rule = {
  min_probability: Number(process.env.RULE_MIN_PROBABILITY ?? 0),
  min_ev: Number(process.env.RULE_MIN_EV ?? -10),
  min_edge: Number(process.env.RULE_MIN_EDGE ?? -10),
  max_odds: Number(process.env.RULE_MAX_ODDS ?? 1e9),
  surface: process.env.RULE_SURFACE ?? 'all',
  score_family: process.env.RULE_SCORE_FAMILY ?? 'all',
  odds_bucket: process.env.RULE_ODDS_BUCKET ?? 'all',
  match_type: process.env.RULE_MATCH_TYPE ?? 'all',
  tournament_level: process.env.RULE_TOURNAMENT_LEVEL ?? 'all',
};

if (!inputCsv) {
  console.error('Missing DRAWDOWN_INPUT_CSV.');
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
    if (char === '"' && inQuotes && next === '"') { current += '"'; i += 1; }
    else if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { row.push(current); current = ''; }
    else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = []; current = '';
    } else current += char;
  }
  if (current || row.length) { row.push(current); rows.push(row); }
  const [headers, ...data] = rows;
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

const toNumber = (value) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const toBool = (value) => String(value).toLowerCase() === 'true';

function applyRule(rows) {
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

// Mulberry32 PRNG so simulator runs are deterministic for a given DRAWDOWN_SEED.
function rngFactory(s) {
  let state = s >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function simulatePath(rows, rng) {
  const n = rows.length;
  let bankroll = startingBankroll;
  let peak = bankroll;
  let maxDrawdown = 0;
  let losingStreak = 0;
  let longestLosingStreak = 0;
  const checkpointBankrolls = {};
  for (let i = 0; i < n; i += 1) {
    const sample = rows[Math.floor(rng() * n)];
    const profit = sample.won ? stake * (sample.bookmaker_odds - 1) : -stake;
    bankroll += profit;
    if (bankroll > peak) peak = bankroll;
    const drawdown = peak - bankroll;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (sample.won) losingStreak = 0;
    else { losingStreak += 1; if (losingStreak > longestLosingStreak) longestLosingStreak = losingStreak; }
    if (checkpoints.includes(i + 1)) checkpointBankrolls[i + 1] = bankroll;
  }
  return { terminalBankroll: bankroll, maxDrawdown, longestLosingStreak, checkpointBankrolls };
}

function main() {
  const allRows = parseCsv(fs.readFileSync(inputCsv, 'utf8')).map((row) => ({
    ...row,
    model_probability: toNumber(row.model_probability),
    bookmaker_odds: toNumber(row.bookmaker_odds),
    edge: toNumber(row.edge),
    expected_value: toNumber(row.expected_value),
    won: toBool(row.won),
  })).filter((row) => row.bookmaker_odds > 1 && row.model_probability > 0);

  const ruleRows = applyRule(allRows);
  if (ruleRows.length < 30) {
    console.error(`Only ${ruleRows.length} rows match the rule. Need at least 30 to bootstrap meaningfully.`);
    process.exit(2);
  }

  const wins = ruleRows.filter((row) => row.won).length;
  const profit = ruleRows.reduce((sum, row) => sum + (row.won ? row.bookmaker_odds - 1 : -1), 0);
  const observed = {
    bets: ruleRows.length,
    wins,
    hit_rate: wins / ruleRows.length,
    average_odds: ruleRows.reduce((sum, row) => sum + row.bookmaker_odds, 0) / ruleRows.length,
    historical_roi: profit / ruleRows.length,
  };

  const rng = rngFactory(seed);
  const terminalBankrolls = [];
  const drawdowns = [];
  const longestLosingStreaks = [];
  const checkpointBuckets = Object.fromEntries(checkpoints.map((c) => [c, []]));
  let downCount50 = 0, downCount100 = 0, downCount200 = 0;

  for (let i = 0; i < paths; i += 1) {
    const result = simulatePath(ruleRows, rng);
    terminalBankrolls.push(result.terminalBankroll);
    drawdowns.push(result.maxDrawdown);
    longestLosingStreaks.push(result.longestLosingStreak);
    for (const checkpoint of checkpoints) {
      const value = result.checkpointBankrolls[checkpoint];
      if (value !== undefined) {
        checkpointBuckets[checkpoint].push(value);
        if (checkpoint === 50 && value < startingBankroll) downCount50 += 1;
        if (checkpoint === 100 && value < startingBankroll) downCount100 += 1;
        if (checkpoint === 200 && value < startingBankroll) downCount200 += 1;
      }
    }
  }

  terminalBankrolls.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  longestLosingStreaks.sort((a, b) => a - b);
  for (const c of checkpoints) checkpointBuckets[c].sort((a, b) => a - b);

  const report = {
    model_version: 'v3_drawdown_sim',
    input_csv: inputCsv,
    rule,
    settings: { paths, startingBankroll, stake, checkpoints, seed },
    observed,
    terminal_bankroll_percentiles: {
      p5: percentile(terminalBankrolls, 5),
      p10: percentile(terminalBankrolls, 10),
      p25: percentile(terminalBankrolls, 25),
      p50: percentile(terminalBankrolls, 50),
      p75: percentile(terminalBankrolls, 75),
      p90: percentile(terminalBankrolls, 90),
      p95: percentile(terminalBankrolls, 95),
    },
    max_drawdown_percentiles: {
      p50: percentile(drawdowns, 50),
      p75: percentile(drawdowns, 75),
      p90: percentile(drawdowns, 90),
      p95: percentile(drawdowns, 95),
      p99: percentile(drawdowns, 99),
    },
    longest_losing_streak_percentiles: {
      p50: percentile(longestLosingStreaks, 50),
      p90: percentile(longestLosingStreaks, 90),
      p99: percentile(longestLosingStreaks, 99),
    },
    checkpoint_percentiles: Object.fromEntries(
      checkpoints.map((c) => [c, {
        p10: percentile(checkpointBuckets[c], 10),
        p50: percentile(checkpointBuckets[c], 50),
        p90: percentile(checkpointBuckets[c], 90),
      }]),
    ),
    probability_below_starting_bankroll: {
      after_50: checkpoints.includes(50) ? downCount50 / paths : null,
      after_100: checkpoints.includes(100) ? downCount100 / paths : null,
      after_200: checkpoints.includes(200) ? downCount200 / paths : null,
    },
    caveat: 'Bootstrap resampling assumes the input CSV is representative. Survivorship bias inflates results; CLV is not modelled.',
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `drawdown-sim-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log('SlipIQ drawdown simulation:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
