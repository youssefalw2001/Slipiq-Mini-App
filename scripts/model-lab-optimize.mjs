import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.env.MODEL_LAB_INPUT_CSV;
const outputDir = process.env.MODEL_LAB_OUTPUT_DIR ?? 'artifacts/model-lab';
const minBets = Number(process.env.MODEL_LAB_MIN_BETS ?? 50);

if (!inputPath) {
  console.error('Missing MODEL_LAB_INPUT_CSV. Point it at first-set-lab-rows-*.csv from a backtest artifact.');
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

function normalizeRows(rawRows) {
  return rawRows.map((row) => ({
    ...row,
    score: row.score,
    model_probability: toNumber(row.model_probability),
    bookmaker_odds: toNumber(row.bookmaker_odds),
    edge: toNumber(row.edge),
    expected_value: toNumber(row.expected_value),
    won: toBool(row.won),
  })).filter((row) => row.score && row.bookmaker_odds > 1 && row.model_probability > 0);
}

function scoreFamily(score) {
  if (score === '7-6' || score === '6-7') return 'tiebreak';
  const [a, b] = score.split('-').map(Number);
  const diff = Math.abs(a - b);
  if (diff >= 4) return 'blowout';
  if (diff === 3) return 'clear';
  if (diff === 2) return 'normal';
  return 'close';
}

function oddsBucket(odds) {
  if (odds < 5) return 'odds_1_5';
  if (odds < 8) return 'odds_5_8';
  if (odds < 12) return 'odds_8_12';
  if (odds < 18) return 'odds_12_18';
  if (odds < 30) return 'odds_18_30';
  return 'odds_30_plus';
}

function evaluate(rows) {
  const bets = rows.length;
  const wins = rows.filter((row) => row.won).length;
  const profit = rows.reduce((sum, row) => sum + (row.won ? row.bookmaker_odds - 1 : -1), 0);
  const hitRate = bets ? wins / bets : 0;
  const roi = bets ? profit / bets : 0;
  const averageOdds = bets ? rows.reduce((sum, row) => sum + row.bookmaker_odds, 0) / bets : 0;
  const averageProbability = bets ? rows.reduce((sum, row) => sum + row.model_probability, 0) / bets : 0;
  const averageEv = bets ? rows.reduce((sum, row) => sum + row.expected_value, 0) / bets : 0;
  const averageEdge = bets ? rows.reduce((sum, row) => sum + row.edge, 0) / bets : 0;
  return { bets, wins, profit, roi, hit_rate: hitRate, average_odds: averageOdds, average_probability: averageProbability, average_ev: averageEv, average_edge: averageEdge };
}

const probabilityThresholds = [0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15];
const evThresholds = [0, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3];
const edgeThresholds = [0, 0.01, 0.02, 0.03, 0.05, 0.08];
const maxOddsThresholds = [8, 12, 18, 30, 1000];
const allowedFamilies = [null, 'normal', 'close', 'clear', 'tiebreak', 'blowout'];

function runGrid(rows) {
  const results = [];

  for (const minProbability of probabilityThresholds) {
    for (const minEv of evThresholds) {
      for (const minEdge of edgeThresholds) {
        for (const maxOdds of maxOddsThresholds) {
          for (const family of allowedFamilies) {
            const filtered = rows.filter((row) => (
              row.model_probability >= minProbability &&
              row.expected_value >= minEv &&
              row.edge >= minEdge &&
              row.bookmaker_odds <= maxOdds &&
              (!family || scoreFamily(row.score) === family)
            ));

            if (filtered.length < minBets) continue;
            results.push({
              rule: { min_probability: minProbability, min_ev: minEv, min_edge: minEdge, max_odds: maxOdds, score_family: family ?? 'all' },
              ...evaluate(filtered),
            });
          }
        }
      }
    }
  }

  return results.sort((a, b) => b.roi - a.roi);
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...evaluate(group) })).sort((a, b) => b.roi - a.roi);
}

function main() {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const rows = normalizeRows(parseCsv(raw));
  const baseQualified = rows.filter((row) => row.model_probability >= 0.03 && row.expected_value >= 0 && row.edge >= 0);
  const grid = runGrid(rows);
  const scoreBreakdown = groupBy(baseQualified, (row) => row.score).filter((item) => item.bets >= Math.max(10, Math.floor(minBets / 3)));
  const familyBreakdown = groupBy(baseQualified, (row) => scoreFamily(row.score)).filter((item) => item.bets >= minBets);
  const oddsBreakdown = groupBy(baseQualified, (row) => oddsBucket(row.bookmaker_odds)).filter((item) => item.bets >= minBets);

  const report = {
    input_path: inputPath,
    rows_loaded: rows.length,
    min_bets: minBets,
    baseline_rule: { min_probability: 0.03, min_ev: 0, min_edge: 0 },
    baseline: evaluate(baseQualified),
    top_rules: grid.slice(0, 30),
    score_breakdown: scoreBreakdown.slice(0, 30),
    score_family_breakdown: familyBreakdown,
    odds_bucket_breakdown: oddsBreakdown,
    warning: grid.length === 0
      ? 'No rules met min sample size. Lower MODEL_LAB_MIN_BETS or run a wider backtest range.'
      : grid[0].roi <= 0
        ? 'No positive high-sample rule found. Current model likely needs stronger player stats/features before premium claims.'
        : 'Positive backtest pockets found. Treat as research only until validated out-of-sample and against closing odds.',
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `model-lab-report-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log('SlipIQ Model Lab report:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
