#!/usr/bin/env node
/*
  Analyse YOUR OWN filtered signals - 11,953 rows from
  artifacts/input/combined-2024-2026-enriched-first-set-scores.csv

  This is the test my 277-match study could not do: it uses YOUR filter,
  YOUR model probabilities, YOUR recorded odds, and the real settled outcomes.

  The most important thing here is CALIBRATION:
  when your model says 20%, does it happen 20% of the time?
  A model can have real signal and still lose money if it is overconfident.
*/
import fs from 'node:fs';

const path = 'artifacts/input/combined-2024-2026-enriched-first-set-scores.csv';
const text = fs.readFileSync(path, 'utf8');

function parseCsv(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1];
    if (q) { if (c === '"' && n === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const h = rows[0];
  return rows.slice(1).filter(r => r.some(x => x !== '')).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const all = parseCsv(text);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (x) => `${(x * 100).toFixed(2)}%`;

// only rows with a resolved real outcome
const rows = all.map(r => ({
  strategy: r.strategy_label || r.strategy_id,
  score: r.score,
  level: r.tournament_level,
  bucket: r.odds_bucket,
  p: num(r.model_probability),
  odds: num(r.bookmaker_odds),
  edge: num(r.edge),
  won: String(r.won).toLowerCase() === 'true',
  actual: r.actual_first_set_score,
  status: String(r.actual_score_status || '').toLowerCase(),
  passed: String(r.setfox_passed_default).toLowerCase() === 'true',
})).filter(r => r.p != null && r.odds != null && r.actual && r.status === 'resolved');

console.log('='.repeat(84));
console.log(`YOUR OWN SIGNALS — ${all.length} total rows, ${rows.length} with resolved outcomes`);
console.log('='.repeat(84));

// ---- 1. odds realism check ----
console.log('\n' + '#'.repeat(84));
console.log('# 1. ARE THE RECORDED ODDS REAL PRICES, OR BUCKET PLACEHOLDERS?');
console.log('#'.repeat(84));
const oddsCounts = new Map();
for (const r of rows) oddsCounts.set(r.odds, (oddsCounts.get(r.odds) || 0) + 1);
const distinct = [...oddsCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\n  Distinct odds values across ${rows.length} rows: ${distinct.length}`);
console.log('  Most common:');
for (const [o, c] of distinct.slice(0, 12)) console.log(`    ${String(o).padStart(8)}  ->  ${c} rows (${pct(c / rows.length)})`);
if (distinct.length < 40) {
  console.log(`\n  *** WARNING: only ${distinct.length} distinct prices for ${rows.length} bets.`);
  console.log('  *** Real market prices vary continuously. These look like BUCKET PLACEHOLDERS,');
  console.log('  *** not prices actually observed at bet time.');
}

// ---- 2. per strategy ----
console.log('\n' + '#'.repeat(84));
console.log('# 2. EVERY STRATEGY, AT ITS OWN RECORDED ODDS');
console.log('#'.repeat(84));
const byStrat = new Map();
for (const r of rows) { if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []); byStrat.get(r.strategy).push(r); }
console.log('\n  strategy                        n      hit      avg model p   avg odds   ROI');
console.log('  ' + '-'.repeat(78));
for (const [s, rs] of [...byStrat.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const hit = rs.filter(r => r.won).length / rs.length;
  const avgP = rs.reduce((a, r) => a + r.p, 0) / rs.length;
  const avgO = rs.reduce((a, r) => a + r.odds, 0) / rs.length;
  const units = rs.reduce((a, r) => a + (r.won ? r.odds - 1 : -1), 0);
  const roi = units / rs.length;
  console.log(`  ${s.slice(0, 28).padEnd(28)} ${String(rs.length).padStart(5)}  ${pct(hit).padStart(7)}  ${pct(avgP).padStart(11)}  ${avgO.toFixed(2).padStart(9)}  ${(roi >= 0 ? '+' : '') + pct(roi)}`);
}

// ---- 3. CALIBRATION ----
console.log('\n' + '#'.repeat(84));
console.log('# 3. CALIBRATION — THE MOST IMPORTANT TEST');
console.log('#'.repeat(84));
console.log('\n  When your model says X%, does it actually happen X% of the time?');
console.log('  Perfect calibration = predicted equals actual in every band.\n');
const bands = [[0, .05], [.05, .10], [.10, .15], [.15, .20], [.20, .25], [.25, .30], [.30, .40], [.40, 1]];
console.log('  model says      n     predicted   actual    gap        verdict');
console.log('  ' + '-'.repeat(74));
let totalPred = 0, totalAct = 0;
for (const [lo, hi] of bands) {
  const b = rows.filter(r => r.p >= lo && r.p < hi);
  if (b.length < 20) continue;
  const pred = b.reduce((a, r) => a + r.p, 0) / b.length;
  const act = b.filter(r => r.won).length / b.length;
  totalPred += pred * b.length; totalAct += act * b.length;
  const gap = act - pred;
  const verdict = Math.abs(gap) < 0.02 ? 'calibrated' : gap < 0 ? 'OVERCONFIDENT' : 'underconfident';
  console.log(`  ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`.padEnd(15) + `${String(b.length).padStart(5)}  ${pct(pred).padStart(9)}  ${pct(act).padStart(8)}  ${(gap >= 0 ? '+' : '') + pct(gap).padStart(7)}   ${verdict}`);
}
console.log('  ' + '-'.repeat(74));
console.log(`  OVERALL         ${String(rows.length).padStart(5)}  ${pct(totalPred / rows.length).padStart(9)}  ${pct(totalAct / rows.length).padStart(8)}  ${((totalAct - totalPred) / rows.length >= 0 ? '+' : '') + pct((totalAct - totalPred) / rows.length)}`);

const ratio = (totalAct / rows.length) / (totalPred / rows.length);
console.log(`\n  Your model predicts ${pct(totalPred / rows.length)} on average.`);
console.log(`  Reality delivered  ${pct(totalAct / rows.length)}.`);
console.log(`  Ratio actual/predicted = ${ratio.toFixed(3)}`);
if (ratio < 0.9) console.log(`  >>> The model is OVERCONFIDENT by ${pct(1 - ratio)} relative. It thinks outcomes are`);
if (ratio < 0.9) console.log(`  >>> more likely than they are. That is exactly how a real signal still loses money.`);
else if (ratio > 1.1) console.log(`  >>> The model is UNDERconfident — it is too pessimistic.`);
else console.log(`  >>> The model is reasonably calibrated.`);

// ---- 4. does the claimed edge predict anything? ----
console.log('\n' + '#'.repeat(84));
console.log('# 4. DOES YOUR "EDGE" COLUMN ACTUALLY PREDICT PROFIT?');
console.log('#'.repeat(84));
console.log('\n  If the edge calculation is real, higher edge should mean higher ROI.\n');
const withEdge = rows.filter(r => r.edge != null).sort((a, b) => a.edge - b.edge);
const qn = 5, size = Math.floor(withEdge.length / qn);
console.log('  edge quintile      n     avg edge    hit      ROI');
console.log('  ' + '-'.repeat(56));
for (let i = 0; i < qn; i++) {
  const b = withEdge.slice(i * size, i === qn - 1 ? withEdge.length : (i + 1) * size);
  if (!b.length) continue;
  const avgE = b.reduce((a, r) => a + r.edge, 0) / b.length;
  const hit = b.filter(r => r.won).length / b.length;
  const roi = b.reduce((a, r) => a + (r.won ? r.odds - 1 : -1), 0) / b.length;
  console.log(`  Q${i + 1} (${i === 0 ? 'lowest' : i === qn - 1 ? 'highest' : '      '})      ${String(b.length).padStart(5)}  ${pct(avgE).padStart(9)}  ${pct(hit).padStart(7)}  ${(roi >= 0 ? '+' : '') + pct(roi)}`);
}
console.log('\n  If ROI does not rise with edge, the edge number is not measuring edge.');
