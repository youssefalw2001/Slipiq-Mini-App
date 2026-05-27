#!/usr/bin/env node
/*
  First Set Lab clean 15-month warehouse backtest for the optimized VIP model.

  Source: combined API-Tennis warehouse artifact, not the live Proof Vault settled rows.
  Goal: rebuild signals from raw historical first-set correct-score odds, then test:
  - Main Core + Reverse grouped baseline.
  - Side-aware optimized VIP booster: Core A/B/D only, E removed.
  - Optional research/P2 pocket C kept separate.
  - Booster-only variants.

  This script intentionally keeps research lanes separate from main ROI.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const warehouseDir = args['warehouse-dir'] || 'combined-warehouse';
const outDir = args.out || 'artifacts/output/clean-vip-optimized-15m';
const bookmakerFilter = String(args.bookmaker || 'bet365').toLowerCase();
const bankroll = Number(args.bankroll || '3000') || 3000;
const riskPct = Number(args['risk-pct'] || '0.05') || 0.05;
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function num(v) { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function normScore(v) { return clean(v).replace('-', ':'); }
function odds(row, score) { return num(row[`odds_${score.replace(':', '_')}`]); }
function groupedOdds(vals) { const xs = vals.map(num); if (xs.some((x) => !x || x <= 1)) return null; const imp = xs.reduce((s, x) => s + 1 / x, 0); return imp > 0 ? Number((1 / imp).toFixed(6)) : null; }
function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function writeCsv(file, rows, fields) { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }

function csvParse(text) {
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
  const text = `${row.event_type_type ?? ''} ${row.tournament_name ?? ''}`.toLowerCase();
  if (key === '265' || /\batp\b|men/.test(text)) return 'ATP';
  if (key === '266' || /\bwta\b|women/.test(text)) return 'WTA';
  return 'UNKNOWN';
}
function tournamentGroup(row) {
  const t = clean(row.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  return 'OTHER_TOUR';
}
function skewBucket(vals) {
  const xs = vals.map(num);
  if (xs.length < 2 || xs.some((x) => !x || x <= 1)) return 'UNKNOWN';
  const ratio = Math.max(...xs) / Math.min(...xs);
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}

const lanes = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365',
    bucket: 'MAIN',
    side: 'P1_CORE',
    public_signal_name: 'Core Cluster',
    target_scores: ['6:2', '6:3', '6:4'],
    qualifying_scores: ['6:3', '6:4'],
    tour: 'ATP',
    tournament_group: 'GRAND_SLAM',
    trigger_score: '6:4',
    trigger_min: 5.00,
    trigger_max: 6.25,
    min_grouped: 2.50,
    max_grouped: null,
    required_skew: null,
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365',
    bucket: 'MAIN',
    side: 'P2_REVERSE',
    public_signal_name: 'Reverse Stretch Cluster',
    target_scores: ['2:6', '4:6', '5:7'],
    qualifying_scores: ['2:6', '4:6'],
    tour: 'ANY',
    tournament_group: 'GRAND_SLAM',
    trigger_score: '',
    trigger_min: null,
    trigger_max: null,
    min_grouped: 2.50,
    max_grouped: 4.50,
    required_skew: 'EXTREME',
  },
  {
    lane_key: 'RESEARCH_P2_GS_26_46_BET365',
    bucket: 'RESEARCH',
    side: 'P2_RESEARCH',
    public_signal_name: 'P2 Sniper Research',
    target_scores: ['2:6', '4:6', '5:7'],
    qualifying_scores: ['2:6', '4:6'],
    tour: 'ANY',
    tournament_group: 'GRAND_SLAM',
    trigger_score: '',
    trigger_min: null,
    trigger_max: null,
    min_grouped: 2.50,
    max_grouped: 4.50,
    required_skew: 'EXTREME',
  },
];

function passLane(row, lane) {
  if (clean(row.bookmaker).toLowerCase() !== bookmakerFilter) return null;
  if (lane.tour !== 'ANY' && tour(row) !== lane.tour) return null;
  if (lane.tournament_group !== 'ANY' && tournamentGroup(row) !== lane.tournament_group) return null;
  const qOdds = lane.qualifying_scores.map((s) => odds(row, s));
  if (qOdds.some((x) => !x || x <= 1)) return null;
  const qGrouped = groupedOdds(qOdds);
  if (!qGrouped || qGrouped < lane.min_grouped) return null;
  if (lane.max_grouped && qGrouped > lane.max_grouped) return null;
  const skew = skewBucket(qOdds);
  if (lane.required_skew && skew !== lane.required_skew) return null;
  if (lane.trigger_score) {
    const trig = odds(row, lane.trigger_score);
    if (!trig || trig < lane.trigger_min || trig > lane.trigger_max) return null;
  }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((x) => !x || x <= 1)) return null;
  const groupDec = groupedOdds(targetOdds);
  if (!groupDec) return null;
  return { qGrouped, groupDec, skew };
}

function pocketUnits(signal) {
  const o63 = Number(signal.odds_6_3 || 0);
  const o64 = Number(signal.odds_6_4 || 0);
  const o26 = Number(signal.odds_2_6 || 0);
  const o62 = Number(signal.odds_6_2 || 0);
  const score = signal.first_set_score;
  const isCore = signal.side === 'P1_CORE';
  const isP2Research = signal.side === 'P2_RESEARCH';
  const a = isCore && signal.skew === 'MID' && o63 >= 4.0 && o63 <= 5.5 ? (score === '6:3' ? o63 - 1 : -1) : 0;
  const b = isCore && o64 > 5.5 && o64 <= 7.5 ? (score === '6:4' ? o64 - 1 : -1) : 0;
  const c = isP2Research && signal.skew === 'EXTREME' && o26 > 10.0 ? (score === '2:6' ? o26 - 1 : -1) : 0;
  const d = isCore && signal.skew === 'HIGH' && o64 >= 4.0 && o64 <= 5.5 ? (score === '6:4' ? o64 - 1 : -1) : 0;
  const e = isCore && signal.skew === 'HIGH' && o62 > 7.5 && o62 <= 10.0 ? (score === '6:2' ? o62 - 1 : -1) : 0;
  return {
    a_63_mid_1u: Number(a.toFixed(6)),
    b_64_band_1u: Number(b.toFixed(6)),
    c_26_research_1u: Number(c.toFixed(6)),
    d_64_high_1u: Number(d.toFixed(6)),
    e_62_high_1u: Number(e.toFixed(6)),
    pocket_labels: [
      a ? 'A 6:3 MID 4.0-5.5' : '',
      b ? 'B 6:4 BAND 5.5-7.5' : '',
      c ? 'C 2:6 RESEARCH EXTREME 10+' : '',
      d ? 'D 6:4 HIGH 4.0-5.5' : '',
      e ? 'E 6:2 HIGH 7.5-10' : '',
    ].filter(Boolean).join(' | '),
  };
}

function buildSignals(rows) {
  const out = [];
  for (const row of rows) {
    for (const lane of lanes) {
      const res = passLane(row, lane);
      if (!res) continue;
      const firstSetScore = normScore(row.first_set_score);
      if (!/^\d+:\d+$/.test(firstSetScore)) continue;
      const win = lane.target_scores.includes(firstSetScore);
      const base = {
        event_key: row.event_key,
        event_date: row.event_date,
        event_time: row.event_time,
        month: clean(row.event_date).slice(0, 7),
        match_name: row.match_name,
        tournament_name: row.tournament_name,
        bookmaker: row.bookmaker,
        lane_key: lane.lane_key,
        bucket: lane.bucket,
        side: lane.side,
        public_signal_name: lane.public_signal_name,
        target_scores: lane.target_scores.join('/'),
        qualifying_grouped_odds: res.qGrouped,
        protected_grouped_odds: res.groupDec,
        skew: res.skew,
        first_set_score: firstSetScore,
        result: win ? 'WIN' : 'LOSS',
        group_units: Number((win ? res.groupDec - 1 : -1).toFixed(6)),
      };
      for (const s of ['6:2', '6:3', '6:4', '2:6', '4:6', '5:7']) base[`odds_${s.replace(':', '_')}`] = odds(row, s) || '';
      out.push({ ...base, ...pocketUnits(base) });
    }
  }
  return out.sort((a, b) => `${a.event_date} ${a.event_time} ${a.event_key} ${a.lane_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key} ${b.lane_key}`));
}

const scenarios = [
  { key: 'MAIN_GROUP_ONLY', desc: 'Main Core + Reverse grouped only', useMainGroup: true },
  { key: 'MAIN_OPT_VIP_ABD_NO_E', desc: 'Main grouped + A/B/D core boosters, E removed', useMainGroup: true, useA: true, useB: true, useD: true },
  { key: 'MAIN_FULL_VIP_ABDE', desc: 'Main grouped + A/B/D/E core boosters', useMainGroup: true, useA: true, useB: true, useD: true, useE: true },
  { key: 'BOOSTER_ONLY_ABD_MAIN', desc: 'A/B/D core boosters only, no grouped bet', useA: true, useB: true, useD: true },
  { key: 'RESEARCH_C_ONLY', desc: 'Research P2 C pocket only, no main ROI', useC: true, researchOnly: true },
  { key: 'MAIN_OPT_PLUS_RESEARCH_C', desc: 'Main optimized A/B/D plus separate research C', useMainGroup: true, useA: true, useB: true, useC: true, useD: true, includeResearch: true },
  { key: 'BOOSTER_ONLY_ABCD_WITH_RESEARCH', desc: 'A/B/D core + research C boosters only', useA: true, useB: true, useC: true, useD: true, includeResearch: true },
];

function unitFor(row, scenario) {
  const stake = 0.50;
  const isMain = row.bucket === 'MAIN';
  const isResearch = row.bucket === 'RESEARCH';
  if (isResearch && !scenario.includeResearch && !scenario.researchOnly) return null;
  if (scenario.researchOnly && !isResearch) return null;
  let units = 0;
  let staked = 0;
  if (scenario.useMainGroup && isMain) { units += row.group_units; staked += 1; }
  if (scenario.useA && row.a_63_mid_1u) { units += stake * row.a_63_mid_1u; staked += stake; }
  if (scenario.useB && row.b_64_band_1u) { units += stake * row.b_64_band_1u; staked += stake; }
  if (scenario.useC && row.c_26_research_1u) { units += stake * row.c_26_research_1u; staked += stake; }
  if (scenario.useD && row.d_64_high_1u) { units += stake * row.d_64_high_1u; staked += stake; }
  if (scenario.useE && row.e_62_high_1u) { units += stake * row.e_62_high_1u; staked += stake; }
  if (staked <= 0) return null;
  return { units: Number(units.toFixed(6)), staked: Number(staked.toFixed(6)) };
}

function summarize(rows) {
  const bets = rows.length;
  const profitUnits = rows.reduce((s, r) => s + r.unit_result, 0);
  const stakedUnits = rows.reduce((s, r) => s + r.staked_units, 0);
  return {
    bets,
    winning_rows: rows.filter((r) => r.unit_result > 0).length,
    losing_rows: rows.filter((r) => r.unit_result < 0).length,
    profit_units: Number(profitUnits.toFixed(6)),
    staked_units: Number(stakedUnits.toFixed(6)),
    roi_on_staked_pct: stakedUnits ? Number(((profitUnits / stakedUnits) * 100).toFixed(2)) : 0,
    worst_row_units: bets ? Number(Math.min(...rows.map((r) => r.unit_result)).toFixed(6)) : 0,
    best_row_units: bets ? Number(Math.max(...rows.map((r) => r.unit_result)).toFixed(6)) : 0,
  };
}
function monthly(rows) {
  const m = new Map();
  for (const row of rows) { if (!m.has(row.month)) m.set(row.month, []); m.get(row.month).push(row); }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, xs]) => ({ month, ...summarize(xs) }));
}
function drawdown(rows) {
  let bank = bankroll; let peak = bankroll; let maxDd = 0; let streak = 0; let worstStreak = 0;
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const before = bank;
    const pnl = before * riskPct * row.unit_result;
    bank += pnl;
    peak = Math.max(peak, bank);
    const dd = peak > 0 ? (peak - bank) / peak : 0;
    maxDd = Math.max(maxDd, dd);
    if (row.unit_result < 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
    out.push({ ...row, index: i + 1, balance_before: Number(before.toFixed(2)), pnl_cash: Number(pnl.toFixed(2)), balance_after: Number(bank.toFixed(2)), drawdown_pct: Number((dd * 100).toFixed(2)) });
  }
  return { final_bankroll: Number(bank.toFixed(2)), net_profit_cash: Number((bank - bankroll).toFixed(2)), return_pct: Number(((bank / bankroll - 1) * 100).toFixed(2)), max_drawdown_pct: Number((maxDd * 100).toFixed(2)), worst_losing_streak: worstStreak, rows: out };
}

function main() {
  if (!fs.existsSync(widePath)) { console.error(`Missing ${widePath}`); process.exit(2); }
  ensureDir(outDir);
  const sourceRows = csvParse(fs.readFileSync(widePath, 'utf8'));
  const signals = buildSignals(sourceRows);
  const allScenarioRows = [];
  const summaryRows = [];
  const allMonthly = [];
  const drawdownSummary = [];
  const allDrawdownRows = [];

  for (const scenario of scenarios) {
    const rows = [];
    for (const sig of signals) {
      const u = unitFor(sig, scenario);
      if (!u) continue;
      rows.push({ scenario: scenario.key, scenario_desc: scenario.desc, ...sig, unit_result: u.units, staked_units: u.staked });
    }
    allScenarioRows.push(...rows);
    summaryRows.push({ scenario: scenario.key, scenario_desc: scenario.desc, ...summarize(rows) });
    allMonthly.push(...monthly(rows).map((r) => ({ scenario: scenario.key, ...r })));
    const dd = drawdown(rows);
    drawdownSummary.push({ scenario: scenario.key, final_bankroll: dd.final_bankroll, net_profit_cash: dd.net_profit_cash, return_pct: dd.return_pct, max_drawdown_pct: dd.max_drawdown_pct, worst_losing_streak: dd.worst_losing_streak });
    allDrawdownRows.push(...dd.rows);
  }

  const fields = ['scenario','event_date','event_time','month','match_name','tournament_name','lane_key','bucket','side','public_signal_name','target_scores','first_set_score','result','skew','protected_grouped_odds','group_units','a_63_mid_1u','b_64_band_1u','c_26_research_1u','d_64_high_1u','e_62_high_1u','pocket_labels','unit_result','staked_units'];
  writeCsv(path.join(outDir, 'clean_vip_optimized_rows.csv'), allScenarioRows, fields);
  writeCsv(path.join(outDir, 'clean_vip_optimized_summary.csv'), summaryRows, ['scenario','scenario_desc','bets','winning_rows','losing_rows','profit_units','staked_units','roi_on_staked_pct','worst_row_units','best_row_units']);
  writeCsv(path.join(outDir, 'clean_vip_optimized_monthly.csv'), allMonthly, ['scenario','month','bets','winning_rows','losing_rows','profit_units','staked_units','roi_on_staked_pct','worst_row_units','best_row_units']);
  writeCsv(path.join(outDir, 'clean_vip_optimized_drawdown.csv'), allDrawdownRows, [...fields, 'index','balance_before','pnl_cash','balance_after','drawdown_pct']);

  const summary = {
    generated_at: new Date().toISOString(),
    source_file: widePath,
    source_rows: sourceRows.length,
    accepted_signal_rows: signals.length,
    definitions: {
      main: 'Core + Reverse only, grouped odds from protected score clusters.',
      optimized_vip: 'Core side-aware A/B/D boosters only; E 6:2 HIGH removed.',
      research: 'P2 C pocket is reported separately and not included in main ROI unless the scenario explicitly says PLUS_RESEARCH_C.',
      stake: 'Grouped bet 1.00u, each booster 0.50u.',
    },
    summaries: summaryRows,
    drawdown_summary: drawdownSummary,
  };
  writeJson(path.join(outDir, 'clean_vip_optimized_summary.json'), summary);
  const report = [
    '# Clean VIP Optimized 15M Warehouse Backtest', '',
    `Generated: ${summary.generated_at}`,
    `Source rows: ${sourceRows.length}`,
    `Accepted signal rows: ${signals.length}`, '',
    '## Scenarios',
    ...summaryRows.map((s) => `- ${s.scenario}: ${s.profit_units}u, ${s.bets} bets, ROI ${s.roi_on_staked_pct}%, worst row ${s.worst_row_units}u`), '',
    '## 5% Compounding Replay',
    ...drawdownSummary.map((d) => `- ${d.scenario}: final $${d.final_bankroll}, net $${d.net_profit_cash}, return ${d.return_pct}%, max DD ${d.max_drawdown_pct}%`), '',
    '## Notes',
    '- This uses the clean warehouse artifact, not live settled Proof Vault rows.',
    '- Main ROI should use main scenarios only; research C is separated.',
    '- Results are historical simulations and do not guarantee future outcomes.',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'clean_vip_optimized_report.md'), report + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
