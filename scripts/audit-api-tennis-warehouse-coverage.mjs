#!/usr/bin/env node
/*
  First Set Lab / SlipIQ API Tennis warehouse coverage audit.

  Memory-safe version: streams the combined warehouse CSVs line-by-line instead of
  loading odds/fixtures into memory. This avoids GitHub Actions heap OOM on large
  12-15 month warehouse artifacts.
*/

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function safeNumber(v) {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}
async function streamCsv(filePath, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line && lineNo > 1) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells;
      continue;
    }
    if (!cells.some((c) => c !== '')) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    await onRow(row, lineNo);
  }
}
function writeCsv(filePath, rows, fields) {
  ensureDir(path.dirname(filePath));
  const out = fs.createWriteStream(filePath, 'utf8');
  out.write(fields.join(',') + '\n');
  for (const row of rows) out.write(fields.map((f) => csvEscape(row[f])).join(',') + '\n');
  out.end();
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function writeRow(out, row, fields) {
  out.write(fields.map((f) => csvEscape(row[f])).join(',') + '\n');
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
  const ratio = nums.length === 2 ? Math.max(...nums) / Math.min(...nums) : nums[1] / ((nums[0] + nums[nums.length - 1]) / 2);
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
function pct(n, d) { return d ? Number(((n / d) * 100).toFixed(2)) : 0; }
function addCount(map, key, inc = 1) { map.set(key, (map.get(key) || 0) + inc); }
function uniqueSize(set) { return set.size; }

const lanes = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365', public_signal_name: 'Core Cluster', model_bucket: 'MAIN',
    tour: 'ATP', tournament_group: 'GRAND_SLAM', target_scores: ['6:2', '6:3', '6:4'], qualifying_scores: ['6:3', '6:4'],
    trigger_score: '6:4', trigger_min: 5.00, trigger_max: 6.25, min_qualifying_grouped: 2.50, max_qualifying_grouped: null, required_skew: null,
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', public_signal_name: 'Reverse Stretch Cluster', model_bucket: 'MAIN',
    tour: 'ANY', tournament_group: 'GRAND_SLAM', target_scores: ['2:6', '4:6', '5:7'], qualifying_scores: ['2:6', '4:6'],
    trigger_score: '', trigger_min: null, trigger_max: null, min_qualifying_grouped: 2.50, max_qualifying_grouped: 4.50, required_skew: 'EXTREME',
  },
  {
    lane_key: 'CORE_P1_MIRROR_WTA_OTHER', public_signal_name: 'Mirror Cluster', model_bucket: 'WATCHLIST',
    tour: 'WTA', tournament_group: 'OTHER_TOUR', target_scores: ['6:3', '6:4', '7:5'], qualifying_scores: ['6:3', '6:4', '7:5'],
    trigger_score: '6:4', trigger_min: 5.00, trigger_max: 8.00, min_qualifying_grouped: 2.60, max_qualifying_grouped: null, required_skew: null,
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
    const triggerOdds = odds(row, lane.trigger_score);
    if (!triggerOdds || triggerOdds < lane.trigger_min || triggerOdds > lane.trigger_max) return { pass: false, reason: 'trigger_out_of_range' };
  }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_protected_scores' };
  return { pass: true, reason: 'accepted', qualifyingGrouped, protectedGrouped: groupedOdds(targetOdds), skew };
}

function makeLaneStats(lane) {
  return {
    lane_key: lane.lane_key,
    public_signal_name: lane.public_signal_name,
    model_bucket: lane.model_bucket,
    fixture_candidate_rows: 0,
    fixture_candidate_set: new Set(),
    first_set_market_rows_all_books: 0,
    first_set_market_set_all_books: new Set(),
    bet365_first_set_rows: 0,
    bet365_first_set_set: new Set(),
    complete_qualifying_rows: 0,
    complete_protected_rows: 0,
    accepted_signal_rows: 0,
    wins: 0,
    losses: 0,
    group_profit_units: 0,
    reject_counts: new Map(),
  };
}

async function main() {
  if (!fs.existsSync(fixturePath) || !fs.existsSync(widePath)) {
    console.error(`Missing required warehouse files in ${warehouseDir}`);
    console.error(`Expected ${fixturePath} and ${widePath}`);
    process.exit(2);
  }
  ensureDir(outDir);

  const laneStats = new Map(lanes.map((lane) => [lane.lane_key, makeLaneStats(lane)]));
  const fixtureUnique = new Set();
  const firstSetUnique = new Set();
  const bet365FirstSetUnique = new Set();
  const bookmakerMap = new Map();
  const monthlyMap = new Map();

  let fixtureRows = 0;
  let firstSetRows = 0;
  let bet365Rows = 0;

  console.log('Streaming fixtures...');
  await streamCsv(fixturePath, (row) => {
    fixtureRows += 1;
    const eventKey = clean(row.event_key);
    if (eventKey) fixtureUnique.add(eventKey);
    for (const lane of lanes) {
      if (!laneFixtureMatch(row, lane)) continue;
      const s = laneStats.get(lane.lane_key);
      s.fixture_candidate_rows += 1;
      if (eventKey) s.fixture_candidate_set.add(eventKey);
    }
  });

  const acceptedFields = ['lane_key','public_signal_name','model_bucket','event_date','event_time','event_key','match_name','tournament_name','bookmaker','first_set_score','result','qualifying_grouped_odds','protected_grouped_odds','market_skew_bucket','target_scores','qualifying_scores'];
  const acceptedOut = fs.createWriteStream(path.join(outDir, 'coverage_audit_accepted_rows.csv'), 'utf8');
  acceptedOut.write(acceptedFields.join(',') + '\n');

  console.log('Streaming first-set correct-score wide rows...');
  await streamCsv(widePath, (row) => {
    firstSetRows += 1;
    const eventKey = clean(row.event_key);
    const bookmaker = clean(row.bookmaker) || 'UNKNOWN';
    if (eventKey) firstSetUnique.add(eventKey);
    if (!bookmakerMap.has(bookmaker)) bookmakerMap.set(bookmaker, { bookmaker, rows: 0, event_keys: new Set() });
    const bookItem = bookmakerMap.get(bookmaker);
    bookItem.rows += 1;
    if (eventKey) bookItem.event_keys.add(eventKey);

    const isBook = bookmaker.toLowerCase() === bookmakerFilter;
    if (isBook) {
      bet365Rows += 1;
      if (eventKey) bet365FirstSetUnique.add(eventKey);
    }

    for (const lane of lanes) {
      if (!laneFixtureMatch(row, lane)) continue;
      const s = laneStats.get(lane.lane_key);
      s.first_set_market_rows_all_books += 1;
      if (eventKey) s.first_set_market_set_all_books.add(eventKey);
      if (!isBook) continue;
      s.bet365_first_set_rows += 1;
      if (eventKey) s.bet365_first_set_set.add(eventKey);
      if (lane.qualifying_scores.every((score) => odds(row, score) && odds(row, score) > 1)) s.complete_qualifying_rows += 1;
      if (lane.target_scores.every((score) => odds(row, score) && odds(row, score) > 1)) s.complete_protected_rows += 1;
      const res = passLane(row, lane);
      if (!res.pass) {
        addCount(s.reject_counts, res.reason);
        continue;
      }
      s.accepted_signal_rows += 1;
      const firstSetScore = normalizeScore(row.first_set_score);
      const hasScore = /^\d+:\d+$/.test(firstSetScore);
      const win = lane.target_scores.includes(firstSetScore);
      const result = hasScore ? (win ? 'WIN' : 'LOSS') : 'NO_SCORE';
      if (hasScore && win) s.wins += 1;
      if (hasScore && !win) s.losses += 1;
      if (hasScore) s.group_profit_units += win ? res.protectedGrouped - 1 : -1;

      const month = clean(row.event_date).slice(0, 7) || 'UNKNOWN';
      const mkey = `${month}|${lane.lane_key}`;
      if (!monthlyMap.has(mkey)) monthlyMap.set(mkey, { month, lane_key: lane.lane_key, signals: 0, wins: 0, losses: 0, no_score: 0 });
      const monthly = monthlyMap.get(mkey);
      monthly.signals += 1;
      if (result === 'WIN') monthly.wins += 1;
      else if (result === 'LOSS') monthly.losses += 1;
      else monthly.no_score += 1;

      writeRow(acceptedOut, {
        lane_key: lane.lane_key,
        public_signal_name: lane.public_signal_name,
        model_bucket: lane.model_bucket,
        event_date: row.event_date,
        event_time: row.event_time,
        event_key: row.event_key,
        match_name: row.match_name,
        tournament_name: row.tournament_name,
        bookmaker,
        first_set_score: row.first_set_score,
        result,
        qualifying_grouped_odds: res.qualifyingGrouped,
        protected_grouped_odds: res.protectedGrouped,
        market_skew_bucket: res.skew,
        target_scores: lane.target_scores.join('/'),
        qualifying_scores: lane.qualifying_scores.join('/'),
      }, acceptedFields);
    }
  });
  acceptedOut.end();

  const laneFunnel = [...laneStats.values()].map((s) => ({
    lane_key: s.lane_key,
    public_signal_name: s.public_signal_name,
    model_bucket: s.model_bucket,
    fixture_candidate_rows: s.fixture_candidate_rows,
    fixture_candidate_unique_matches: uniqueSize(s.fixture_candidate_set),
    first_set_market_rows_all_books: s.first_set_market_rows_all_books,
    first_set_market_unique_matches_all_books: uniqueSize(s.first_set_market_set_all_books),
    bet365_first_set_rows: s.bet365_first_set_rows,
    bet365_first_set_unique_matches: uniqueSize(s.bet365_first_set_set),
    complete_qualifying_rows: s.complete_qualifying_rows,
    complete_protected_rows: s.complete_protected_rows,
    accepted_signal_rows: s.accepted_signal_rows,
    coverage_fixture_to_bet365_pct: pct(uniqueSize(s.bet365_first_set_set), uniqueSize(s.fixture_candidate_set)),
    acceptance_from_bet365_pct: pct(s.accepted_signal_rows, s.bet365_first_set_rows),
    wins: s.wins,
    losses: s.losses,
    hit_rate_pct: pct(s.wins, s.wins + s.losses),
    group_profit_units: Number(s.group_profit_units.toFixed(6)),
    group_roi_pct: s.wins + s.losses ? Number(((s.group_profit_units / (s.wins + s.losses)) * 100).toFixed(2)) : 0,
  }));

  const rejectionRows = [];
  for (const s of laneStats.values()) {
    for (const [reason, rows] of [...s.reject_counts.entries()].sort()) {
      rejectionRows.push({ lane_key: s.lane_key, public_signal_name: s.public_signal_name, reason, rows });
    }
  }
  const monthlyRows = [...monthlyMap.values()].sort((a, b) => `${a.month}|${a.lane_key}`.localeCompare(`${b.month}|${b.lane_key}`)).map((r) => ({ ...r, hit_rate_pct: pct(r.wins, r.wins + r.losses) }));
  const bookmakerRows = [...bookmakerMap.values()].map((r) => ({
    bookmaker: r.bookmaker,
    rows: r.rows,
    unique_matches: r.event_keys.size,
    pct_of_first_set_matches: pct(r.event_keys.size, firstSetUnique.size),
  })).sort((a, b) => b.unique_matches - a.unique_matches);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'api_tennis_warehouse_coverage_audit_streaming',
    source_files: { fixtures: fixturePath, first_set_wide: widePath },
    bookmaker: bookmakerFilter,
    totals: {
      fixture_rows: fixtureRows,
      fixture_unique_matches: fixtureUnique.size,
      first_set_correct_score_rows: firstSetRows,
      first_set_correct_score_unique_matches: firstSetUnique.size,
      bet365_first_set_rows: bet365Rows,
      bet365_first_set_unique_matches: bet365FirstSetUnique.size,
      fixture_to_first_set_market_pct: pct(firstSetUnique.size, fixtureUnique.size),
      fixture_to_bet365_first_set_pct: pct(bet365FirstSetUnique.size, fixtureUnique.size),
      first_set_market_to_bet365_pct: pct(bet365FirstSetUnique.size, firstSetUnique.size),
    },
    lane_funnel: laneFunnel,
  };

  writeJson(path.join(outDir, 'coverage_audit_summary.json'), summary);
  writeCsv(path.join(outDir, 'coverage_audit_lane_funnel.csv'), laneFunnel, Object.keys(laneFunnel[0] || {}));
  writeCsv(path.join(outDir, 'coverage_audit_rejections.csv'), rejectionRows, ['lane_key','public_signal_name','reason','rows']);
  writeCsv(path.join(outDir, 'coverage_audit_monthly.csv'), monthlyRows, ['month','lane_key','signals','wins','losses','no_score','hit_rate_pct']);
  writeCsv(path.join(outDir, 'coverage_audit_bookmaker_coverage.csv'), bookmakerRows, ['bookmaker','rows','unique_matches','pct_of_first_set_matches']);

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
    '## Read this correctly',
    '- Low fixture-to-Bet365 coverage means historical volume is likely undercounted by archived market availability.',
    '- High Bet365 coverage with low accepted rows means the filters are the true limiter.',
    '- Month clustering means volume projections must be tournament/season aware.',
  ];
  fs.writeFileSync(path.join(outDir, 'coverage_audit_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
