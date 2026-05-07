import fs from 'node:fs';
import path from 'node:path';

const csvListRaw = process.env.MODEL_CONSENSUS_CSVS;
const outputDir = process.env.MODEL_CONSENSUS_OUTPUT_DIR ?? 'artifacts/model-consensus-v2';
const minBetsPerWindow = Number(process.env.MODEL_CONSENSUS_MIN_BETS_PER_WINDOW ?? 35);
const minPositiveWindows = Number(process.env.MODEL_CONSENSUS_MIN_POSITIVE_WINDOWS ?? 2);

if (!csvListRaw) {
  console.error('Missing MODEL_CONSENSUS_CSVS. Provide comma-separated V2 backtest CSV paths.');
  process.exit(1);
}

const csvPaths = csvListRaw.split(',').map((item) => item.trim()).filter(Boolean);
if (csvPaths.length < 2) {
  console.error('MODEL_CONSENSUS_CSVS must include at least two CSV files.');
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
  const rows = normalizeRows(parseCsv(fs.readFileSync(csvPath, 'utf8')));
  return {
    id: path.basename(csvPath).replace('.csv', ''),
    index,
    csv_path: csvPath,
    rows,
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
    average_ev: bets ? rows.reduce((sum, row) => sum + row.expected_value, 0) / bets : 0,
    average_edge: bets ? rows.reduce((sum, row) => sum + row.edge, 0) / bets : 0,
  };
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

const probabilityThresholds = [0.03, 0.05, 0.08, 0.1, 0.12, 0.15];
const evThresholds = [0, 0.05, 0.1, 0.15, 0.2];
const edgeThresholds = [0, 0.02, 0.05, 0.08];
const maxOddsThresholds = [8, 12, 15, 18, 25, 1000];
const surfaces = ['all', 'hard', 'clay', 'grass', 'indoor'];
const scoreFamilies = ['all', 'normal', 'close', 'clear', 'tiebreak', 'blowout'];
const oddsBuckets = ['all', 'odds_5_8', 'odds_8_12', 'odds_12_18', 'odds_18_30'];
const matchTypes = ['all', 'singles', 'doubles'];
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
                    const restrictions = [surface, scoreFamily, oddsBucket, matchType, tournamentLevel].filter((value) => value !== 'all').length;
                    if (restrictions > 3) continue;
                    if (scoreFamily === 'tiebreak' && minProbability < 0.08) continue;
                    rules.push({
                      min_probability: minProbability,
                      min_ev: minEv,
                      min_edge: minEdge,
                      max_odds: maxOdds,
                      surface,
                      score_family: scoreFamily,
                      odds_bucket: oddsBucket,
                      match_type: matchType,
                      tournament_level: tournamentLevel,
                    });
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

function scoreConsensus(windowMetrics) {
  const eligible = windowMetrics.filter((item) => item.bets >= minBetsPerWindow);
  const positive = eligible.filter((item) => item.roi > 0);
  const totalBets = eligible.reduce((sum, item) => sum + item.bets, 0);
  const totalProfit = eligible.reduce((sum, item) => sum + item.profit, 0);
  const averageRoi = eligible.length ? eligible.reduce((sum, item) => sum + item.roi, 0) / eligible.length : -999;
  const worstRoi = eligible.length ? Math.min(...eligible.map((item) => item.roi)) : -999;
  const bestRoi = eligible.length ? Math.max(...eligible.map((item) => item.roi)) : -999;
  const totalRoi = totalBets ? totalProfit / totalBets : -999;
  const positiveRate = eligible.length ? positive.length / eligible.length : 0;
  const stabilityPenalty = bestRoi === -999 ? 999 : Math.abs(bestRoi - worstRoi) * 0.25;
  const sampleBonus = Math.min(totalBets / 1000, 1) * 0.05;
  const consensusScore = totalRoi + averageRoi * 0.5 + positiveRate * 0.1 + sampleBonus - stabilityPenalty;

  return {
    eligible_windows: eligible.length,
    positive_windows: positive.length,
    positive_window_rate: positiveRate,
    total_bets: totalBets,
    total_profit: totalProfit,
    total_roi: totalRoi,
    average_window_roi: averageRoi,
    worst_window_roi: worstRoi,
    best_window_roi: bestRoi,
    consensus_score: consensusScore,
  };
}

function evaluateRuleAcrossWindows(rule, windows) {
  const windowMetrics = windows.map((window) => {
    const metrics = evaluate(applyRule(window.rows, rule));
    return {
      window_id: window.id,
      window_index: window.index,
      ...metrics,
    };
  });
  const consensus = scoreConsensus(windowMetrics);
  const status = consensus.eligible_windows < 2
    ? 'REJECT_LOW_SAMPLE'
    : consensus.positive_windows >= minPositiveWindows && consensus.total_roi > 0
      ? 'CONSENSUS_CANDIDATE'
      : consensus.positive_windows >= Math.max(1, minPositiveWindows - 1) && consensus.total_roi > -0.05
        ? 'WATCHLIST'
        : 'REJECT_UNSTABLE';

  return {
    rule,
    status,
    consensus,
    windows: windowMetrics,
  };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] ?? 'unknown';
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return [...groups.entries()].map(([name, group]) => ({ key: name, ...evaluate(group) })).sort((a, b) => b.roi - a.roi);
}

function main() {
  const windows = csvPaths.map(loadWindow);
  const allRows = windows.flatMap((window) => window.rows);
  const baselineRule = { min_probability: 0.03, min_ev: 0, min_edge: 0, max_odds: 1000, surface: 'all', score_family: 'all', odds_bucket: 'all', match_type: 'all', tournament_level: 'all' };
  const rules = buildRules();

  console.log(`Loaded ${windows.length} windows.`);
  for (const window of windows) console.log(`${window.id}: ${window.rows.length} rows`);
  console.log(`Testing ${rules.length} candidate rules.`);

  const results = rules
    .map((rule) => evaluateRuleAcrossWindows(rule, windows))
    .filter((result) => result.consensus.eligible_windows >= 2)
    .sort((a, b) => b.consensus.consensus_score - a.consensus.consensus_score);

  const consensusCandidates = results.filter((item) => item.status === 'CONSENSUS_CANDIDATE');
  const watchlist = results.filter((item) => item.status === 'WATCHLIST');
  const baseline = evaluateRuleAcrossWindows(baselineRule, windows);

  const report = {
    model_version: 'v2_multi_window_consensus',
    csv_paths: csvPaths,
    windows: windows.map((window) => ({ id: window.id, csv_path: window.csv_path, rows: window.rows.length })),
    settings: {
      min_bets_per_window: minBetsPerWindow,
      min_positive_windows: minPositiveWindows,
    },
    baseline,
    top_consensus_candidates: consensusCandidates.slice(0, 30),
    watchlist_rules: watchlist.slice(0, 30),
    top_rules_any_status: results.slice(0, 40),
    all_rows_breakdown: {
      surface: groupBy(allRows, 'surface'),
      score_family: groupBy(allRows, 'score_family'),
      odds_bucket: groupBy(allRows, 'odds_bucket'),
      match_type: groupBy(allRows, 'match_type'),
      tournament_level: groupBy(allRows, 'tournament_level'),
    },
    verdict: consensusCandidates.length > 0
      ? 'At least one V2 rule showed positive multi-window consensus. Treat as research until live tracking confirms it.'
      : watchlist.length > 0
        ? 'No strong consensus rule yet, but some near-breakeven patterns exist. Continue feature/model refinement.'
        : 'No multi-window consensus found. Do not ship a strict signal filter yet.',
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `model-consensus-v2-report-${Date.now()}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log('SlipIQ Model Consensus V2 report:');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
