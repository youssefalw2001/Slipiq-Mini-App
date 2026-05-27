#!/usr/bin/env node
/*
  First Set Lab live-scanner parity backtest.

  This is intentionally broader than the clean Core+Reverse proof backtest.
  It rebuilds historical warehouse candidates using the live scanner lane set:
  - Core Cluster
  - Reverse Stretch Cluster
  - Mirror Cluster
  - Core Cluster Plus
  - V3 Cluster
  - Research P2 GS Sniper

  It outputs both strict public-main proof and broad scanner-parity results so
  we stop comparing a wide live ledger against a narrow historical model.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const warehouseDir = args['warehouse-dir'] || 'combined-warehouse';
const outDir = args.out || 'artifacts/output/live-scanner-parity-backtest';
const bookmakerFallback = String(args.bookmaker || 'bet365').toLowerCase();
const bankroll = Number(args.bankroll || '3000') || 3000;
const riskPcts = String(args['risk-pcts'] || '0.03,0.05,0.07').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0 && v < 1);
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v) { return clean(v).toLowerCase().replace(/[_-]/g, ' '); }
function n(v) { if (v === undefined || v === null || clean(v) === '') return null; const x = Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; }
function scoreKey(score) { return `odds_${score.replace(':', '_')}`; }
function score(row, s) { return n(row[scoreKey(s)]); }
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function groupedOdds(values) { const xs = values.map(n); if (xs.some((x) => !x || x <= 1)) return null; const implied = xs.reduce((sum, x) => sum + 1 / x, 0); return implied ? Number((1 / implied).toFixed(6)) : null; }
function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(file, rows, fields) { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i], nx = text[i + 1];
    if (quoted) {
      if (ch === '"' && nx === '"') { cell += '"'; i += 1; }
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
function skewBucket(vals) {
  const xs = vals.map(n);
  if (xs.length < 2 || xs.some((x) => !x || x <= 1)) return 'UNKNOWN';
  const ratio = xs.length === 2 ? Math.max(...xs) / Math.min(...xs) : xs[1] / ((xs[0] + xs[xs.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}
function tierRank(tier) { return ({ Comfort: 4, S: 3, A: 2, B: 1, Research: 0 })[tier] || 0; }
function tierFor(grouped, lane) { if (lane.access === 'RESEARCH_ONLY') return 'Research'; if (grouped >= lane.tierFloorS) return 'S'; if (grouped >= lane.tierFloorA) return 'A'; return 'B'; }
function signalRank(row) { return tierRank(row.public_tier) * 1000000 + Number(row.quality || 0) * 100000 + Number(row.grouped_odds || 0) * 100 + Number(row.trigger_odds || 0); }

const lanes = [
  { key: 'CORE_P1_ATP_GS_BET365', lane_class: 'MAIN', access: 'CORE_AND_VIP', books: ['bet365'], gate: ['6:3','6:4'], target: ['6:2','6:3','6:4'], triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25, minGrouped: 2.50, maxGrouped: null, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', label: 'Core Cluster', tierFloorA: 2.50, tierFloorS: 3.10, quality: 4 },
  { key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', lane_class: 'MAIN', access: 'CORE_AND_VIP', books: ['bet365'], gate: ['2:6','4:6'], target: ['2:6','4:6','5:7'], triggerScore: '', triggerMin: null, triggerMax: null, minGrouped: 2.50, maxGrouped: 4.50, requiredSkew: 'EXTREME', tour: 'ANY', tournamentGroup: 'GRAND_SLAM', label: 'Reverse Stretch Cluster', tierFloorA: 2.50, tierFloorS: 3.50, quality: 4 },
  { key: 'CORE_P1_MIRROR_WTA_OTHER', lane_class: 'WATCHLIST', access: 'CORE_AND_VIP', books: ['bet365','1xBet'], gate: ['6:3','6:4','7:5'], target: ['6:3','6:4','7:5'], triggerScore: '6:4', triggerMin: 5.00, triggerMax: 8.00, minGrouped: 2.60, maxGrouped: null, tour: 'WTA', tournamentGroup: 'OTHER_TOUR', label: 'Mirror Cluster', tierFloorA: 2.60, tierFloorS: 2.90, quality: 2 },
  { key: 'VIP_P1_ATP_GS_MULTI', lane_class: 'PAUSED_RESEARCH', access: 'VIP_ONLY', books: ['bet365','1xBet','10Bet'], gate: ['6:3','6:4'], target: ['6:3','6:4'], triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25, minGrouped: 2.60, maxGrouped: null, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', label: 'Core Cluster Plus', tierFloorA: 2.60, tierFloorS: 3.10, quality: 3 },
  { key: 'VIP_P2_V3_SHAPE', lane_class: 'RESEARCH', access: 'VIP_ONLY', books: ['bet365','1xBet','10Bet'], gate: ['3:6','4:6','5:7'], target: ['3:6','4:6','5:7'], triggerScore: '4:6', triggerMin: 6.25, triggerMax: 6.99, minGrouped: 3.50, maxGrouped: null, tour: 'ANY', tournamentGroup: 'ANY', label: 'V3 Cluster', tierFloorA: 3.50, tierFloorS: 3.75, quality: 2 },
  { key: 'RESEARCH_P2_GS_26_46_BET365', lane_class: 'RESEARCH', access: 'RESEARCH_ONLY', books: ['bet365'], gate: ['2:6','4:6'], target: ['2:6','4:6','5:7'], triggerScore: '', triggerMin: null, triggerMax: null, minGrouped: 2.50, maxGrouped: 4.50, requiredSkew: 'EXTREME', tour: 'ANY', tournamentGroup: 'GRAND_SLAM', label: 'Research P2 GS Sniper', tierFloorA: 2.50, tierFloorS: 3.50, quality: 1 },
];

function pass(row, lane, book) {
  if (book && norm(row.bookmaker) !== norm(book)) return null;
  if (lane.tour !== 'ANY' && tour(row) !== lane.tour) return null;
  if (lane.tournamentGroup !== 'ANY' && tournamentGroup(row) !== lane.tournamentGroup) return null;
  const gateOdds = lane.gate.map((s) => score(row, s));
  if (gateOdds.some((x) => !x || x <= 1)) return null;
  const gateGrouped = groupedOdds(gateOdds);
  if (!gateGrouped || gateGrouped < lane.minGrouped) return null;
  if (lane.maxGrouped && gateGrouped > lane.maxGrouped) return null;
  const skew = skewBucket(gateOdds);
  if (lane.requiredSkew && skew !== lane.requiredSkew) return null;
  let triggerOdds = '';
  if (lane.triggerScore) {
    triggerOdds = score(row, lane.triggerScore);
    if (!triggerOdds || triggerOdds < lane.triggerMin || triggerOdds > lane.triggerMax) return null;
  }
  const targetOdds = lane.target.map((s) => score(row, s));
  if (targetOdds.some((x) => !x || x <= 1)) return null;
  const protectedGrouped = groupedOdds(targetOdds);
  if (!protectedGrouped) return null;
  return { gateGrouped, protectedGrouped, skew, triggerOdds };
}

function buildCandidates(rows) {
  const out = [];
  for (const row of rows) {
    for (const lane of lanes) {
      for (const book of lane.books) {
        const p = pass(row, lane, book);
        if (!p) continue;
        const first = normalizeScore(row.first_set_score);
        if (!/^\d+:\d+$/.test(first)) continue;
        const win = lane.target.includes(first);
        const publicTier = tierFor(p.gateGrouped, lane);
        const signalKey = [row.event_key, lane.key, 'exact_score_cluster', lane.gate.join('/')].join(':');
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
          bookmaker: book,
          lane_key: lane.key,
          lane_class: lane.lane_class,
          access: lane.access,
          public_signal_name: lane.label,
          gate_scores: lane.gate.join('/'),
          target_scores: lane.target.join('/'),
          first_set_score: first,
          result: win ? 'WIN' : 'LOSS',
          gate_grouped_odds: p.gateGrouped,
          protected_grouped_odds: p.protectedGrouped,
          grouped_profit_units: Number((win ? p.protectedGrouped - 1 : -1).toFixed(6)),
          skew: p.skew,
          trigger_odds: p.triggerOdds,
          public_tier: publicTier,
          quality: lane.quality,
        });
      }
    }
  }
  return out.sort((a,b) => `${a.event_date} ${a.event_time} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.signal_key}`));
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    const prev = map.get(row.signal_key);
    if (!prev || signalRank(row) > signalRank(prev)) map.set(row.signal_key, row);
  }
  return [...map.values()].sort((a,b) => `${a.event_date} ${a.event_time} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.signal_key}`));
}
function capByDay(rows, cap, room) {
  const byDay = new Map();
  for (const row of rows) { const day = row.event_date || 'unknown'; if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(row); }
  const keep = [];
  for (const [day, arr] of [...byDay.entries()].sort()) {
    const ranked = arr.sort((a,b) => signalRank(b) - signalRank(a));
    for (let i = 0; i < ranked.length && (cap <= 0 || i < cap); i += 1) keep.push({ ...ranked[i], telegram_room: room });
  }
  return keep.sort((a,b) => `${a.event_date} ${a.event_time} ${a.telegram_room} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.telegram_room} ${b.signal_key}`));
}
function selectedRoomSignals(candidate) {
  const exact = candidate.filter((r) => r.access !== 'RESEARCH_ONLY');
  const research = candidate.filter((r) => r.access === 'RESEARCH_ONLY').map((r) => ({ ...r, telegram_room: 'Research' }));
  const core = capByDay(exact.filter((r) => r.access === 'CORE_AND_VIP'), 10, 'Core');
  const vip = capByDay(exact, 5, 'VIP');
  return [...core, ...vip, ...research].sort((a,b) => `${a.event_date} ${a.event_time} ${a.telegram_room} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.telegram_room} ${b.signal_key}`));
}
function uniqueCustomerRows(selected) {
  const map = new Map();
  for (const row of selected) {
    const prev = map.get(row.signal_key);
    if (!prev || signalRank(row) > signalRank(prev)) map.set(row.signal_key, row);
  }
  return [...map.values()].sort((a,b) => `${a.event_date} ${a.event_time} ${a.signal_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.signal_key}`));
}

function summarize(rows) {
  const units = rows.reduce((s,r) => s + Number(r.grouped_profit_units || 0), 0);
  const staked = rows.length;
  return { rows: rows.length, wins: rows.filter((r) => r.result === 'WIN').length, losses: rows.filter((r) => r.result === 'LOSS').length, profit_units: Number(units.toFixed(6)), staked_units: staked, roi_pct: staked ? Number(((units/staked)*100).toFixed(2)) : 0, first_date: rows[0]?.event_date || '', last_date: rows[rows.length-1]?.event_date || '' };
}
function groupSummary(rows, field) {
  const m = new Map();
  for (const r of rows) { const k = r[field] || 'UNKNOWN'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key, xs]) => ({ [field]: key, ...summarize(xs) }));
}
function compound(rows, risk) {
  let bank = bankroll; let peak = bankroll; let maxDd = 0; let streak = 0; let worstStreak = 0;
  for (const r of rows) {
    bank = bank * (1 + risk * Number(r.grouped_profit_units || 0));
    peak = Math.max(peak, bank);
    maxDd = Math.max(maxDd, peak ? (peak - bank) / peak : 0);
    if (Number(r.grouped_profit_units || 0) < 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  return { risk_pct: risk, final_bankroll: Number(bank.toFixed(2)), net_profit: Number((bank-bankroll).toFixed(2)), return_pct: Number(((bank/bankroll-1)*100).toFixed(2)), max_drawdown_pct: Number((maxDd*100).toFixed(2)), worst_losing_streak: worstStreak };
}

function main() {
  if (!fs.existsSync(widePath)) { console.error(`Missing warehouse file: ${widePath}`); process.exit(2); }
  ensureDir(outDir);
  const source = parseCsv(fs.readFileSync(widePath, 'utf8'));
  const raw = buildCandidates(source);
  const candidate = dedupe(raw);
  const selected = selectedRoomSignals(candidate);
  const unique = uniqueCustomerRows(selected);
  const publicMain = unique.filter((r) => r.lane_class === 'MAIN');
  const broadNoPaused = unique.filter((r) => r.lane_class !== 'PAUSED_RESEARCH');
  const broadAll = unique;
  const liveComparable = unique.filter((r) => ['MAIN','WATCHLIST','PAUSED_RESEARCH','RESEARCH'].includes(r.lane_class));
  const scenarios = [
    { scenario: 'PUBLIC_MAIN_CORE_REVERSE_ONLY', rows: publicMain },
    { scenario: 'BROAD_SCANNER_NO_PAUSED', rows: broadNoPaused },
    { scenario: 'BROAD_SCANNER_ALL_EXACT_LANES', rows: broadAll },
    { scenario: 'LIVE_COMPARABLE_ALL_CURRENT_LANES', rows: liveComparable },
  ];
  const scenarioRows = scenarios.map((s) => ({ scenario: s.scenario, ...summarize(s.rows) }));
  const monthly = scenarios.flatMap((s) => groupSummary(s.rows, 'month').map((r) => ({ scenario: s.scenario, ...r })));
  const byLane = scenarios.flatMap((s) => groupSummary(s.rows, 'lane_key').map((r) => ({ scenario: s.scenario, ...r })));
  const comp = scenarios.flatMap((s) => riskPcts.map((risk) => ({ scenario: s.scenario, ...compound(s.rows, risk) })));

  const fields = ['event_date','event_time','match_name','tournament_name','tour','tournament_group','bookmaker','telegram_room','lane_key','lane_class','access','public_signal_name','gate_scores','target_scores','first_set_score','result','gate_grouped_odds','protected_grouped_odds','grouped_profit_units','skew','trigger_odds','public_tier','signal_key'];
  writeCsv(path.join(outDir, 'live_scanner_parity_raw_candidates.csv'), raw, fields);
  writeCsv(path.join(outDir, 'live_scanner_parity_deduped_candidates.csv'), candidate, fields);
  writeCsv(path.join(outDir, 'live_scanner_parity_selected_room_signals.csv'), selected, fields);
  writeCsv(path.join(outDir, 'live_scanner_parity_unique_customer_rows.csv'), unique, fields);
  writeCsv(path.join(outDir, 'live_scanner_parity_summary.csv'), scenarioRows, ['scenario','rows','wins','losses','profit_units','staked_units','roi_pct','first_date','last_date']);
  writeCsv(path.join(outDir, 'live_scanner_parity_monthly.csv'), monthly, ['scenario','month','rows','wins','losses','profit_units','staked_units','roi_pct','first_date','last_date']);
  writeCsv(path.join(outDir, 'live_scanner_parity_by_lane.csv'), byLane, ['scenario','lane_key','rows','wins','losses','profit_units','staked_units','roi_pct','first_date','last_date']);
  writeCsv(path.join(outDir, 'live_scanner_parity_compounding.csv'), comp, ['scenario','risk_pct','final_bankroll','net_profit','return_pct','max_drawdown_pct','worst_losing_streak']);
  const summary = { generated_at: new Date().toISOString(), source_file: widePath, source_rows: source.length, raw_candidate_rows: raw.length, deduped_candidate_signals: candidate.length, selected_room_signals: selected.length, unique_customer_rows: unique.length, scenario_summary: scenarioRows, compounding: comp, note: 'Parity test uses live scanner exact-score lanes and daily room caps. Public main remains Core + Reverse only; broad scanner lanes are not public main ROI.' };
  writeJson(path.join(outDir, 'live_scanner_parity_summary.json'), summary);
  fs.writeFileSync(path.join(outDir, 'live_scanner_parity_report.md'), ['# Live Scanner Parity Backtest', '', `Generated: ${summary.generated_at}`, `Source rows: ${source.length}`, `Raw candidates: ${raw.length}`, `Deduped candidates: ${candidate.length}`, `Selected room signals: ${selected.length}`, `Unique customer rows: ${unique.length}`, '', '## Scenarios', ...scenarioRows.map((s) => `- ${s.scenario}: ${s.rows} rows, ${s.profit_units}u, ROI ${s.roi_pct}%, ${s.first_date} to ${s.last_date}`), '', '## Compounding', ...comp.map((c) => `- ${c.scenario} @ ${(c.risk_pct*100).toFixed(1)}%: final $${c.final_bankroll}, max DD ${c.max_drawdown_pct}%`), '', '## Notes', '- This is NOT the public main proof unless scenario is PUBLIC_MAIN_CORE_REVERSE_ONLY.', '- It exists to answer why live row density is much higher than strict Core+Reverse historical counts.', '- Comfort / Over-Under are excluded because this warehouse file is first-set correct-score wide data.'].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}
main();
