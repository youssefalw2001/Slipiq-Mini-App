#!/usr/bin/env node
/*
  First Set Lab / SlipIQ Pocket Booster warehouse backtest.

  Reads combined API-Tennis first_set_correct_score_wide_combined.csv and tests:
  - Main grouped model: Core Cluster + Reverse Stretch only.
  - Pocket Booster v1: exact-score booster overlays discovered from live Proof Vault.

  This script keeps receipt/exact-score booster units separate from grouped units.
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
const outDir = params.out || 'artifacts/output/pocket-booster-backtest';
const bookmakerFilter = String(params.bookmaker || 'bet365').toLowerCase();
const boosterStakes = String(params['booster-stakes'] || '0.10,0.15,0.20,0.25,0.30,0.50')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 0 && v <= 2);
const bankroll = Number(params.bankroll || '3000') || 3000;
const riskPcts = String(params['risk-pcts'] || '0.05,0.06,0.07')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0 && v < 1);

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
  return rows.slice(1)
    .filter((r) => r.some((c) => c !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
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
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}

function scoreSkewBucket(values) {
  const nums = values.map(safeNumber);
  if (nums.length < 2 || nums.some((o) => !o || o <= 1)) return 'UNKNOWN';
  const ratio = nums.length === 2
    ? Math.max(...nums) / Math.min(...nums)
    : nums[1] / ((nums[0] + nums[nums.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}

const lanes = [
  {
    key: 'CORE_P1_ATP_GS_BET365',
    public_signal_name: 'Core Cluster',
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
  },
  {
    key: 'CORE_P2_GS_REVERSE_STRETCH_BET365',
    public_signal_name: 'Reverse Stretch Cluster',
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
  },
  {
    key: 'RESEARCH_P2_GS_26_46_BET365',
    public_signal_name: 'P2 Sniper Research',
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
    research_only: true,
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

function pocketHits(signal) {
  const scoreOdds = Object.fromEntries(signal.target_scores.split('/').map((score) => [score, Number(signal[`odds_${score.replace(':', '_')}`] || 0)]));
  const pockets = [];

  const o63 = Number(signal.odds_6_3 || 0);
  const o64 = Number(signal.odds_6_4 || 0);
  const o26 = Number(signal.odds_2_6 || 0);
  const o62 = Number(signal.odds_6_2 || 0);

  if (signal.model_bucket === 'MAIN' && signal.market_skew_bucket === 'MID' && o63 >= 4.0 && o63 <= 5.5) {
    pockets.push({ key: 'A_63_MAIN_MID_4_0_5_5', score: '6:3', odds: o63 });
  }
  if (signal.model_bucket === 'MAIN' && signal.market_skew_bucket === 'UNKNOWN_OR_NONE' && o64 > 5.5 && o64 <= 7.5) {
    pockets.push({ key: 'B_64_MAIN_NONE_5_5_7_5', score: '6:4', odds: o64 });
  }
  if (signal.lane_key === 'RESEARCH_P2_GS_26_46_BET365' && signal.market_skew_bucket === 'EXTREME' && o26 > 10.0) {
    pockets.push({ key: 'C_26_P2_SNIPER_EXTREME_10_PLUS', score: '2:6', odds: o26 });
  }
  if (signal.model_bucket === 'MAIN' && signal.market_skew_bucket === 'HIGH' && o64 >= 4.0 && o64 <= 5.5) {
    pockets.push({ key: 'D_64_MAIN_HIGH_4_0_5_5', score: '6:4', odds: o64 });
  }
  if (signal.model_bucket === 'MAIN' && signal.market_skew_bucket === 'HIGH' && o62 > 7.5 && o62 <= 10.0) {
    pockets.push({ key: 'E_62_MAIN_HIGH_7_5_10_0', score: '6:2', odds: o62 });
  }

  return pockets.filter((p) => p.odds && p.odds > 1);
}

function buildSignals(rows) {
  const accepted = [];
  const rejects = new Map();
  for (const row of rows) {
    for (const lane of lanes) {
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
      const base = {
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
        model_bucket: lane.research_only ? 'RESEARCH' : 'MAIN',
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
        market_skew_bucket: res.skew || 'UNKNOWN_OR_NONE',
      };
      for (const s of ['6:2','6:3','6:4','2:6','4:6','5:7']) base[`odds_${s.replace(':', '_')}`] = odds(row, s) || '';
      const pockets = pocketHits(base);
      accepted.push({
        ...base,
        pocket_count: pockets.length,
        pocket_keys: pockets.map((p) => p.key).join('|'),
        pocket_scores: pockets.map((p) => p.score).join('|'),
        pocket_odds: pockets.map((p) => p.odds).join('|'),
        pocket_booster_1u_units: Number(pockets.reduce((sum, p) => sum + (firstSetScore === p.score ? p.odds - 1 : -1), 0).toFixed(6)),
      });
    }
  }
  return { accepted, rejects };
}

function summarize(rows, boosterStake = 0) {
  const bets = rows.length;
  const wins = rows.filter((r) => r.result === 'WIN').length;
  const losses = rows.filter((r) => r.result === 'LOSS').length;
  const groupUnits = rows.reduce((sum, r) => sum + Number(r.group_profit_units || 0), 0);
  const receiptUnits = rows.reduce((sum, r) => sum + Number(r.receipt_profit_units || 0), 0);
  const boosterUnits = rows.reduce((sum, r) => sum + boosterStake * Number(r.pocket_booster_1u_units || 0), 0);
  const pocketRows = rows.filter((r) => Number(r.pocket_count || 0) > 0).length;
  const pocketHitRows = rows.filter((r) => Number(r.pocket_booster_1u_units || 0) > 0).length;
  const totalUnits = groupUnits + boosterUnits;
  const totalStakeUnits = rows.reduce((sum, r) => sum + 1 + boosterStake * Number(r.pocket_count || 0), 0);
  return {
    bets,
    wins,
    losses,
    hit_rate_pct: bets ? Number(((wins / bets) * 100).toFixed(2)) : 0,
    pocket_rows: pocketRows,
    pocket_hit_rows: pocketHitRows,
    group_profit_units: Number(groupUnits.toFixed(6)),
    group_roi_pct: bets ? Number(((groupUnits / bets) * 100).toFixed(2)) : 0,
    receipt_profit_units: Number(receiptUnits.toFixed(6)),
    receipt_roi_pct: bets ? Number(((receiptUnits / bets) * 100).toFixed(2)) : 0,
    booster_stake: boosterStake,
    pocket_booster_units: Number(boosterUnits.toFixed(6)),
    total_profit_units: Number(totalUnits.toFixed(6)),
    total_staked_units: Number(totalStakeUnits.toFixed(6)),
    roi_on_total_staked_pct: totalStakeUnits ? Number(((totalUnits / totalStakeUnits) * 100).toFixed(2)) : 0,
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

function summaryRows(rows, keyName, keyFn, boosterStake) {
  return [...groupBy(rows, keyFn).entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([key, xs]) => ({ [keyName]: key, ...summarize(xs, boosterStake) }));
}

function simulateDrawdown(rows, riskPct, boosterStake) {
  let bank = bankroll;
  let peak = bankroll;
  let worstDrawdownPct = 0;
  let worstLosingStreak = 0;
  let streak = 0;
  const out = [];
  const sorted = [...rows].sort((a, b) => `${a.event_date} ${a.event_time} ${a.event_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key}`));
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const unitResult = Number(row.group_profit_units || 0) + boosterStake * Number(row.pocket_booster_1u_units || 0);
    const stake = bank * riskPct;
    const profit = stake * unitResult;
    bank += profit;
    if (unitResult < 0) streak += 1;
    else streak = 0;
    worstLosingStreak = Math.max(worstLosingStreak, streak);
    peak = Math.max(peak, bank);
    const drawdownPct = peak > 0 ? (peak - bank) / peak : 0;
    worstDrawdownPct = Math.max(worstDrawdownPct, drawdownPct);
    out.push({
      booster_stake: boosterStake,
      risk_pct: riskPct,
      index: i + 1,
      event_date: row.event_date,
      event_time: row.event_time,
      lane_key: row.lane_key,
      match_name: row.match_name,
      result: row.result,
      group_profit_units: row.group_profit_units,
      pocket_booster_1u_units: row.pocket_booster_1u_units,
      unit_result: Number(unitResult.toFixed(6)),
      balance_before: Number((bank - profit).toFixed(2)),
      stake: Number(stake.toFixed(2)),
      profit_loss: Number(profit.toFixed(2)),
      balance_after: Number(bank.toFixed(2)),
      drawdown_pct: Number((drawdownPct * 100).toFixed(2)),
    });
  }
  return {
    booster_stake: boosterStake,
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
  const researchRows = accepted.filter((r) => r.model_bucket === 'RESEARCH');

  const fields = [
    'event_key','event_date','event_time','match_name','player1','player2','tournament_name','event_type_key','tour','tournament_group','bookmaker','lane_key','public_signal_name','model_bucket','target_scores','qualifying_scores','first_set_score','result','qualifying_grouped_odds','protected_grouped_odds','grouped_american_odds','exact_receipt_odds','receipt_american_odds','group_profit_units','receipt_profit_units','market_skew_bucket','odds_6_2','odds_6_3','odds_6_4','odds_2_6','odds_4_6','odds_5_7','pocket_count','pocket_keys','pocket_scores','pocket_odds','pocket_booster_1u_units'
  ];

  writeCsv(path.join(outDir, 'pocket_booster_all_rows.csv'), accepted, fields);
  writeCsv(path.join(outDir, 'pocket_booster_main_rows.csv'), mainRows, fields);
  writeCsv(path.join(outDir, 'pocket_booster_research_rows.csv'), researchRows, fields);

  const scenarioSummaries = boosterStakes.map((stake) => summarize(mainRows, stake));
  const drawdown = boosterStakes.flatMap((stake) => riskPcts.map((risk) => simulateDrawdown(mainRows, risk, stake)));
  const drawdownRows = drawdown.flatMap((d) => d.rows);
  writeCsv(path.join(outDir, 'pocket_booster_scenarios.csv'), scenarioSummaries, ['booster_stake','bets','wins','losses','hit_rate_pct','pocket_rows','pocket_hit_rows','group_profit_units','group_roi_pct','receipt_profit_units','receipt_roi_pct','pocket_booster_units','total_profit_units','total_staked_units','roi_on_total_staked_pct']);
  writeCsv(path.join(outDir, 'pocket_booster_monthly_split.csv'), boosterStakes.flatMap((stake) => summaryRows(mainRows, 'month', (r) => clean(r.event_date).slice(0, 7), stake)), ['month','booster_stake','bets','wins','losses','hit_rate_pct','pocket_rows','pocket_hit_rows','group_profit_units','group_roi_pct','receipt_profit_units','receipt_roi_pct','pocket_booster_units','total_profit_units','total_staked_units','roi_on_total_staked_pct']);
  writeCsv(path.join(outDir, 'pocket_booster_drawdown.csv'), drawdownRows, ['booster_stake','risk_pct','index','event_date','event_time','lane_key','match_name','result','group_profit_units','pocket_booster_1u_units','unit_result','balance_before','stake','profit_loss','balance_after','drawdown_pct']);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'pocket_booster_v1_from_warehouse',
    source_file: widePath,
    bookmaker: bookmakerFilter,
    definitions: {
      main_model: 'Core Cluster + Reverse Stretch Cluster only',
      booster: 'Pocket Booster v1 exact-score overlay; grouped odds and booster units remain separate',
      pocket_a: '6:3 + MAIN + MID skew + odds 4.0-5.5',
      pocket_b: '6:4 + MAIN + no/unknown skew + odds 5.5-7.5',
      pocket_c: '2:6 + P2 Sniper research + EXTREME skew + odds 10+',
      pocket_d: '6:4 + MAIN + HIGH skew + odds 4.0-5.5',
      pocket_e: '6:2 + MAIN + HIGH skew + odds 7.5-10.0',
      warning: 'P2 Sniper remains research unless explicitly promoted after validation.',
    },
    source_rows: rows.length,
    accepted_rows: accepted.length,
    main_group_only_summary: summarize(mainRows, 0),
    scenarios: scenarioSummaries,
    research_summary: summarize(researchRows, 0),
    drawdown_summary: drawdown.map(({ rows: _rows, ...rest }) => rest),
    reject_counts: Object.fromEntries([...rejects.entries()].sort()),
  };
  writeJson(path.join(outDir, 'pocket_booster_summary.json'), summary);

  const report = [
    '# Pocket Booster v1 Warehouse Backtest',
    '',
    `Generated: ${summary.generated_at}`,
    `Source rows: ${summary.source_rows}`,
    `Bookmaker: ${bookmakerFilter}`,
    '',
    '## Main Group-Only Baseline',
    `- Bets: ${summary.main_group_only_summary.bets}`,
    `- Wins/Losses: ${summary.main_group_only_summary.wins}W / ${summary.main_group_only_summary.losses}L`,
    `- Group units: ${summary.main_group_only_summary.group_profit_units}`,
    `- Group ROI: ${summary.main_group_only_summary.group_roi_pct}%`,
    '',
    '## Pocket Booster Scenarios',
    ...scenarioSummaries.map((s) => `- Booster ${s.booster_stake}u: total ${s.total_profit_units}u, booster ${s.pocket_booster_units}u, ROI on total staked ${s.roi_on_total_staked_pct}%, pocket rows ${s.pocket_rows}, pocket hit rows ${s.pocket_hit_rows}`),
    '',
    '## Drawdown / Compounding',
    ...summary.drawdown_summary.map((d) => `- Booster ${d.booster_stake}u, risk ${(d.risk_pct * 100).toFixed(1)}%: final ${d.final_bankroll}, net ${d.net_profit}, return ${d.return_pct}%, max DD ${d.max_drawdown_pct}%, worst losing streak ${d.worst_losing_streak}`),
    '',
    '## Notes',
    '- Main grouped proof remains Core + Reverse only.',
    '- Booster exact-score units are separate from receipt lens and separate from grouped units.',
    '- P2 Sniper is included only for pocket research; do not merge into main ROI without forward validation.',
  ];
  fs.writeFileSync(path.join(outDir, 'pocket_booster_report.md'), `${report.join('\n')}\n`, 'utf8');

  console.log(JSON.stringify(summary, null, 2));
}

main();
