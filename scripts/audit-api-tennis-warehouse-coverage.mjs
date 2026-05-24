#!/usr/bin/env node
/*
  First Set Lab / SlipIQ API Tennis warehouse coverage audit.

  Purpose:
  - Explain why historical backtests may show lower volume than live scanner volume.
  - Measure the funnel from fixtures -> first-set correct-score markets -> Bet365 rows
    -> complete protected score coverage -> upgraded model signals.
  - No API calls. No Supabase writes. Artifact-first audit only.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const warehouseDir = params['warehouse-dir'] || 'combined-warehouse';
const outDir = params.out || 'artifacts/output/api-tennis-warehouse-coverage-audit';
const bookmakerFilter = String(params.bookmaker || 'bet365').toLowerCase();

const fixturePath = path.join(warehouseDir, 'fixtures_full_combined.csv');
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');
const oddsPath = path.join(warehouseDir, 'odds_full_long_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function safeNumber(v) {
  if (v === undefined || v === null || clean(v) === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return csvParse(fs.readFileSync(filePath, 'utf8'));
}
function writeCsv(filePath, rows, fields) {
  ensureDir(path.dirname(filePath));
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvEscape(row[f])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function odds(row, score) { return safeNumber(row[`odds_${score.replace(':', '_')}`]); }
function groupedOdds(values) {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
}
function scoreSkewBucket(values) {
  const nums = values.map(safeNumber);
  if (nums.length < 2 || nums.some((o) => !o || o <= 1)) return 'UNKNOWN';
  let ratio;
  if (nums.length === 2) ratio = Math.max(...nums) / Math.min(...nums);
  else ratio = nums[1] / ((nums[0] + nums[nums.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function tour(row) {
  const key = clean(row.event_type_key);
  const type = `${row.event_type_type ?? ''} ${row.tournament_name ?? ''}`.toLowerCase();
  if (key === '265' || /\batp\b|men/.test(type)) return 'ATP';
  if (key === '266' || /\bwta\b|women/.test(type)) return 'WTA';
  return 'UNKNOWN';
}
function tournamentGroup(row) {
  const t = clean(row.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['barcelona', 'halle', 'queen', 'queens', 'london', 'stuttgart', 'charleston', 'washington', 'hamburg', 'tokyo', 'acapulco', 'eastbourne', 'rotterdam', 'basel', 'vienna', 'adelaide', 'brisbane', 'bad homburg', 'berlin', 'strasbourg', 'antwerp', 'dallas', 'rio', 'astana', 'chengdu', 'zhuhai', 'seoul'].some((k) => t.includes(k))) return 'STRONG_500_250';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}
function uniqCount(rows, field = 'event_key') {
  return new Set(rows.map((r) => clean(r[field])).filter(Boolean)).size;
}
function pct(n, d) { return d ? Number(((n / d) * 100).toFixed(2)) : 0; }
function addCount(map, key, inc = 1) { map.set(key, (map.get(key) || 0) + inc); }

const lanes = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365',
    public_signal_name: 'Core Cluster',
    model_bucket: 'MAIN',
    tour: 'ATP',
    tournament_group: 'GRAND_SLAM',
    target_scores: ['6:2', '6:3', '6:4'],
    qualifying_scores: ['6:3', '6:4'],
    trigger_score: '6:4',
    trigger_min: 5.00,
    trigger_max: 6.25,
    min_qualifying_grouped: 2.50,
    max_qualifying_grouped: null,
    required_skew: null,
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365',
    public_signal_name: 'Reverse Stretch Cluster',
    model_bucket: 'MAIN',
    tour: 'ANY',
    tournament_group: 'GRAND_SLAM',
    target_scores: ['2:6', '4:6', '5:7'],
    qualifying_scores: ['2:6', '4:6'],
    trigger_score: '',
    trigger_min: null,
    trigger_max: null,
    min_qualifying_grouped: 2.50,
    max_qualifying_grouped: 4.50,
    required_skew: 'EXTREME',
  },
  {
    lane_key: 'CORE_P1_MIRROR_WTA_OTHER',
    public_signal_name: 'Mirror Cluster',
    model_bucket: 'WATCHLIST',
    tour: 'WTA',
    tournament_group: 'OTHER_TOUR',
    target_scores: ['6:3', '6:4', '7:5'],
    qualifying_scores: ['6:3', '6:4', '7:5'],
    trigger_score: '6:4',
    trigger_min: 5.00,
    trigger_max: 8.00,
    min_qualifying_grouped: 2.60,
    max_qualifying_grouped: null,
    required_skew: null,
  },
];

function laneFixtureMatch(row, lane) {
  const rowTour = tour(row);
  const rowGroup = tournamentGroup(row);
  if (lane.tour !== 'ANY' && rowTour !== lane.tour) return false;
  if (lane.tournament_group !== 'ANY' && rowGroup !== lane.tournament_group) return false;
  return true;
}
function passLane(row, lane) {
  if (clean(row.bookmaker).toLowerCase() !== bookmakerFilter) return { pass: false, reason: 'wrong_bookmaker' };
  if (!laneFixtureMatch(row, lane)) return { pass: false, reason: 'wrong_fixture_bucket' };
  const qualifyingOdds = lane.qualifying_scores.map((s) => odds(row, s));
  if (qualifyingOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_qualifying_scores' };
  const qualifyingGrouped = groupedOdds(qualifyingOdds);
  if (!qualifyingGrouped || qualifyingGrouped < lane.min_qualifying_grouped) return { pass: false, reason: 'qualifying_grouped_below_floor' };
  if (lane.max_qualifying_grouped && qualifyingGrouped > lane.max_qualifying_grouped) return { pass: false, reason: 'qualifying_grouped_above_ceiling' };
  const skew = scoreSkewBucket(qualifyingOdds);
  if (lane.required_skew && skew !== lane.required_skew) return { pass: false, reason: 'wrong_skew' };
  if (lane.trigger_score) {
    const t = odds(row, lane.trigger_score);
    if (!t || t < lane.trigger_min || t > lane.trigger_max) return { pass: false, reason: 'trigger_out_of_range' };
  }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_protected_scores' };
  const protectedGrouped = groupedOdds(targetOdds);
  return { pass: true, reason: 'accepted', qualifyingGrouped, protectedGrouped, skew };
}

function summarizeRows(rows) {
  return { rows: rows.length, unique_matches: uniqCount(rows) };
}

function main() {
  if (!fs.existsSync(fixturePath) || !fs.existsSync(widePath)) {
    console.error(`Missing required warehouse files in ${warehouseDir}`);
    console.error(`Expected ${fixturePath} and ${widePath}`);
    process.exit(2);
  }
  ensureDir(outDir);
  const fixtures = readCsv(fixturePath);
  const wideRows = readCsv(widePath);
  const oddsRows = readCsv(oddsPath);

  const firstSetRows = wideRows.filter((r) => clean(r.market_name) || clean(r.bookmaker));
  const bet365Rows = firstSetRows.filter((r) => clean(r.bookmaker).toLowerCase() === bookmakerFilter);
  const fixturesWithFirstSetMarket = new Set(firstSetRows.map((r) => clean(r.event_key)).filter(Boolean));
  const fixturesWithBet365FirstSet = new Set(bet365Rows.map((r) => clean(r.event_key)).filter(Boolean));

  const laneFunnel = [];
  const rejectionRows = [];
  const acceptedRows = [];

  for (const lane of lanes) {
    const fixtureCandidates = fixtures.filter((r) => laneFixtureMatch(r, lane));
    const marketCandidates = firstSetRows.filter((r) => laneFixtureMatch(r, lane));
    const bookCandidates = bet365Rows.filter((r) => laneFixtureMatch(r, lane));
    const completeQualifying = bookCandidates.filter((r) => lane.qualifying_scores.every((s) => odds(r, s) && odds(r, s) > 1));
    const completeProtected = bookCandidates.filter((r) => lane.target_scores.every((s) => odds(r, s) && odds(r, s) > 1));
    const rejectCounts = new Map();
    let accepted = 0;
    let wins = 0;
    let losses = 0;
    let groupUnits = 0;

    for (const row of bookCandidates) {
      const res = passLane(row, lane);
      if (!res.pass) {
        addCount(rejectCounts, res.reason);
        continue;
      }
      accepted += 1;
      const firstSetScore = normalizeScore(row.first_set_score);
      const win = lane.target_scores.includes(firstSetScore);
      const hasScore = /^\d+:\d+$/.test(firstSetScore);
      if (hasScore && win) wins += 1;
      if (hasScore && !win) losses += 1;
      if (hasScore) groupUnits += win ? res.protectedGrouped - 1 : -1;
      acceptedRows.push({
        lane_key: lane.lane_key,
        public_signal_name: lane.public_signal_name,
        model_bucket: lane.model_bucket,
        event_date: row.event_date,
        event_time: row.event_time,
        event_key: row.event_key,
        match_name: row.match_name,
        tournament_name: row.tournament_name,
        bookmaker: row.bookmaker,
        first_set_score: row.first_set_score,
        result: hasScore ? (win ? 'WIN' : 'LOSS') : 'NO_SCORE',
        qualifying_grouped_odds: res.qualifyingGrouped,
        protected_grouped_odds: res.protectedGrouped,
        market_skew_bucket: res.skew,
        target_scores: lane.target_scores.join('/'),
        qualifying_scores: lane.qualifying_scores.join('/'),
      });
    }
    for (const [reason, count] of [...rejectCounts.entries()].sort()) {
      rejectionRows.push({ lane_key: lane.lane_key, public_signal_name: lane.public_signal_name, reason, rows: count });
    }

    laneFunnel.push({
      lane_key: lane.lane_key,
      public_signal_name: lane.public_signal_name,
      model_bucket: lane.model_bucket,
      fixture_candidate_rows: fixtureCandidates.length,
      fixture_candidate_unique_matches: uniqCount(fixtureCandidates),
      first_set_market_rows_all_books: marketCandidates.length,
      first_set_market_unique_matches_all_books: uniqCount(marketCandidates),
      bet365_first_set_rows: bookCandidates.length,
      bet365_first_set_unique_matches: uniqCount(bookCandidates),
      complete_qualifying_rows: completeQualifying.length,
      complete_protected_rows: completeProtected.length,
      accepted_signal_rows: accepted,
      coverage_fixture_to_bet365_pct: pct(uniqCount(bookCandidates), uniqCount(fixtureCandidates)),
      acceptance_from_bet365_pct: pct(accepted, bookCandidates.length),
      wins,
      losses,
      hit_rate_pct: pct(wins, wins + losses),
      group_profit_units: Number(groupUnits.toFixed(6)),
      group_roi_pct: wins + losses ? Number(((groupUnits / (wins + losses)) * 100).toFixed(2)) : 0,
    });
  }

  const monthly = [];
  const monthlyMap = new Map();
  for (const row of acceptedRows) {
    const month = clean(row.event_date).slice(0, 7) || 'UNKNOWN';
    const key = `${month}|${row.lane_key}`;
    if (!monthlyMap.has(key)) monthlyMap.set(key, { month, lane_key: row.lane_key, signals: 0, wins: 0, losses: 0, no_score: 0 });
    const item = monthlyMap.get(key);
    item.signals += 1;
    if (row.result === 'WIN') item.wins += 1;
    else if (row.result === 'LOSS') item.losses += 1;
    else item.no_score += 1;
  }
  for (const item of monthlyMap.values()) {
    item.hit_rate_pct = pct(item.wins, item.wins + item.losses);
    monthly.push(item);
  }
  monthly.sort((a, b) => `${a.month}|${a.lane_key}`.localeCompare(`${b.month}|${b.lane_key}`));

  const bookmakerMap = new Map();
  for (const row of firstSetRows) {
    const b = clean(row.bookmaker) || 'UNKNOWN';
    if (!bookmakerMap.has(b)) bookmakerMap.set(b, { bookmaker: b, rows: 0, unique_matches_set: new Set() });
    const item = bookmakerMap.get(b);
    item.rows += 1;
    if (clean(row.event_key)) item.unique_matches_set.add(clean(row.event_key));
  }
  const bookmakerCoverage = [...bookmakerMap.values()].map((r) => ({
    bookmaker: r.bookmaker,
    rows: r.rows,
    unique_matches: r.unique_matches_set.size,
    pct_of_first_set_matches: pct(r.unique_matches_set.size, fixturesWithFirstSetMarket.size),
  })).sort((a, b) => b.unique_matches - a.unique_matches);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'api_tennis_warehouse_coverage_audit',
    source_files: { fixtures: fixturePath, first_set_wide: widePath, odds_long: fs.existsSync(oddsPath) ? oddsPath : null },
    bookmaker: bookmakerFilter,
    totals: {
      fixture_rows: fixtures.length,
      fixture_unique_matches: uniqCount(fixtures),
      first_set_correct_score_rows: firstSetRows.length,
      first_set_correct_score_unique_matches: fixturesWithFirstSetMarket.size,
      bet365_first_set_rows: bet365Rows.length,
      bet365_first_set_unique_matches: fixturesWithBet365FirstSet.size,
      odds_long_rows: oddsRows.length,
      fixture_to_first_set_market_pct: pct(fixturesWithFirstSetMarket.size, uniqCount(fixtures)),
      fixture_to_bet365_first_set_pct: pct(fixturesWithBet365FirstSet.size, uniqCount(fixtures)),
      first_set_market_to_bet365_pct: pct(fixturesWithBet365FirstSet.size, fixturesWithFirstSetMarket.size),
    },
    lane_funnel: laneFunnel,
  };

  writeJson(path.join(outDir, 'coverage_audit_summary.json'), summary);
  writeCsv(path.join(outDir, 'coverage_audit_lane_funnel.csv'), laneFunnel, Object.keys(laneFunnel[0] || {}));
  writeCsv(path.join(outDir, 'coverage_audit_rejections.csv'), rejectionRows, ['lane_key','public_signal_name','reason','rows']);
  writeCsv(path.join(outDir, 'coverage_audit_monthly.csv'), monthly, ['month','lane_key','signals','wins','losses','no_score','hit_rate_pct']);
  writeCsv(path.join(outDir, 'coverage_audit_bookmaker_coverage.csv'), bookmakerCoverage, ['bookmaker','rows','unique_matches','pct_of_first_set_matches']);
  writeCsv(path.join(outDir, 'coverage_audit_accepted_rows.csv'), acceptedRows, ['lane_key','public_signal_name','model_bucket','event_date','event_time','event_key','match_name','tournament_name','bookmaker','first_set_score','result','qualifying_grouped_odds','protected_grouped_odds','market_skew_bucket','target_scores','qualifying_scores']);

  const mainAccepted = laneFunnel.filter((r) => r.model_bucket === 'MAIN').reduce((sum, r) => sum + r.accepted_signal_rows, 0);
  const report = [
    '# API Tennis Warehouse Coverage Audit',
    '',
    `Generated: ${summary.generated_at}`,
    `Bookmaker focus: ${bookmakerFilter}`,
    '',
    '## Global coverage',
    `- Fixture rows: ${summary.totals.fixture_rows}`,
    `- Fixture unique matches: ${summary.totals.fixture_unique_matches}`,
    `- First-set correct-score unique matches: ${summary.totals.first_set_correct_score_unique_matches} (${summary.totals.fixture_to_first_set_market_pct}% of fixtures)`,
    `- Bet365 first-set correct-score unique matches: ${summary.totals.bet365_first_set_unique_matches} (${summary.totals.fixture_to_bet365_first_set_pct}% of fixtures)`,
    `- Bet365 share of first-set market matches: ${summary.totals.first_set_market_to_bet365_pct}%`,
    '',
    '## Upgraded model funnel',
    ...laneFunnel.map((r) => [
      `### ${r.public_signal_name}`,
      `- Fixture candidates: ${r.fixture_candidate_unique_matches}`,
      `- Any-book first-set market matches: ${r.first_set_market_unique_matches_all_books}`,
      `- Bet365 first-set market matches: ${r.bet365_first_set_unique_matches}`,
      `- Complete protected rows: ${r.complete_protected_rows}`,
      `- Accepted signal rows: ${r.accepted_signal_rows}`,
      `- Fixture-to-Bet365 coverage: ${r.coverage_fixture_to_bet365_pct}%`,
      `- Acceptance from Bet365 rows: ${r.acceptance_from_bet365_pct}%`,
      `- Settled result: ${r.wins}W / ${r.losses}L, ${r.group_profit_units}u`,
    ].join('\n')),
    '',
    `Main accepted signal rows: ${mainAccepted}`,
    '',
    '## What this tells us',
    '- If fixture-to-Bet365 coverage is low, historical volume is likely undercounted by archived market availability.',
    '- If Bet365 coverage is high but accepted rows are low, the filters are the true limiter.',
    '- If accepted rows cluster in a few months, volume projections should be season/tournament aware.',
  ];
  fs.writeFileSync(path.join(outDir, 'coverage_audit_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
