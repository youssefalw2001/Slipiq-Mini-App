import fs from 'node:fs';
import path from 'node:path';

const trainCsv = process.env.MODEL_MASTER_TRAIN_CSV;
const validationCsv = process.env.MODEL_MASTER_VALIDATION_CSV;
const outputDir = process.env.MODEL_MASTER_OUTPUT_DIR ?? 'artifacts/model-master';
const minTrainBets = Number(process.env.MODEL_MASTER_MIN_TRAIN_BETS ?? 75);
const minValidationBets = Number(process.env.MODEL_MASTER_MIN_VALIDATION_BETS ?? 40);

if (!trainCsv || !validationCsv) {
  console.error('Missing MODEL_MASTER_TRAIN_CSV or MODEL_MASTER_VALIDATION_CSV.');
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

function applyRule(rows, rule) {
  return rows.filter((row) => (
    row.model_probability >= rule.min_probability &&
    row.expected_value >= rule.min_ev &&
    row.edge >= rule.min_edge &&
    row.bookmaker_odds <= rule.max_odds &&
    (!rule.score_family || rule.score_family === 'all' || scoreFamily(row.score) === rule.score_family) &&
    (!rule.odds_bucket || rule.odds_bucket === 'all' || oddsBucket(row.bookmaker_odds) === rule.odds_bucket)
  ));
}

const probabilityThresholds = [0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15];
const evThresholds = [0, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3];
const edgeThresholds = [0, 0.01, 0.02, 0.03, 0.05, 0.08];
const maxOddsThresholds = [6, 8, 10, 12, 15, 18, 25, 1000];
const allowedFamilies = ['all', 'normal', 'close', 'clear', 'tiebreak', 'blowout'];
const allowedOddsBuckets = ['all', 'odds_1_5', 'odds_5_8', 'odds_8_12', 'odds_12_18', 'odds_18_30'];

function trainRules(trainRows) {
  const candidates = [];

  for (const minProbability of probabilityThresholds) {
    for (const minEv of evThresholds) {
      for (const minEdge of edgeThresholds) {
        for (const maxOdds of maxOddsThresholds) {
          for (const scoreFamilyRule of allowedFamilies) {
            for (const oddsBucketRule of allowedOddsBuckets) {
              if (oddsBucketRule !== 'all' && maxOdds !== 1000) continue;
              const rule = {
                min_probability: minProbability,
                min_ev: minEv,
                min_edge: minEdge,
                max_odds: maxOdds,
                score_family: scoreFamilyRule,
                odds_bucket: oddsBucketRule,
              };
              const rows = applyRule(trainRows, rule);
              if (rows.length < minTrainBets) continue;
              const metrics = evaluate(rows);
              candidates.push({ rule, train: metrics });
            }
          }
        }
      }
    }
  }

  return candidates.sort((a, b) => b.train.roi - a.train.roi).slice(0, 100);
}

function stabilityScore(train, validation) {
  if (validation.bets < minValidationBets) return -999;
  const roiPenalty = Math.abs(train.roi - validation.roi) * 0.5;
  const hitPenalty = Math.abs(train.hit_rate - validation.hit_rate) * 0.25;
  const sampleBonus = Math.min(validation.bets / 500, 1) * 0.05;
  return validation.roi - roiPenalty - hitPenalty + sampleBonus;
}

function validateCandidates(candidates, validationRows) {
  return candidates.map((candidate) => {
    const validation = evaluate(applyRule(validationRows, candidate.rule));
    const stability = stabilityScore(candidate.train, validation);
    const status = validation.bets < minValidationBets
      ? 'REJECT_LOW_SAMPLE'
      : validation.roi > 0 && candidate.train.roi > 0
        ? 'VALIDATED_CANDIDATE'
        : validation.roi > -0.05
          ? 'WATCHLIST'
          : 'REJECT_FAILED_VALIDATION';

    return {
      rule: candidate.rule,
      train: candidate.train,
      validation,
      stability_score: stability,
      status,
    };
  }).sort((a, b) => b.stability_score - a.stability_score);
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
  const trainRows = normalizeRows(parseCsv(fs.readFileSync(trainCsv, 'utf8')));
  const validationRows = normalizeRows(parseCsv(fs.readFileSync(validationCsv, 'utf8')));

  const baselineRule = { min_probability: 0.03, min_ev: 0, min_edge: 0, max_odds: 1000, score_family: 'all', odds_bucket: 'all' };
  const baselineTrain = evaluate(applyRule(trainRows, baselineRule));
  const baselineValidation = evaluate(applyRule(validationRows, baselineRule));
  const trained = trainRules(trainRows);
  const validated = validateCandidates(trained, validationRows);
  const validatedCandidates = validated.filter((item) => item.status === 'VALIDATED_CANDIDATE');
  const watchlist = validated.filter((item) => item.status === 'WATCHLIST');

  const report = {
    train_csv: trainCsv,
    validation_csv: validationCsv,
    train_rows_loaded: trainRows.length,
    validation_rows_loaded: validationRows.length,
    min_train_bets: minTrainBets,
    min_validation_bets: minValidationBets,
    baseline: {
      rule: baselineRule,
      train: baselineTrain,
      validation: baselineValidation,
    },
    top_validated_rules: validatedCandidates.slice(0, 20),
    watchlist_rules: watchlist.slice(0, 20),
    top_train_rules_with_validation: validated.slice(0, 30),
    validation_score_family_breakdown: groupBy(applyRule(validationRows, baselineRule), (row) => scoreFamily(row.score)),
    validation_odds_bucket_breakdown: groupBy(applyRule(validationRows, baselineRule), (row) => oddsBucket(row.bookmaker_odds)),
    verdict: validatedCandidates.length > 0
      ? 'A positive rule survived separate validation. Treat as research until tested on more windows and live paper trading.'
      : watchlist.length > 0
        ? 'No clearly positive rule survived validation, but some rules stayed near breakeven. Upgrade model features before premium claims.'
        : 'No rule survived validation. Current model should not be marketed as an edge model yet.',
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `model-master-report-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log('SlipIQ Model Master validation report:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
