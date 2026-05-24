#!/usr/bin/env node
/*
  First Set Lab / SlipIQ upgraded Bet365 protected-score backtest.

  Reads the API Tennis full historical odds warehouse combined files and tests the
  upgraded live model without calling API Tennis again.

  Main lanes:
  - Core Cluster: ATP Grand Slam, Bet365, old 6:3/6:4 gate preserved,
    protected executable target 6:2/6:3/6:4.
  - Reverse Stretch Cluster: Grand Slam, Bet365, old 2:6/4:6 gate preserved,
    protected executable target 2:6/4:6/5:7.

  Watchlist lane:
  - Mirror Cluster: WTA OTHER_TOUR, Bet365, 6:3/6:4/7:5. Reported separately.

  Core Cluster Plus is intentionally excluded.
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
const outDir = params.out || 'artifacts/output/upgraded-bet365-backtest';
const bookmakerFilter = String(params.bookmaker || 'bet365').toLowerCase();
const bankroll = Number(params.bankroll || '3000') || 3000;
const riskPcts = String(params['risk-pcts'] || '0.05,0.06,0.07')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0 && v < 1);
const includeMirrorWatchlist = String(params['include-mirror-watchlist'] ?? 'true').toLowerCase() !== 'false';

const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clean(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function safeNumber(v) {
  if (v === undefined || v === null || clean(v) === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeScore(v) {
  return clean(v).replace('-', ':');
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
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
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

function decimalToAmerican(decimal) {
  const d = safeNumber(decimal);
  if (!d || d <= 1) return '';
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function odds(row, score) {
  return safeNumber(row[`odds_${score.replace(':', '_')}`]);
}

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
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai', 'qatar open'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['barcelona', 'halle', 'queen', 'queens', 'london', 'stuttgart', 'charleston', 'washington', 'hamburg', 'tokyo', 'acapulco', 'eastbourne', 'rotterdam', 'basel', 'vienna', 'adelaide', 'brisbane', 'bad homburg', 'berlin', 'strasbourg', 'antwerp', 'dallas', 'rio', 'astana', 'chengdu', 'zhuhai', 'seoul'].some((k) => t.includes(k))) return 'STRONG_500_250';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}

const lanes = [
  {
    key: 'CORE_P1_ATP_GS_BET365',
    public_signal_name: 'Core Cluster',
    model_bucket: 'MAIN',
    target_scores: ['6:2', '6:3', '6:4'],
    qualifying_scores: ['6:3', '6:4'],
    trigger_score: '6:4',
    trigger_min: 5.00,
    trigger_max: 6.25,
    min_qualifying_grouped: 2.50,
    max_qualifying_grouped: null,
    required_skew: null,
    tour: 'ATP',
    tournament_group: 'GRAND_SLAM',
    bookmaker: 'bet365',
  },
  {
    key: 'CORE_P2_GS_REVERSE_STRETCH_BET365',
    public_signal_name: 'Reverse Stretch Cluster',
    model_bucket: 'MAIN',
    target_scores: ['2:6', '4:6', '5:7'],
    qualifying_scores: ['2:6', '4:6'],
    trigger_score: '',
    trigger_min: null,
    trigger_max: null,
    min_qualifying_grouped: 2.50,
    max_qualifying_grouped: 4.50,
    required_skew: 'EXTREME',
    tour: 'ANY',
    tournament_group: 'GRAND_SLAM',
    bookmaker: 'bet365',
  },
  {
    key: 'CORE_P1_MIRROR_WTA_OTHER',
    public_signal_name: 'Mirror Cluster',
    model_bucket: 'WATCHLIST',
    target_scores: ['6:3', '6:4', '7:5'],
    qualifying_scores: ['6:3', '6:4', '7:5'],
    trigger_score: '6:4',
    trigger_min: 5.00,
    trigger_max: 8.00,
    min_qualifying_grouped: 2.60,
    max_qualifying_grouped: null,
    required_skew: null,
    tour: 'WTA',
    tournament_group: 'OTHER_TOUR',
    bookmaker: 'bet365',
  },
];

function passLane(row, lane) {
  if (clean(row.bookmaker).toLowerCase() !== bookmakerFilter) return { pass: false, reason: 'wrong_bookmaker' };
  const rowTour = tour(row);
  const rowGroup = tournamentGroup(row);
  if (lane.tour !== 'ANY' && rowTour !== lane.tour) return { pass: false, reason: 'wrong_tour' };
  if (lane.tournament_group !== 'ANY' && rowGroup !== lane.tournament_group) return { pass: false, reason: 'wrong_tournament_group' };

  const qualifyingOdds = lane.qualifying_scores.map((s) => odds(row, s));
  if (qualifyingOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_qualifying_odds' };
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
  if (targetOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_protected_odds' };
  const protectedGrouped = groupedOdds(targetOdds);
  if (!protectedGrouped) return { pass: false, reason: 'bad_protected_grouped' };

  return { pass: true, qualifyingOdds, qualifyingGrouped, targetOdds, protectedGrouped, skew, rowTour, rowGroup };
}

function buildSignals(rows) {
  const accepted = [];
  const rejects = new Map();
  for (const row of rows) {
    for (const lane of lanes) {
      if (!includeMirrorWatchlist && lane.model_bucket === 'WATCHLIST') continue;
      const res = passLane(row, lane);
      if (!res.pass) {
        const key = `${lane.key}|${res.reason}`;
        rejects.set(key, (rejects.get(key) || 0) + 1);
        continue;
      }
      const firstSetScore = normalizeScore(row.first_set_score);
      if (!/^\d+:\d+$/.test(firstSetScore)) {
        rejects.set(`${lane.key}|missing_first_set_score`, (rejects.get(`${lane.key}|missing_first_set_score`) || 0) + 1);
        continue;
      }
      const win = lane.target_scores.includes(firstSetScore);
      const exactReceiptOdds = win ? odds(row, firstSetScore) : null;
      const groupProfitUnits = win ? res.protectedGrouped - 1 : -1;
      const receiptProfitUnits = win && exactReceiptOdds ? exactReceiptOdds - 1 : -1;
      accepted.push({
        event_key: row.event_key,
        event_date: row.event_date,
        event_time: row.event_time,
        match_name: row.match_name,
        player1: row.player1,
        player2: row.player2,
        tournament_name: row.tournament_name,
        event_type_key: row.event_type_key,
        tour: res.rowTour,
        tournament_group: res.rowGroup,
        bookmaker: row.bookmaker,
        lane_key: lane.key,
        public_signal_name: lane.public_signal_name,
        model_bucket: lane.model_bucket,
        target_scores: lane.target_scores.join('/'),
        qualifying_scores: lane.qualifying_scores.join('/'),
        first_set_score: firstSetScore,
        result: win ? 'WIN' : 'LOSS',
        qualifying_grouped_odds: res.qualifyingGrouped,
        protected_grouped_odds: res.protectedGrouped,
        grouped_american_odds: decimalToAmerican(res.protectedGrouped),
        exact_receipt_odds: exactReceiptOdds || '',
        receipt_american_odds: exactReceiptOdds ? decimalToAmerican(exactReceiptOdds) : '',
        group_profit_units: Number(groupProfitUnits.toFixed(6)),
        receipt_profit_units: Number(receiptProfitUnits.toFixed(6)),
        market_skew_bucket: res.skew,
        odds_json: JSON.stringify(Object.fromEntries(lane.target_scores.map((s, i) => [s, res.targetOdds[i]]))),
      });
    }
  }
  return { accepted, rejects };
}

function summarize(rows) {
  const bets = rows.length;
  const wins = rows.filter((r) => r.result === 'WIN').length;
  const losses = rows.filter((r) => r.result === 'LOSS').length;
  const groupUnits = rows.reduce((sum, r) => sum + Number(r.group_profit_units || 0), 0);
  const receiptUnits = rows.reduce((sum, r) => sum + Number(r.receipt_profit_units || 0), 0);
  return {
    bets,
    wins,
    losses,
    hit_rate_pct: bets ? Number(((wins / bets) * 100).toFixed(2)) : 0,
    group_profit_units: Number(groupUnits.toFixed(6)),
    group_roi_pct: bets ? Number(((groupUnits / bets) * 100).toFixed(2)) : 0,
    receipt_profit_units: Number(receiptUnits.toFixed(6)),
    receipt_roi_pct: bets ? Number(((receiptUnits / bets) * 100).toFixed(2)) : 0,
    avg_grouped_decimal_odds: bets ? Number((rows.reduce((sum, r) => sum + Number(r.protected_grouped_odds || 0), 0) / bets).toFixed(6)) : 0,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function summaryRows(rows, keyName, keyFn) {
  return [...groupBy(rows, keyFn).entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, xs]) => ({
    [keyName]: key,
    ...summarize(xs),
  }));
}

function simulateDrawdown(rows, riskPct) {
  let bank = bankroll;
  let peak = bankroll;
  let worstDrawdownPct = 0;
  let worstLosingStreak = 0;
  let streak = 0;
  const out = [];
  const sorted = [...rows].sort((a, b) => `${a.event_date} ${a.event_time} ${a.event_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key}`));
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const stake = bank * riskPct;
    const profit = stake * Number(row.group_profit_units || 0);
    bank += profit;
    if (row.result === 'LOSS') streak += 1;
    else streak = 0;
    worstLosingStreak = Math.max(worstLosingStreak, streak);
    peak = Math.max(peak, bank);
    const drawdownPct = peak > 0 ? (peak - bank) / peak : 0;
    worstDrawdownPct = Math.max(worstDrawdownPct, drawdownPct);
    out.push({
      risk_pct: riskPct,
      index: i + 1,
      event_date: row.event_date,
      event_time: row.event_time,
      lane_key: row.lane_key,
      match_name: row.match_name,
      result: row.result,
      group_profit_units: row.group_profit_units,
      balance_before: Number((bank - profit).toFixed(2)),
      stake: Number(stake.toFixed(2)),
      profit_loss: Number(profit.toFixed(2)),
      balance_after: Number(bank.toFixed(2)),
      drawdown_pct: Number((drawdownPct * 100).toFixed(2)),
    });
  }
  return {
    risk_pct: riskPct,
    starting_bankroll: bankroll,
    final_bankroll: Number(bank.toFixed(2)),
    net_profit: Number((bank - bankroll).toFixed(2)),
    return_pct: Number(((bank / bankroll - 1) * 100).toFixed(2)),
    worst_losing_streak: worstLosingStreak,
    max_drawdown_pct: Number((worstDrawdownPct * 100).toFixed(2)),
    rows: out,
  };
}

function main() {
  if (!fs.existsSync(widePath)) {
    console.error(`Missing warehouse file: ${widePath}`);
    process.exit(2);
  }
  ensureDir(outDir);
  const rows = csvParse(fs.readFileSync(widePath, 'utf8'));
  const { accepted, rejects } = buildSignals(rows);
  const mainRows = accepted.filter((r) => r.model_bucket === 'MAIN');
  const watchlistRows = accepted.filter((r) => r.model_bucket === 'WATCHLIST');
  const allDrawdown = riskPcts.map((risk) => simulateDrawdown(mainRows, risk));

  const fields = [
    'event_key','event_date','event_time','match_name','player1','player2','tournament_name','event_type_key','tour','tournament_group','bookmaker','lane_key','public_signal_name','model_bucket','target_scores','qualifying_scores','first_set_score','result','qualifying_grouped_odds','protected_grouped_odds','grouped_american_odds','exact_receipt_odds','receipt_american_odds','group_profit_units','receipt_profit_units','market_skew_bucket','odds_json'
  ];
  writeCsv(path.join(outDir, 'upgraded_bet365_backtest_rows.csv'), accepted, fields);
  writeCsv(path.join(outDir, 'upgraded_bet365_main_rows.csv'), mainRows, fields);
  writeCsv(path.join(outDir, 'upgraded_bet365_watchlist_rows.csv'), watchlistRows, fields);
  writeCsv(path.join(outDir, 'upgraded_bet365_lane_split.csv'), summaryRows(accepted, 'lane_key', (r) => r.lane_key), ['lane_key','bets','wins','losses','hit_rate_pct','group_profit_units','group_roi_pct','receipt_profit_units','receipt_roi_pct','avg_grouped_decimal_odds']);
  writeCsv(path.join(outDir, 'upgraded_bet365_monthly_split.csv'), summaryRows(mainRows, 'month', (r) => clean(r.event_date).slice(0, 7)), ['month','bets','wins','losses','hit_rate_pct','group_profit_units','group_roi_pct','receipt_profit_units','receipt_roi_pct','avg_grouped_decimal_odds']);
  writeCsv(path.join(outDir, 'upgraded_bet365_drawdown.csv'), allDrawdown.flatMap((d) => d.rows), ['risk_pct','index','event_date','event_time','lane_key','match_name','result','group_profit_units','balance_before','stake','profit_loss','balance_after','drawdown_pct']);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'upgraded_bet365_v2_protected_from_warehouse',
    source_file: widePath,
    bookmaker: bookmakerFilter,
    definitions: {
      main_model: 'Core Cluster + Reverse Stretch Cluster only',
      core_cluster: 'ATP Grand Slam Bet365; old 6:3/6:4 gate; protected target 6:2/6:3/6:4',
      reverse_stretch: 'Grand Slam Bet365; old 2:6/4:6 gate; EXTREME skew; protected target 2:6/4:6/5:7',
      mirror_cluster: 'WTA OTHER_TOUR Bet365 6:3/6:4/7:5 watchlist only',
      excluded: 'Core Cluster Plus / VIP_P1_ATP_GS_MULTI is intentionally not tested in active main model',
      grouped_odds_formula: '1 / sum(1 / exact_score_decimal_odds)',
    },
    source_rows: rows.length,
    accepted_rows: accepted.length,
    main_summary: summarize(mainRows),
    watchlist_summary: summarize(watchlistRows),
    combined_summary: summarize(accepted),
    drawdown_summary: allDrawdown.map(({ rows: _rows, ...rest }) => rest),
    reject_counts: Object.fromEntries([...rejects.entries()].sort()),
  };

  writeJson(path.join(outDir, 'upgraded_bet365_backtest_summary.json'), summary);

  const laneSplit = summaryRows(accepted, 'lane_key', (r) => r.lane_key);
  const monthlySplit = summaryRows(mainRows, 'month', (r) => clean(r.event_date).slice(0, 7));
  const report = [
    '# Upgraded Bet365 Protected-Score Backtest',
    '',
    `Generated: ${summary.generated_at}`,
    `Source rows: ${summary.source_rows}`,
    `Bookmaker: ${bookmakerFilter}`,
    '',
    '## Main Model Summary',
    `- Bets: ${summary.main_summary.bets}`,
    `- Wins/Losses: ${summary.main_summary.wins}W / ${summary.main_summary.losses}L`,
    `- Hit rate: ${summary.main_summary.hit_rate_pct}%`,
    `- Group profit units: ${summary.main_summary.group_profit_units}`,
    `- Group ROI: ${summary.main_summary.group_roi_pct}%`,
    `- Receipt profit units: ${summary.main_summary.receipt_profit_units}`,
    `- Receipt ROI: ${summary.main_summary.receipt_roi_pct}%`,
    '',
    '## Drawdown / Compounding',
    ...summary.drawdown_summary.map((d) => `- Risk ${(d.risk_pct * 100).toFixed(1)}%: final ${d.final_bankroll}, net ${d.net_profit}, return ${d.return_pct}%, max DD ${d.max_drawdown_pct}%, worst losing streak ${d.worst_losing_streak}`),
    '',
    '## Lane Split',
    ...laneSplit.map((r) => `- ${r.lane_key}: ${r.bets} bets, ${r.wins}W/${r.losses}L, hit ${r.hit_rate_pct}%, group ${r.group_profit_units}u, ROI ${r.group_roi_pct}%`),
    '',
    '## Monthly Main Split',
    ...monthlySplit.map((r) => `- ${r.month}: ${r.bets} bets, ${r.wins}W/${r.losses}L, hit ${r.hit_rate_pct}%, group ${r.group_profit_units}u, ROI ${r.group_roi_pct}%`),
    '',
    '## Notes',
    '- Main result excludes Mirror watchlist and excludes Core Cluster Plus.',
    '- Rows with missing protected exact-score odds are rejected from the main result instead of estimated.',
    '- This is a historical warehouse backtest. It does not send Telegram and does not write Supabase.',
  ];
  fs.writeFileSync(path.join(outDir, 'upgraded_bet365_report.md'), report.join('\n'), 'utf8');

  console.log(JSON.stringify(summary, null, 2));
}

main();
