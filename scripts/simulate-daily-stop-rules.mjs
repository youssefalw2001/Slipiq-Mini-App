#!/usr/bin/env node
/*
  First Set Lab / SlipIQ Daily Stop Rule Simulator

  Reads upgraded Bet365 backtest rows and simulates daily stop-win, stop-loss,
  max-signals, losing-streak stop, and green-protection rules.

  Purpose:
  - Find whether stopping after the right daily profit/loss threshold improves
    profit units, ROI, max drawdown, and emotional risk.
  - Research only. No Supabase writes. No Telegram.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const inputPath = params.input || 'upgraded-bet365-backtest/upgraded_bet365_main_rows.csv';
const outDir = params.out || 'artifacts/output/daily-stop-rule-simulator';
const bankroll = Number(params.bankroll || '3000') || 3000;
const riskPct = Number(params['risk-pct'] || '0.05') || 0.05;

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
function parseCsv(text) {
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
function dateKey(row) { return clean(row.event_date).slice(0, 10); }
function sortKey(row) { return `${clean(row.event_date)} ${clean(row.event_time)} ${clean(row.event_key)} ${clean(row.match_name)}`; }

const rules = [
  { name: 'NO_STOP_BASELINE', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_LOSS_-2U', stopLoss: -2, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_LOSS_-3U', stopLoss: -3, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_LOSS_-4U', stopLoss: -4, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_WIN_+2U', stopLoss: null, stopWin: 2, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_WIN_+3U', stopLoss: null, stopWin: 3, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_WIN_+4U', stopLoss: null, stopWin: 4, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_WIN_+5U', stopLoss: null, stopWin: 5, maxSignals: null, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'MAX_3_SIGNALS_DAY', stopLoss: null, stopWin: null, maxSignals: 3, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'MAX_5_SIGNALS_DAY', stopLoss: null, stopWin: null, maxSignals: 5, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'MAX_7_SIGNALS_DAY', stopLoss: null, stopWin: null, maxSignals: 7, lossStreakStop: null, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_AFTER_2_STRAIGHT_LOSSES', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: 2, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_AFTER_3_STRAIGHT_LOSSES', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: 3, greenProtectStart: null, greenGiveback: null },
  { name: 'STOP_AFTER_4_STRAIGHT_LOSSES', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: 4, greenProtectStart: null, greenGiveback: null },
  { name: 'GUARD_-3U_3L', stopLoss: -3, stopWin: null, maxSignals: null, lossStreakStop: 3, greenProtectStart: null, greenGiveback: null },
  { name: 'GUARD_-3U_+4U_3L', stopLoss: -3, stopWin: 4, maxSignals: null, lossStreakStop: 3, greenProtectStart: null, greenGiveback: null },
  { name: 'GREEN_PROTECT_+2U_GIVEBACK_1U', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: 2, greenGiveback: 1 },
  { name: 'GREEN_PROTECT_+3U_GIVEBACK_1.5U', stopLoss: null, stopWin: null, maxSignals: null, lossStreakStop: null, greenProtectStart: 3, greenGiveback: 1.5 },
  { name: 'FULL_GUARD_-3U_+4U_3L_GREEN', stopLoss: -3, stopWin: 4, maxSignals: null, lossStreakStop: 3, greenProtectStart: 2, greenGiveback: 1 },
  { name: 'SOFT_GUARD_-4U_+5U_4L_GREEN', stopLoss: -4, stopWin: 5, maxSignals: null, lossStreakStop: 4, greenProtectStart: 3, greenGiveback: 1.5 },
];

function shouldStopAfter(rule, dayUnits, dayPeak, dayTaken, currentLossStreak) {
  if (rule.maxSignals && dayTaken >= rule.maxSignals) return 'MAX_SIGNALS';
  if (rule.stopLoss !== null && dayUnits <= rule.stopLoss) return 'STOP_LOSS';
  if (rule.stopWin !== null && dayUnits >= rule.stopWin) return 'STOP_WIN';
  if (rule.lossStreakStop && currentLossStreak >= rule.lossStreakStop) return 'LOSS_STREAK_STOP';
  if (rule.greenProtectStart !== null && dayPeak >= rule.greenProtectStart && dayUnits <= dayPeak - rule.greenGiveback) return 'GREEN_PROTECTION';
  return '';
}

function simulate(rows, rule) {
  const sorted = [...rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  let totalUnits = 0;
  let taken = 0;
  let skipped = 0;
  let wins = 0;
  let losses = 0;
  let skippedWins = 0;
  let skippedLosses = 0;
  let bank = bankroll;
  let peakBank = bankroll;
  let maxDrawdownPct = 0;
  let worstLosingStreak = 0;
  let currentGlobalLossStreak = 0;
  let currentDate = '';
  let stoppedForDay = false;
  let stopReason = '';
  let dayUnits = 0;
  let dayPeak = 0;
  let dayTaken = 0;
  let dayLossStreak = 0;
  const dayRows = [];
  const ledgerRows = [];

  function closeDay() {
    if (!currentDate) return;
    dayRows.push({
      rule: rule.name,
      event_date: currentDate,
      day_units: Number(dayUnits.toFixed(6)),
      day_peak_units: Number(dayPeak.toFixed(6)),
      taken: dayTaken,
      stopped: String(stoppedForDay),
      stop_reason: stopReason,
    });
  }

  for (const row of sorted) {
    const d = dateKey(row);
    if (d !== currentDate) {
      closeDay();
      currentDate = d;
      stoppedForDay = false;
      stopReason = '';
      dayUnits = 0;
      dayPeak = 0;
      dayTaken = 0;
      dayLossStreak = 0;
    }
    const units = safeNumber(row.group_profit_units);
    const result = units > 0 ? 'WIN' : 'LOSS';
    if (stoppedForDay) {
      skipped += 1;
      if (result === 'WIN') skippedWins += 1;
      else skippedLosses += 1;
      continue;
    }
    taken += 1;
    dayTaken += 1;
    totalUnits += units;
    dayUnits += units;
    dayPeak = Math.max(dayPeak, dayUnits);
    if (result === 'WIN') {
      wins += 1;
      dayLossStreak = 0;
      currentGlobalLossStreak = 0;
    } else {
      losses += 1;
      dayLossStreak += 1;
      currentGlobalLossStreak += 1;
      worstLosingStreak = Math.max(worstLosingStreak, currentGlobalLossStreak);
    }
    const stake = bank * riskPct;
    const profit = stake * units;
    const before = bank;
    bank += profit;
    peakBank = Math.max(peakBank, bank);
    const dd = peakBank > 0 ? (peakBank - bank) / peakBank : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    ledgerRows.push({
      rule: rule.name,
      event_date: d,
      match_name: row.match_name,
      lane_key: row.lane_key,
      result,
      group_profit_units: units,
      day_units_after: Number(dayUnits.toFixed(6)),
      balance_before: Number(before.toFixed(2)),
      stake: Number(stake.toFixed(2)),
      profit_loss: Number(profit.toFixed(2)),
      balance_after: Number(bank.toFixed(2)),
    });

    const reason = shouldStopAfter(rule, dayUnits, dayPeak, dayTaken, dayLossStreak);
    if (reason) {
      stoppedForDay = true;
      stopReason = reason;
    }
  }
  closeDay();

  return {
    summary: {
      rule: rule.name,
      taken_bets: taken,
      skipped_bets: skipped,
      wins,
      losses,
      hit_rate_pct: taken ? Number(((wins / taken) * 100).toFixed(2)) : 0,
      profit_units: Number(totalUnits.toFixed(6)),
      roi_pct: taken ? Number(((totalUnits / taken) * 100).toFixed(2)) : 0,
      skipped_winners: skippedWins,
      skipped_losses: skippedLosses,
      worst_losing_streak: worstLosingStreak,
      max_drawdown_pct: Number((maxDrawdownPct * 100).toFixed(2)),
      starting_bankroll: bankroll,
      final_bankroll: Number(bank.toFixed(2)),
      net_profit: Number((bank - bankroll).toFixed(2)),
      return_pct: Number(((bank / bankroll - 1) * 100).toFixed(2)),
      stopped_days: dayRows.filter((r) => r.stopped === 'true').length,
    },
    dayRows,
    ledgerRows,
  };
}

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`Missing input CSV: ${inputPath}`);
    process.exit(2);
  }
  ensureDir(outDir);
  const raw = parseCsv(fs.readFileSync(inputPath, 'utf8'));
  const rows = raw
    .filter((r) => clean(r.model_bucket || 'MAIN') === 'MAIN')
    .filter((r) => clean(r.result) === 'WIN' || clean(r.result) === 'LOSS')
    .map((r) => ({ ...r, group_profit_units: safeNumber(r.group_profit_units) }))
    .filter((r) => Number.isFinite(r.group_profit_units));

  const sims = rules.map((rule) => simulate(rows, rule));
  const summaries = sims.map((s) => s.summary).sort((a, b) => {
    if (b.profit_units !== a.profit_units) return b.profit_units - a.profit_units;
    return a.max_drawdown_pct - b.max_drawdown_pct;
  });
  const bestByProfit = summaries[0] || null;
  const bestByDrawdownAdjusted = [...summaries].sort((a, b) => {
    const scoreA = a.profit_units - (a.max_drawdown_pct / 10);
    const scoreB = b.profit_units - (b.max_drawdown_pct / 10);
    return scoreB - scoreA;
  })[0] || null;

  writeCsv(path.join(outDir, 'daily_stop_rule_summary.csv'), summaries, ['rule','taken_bets','skipped_bets','wins','losses','hit_rate_pct','profit_units','roi_pct','skipped_winners','skipped_losses','worst_losing_streak','max_drawdown_pct','starting_bankroll','final_bankroll','net_profit','return_pct','stopped_days']);
  writeCsv(path.join(outDir, 'daily_stop_rule_day_log.csv'), sims.flatMap((s) => s.dayRows), ['rule','event_date','day_units','day_peak_units','taken','stopped','stop_reason']);
  writeCsv(path.join(outDir, 'daily_stop_rule_ledger.csv'), sims.flatMap((s) => s.ledgerRows), ['rule','event_date','match_name','lane_key','result','group_profit_units','day_units_after','balance_before','stake','profit_loss','balance_after']);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'daily_stop_rule_simulator',
    input: inputPath,
    source_rows: rows.length,
    bankroll,
    risk_pct: riskPct,
    baseline: summaries.find((s) => s.rule === 'NO_STOP_BASELINE'),
    best_by_profit: bestByProfit,
    best_drawdown_adjusted: bestByDrawdownAdjusted,
    all_rules: summaries,
  };
  writeJson(path.join(outDir, 'daily_stop_rule_summary.json'), summary);

  const top = summaries.slice(0, 10);
  const report = [
    '# Daily Stop Rule Simulator',
    '',
    `Generated: ${summary.generated_at}`,
    `Input rows: ${summary.source_rows}`,
    `Bankroll: ${bankroll}`,
    `Risk per bet: ${(riskPct * 100).toFixed(2)}%`,
    '',
    '## Baseline',
    summary.baseline ? `- ${summary.baseline.rule}: ${summary.baseline.profit_units}u, ROI ${summary.baseline.roi_pct}%, max DD ${summary.baseline.max_drawdown_pct}%, final bankroll ${summary.baseline.final_bankroll}` : '- Missing baseline',
    '',
    '## Best by profit units',
    bestByProfit ? `- ${bestByProfit.rule}: ${bestByProfit.profit_units}u, ROI ${bestByProfit.roi_pct}%, max DD ${bestByProfit.max_drawdown_pct}%, skipped ${bestByProfit.skipped_bets} bets, final bankroll ${bestByProfit.final_bankroll}` : '- Missing',
    '',
    '## Best drawdown-adjusted',
    bestByDrawdownAdjusted ? `- ${bestByDrawdownAdjusted.rule}: ${bestByDrawdownAdjusted.profit_units}u, ROI ${bestByDrawdownAdjusted.roi_pct}%, max DD ${bestByDrawdownAdjusted.max_drawdown_pct}%, skipped ${bestByDrawdownAdjusted.skipped_bets} bets, final bankroll ${bestByDrawdownAdjusted.final_bankroll}` : '- Missing',
    '',
    '## Top rules by profit',
    ...top.map((r) => `- ${r.rule}: ${r.profit_units}u, ROI ${r.roi_pct}%, max DD ${r.max_drawdown_pct}%, taken ${r.taken_bets}, skipped W/L ${r.skipped_winners}/${r.skipped_losses}`),
    '',
    '## Read this correctly',
    '- A stop rule is only useful if it improves drawdown or profit without skipping too many winners.',
    '- Do not choose a rule only because it perfectly fits the past. Prefer simple rules that survive forward testing.',
    '- This is research only until tested live on 100+ new signals.',
  ];
  fs.writeFileSync(path.join(outDir, 'daily_stop_rule_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main();
