#!/usr/bin/env node
/*
  First Set Lab / SlipIQ
  Optimized VIP Protected 3 risk-filter warehouse backtest + blind split.

  Uses API-Tennis first_set_correct_score_wide_combined.csv from the warehouse artifact.

  Tests:
  - Baseline grouped Protected 3: 1u every accepted signal.
  - Raw VIP + booster: 1u every accepted signal + pocket booster stake when pocket flags fire.
  - Risk-filtered overlay:
      * grouped odds < 2.25 => track only, 0u stake
      * no booster, odds >= 2.25 => 0.5u base
      * booster active, odds >= 2.25 => 1u base + booster add-on
      * booster active and odds 3.25-3.99 => tagged as strong tier, same stake for now

  Blind test:
  - Chronological split: first train_pct of signals = calibration/train, remaining = blind/test.
  - Rules are fixed and do not learn from test rows.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const warehouseDir = args['warehouse-dir'] || 'combined-warehouse';
const outDir = args.out || 'artifacts/output/optimized-vip-risk-filter-backtest';
const bookmakerFilter = String(args.bookmaker || 'bet365').toLowerCase();
const bankroll = Number(args.bankroll || '3000') || 3000;
const boosterStake = Number(args['booster-stake'] || '0.50');
const trainPct = Math.min(0.95, Math.max(0.05, Number(args['train-pct'] || '0.70') || 0.70));
const riskPcts = String(args['risk-pcts'] || '0.03,0.05')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0 && v < 1);
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v) { return clean(v).toLowerCase().replace(/[_-]/g, ' '); }
function num(v) { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function odds(row, score) { return num(row[`odds_${score.replace(':', '_')}`]); }
function groupedOdds(values) { const xs = values.map(num); if (xs.some((x) => !x || x <= 1)) return null; const implied = xs.reduce((s, x) => s + 1 / x, 0); return implied ? Number((1 / implied).toFixed(6)) : null; }
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

function tour(row) {
  const key = clean(row.event_type_key);
  const txt = `${row.event_type_type ?? ''} ${row.tournament_name ?? ''}`.toLowerCase();
  if (key === '265' || /\batp\b|men/.test(txt)) return 'ATP';
  if (key === '266' || /\bwta\b|women/.test(txt)) return 'WTA';
  return 'UNKNOWN';
}

function tournamentGroup(row) {
  const t = clean(row.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai', 'qatar open'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}

function skewBucket(values) {
  const xs = values.map(num);
  if (xs.length < 2 || xs.some((x) => !x || x <= 1)) return 'UNKNOWN_OR_NONE';
  const ratio = xs.length === 2 ? Math.max(...xs) / Math.min(...xs) : xs[1] / ((xs[0] + xs[xs.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}

const laneDefs = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365', lane_class: 'PUBLIC_MAIN', public_signal_name: 'Core Cluster', book: 'bet365', tour: 'ATP', tournament_group: 'GRAND_SLAM', gate_scores: ['6:3','6:4'], target_scores: ['6:2','6:3','6:4'], trigger_score: '6:4', trigger_min: 5.00, trigger_max: 6.25, min_gate_grouped: 2.50, max_gate_grouped: null, required_skew: null,
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', lane_class: 'PUBLIC_MAIN', public_signal_name: 'Reverse Stretch Cluster', book: 'bet365', tour: 'ANY', tournament_group: 'GRAND_SLAM', gate_scores: ['2:6','4:6'], target_scores: ['2:6','4:6','5:7'], trigger_score: '', trigger_min: null, trigger_max: null, min_gate_grouped: 2.50, max_gate_grouped: 4.50, required_skew: 'EXTREME',
  },
  {
    lane_key: 'RESEARCH_P2_GS_26_46_BET365', lane_class: 'OPTIMIZED_VIP', public_signal_name: 'Research P2 GS Sniper', book: 'bet365', tour: 'ANY', tournament_group: 'GRAND_SLAM', gate_scores: ['2:6','4:6'], target_scores: ['2:6','4:6','5:7'], trigger_score: '', trigger_min: null, trigger_max: null, min_gate_grouped: 2.50, max_gate_grouped: 4.50, required_skew: 'EXTREME',
  },
  {
    lane_key: 'VIP_P2_V3_SHAPE', lane_class: 'OPTIMIZED_VIP', public_signal_name: 'V3 Cluster', book: 'ANY', tour: 'ANY', tournament_group: 'ANY', gate_scores: ['3:6','4:6','5:7'], target_scores: ['3:6','4:6','5:7'], trigger_score: '4:6', trigger_min: 6.25, trigger_max: 6.99, min_gate_grouped: 3.50, max_gate_grouped: null, required_skew: null,
  },
];

function passGate(row, lane) {
  const bookNorm = norm(row.bookmaker).replace(/\s+/g, '');
  if (lane.book !== 'ANY' && bookNorm !== norm(lane.book).replace(/\s+/g, '')) return null;
  if (lane.book === 'ANY' && !['bet365','1xbet','10bet'].includes(bookNorm)) return null;
  if (lane.tour !== 'ANY' && tour(row) !== lane.tour) return null;
  if (lane.tournament_group !== 'ANY' && tournamentGroup(row) !== lane.tournament_group) return null;
  const gateOdds = lane.gate_scores.map((s) => odds(row, s));
  if (gateOdds.some((x) => !x || x <= 1)) return null;
  const gateGrouped = groupedOdds(gateOdds);
  if (!gateGrouped || gateGrouped < lane.min_gate_grouped) return null;
  if (lane.max_gate_grouped && gateGrouped > lane.max_gate_grouped) return null;
  const skew = skewBucket(gateOdds);
  if (lane.required_skew && skew !== lane.required_skew) return null;
  let triggerOdds = '';
  if (lane.trigger_score) {
    triggerOdds = odds(row, lane.trigger_score);
    if (!triggerOdds || triggerOdds < lane.trigger_min || triggerOdds > lane.trigger_max) return null;
  }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((x) => !x || x <= 1)) return null;
  const targetGrouped = groupedOdds(targetOdds);
  if (!targetGrouped) return null;
  return { gateGrouped, targetGrouped, targetOdds, skew, triggerOdds };
}

function pocketHits(signal) {
  const pockets = [];
  const o63 = Number(signal.odds_6_3 || 0);
  const o64 = Number(signal.odds_6_4 || 0);
  const o26 = Number(signal.odds_2_6 || 0);
  const o62 = Number(signal.odds_6_2 || 0);

  if (signal.booster_bucket === 'MAIN' && signal.market_skew_bucket === 'MID' && o63 >= 4.0 && o63 <= 5.5) {
    pockets.push({ key: 'A_63_MAIN_MID_4_0_5_5', score: '6:3', odds: o63 });
  }
  if (signal.booster_bucket === 'MAIN' && signal.market_skew_bucket === 'UNKNOWN_OR_NONE' && o64 > 5.5 && o64 <= 7.5) {
    pockets.push({ key: 'B_64_MAIN_NONE_5_5_7_5', score: '6:4', odds: o64 });
  }
  if (signal.lane_key === 'RESEARCH_P2_GS_26_46_BET365' && signal.market_skew_bucket === 'EXTREME' && o26 > 10.0) {
    pockets.push({ key: 'C_26_P2_SNIPER_EXTREME_10_PLUS', score: '2:6', odds: o26 });
  }
  if (signal.booster_bucket === 'MAIN' && signal.market_skew_bucket === 'HIGH' && o64 >= 4.0 && o64 <= 5.5) {
    pockets.push({ key: 'D_64_MAIN_HIGH_4_0_5_5', score: '6:4', odds: o64 });
  }
  if (signal.booster_bucket === 'MAIN' && signal.market_skew_bucket === 'HIGH' && o62 > 7.5 && o62 <= 10.0) {
    pockets.push({ key: 'E_62_MAIN_HIGH_7_5_10_0', score: '6:2', odds: o62 });
  }
  return pockets.filter((p) => p.odds && p.odds > 1);
}

function riskTier(signal) {
  const oddsValue = Number(signal.target_grouped_odds || 0);
  const hasBooster = Number(signal.pocket_count || 0) > 0;
  if (oddsValue < 2.25) return 'TRACK_ONLY_UNDER_2_25';
  if (hasBooster && oddsValue >= 3.25 && oddsValue < 4.00) return 'STRONG_BOOSTER_3_25_3_99';
  if (hasBooster) return 'STANDARD_BOOSTER_2_25_PLUS';
  return 'SMALL_NO_BOOSTER_2_25_PLUS';
}

function applyStrategies(signal) {
  const grouped = Number(signal.group_profit_units || 0);
  const booster1u = Number(signal.pocket_booster_1u_units || 0);
  const pocketCount = Number(signal.pocket_count || 0);
  const rawUnit = grouped + boosterStake * booster1u;
  const rawStake = 1 + boosterStake * pocketCount;
  const tier = riskTier(signal);
  let filteredUnit = 0;
  let filteredStake = 0;
  if (tier === 'TRACK_ONLY_UNDER_2_25') {
    filteredUnit = 0;
    filteredStake = 0;
  } else if (pocketCount > 0) {
    filteredUnit = rawUnit;
    filteredStake = rawStake;
  } else {
    filteredUnit = 0.5 * grouped;
    filteredStake = 0.5;
  }
  return {
    risk_tier: tier,
    baseline_unit_result: Number(grouped.toFixed(6)),
    baseline_staked_units: 1,
    raw_vip_unit_result: Number(rawUnit.toFixed(6)),
    raw_vip_staked_units: Number(rawStake.toFixed(6)),
    filtered_unit_result: Number(filteredUnit.toFixed(6)),
    filtered_staked_units: Number(filteredStake.toFixed(6)),
    filtered_staked: filteredStake > 0,
  };
}

function buildSignals(sourceRows) {
  const out = [];
  for (const row of sourceRows) {
    const actual = normalizeScore(row.first_set_score);
    if (!/^\d+:\d+$/.test(actual)) continue;
    for (const lane of laneDefs) {
      const gate = passGate(row, lane);
      if (!gate) continue;
      const win = lane.target_scores.includes(actual);
      const base = {
        event_key: row.event_key,
        event_date: row.event_date,
        event_time: row.event_time,
        month: clean(row.event_date).slice(0,7),
        match_name: row.match_name,
        player1: row.player1,
        player2: row.player2,
        tournament_name: row.tournament_name,
        event_type_key: row.event_type_key,
        tour: tour(row),
        tournament_group: tournamentGroup(row),
        bookmaker: row.bookmaker,
        lane_key: lane.lane_key,
        lane_class: lane.lane_class,
        public_signal_name: lane.public_signal_name,
        booster_bucket: lane.lane_key === 'RESEARCH_P2_GS_26_46_BET365' ? 'RESEARCH_P2_SNIPER' : lane.lane_key === 'VIP_P2_V3_SHAPE' ? 'OTHER' : 'MAIN',
        target_scores: lane.target_scores.join('/'),
        gate_scores: lane.gate_scores.join('/'),
        first_set_score: actual,
        result: win ? 'WIN' : 'LOSS',
        gate_grouped_odds: gate.gateGrouped,
        target_grouped_odds: gate.targetGrouped,
        group_profit_units: Number((win ? gate.targetGrouped - 1 : -1).toFixed(6)),
        market_skew_bucket: gate.skew || 'UNKNOWN_OR_NONE',
        trigger_odds: gate.triggerOdds,
      };
      for (const s of ['6:2','6:3','6:4','2:6','4:6','5:7']) base[`odds_${s.replace(':', '_')}`] = odds(row, s) || '';
      const pockets = pocketHits(base);
      const signal = {
        ...base,
        pocket_count: pockets.length,
        pocket_keys: pockets.map((p) => p.key).join('|'),
        pocket_scores: pockets.map((p) => p.score).join('|'),
        pocket_odds: pockets.map((p) => p.odds).join('|'),
        pocket_booster_1u_units: Number(pockets.reduce((sum, p) => sum + (actual === p.score ? p.odds - 1 : -1), 0).toFixed(6)),
      };
      out.push({ ...signal, ...applyStrategies(signal) });
    }
  }
  return out.sort((a,b) => `${a.event_date} ${a.event_time} ${a.event_key} ${a.lane_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key} ${b.lane_key}`));
}

function summarize(rows, unitField, stakeField) {
  const units = rows.reduce((s,r) => s + Number(r[unitField] || 0), 0);
  const staked = rows.reduce((s,r) => s + Number(r[stakeField] || 0), 0);
  const activeRows = rows.filter((r) => Number(r[stakeField] || 0) > 0);
  const wins = activeRows.filter((r) => r.result === 'WIN').length;
  const losses = activeRows.filter((r) => r.result === 'LOSS').length;
  const returns = activeRows.map((r) => Number(r[unitField] || 0));
  return {
    rows: rows.length,
    active_rows: activeRows.length,
    track_only_rows: rows.length - activeRows.length,
    wins,
    losses,
    hit_rate_pct: activeRows.length ? Number(((wins / activeRows.length) * 100).toFixed(2)) : 0,
    profit_units: Number(units.toFixed(6)),
    staked_units: Number(staked.toFixed(6)),
    roi_on_staked_pct: staked ? Number(((units / staked) * 100).toFixed(2)) : 0,
    avg_unit_result: activeRows.length ? Number((returns.reduce((s,x) => s + x, 0) / activeRows.length).toFixed(6)) : 0,
    best_row_units: returns.length ? Number(Math.max(...returns).toFixed(6)) : 0,
    worst_row_units: returns.length ? Number(Math.min(...returns).toFixed(6)) : 0,
    first_date: rows[0]?.event_date || '',
    last_date: rows[rows.length - 1]?.event_date || '',
  };
}

function summarizeAll(rows) {
  return {
    baseline_grouped: summarize(rows, 'baseline_unit_result', 'baseline_staked_units'),
    raw_vip_booster: summarize(rows, 'raw_vip_unit_result', 'raw_vip_staked_units'),
    risk_filtered: summarize(rows, 'filtered_unit_result', 'filtered_staked_units'),
  };
}

function groupRows(rows, keys, unitField, stakeField) {
  const map = new Map();
  for (const row of rows) {
    const key = keys.map((k) => row[k] || 'UNKNOWN').join('||');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key, xs]) => {
    const parts = key.split('||');
    return { ...Object.fromEntries(keys.map((k, i) => [k, parts[i]])), ...summarize(xs, unitField, stakeField) };
  });
}

function compound(rows, riskPct, unitField, stakeField) {
  let bank = bankroll;
  let peak = bankroll;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  const curve = [];
  let activeIndex = 0;
  for (const r of rows) {
    const staked = Number(r[stakeField] || 0) > 0;
    if (!staked) {
      curve.push({ index: curve.length + 1, active_index: activeIndex, event_date: r.event_date, match_name: r.match_name, lane_key: r.lane_key, result: 'TRACK_ONLY', unit_result: 0, balance_before: Number(bank.toFixed(2)), stake: 0, profit_loss: 0, balance_after: Number(bank.toFixed(2)), drawdown_pct: Number((maxDd*100).toFixed(2)) });
      continue;
    }
    activeIndex += 1;
    const unit = Number(r[unitField] || 0);
    const stake = bank * riskPct * Number(r[stakeField] || 0);
    const pnl = bank * riskPct * unit;
    const before = bank;
    bank += pnl;
    peak = Math.max(peak, bank);
    const dd = peak ? (peak - bank) / peak : 0;
    maxDd = Math.max(maxDd, dd);
    if (unit < 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
    curve.push({ index: curve.length + 1, active_index: activeIndex, event_date: r.event_date, match_name: r.match_name, lane_key: r.lane_key, risk_tier: r.risk_tier, result: r.result, unit_result: Number(unit.toFixed(6)), balance_before: Number(before.toFixed(2)), stake: Number(stake.toFixed(2)), profit_loss: Number(pnl.toFixed(2)), balance_after: Number(bank.toFixed(2)), drawdown_pct: Number((dd*100).toFixed(2)) });
  }
  return { risk_pct: riskPct, starting_bankroll: bankroll, final_bankroll: Number(bank.toFixed(2)), net_profit: Number((bank-bankroll).toFixed(2)), return_pct: Number(((bank/bankroll - 1) * 100).toFixed(2)), max_drawdown_pct: Number((maxDd*100).toFixed(2)), worst_losing_streak: worstStreak, curve };
}

function splitChronological(rows) {
  const cut = Math.floor(rows.length * trainPct);
  return { train: rows.slice(0, cut), blind: rows.slice(cut), cut_index: cut };
}

function main() {
  if (!fs.existsSync(widePath)) { console.error(`Missing warehouse file: ${widePath}`); process.exit(2); }
  ensureDir(outDir);
  const sourceRows = parseCsv(fs.readFileSync(widePath, 'utf8'));
  const allRows = buildSignals(sourceRows);
  const { train, blind, cut_index } = splitChronological(allRows);

  const fields = [
    'event_date','event_time','match_name','tournament_name','bookmaker','lane_key','lane_class','public_signal_name','booster_bucket','target_scores','gate_scores','gate_grouped_odds','target_grouped_odds','first_set_score','result','group_profit_units','market_skew_bucket','trigger_odds','odds_6_2','odds_6_3','odds_6_4','odds_2_6','odds_4_6','odds_5_7','pocket_count','pocket_keys','pocket_scores','pocket_odds','pocket_booster_1u_units','risk_tier','baseline_unit_result','baseline_staked_units','raw_vip_unit_result','raw_vip_staked_units','filtered_unit_result','filtered_staked_units','filtered_staked','event_key'
  ];
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_all_rows.csv'), allRows, fields);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_train_rows.csv'), train, fields);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_blind_rows.csv'), blind, fields);

  const splitSummary = [
    { split: 'ALL', ...summarizeAll(allRows) },
    { split: 'TRAIN', ...summarizeAll(train) },
    { split: 'BLIND', ...summarizeAll(blind) },
  ];
  const flatSplit = splitSummary.flatMap((s) => Object.entries({ baseline_grouped: s.baseline_grouped, raw_vip_booster: s.raw_vip_booster, risk_filtered: s.risk_filtered }).map(([strategy, summary]) => ({ split: s.split, strategy, ...summary })));
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_split_summary.csv'), flatSplit, ['split','strategy','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','avg_unit_result','best_row_units','worst_row_units','first_date','last_date']);

  const byTier = groupRows(allRows, ['risk_tier'], 'filtered_unit_result', 'filtered_staked_units');
  const blindByTier = groupRows(blind, ['risk_tier'], 'filtered_unit_result', 'filtered_staked_units');
  const byLane = groupRows(allRows, ['lane_key'], 'filtered_unit_result', 'filtered_staked_units');
  const byLaneBlind = groupRows(blind, ['lane_key'], 'filtered_unit_result', 'filtered_staked_units');
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_by_tier.csv'), byTier, ['risk_tier','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','avg_unit_result','best_row_units','worst_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_blind_by_tier.csv'), blindByTier, ['risk_tier','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','avg_unit_result','best_row_units','worst_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_by_lane.csv'), byLane, ['lane_key','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','avg_unit_result','best_row_units','worst_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_blind_by_lane.csv'), byLaneBlind, ['lane_key','rows','active_rows','track_only_rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_on_staked_pct','avg_unit_result','best_row_units','worst_row_units','first_date','last_date']);

  const compoundingRows = [];
  const curves = [];
  for (const split of [{ name: 'ALL', rows: allRows }, { name: 'TRAIN', rows: train }, { name: 'BLIND', rows: blind }]) {
    for (const strategy of [
      { key: 'baseline_grouped', unit: 'baseline_unit_result', stake: 'baseline_staked_units' },
      { key: 'raw_vip_booster', unit: 'raw_vip_unit_result', stake: 'raw_vip_staked_units' },
      { key: 'risk_filtered', unit: 'filtered_unit_result', stake: 'filtered_staked_units' },
    ]) {
      for (const risk of riskPcts) {
        const c = compound(split.rows, risk, strategy.unit, strategy.stake);
        compoundingRows.push({ split: split.name, strategy: strategy.key, ...Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'curve')) });
        curves.push(...c.curve.map((row) => ({ split: split.name, strategy: strategy.key, risk_pct: risk, ...row })));
      }
    }
  }
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_compounding.csv'), compoundingRows, ['split','strategy','risk_pct','starting_bankroll','final_bankroll','net_profit','return_pct','max_drawdown_pct','worst_losing_streak']);
  writeCsv(path.join(outDir, 'optimized_vip_risk_filter_compounding_curve.csv'), curves, ['split','strategy','risk_pct','index','active_index','event_date','match_name','lane_key','risk_tier','result','unit_result','balance_before','stake','profit_loss','balance_after','drawdown_pct']);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'optimized_vip_protected3_risk_filter_warehouse_blind_test',
    source_file: widePath,
    source_rows: sourceRows.length,
    accepted_rows: allRows.length,
    train_pct: trainPct,
    train_rows: train.length,
    blind_rows: blind.length,
    blind_start_date: blind[0]?.event_date || '',
    blind_end_date: blind[blind.length - 1]?.event_date || '',
    booster_stake: boosterStake,
    risk_pcts: riskPcts,
    rules: {
      lanes: laneDefs.map((l) => ({ lane_key: l.lane_key, target_scores: l.target_scores, gate_scores: l.gate_scores })),
      risk_filter: 'track only if protected grouped odds < 2.25; no-booster rows half-stake; booster rows full base plus pocket booster add-on; strong tier is booster with odds 3.25-3.99',
      blind_test: 'chronological holdout; train split first, blind split last; no tuning from blind split',
    },
    split_summary: flatSplit,
    tier_summary: byTier,
    blind_tier_summary: blindByTier,
    lane_summary: byLane,
    blind_lane_summary: byLaneBlind,
    compounding: compoundingRows,
  };
  writeJson(path.join(outDir, 'optimized_vip_risk_filter_summary.json'), summary);

  const allRisk = flatSplit.find((r) => r.split === 'ALL' && r.strategy === 'risk_filtered');
  const blindRisk = flatSplit.find((r) => r.split === 'BLIND' && r.strategy === 'risk_filtered');
  const allRaw = flatSplit.find((r) => r.split === 'ALL' && r.strategy === 'raw_vip_booster');
  const blindRaw = flatSplit.find((r) => r.split === 'BLIND' && r.strategy === 'raw_vip_booster');
  const report = [
    '# Optimized VIP Risk-Filtered Warehouse Blind Backtest',
    '',
    `Generated: ${summary.generated_at}`,
    `Source rows: ${sourceRows.length}`,
    `Accepted Optimized VIP Protected 3 rows: ${allRows.length}`,
    `Train rows: ${train.length}`,
    `Blind rows: ${blind.length}`,
    `Blind window: ${summary.blind_start_date} to ${summary.blind_end_date}`,
    `Booster stake: ${boosterStake}u per fired pocket`,
    '',
    '## Rules Tested',
    '- Baseline grouped: 1u on every accepted Protected 3 signal.',
    '- Raw VIP booster: 1u base on every accepted signal plus pocket booster add-on.',
    '- Risk-filtered: track under 2.25 grouped odds; half-stake no-booster rows; full base plus booster add-on on booster rows.',
    '',
    '## All Rows',
    `- Raw VIP booster: ${allRaw?.active_rows ?? 0} active rows, ${allRaw?.profit_units ?? 0}u, ROI ${allRaw?.roi_on_staked_pct ?? 0}%`,
    `- Risk-filtered: ${allRisk?.active_rows ?? 0} active rows, ${allRisk?.profit_units ?? 0}u, ROI ${allRisk?.roi_on_staked_pct ?? 0}%`,
    '',
    '## Blind Holdout',
    `- Raw VIP booster: ${blindRaw?.active_rows ?? 0} active rows, ${blindRaw?.profit_units ?? 0}u, ROI ${blindRaw?.roi_on_staked_pct ?? 0}%`,
    `- Risk-filtered: ${blindRisk?.active_rows ?? 0} active rows, ${blindRisk?.profit_units ?? 0}u, ROI ${blindRisk?.roi_on_staked_pct ?? 0}%`,
    '',
    '## Blind Tier Summary',
    ...blindByTier.map((s) => `- ${s.risk_tier}: rows ${s.rows}, active ${s.active_rows}, ${s.wins}W/${s.losses}L, ${s.profit_units}u, ROI ${s.roi_on_staked_pct}%`),
    '',
    '## Notes',
    '- This is a warehouse replay, not live execution proof.',
    '- Blind split is chronological and should be treated as a stronger test than all-row optimization, but it is still historical.',
    '- No Azuro/web3 execution is involved.',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'optimized_vip_risk_filter_report.md'), report, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
