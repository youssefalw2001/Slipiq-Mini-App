#!/usr/bin/env node
/*
  First Set Lab / SlipIQ walk-forward exact-score booster optimizer.

  Reads the API-Tennis combined warehouse file and rebuilds the Core + Reverse
  grouped baseline, then tests exact-score booster selection using only prior
  history before each month. Receipt/exact-score booster units stay separate
  from grouped model units.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

const warehouseDir = params['warehouse-dir'] || 'combined-warehouse';
const outDir = params.out || 'artifacts/output/walk-forward-exact-booster-optimizer';
const bookmakerFilter = String(params.bookmaker || 'bet365').toLowerCase();
const boosterStakes = String(params['booster-stakes'] || '0.10,0.25,0.50,1.00').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v >= 0);
const minTrainExamples = Number(params['min-train-examples'] || '30') || 30;
const minTrainUnits = Number(params['min-train-units'] || '0');
const bankroll = Number(params.bankroll || '3000') || 3000;
const riskPcts = String(params['risk-pcts'] || '0.05,0.06,0.07').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0 && v < 1);
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function safeNumber(v) { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function odds(row, score) { return safeNumber(row[`odds_${score.replace(':', '_')}`]); }
function groupedOdds(values) { const nums = values.map(safeNumber); if (nums.some((v) => !v || v <= 1)) return null; const implied = nums.reduce((s, v) => s + 1 / v, 0); return implied > 0 ? Number((1 / implied).toFixed(6)) : null; }
function scoreSkewBucket(values) { const nums = values.map(safeNumber); if (nums.length < 2 || nums.some((o) => !o || o <= 1)) return 'UNKNOWN'; const ratio = nums.length === 2 ? Math.max(...nums) / Math.min(...nums) : nums[1] / ((nums[0] + nums[nums.length - 1]) / 2); if (ratio < 0.80) return 'LOW'; if (ratio < 1.15) return 'MID'; if (ratio < 1.75) return 'HIGH'; return 'EXTREME'; }
function tour(row) { const key = clean(row.event_type_key); const type = `${row.event_type_type ?? ''} ${row.tournament_name ?? ''}`.toLowerCase(); if (key === '265' || /\batp\b|men/.test(type)) return 'ATP'; if (key === '266' || /\bwta\b|women/.test(type)) return 'WTA'; return 'UNKNOWN'; }
function tournamentGroup(row) { const t = clean(row.tournament_name).toLowerCase(); if (['australian open','roland garros','french open','wimbledon','us open'].some((k) => t.includes(k))) return 'GRAND_SLAM'; return 'OTHER_TOUR'; }
function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(filePath, rows, fields) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function writeJson(filePath, value) { ensureDir(path.dirname(filePath)); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }

function csvParse(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]; const next = text[i + 1];
    if (quoted) { if (ch === '"' && next === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const lanes = [
  { key: 'CORE_P1_ATP_GS_BET365', name: 'Core Cluster', target_scores: ['6:2','6:3','6:4'], qualifying_scores: ['6:3','6:4'], trigger_score: '6:4', trigger_min: 5, trigger_max: 6.25, min_qualifying_grouped: 2.5, max_qualifying_grouped: null, required_skew: null, tour: 'ATP', tournament_group: 'GRAND_SLAM' },
  { key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', name: 'Reverse Stretch Cluster', target_scores: ['2:6','4:6','5:7'], qualifying_scores: ['2:6','4:6'], trigger_score: '', trigger_min: null, trigger_max: null, min_qualifying_grouped: 2.5, max_qualifying_grouped: 4.5, required_skew: 'EXTREME', tour: 'ANY', tournament_group: 'GRAND_SLAM' },
];

function passLane(row, lane) {
  if (clean(row.bookmaker).toLowerCase() !== bookmakerFilter) return null;
  const rowTour = tour(row); const rowGroup = tournamentGroup(row);
  if (lane.tour !== 'ANY' && rowTour !== lane.tour) return null;
  if (lane.tournament_group !== 'ANY' && rowGroup !== lane.tournament_group) return null;
  const qualifyingOdds = lane.qualifying_scores.map((s) => odds(row, s));
  if (qualifyingOdds.some((v) => !v || v <= 1)) return null;
  const qualifyingGrouped = groupedOdds(qualifyingOdds);
  if (!qualifyingGrouped || qualifyingGrouped < lane.min_qualifying_grouped) return null;
  if (lane.max_qualifying_grouped && qualifyingGrouped > lane.max_qualifying_grouped) return null;
  const skew = scoreSkewBucket(qualifyingOdds);
  if (lane.required_skew && skew !== lane.required_skew) return null;
  if (lane.trigger_score) { const trigger = odds(row, lane.trigger_score); if (!trigger || trigger < lane.trigger_min || trigger > lane.trigger_max) return null; }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((v) => !v || v <= 1)) return null;
  const protectedGrouped = groupedOdds(targetOdds);
  if (!protectedGrouped) return null;
  return { qualifyingGrouped, protectedGrouped, skew, rowTour, rowGroup };
}

function buildMainSignals(rows) {
  const accepted = [];
  for (const row of rows) {
    for (const lane of lanes) {
      const res = passLane(row, lane);
      if (!res) continue;
      const firstSetScore = normalizeScore(row.first_set_score);
      if (!/^\d+:\d+$/.test(firstSetScore)) continue;
      const win = lane.target_scores.includes(firstSetScore);
      const groupProfit = win ? res.protectedGrouped - 1 : -1;
      const exactReceiptOdds = win ? odds(row, firstSetScore) : null;
      const signal = {
        event_key: row.event_key,
        event_date: row.event_date,
        event_time: row.event_time,
        month: clean(row.event_date).slice(0, 7),
        match_name: row.match_name,
        lane_key: lane.key,
        public_signal_name: lane.name,
        first_set_score: firstSetScore,
        result: win ? 'WIN' : 'LOSS',
        market_skew_bucket: res.skew,
        protected_grouped_odds: res.protectedGrouped,
        group_profit_units: Number(groupProfit.toFixed(6)),
        exact_receipt_odds: exactReceiptOdds || '',
        receipt_profit_units: win && exactReceiptOdds ? Number((exactReceiptOdds - 1).toFixed(6)) : -1,
      };
      for (const score of ['6:2','6:3','6:4','2:6','4:6','5:7']) signal[`odds_${score.replace(':', '_')}`] = odds(row, score) || '';
      accepted.push(signal);
    }
  }
  accepted.sort((a, b) => `${a.event_date} ${a.event_time} ${a.event_key}`.localeCompare(`${b.event_date} ${b.event_time} ${b.event_key}`));
  return accepted;
}

function candidateKey(row, score) { return `${row.lane_key}|${score}`; }
function scoreForKey(key) { return key.split('|')[1]; }
function oddsForScore(row, score) { return Number(row[`odds_${score.replace(':', '_')}`] || 0); }
function exactUnit(row, score) { const o = oddsForScore(row, score); if (!o || o <= 1) return null; return row.first_set_score === score ? o - 1 : -1; }

function trainKeys(trainRows) {
  const stats = new Map();
  for (const row of trainRows) {
    const scores = row.lane_key === 'CORE_P1_ATP_GS_BET365' ? ['6:2','6:3','6:4'] : ['2:6','4:6','5:7'];
    for (const score of scores) {
      const unit = exactUnit(row, score);
      if (unit === null) continue;
      const key = candidateKey(row, score);
      const s = stats.get(key) || { key, score, examples: 0, hits: 0, units: 0 };
      s.examples += 1;
      s.hits += row.first_set_score === score ? 1 : 0;
      s.units += unit;
      stats.set(key, s);
    }
  }
  return [...stats.values()]
    .filter((s) => s.examples >= minTrainExamples && s.units > minTrainUnits)
    .sort((a, b) => b.units - a.units)
    .map((s) => ({ ...s, units: Number(s.units.toFixed(6)), hit_rate_pct: Number(((s.hits / s.examples) * 100).toFixed(2)) }));
}

function applyWalkForward(rows, boosterStake) {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const out = [];
  const monthly = [];
  for (const month of months) {
    const train = rows.filter((r) => r.month < month);
    const test = rows.filter((r) => r.month === month);
    const selected = trainKeys(train);
    const selectedKeys = new Set(selected.map((s) => s.key));
    let monthGroup = 0; let monthBooster = 0; let monthPocketRows = 0; let monthPocketHits = 0;
    for (const row of test) {
      const rowSelected = [];
      for (const score of (row.lane_key === 'CORE_P1_ATP_GS_BET365' ? ['6:2','6:3','6:4'] : ['2:6','4:6','5:7'])) {
        const key = candidateKey(row, score);
        if (selectedKeys.has(key)) {
          const unit = exactUnit(row, score);
          if (unit !== null) rowSelected.push({ key, score, unit, odds: oddsForScore(row, score) });
        }
      }
      const booster1u = rowSelected.reduce((sum, x) => sum + x.unit, 0);
      const boosterUnits = boosterStake * booster1u;
      const totalUnits = Number(row.group_profit_units || 0) + boosterUnits;
      monthGroup += Number(row.group_profit_units || 0);
      monthBooster += boosterUnits;
      if (rowSelected.length) monthPocketRows += 1;
      if (booster1u > 0) monthPocketHits += 1;
      out.push({
        ...row,
        booster_stake: boosterStake,
        selected_keys: rowSelected.map((x) => x.key).join('|'),
        selected_scores: rowSelected.map((x) => x.score).join('|'),
        selected_odds: rowSelected.map((x) => x.odds).join('|'),
        booster_1u_units: Number(booster1u.toFixed(6)),
        booster_units: Number(boosterUnits.toFixed(6)),
        total_units: Number(totalUnits.toFixed(6)),
      });
    }
    monthly.push({
      month,
      booster_stake: boosterStake,
      train_rows: train.length,
      test_rows: test.length,
      selected_keys: selected.map((s) => `${s.key}(${s.examples},${s.units}u)`).join('; '),
      group_units: Number(monthGroup.toFixed(6)),
      booster_units: Number(monthBooster.toFixed(6)),
      total_units: Number((monthGroup + monthBooster).toFixed(6)),
      pocket_rows: monthPocketRows,
      pocket_hit_rows: monthPocketHits,
    });
  }
  return { rows: out, monthly };
}

function summarize(rows) {
  const bets = rows.length;
  const groupUnits = rows.reduce((s, r) => s + Number(r.group_profit_units || 0), 0);
  const boosterUnits = rows.reduce((s, r) => s + Number(r.booster_units || 0), 0);
  const totalUnits = rows.reduce((s, r) => s + Number(r.total_units || r.group_profit_units || 0), 0);
  const totalStaked = rows.reduce((s, r) => s + 1 + Number(r.booster_stake || 0) * (clean(r.selected_scores) ? clean(r.selected_scores).split('|').filter(Boolean).length : 0), 0);
  return {
    bets,
    wins: rows.filter((r) => r.result === 'WIN').length,
    losses: rows.filter((r) => r.result === 'LOSS').length,
    group_profit_units: Number(groupUnits.toFixed(6)),
    booster_units: Number(boosterUnits.toFixed(6)),
    total_profit_units: Number(totalUnits.toFixed(6)),
    total_staked_units: Number(totalStaked.toFixed(6)),
    roi_on_total_staked_pct: totalStaked ? Number(((totalUnits / totalStaked) * 100).toFixed(2)) : 0,
    pocket_rows: rows.filter((r) => clean(r.selected_scores)).length,
    pocket_hit_rows: rows.filter((r) => Number(r.booster_1u_units || 0) > 0).length,
  };
}

function drawdown(rows, riskPct) {
  let bank = bankroll; let peak = bankroll; let maxDd = 0; let worstStreak = 0; let streak = 0; const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const unit = Number(row.total_units || row.group_profit_units || 0); const stake = bank * riskPct; const profit = stake * unit; const before = bank;
    bank += profit; if (unit < 0) streak += 1; else streak = 0; worstStreak = Math.max(worstStreak, streak); peak = Math.max(peak, bank); const dd = peak ? (peak - bank) / peak : 0; maxDd = Math.max(maxDd, dd);
    out.push({ booster_stake: row.booster_stake, risk_pct: riskPct, index: i + 1, event_date: row.event_date, event_time: row.event_time, lane_key: row.lane_key, match_name: row.match_name, result: row.result, unit_result: Number(unit.toFixed(6)), balance_before: Number(before.toFixed(2)), stake: Number(stake.toFixed(2)), profit_loss: Number(profit.toFixed(2)), balance_after: Number(bank.toFixed(2)), drawdown_pct: Number((dd * 100).toFixed(2)) });
  }
  return { risk_pct: riskPct, starting_bankroll: bankroll, final_bankroll: Number(bank.toFixed(2)), net_profit: Number((bank - bankroll).toFixed(2)), return_pct: Number(((bank / bankroll - 1) * 100).toFixed(2)), worst_losing_streak: worstStreak, max_drawdown_pct: Number((maxDd * 100).toFixed(2)), rows: out };
}

function main() {
  if (!fs.existsSync(widePath)) { console.error(`Missing warehouse file: ${widePath}`); process.exit(2); }
  ensureDir(outDir);
  const sourceRows = csvParse(fs.readFileSync(widePath, 'utf8'));
  const mainRows = buildMainSignals(sourceRows);
  const allScenarioRows = []; const allMonthly = []; const scenarioSummaries = []; const allDrawdownRows = []; const drawdownSummary = [];
  for (const stake of boosterStakes) {
    const wf = applyWalkForward(mainRows, stake);
    allScenarioRows.push(...wf.rows); allMonthly.push(...wf.monthly);
    scenarioSummaries.push({ booster_stake: stake, ...summarize(wf.rows) });
    for (const risk of riskPcts) { const dd = drawdown(wf.rows, risk); drawdownSummary.push({ booster_stake: stake, ...Object.fromEntries(Object.entries(dd).filter(([k]) => k !== 'rows')) }); allDrawdownRows.push(...dd.rows); }
  }
  const groupBaseline = {
    bets: mainRows.length,
    wins: mainRows.filter((r) => r.result === 'WIN').length,
    losses: mainRows.filter((r) => r.result === 'LOSS').length,
    group_profit_units: Number(mainRows.reduce((s, r) => s + Number(r.group_profit_units || 0), 0).toFixed(6)),
  };
  groupBaseline.group_roi_pct = groupBaseline.bets ? Number(((groupBaseline.group_profit_units / groupBaseline.bets) * 100).toFixed(2)) : 0;

  writeCsv(path.join(outDir, 'walk_forward_booster_rows.csv'), allScenarioRows, ['booster_stake','event_key','event_date','event_time','month','match_name','lane_key','public_signal_name','first_set_score','result','market_skew_bucket','protected_grouped_odds','group_profit_units','selected_keys','selected_scores','selected_odds','booster_1u_units','booster_units','total_units']);
  writeCsv(path.join(outDir, 'walk_forward_booster_monthly.csv'), allMonthly, ['booster_stake','month','train_rows','test_rows','selected_keys','group_units','booster_units','total_units','pocket_rows','pocket_hit_rows']);
  writeCsv(path.join(outDir, 'walk_forward_booster_scenarios.csv'), scenarioSummaries, ['booster_stake','bets','wins','losses','group_profit_units','booster_units','total_profit_units','total_staked_units','roi_on_total_staked_pct','pocket_rows','pocket_hit_rows']);
  writeCsv(path.join(outDir, 'walk_forward_booster_drawdown.csv'), allDrawdownRows, ['booster_stake','risk_pct','index','event_date','event_time','lane_key','match_name','result','unit_result','balance_before','stake','profit_loss','balance_after','drawdown_pct']);

  const summary = { generated_at: new Date().toISOString(), mode: 'walk_forward_exact_booster_optimizer', source_file: widePath, bookmaker: bookmakerFilter, min_train_examples: minTrainExamples, min_train_units: minTrainUnits, source_rows: sourceRows.length, main_group_only_baseline: groupBaseline, scenarios: scenarioSummaries, drawdown_summary: drawdownSummary, warning: 'Walk-forward optimizer chooses exact-score boosters using only prior months. Keep main proof Core + Reverse grouped odds separate from booster units.' };
  writeJson(path.join(outDir, 'walk_forward_booster_summary.json'), summary);

  const report = ['# Walk-Forward Exact Booster Optimizer', '', `Generated: ${summary.generated_at}`, `Source rows: ${sourceRows.length}`, '', '## Group-Only Baseline', `- Bets: ${groupBaseline.bets}`, `- Wins/Losses: ${groupBaseline.wins}W / ${groupBaseline.losses}L`, `- Group units: ${groupBaseline.group_profit_units}`, `- Group ROI: ${groupBaseline.group_roi_pct}%`, '', '## Walk-Forward Scenarios', ...scenarioSummaries.map((s) => `- Booster ${s.booster_stake}u: total ${s.total_profit_units}u, booster ${s.booster_units}u, total staked ${s.total_staked_units}u, ROI ${s.roi_on_total_staked_pct}%, pocket rows ${s.pocket_rows}, pocket hit rows ${s.pocket_hit_rows}`), '', '## Drawdown / Compounding', ...drawdownSummary.map((d) => `- Booster ${d.booster_stake}u, risk ${(d.risk_pct * 100).toFixed(1)}%: final ${d.final_bankroll}, net ${d.net_profit}, return ${d.return_pct}%, max DD ${d.max_drawdown_pct}%, worst losing streak ${d.worst_losing_streak}`), '', '## Notes', '- Core + Reverse grouped model remains the public main proof baseline.', '- Booster units are exact-score overlay units selected via prior-month walk-forward training.', '- Do not use full-sample optimized exact scores as public proof.'].join('\n');
  fs.writeFileSync(path.join(outDir, 'walk_forward_booster_report.md'), report + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
