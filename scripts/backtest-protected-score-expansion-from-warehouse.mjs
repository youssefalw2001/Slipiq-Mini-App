#!/usr/bin/env node
/*
  First Set Lab protected score expansion test.

  Tests whether adding protected extra correct scores improves or dilutes the edge.
  Uses the clean warehouse wide correct-score file, not live settled Proof Vault rows.

  Variants:
  - GATE_2: original 2-score gate/target only.
  - PROTECTED_3: current protected group with one extra missing score.
  - WIDE_4: experimental wider group with one additional adjacent score.

  Lanes:
  - Core
  - Reverse
  - Research P2
  - V3
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const warehouseDir = args['warehouse-dir'] || 'combined-warehouse';
const outDir = args.out || 'artifacts/output/protected-score-expansion';
const bankroll = Number(args.bankroll || '3000') || 3000;
const riskPcts = String(args['risk-pcts'] || '0.03,0.05,0.07').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0 && v < 1);
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
  if (xs.length < 2 || xs.some((x) => !x || x <= 1)) return 'UNKNOWN';
  const ratio = xs.length === 2 ? Math.max(...xs) / Math.min(...xs) : xs[1] / ((xs[0] + xs[xs.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}

const laneDefs = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365', lane_class: 'MAIN', public_signal_name: 'Core Cluster', book: 'bet365', tour: 'ATP', tournament_group: 'GRAND_SLAM', gate_scores: ['6:3','6:4'], trigger_score: '6:4', trigger_min: 5.00, trigger_max: 6.25, min_gate_grouped: 2.50, max_gate_grouped: null, required_skew: null,
    variants: { GATE_2: ['6:3','6:4'], PROTECTED_3: ['6:2','6:3','6:4'], WIDE_4: ['6:2','6:3','6:4','7:5'] },
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', lane_class: 'MAIN', public_signal_name: 'Reverse Stretch Cluster', book: 'bet365', tour: 'ANY', tournament_group: 'GRAND_SLAM', gate_scores: ['2:6','4:6'], trigger_score: '', trigger_min: null, trigger_max: null, min_gate_grouped: 2.50, max_gate_grouped: 4.50, required_skew: 'EXTREME',
    variants: { GATE_2: ['2:6','4:6'], PROTECTED_3: ['2:6','4:6','5:7'], WIDE_4: ['1:6','2:6','4:6','5:7'] },
  },
  {
    lane_key: 'RESEARCH_P2_GS_26_46_BET365', lane_class: 'RESEARCH', public_signal_name: 'Research P2 GS Sniper', book: 'bet365', tour: 'ANY', tournament_group: 'GRAND_SLAM', gate_scores: ['2:6','4:6'], trigger_score: '', trigger_min: null, trigger_max: null, min_gate_grouped: 2.50, max_gate_grouped: 4.50, required_skew: 'EXTREME',
    variants: { GATE_2: ['2:6','4:6'], PROTECTED_3: ['2:6','4:6','5:7'], WIDE_4: ['1:6','2:6','4:6','5:7'] },
  },
  {
    lane_key: 'VIP_P2_V3_SHAPE', lane_class: 'RESEARCH', public_signal_name: 'V3 Cluster', book: 'ANY', tour: 'ANY', tournament_group: 'ANY', gate_scores: ['3:6','4:6','5:7'], trigger_score: '4:6', trigger_min: 6.25, trigger_max: 6.99, min_gate_grouped: 3.50, max_gate_grouped: null, required_skew: null,
    variants: { GATE_2: ['4:6','5:7'], PROTECTED_3: ['3:6','4:6','5:7'], WIDE_4: ['2:6','3:6','4:6','5:7'] },
  },
];

function passGate(row, lane) {
  if (lane.book !== 'ANY' && norm(row.bookmaker) !== norm(lane.book)) return null;
  if (lane.book === 'ANY' && !['bet365','1xbet','10bet'].includes(norm(row.bookmaker).replace(/\s+/g, ''))) return null;
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
  return { gateGrouped, skew, triggerOdds };
}

function buildRows(sourceRows) {
  const out = [];
  for (const row of sourceRows) {
    const actual = normalizeScore(row.first_set_score);
    if (!/^\d+:\d+$/.test(actual)) continue;
    for (const lane of laneDefs) {
      const gate = passGate(row, lane);
      if (!gate) continue;
      for (const [variant, targetScores] of Object.entries(lane.variants)) {
        const targetOdds = targetScores.map((s) => odds(row, s));
        if (targetOdds.some((x) => !x || x <= 1)) continue;
        const dec = groupedOdds(targetOdds);
        if (!dec) continue;
        const win = targetScores.includes(actual);
        const signalKey = [row.event_key, lane.lane_key, row.bookmaker, variant, lane.gate_scores.join('/')].join(':');
        out.push({
          signal_key: signalKey,
          event_key: row.event_key,
          event_date: row.event_date,
          event_time: row.event_time,
          month: clean(row.event_date).slice(0,7),
          match_name: row.match_name,
          tournament_name: row.tournament_name,
          tour: tour(row),
          tournament_group: tournamentGroup(row),
          bookmaker: row.bookmaker,
          lane_key: lane.lane_key,
          lane_class: lane.lane_class,
          public_signal_name: lane.public_signal_name,
          variant,
          gate_scores: lane.gate_scores.join('/'),
          target_scores: targetScores.join('/'),
          gate_grouped_odds: gate.gateGrouped,
          target_grouped_odds: dec,
          first_set_score: actual,
          result: win ? 'WIN' : 'LOSS',
          unit_result: Number((win ? dec - 1 : -1).toFixed(6)),
          staked_units: 1,
          skew: gate.skew,
          trigger_odds: gate.triggerOdds,
        });
      }
    }
  }
  return out.sort((a,b) => `${a.event_date} ${a.event_time} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.signal_key}`));
}

function summarize(rows) {
  const units = rows.reduce((s,r) => s + Number(r.unit_result || 0), 0);
  const staked = rows.reduce((s,r) => s + Number(r.staked_units || 0), 0);
  return {
    rows: rows.length,
    wins: rows.filter((r) => r.result === 'WIN').length,
    losses: rows.filter((r) => r.result === 'LOSS').length,
    hit_rate_pct: rows.length ? Number(((rows.filter((r) => r.result === 'WIN').length / rows.length) * 100).toFixed(2)) : 0,
    profit_units: Number(units.toFixed(6)),
    staked_units: Number(staked.toFixed(6)),
    roi_pct: staked ? Number(((units/staked)*100).toFixed(2)) : 0,
    avg_odds: rows.length ? Number((rows.reduce((s,r) => s + Number(r.target_grouped_odds || 0), 0) / rows.length).toFixed(4)) : 0,
    worst_row_units: rows.length ? Number(Math.min(...rows.map((r) => Number(r.unit_result || 0))).toFixed(6)) : 0,
    best_row_units: rows.length ? Number(Math.max(...rows.map((r) => Number(r.unit_result || 0))).toFixed(6)) : 0,
    first_date: rows[0]?.event_date || '',
    last_date: rows[rows.length - 1]?.event_date || '',
  };
}
function grouped(rows, keys) {
  const map = new Map();
  for (const r of rows) {
    const key = keys.map((k) => r[k] || 'UNKNOWN').join('||');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key, xs]) => {
    const parts = key.split('||');
    const obj = Object.fromEntries(keys.map((k, i) => [k, parts[i]]));
    return { ...obj, ...summarize(xs) };
  });
}
function compound(rows, risk) {
  let bank = bankroll, peak = bankroll, maxDd = 0, streak = 0, worstStreak = 0;
  for (const r of rows) {
    bank = bank * (1 + risk * Number(r.unit_result || 0));
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak ? (peak - bank) / peak : 0);
    if (Number(r.unit_result || 0) < 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  return { risk_pct: risk, final_bankroll: Number(bank.toFixed(2)), net_profit: Number((bank-bankroll).toFixed(2)), return_pct: Number(((bank/bankroll-1)*100).toFixed(2)), max_drawdown_pct: Number((maxDd*100).toFixed(2)), worst_losing_streak: worstStreak };
}

function main() {
  if (!fs.existsSync(widePath)) { console.error(`Missing warehouse file ${widePath}`); process.exit(2); }
  ensureDir(outDir);
  const sourceRows = parseCsv(fs.readFileSync(widePath, 'utf8'));
  const rows = buildRows(sourceRows);
  const summaryByLaneVariant = grouped(rows, ['lane_key','variant']);
  const summaryByVariant = grouped(rows, ['variant']);
  const monthly = grouped(rows, ['lane_key','variant','month']);
  const comboDefs = [
    { combo: 'MAIN_CORE_REVERSE', lanes: ['CORE_P1_ATP_GS_BET365','CORE_P2_GS_REVERSE_STRETCH_BET365'] },
    { combo: 'OPT_CORE_REVERSE_RESEARCH_P2_V3', lanes: ['CORE_P1_ATP_GS_BET365','CORE_P2_GS_REVERSE_STRETCH_BET365','RESEARCH_P2_GS_26_46_BET365','VIP_P2_V3_SHAPE'] },
  ];
  const comboSummary = [];
  const comboCompounding = [];
  for (const c of comboDefs) {
    for (const variant of ['GATE_2','PROTECTED_3','WIDE_4']) {
      const xs = rows.filter((r) => c.lanes.includes(r.lane_key) && r.variant === variant);
      comboSummary.push({ combo: c.combo, variant, ...summarize(xs) });
      for (const risk of riskPcts) comboCompounding.push({ combo: c.combo, variant, ...compound(xs, risk) });
    }
  }

  const fields = ['event_date','event_time','match_name','tournament_name','bookmaker','lane_key','lane_class','public_signal_name','variant','gate_scores','target_scores','gate_grouped_odds','target_grouped_odds','first_set_score','result','unit_result','staked_units','skew','trigger_odds','signal_key'];
  writeCsv(path.join(outDir, 'protected_score_expansion_rows.csv'), rows, fields);
  writeCsv(path.join(outDir, 'protected_score_expansion_by_lane_variant.csv'), summaryByLaneVariant, ['lane_key','variant','rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_pct','avg_odds','worst_row_units','best_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'protected_score_expansion_by_variant.csv'), summaryByVariant, ['variant','rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_pct','avg_odds','worst_row_units','best_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'protected_score_expansion_monthly.csv'), monthly, ['lane_key','variant','month','rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_pct','avg_odds','worst_row_units','best_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'protected_score_expansion_combo_summary.csv'), comboSummary, ['combo','variant','rows','wins','losses','hit_rate_pct','profit_units','staked_units','roi_pct','avg_odds','worst_row_units','best_row_units','first_date','last_date']);
  writeCsv(path.join(outDir, 'protected_score_expansion_compounding.csv'), comboCompounding, ['combo','variant','risk_pct','final_bankroll','net_profit','return_pct','max_drawdown_pct','worst_losing_streak']);

  const summary = { generated_at: new Date().toISOString(), source_file: widePath, source_rows: sourceRows.length, generated_rows: rows.length, by_variant: summaryByVariant, by_lane_variant: summaryByLaneVariant, combo_summary: comboSummary, compounding: comboCompounding, note: 'GATE_2 is original gate target only, PROTECTED_3 is current extra protected score, WIDE_4 is experimental wider group.' };
  writeJson(path.join(outDir, 'protected_score_expansion_summary.json'), summary);
  fs.writeFileSync(path.join(outDir, 'protected_score_expansion_report.md'), ['# Protected Score Expansion Backtest', '', `Generated: ${summary.generated_at}`, `Source rows: ${sourceRows.length}`, `Generated rows: ${rows.length}`, '', '## Combo Summary', ...comboSummary.map((s) => `- ${s.combo} ${s.variant}: ${s.rows} rows, ${s.profit_units}u, ROI ${s.roi_pct}%, hit ${s.hit_rate_pct}%, avg odds ${s.avg_odds}`), '', '## Notes', '- This test answers whether the new protected third score is helping historically.', '- WIDE_4 should remain research unless it beats PROTECTED_3 on units, ROI, and drawdown.', '- Uses clean warehouse rows, not live Proof Vault settled rows.'].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
