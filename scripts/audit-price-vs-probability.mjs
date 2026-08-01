#!/usr/bin/env node
/*
  THE DECISIVE TEST.

  The whole "Player 2 & 9-12" plan assumes: hit rate 33.68%, price ~3.50.
  That assumes hit rate and price are INDEPENDENT.

  In any efficient market they are inversely linked: the price is long precisely
  because the outcome is unlikely. This script measures that link directly using
  real api-tennis prices and real first-set outcomes.

  If hit rate falls as price rises, "filter for longer prices" cannot create edge.
*/
import fs from 'node:fs';

const path = 'artifacts/output/real_grouped_price_study.csv';
const text = fs.readFileSync(path, 'utf8');
const lines = text.trim().split('\n');
const headers = lines[0].split(',');

function parseLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
const rows = lines.slice(1).map(l => {
  const v = parseLine(l);
  return Object.fromEntries(headers.map((h, i) => [h, v[i]]));
}).map(r => ({ dutch: Number(r.dutch), won: r.won === 'true', overround: Number(r.overround) }))
  .filter(r => Number.isFinite(r.dutch));

const pct = (x) => `${(x * 100).toFixed(2)}%`;

console.log('='.repeat(80));
console.log('IS THE FIRST-SET CORRECT-SCORE MARKET EFFICIENT?');
console.log(`Sample: ${rows.length} real matches with real prices and real outcomes`);
console.log('='.repeat(80));

const buckets = [
  ['2.10 - 2.50', 2.10, 2.50],
  ['2.50 - 3.00', 2.50, 3.00],
  ['3.00 - 3.50', 3.00, 3.50],
  ['3.50 - 4.50', 3.50, 4.50],
  ['4.50 - 6.00', 4.50, 6.00],
  ['6.00 +    ', 6.00, 999],
];

console.log('\nIf the market is efficient, hit rate should FALL as price RISES,');
console.log('and EV should sit near -(overround) in every single bucket.\n');
console.log('  Price bucket    n     avg price   actual hit   implied hit   EV/bet');
console.log('  ' + '-'.repeat(72));

let totalEv = 0, totalN = 0;
for (const [label, lo, hi] of buckets) {
  const b = rows.filter(r => r.dutch >= lo && r.dutch < hi);
  if (b.length < 5) { console.log(`  ${label}   ${String(b.length).padStart(3)}   (too few to read)`); continue; }
  const avgPrice = b.reduce((a, r) => a + r.dutch, 0) / b.length;
  const hit = b.filter(r => r.won).length / b.length;
  const implied = 1 / avgPrice;
  const ev = hit * avgPrice - 1;
  totalEv += ev * b.length; totalN += b.length;
  console.log(`  ${label}   ${String(b.length).padStart(3)}   ${avgPrice.toFixed(3).padStart(9)}   ${pct(hit).padStart(10)}   ${pct(implied).padStart(11)}   ${(ev >= 0 ? '+' : '') + pct(ev)}`);
}

console.log('\n' + '='.repeat(80));
console.log('THE CORRELATION');
console.log('='.repeat(80));
const n = rows.length;
const xs = rows.map(r => r.dutch), ys = rows.map(r => r.won ? 1 : 0);
const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
const cov = xs.map((x, i) => (x - mx) * (ys[i] - my)).reduce((a, b) => a + b, 0) / n;
const sx = Math.sqrt(xs.map(x => (x - mx) ** 2).reduce((a, b) => a + b, 0) / n);
const sy = Math.sqrt(ys.map(y => (y - my) ** 2).reduce((a, b) => a + b, 0) / n);
const r = cov / (sx * sy);
console.log(`  Correlation between price and winning: ${r.toFixed(4)}`);
console.log(`  ${r < -0.1 ? 'NEGATIVE — longer price genuinely means less likely. Market is doing its job.' : 'weak/none'}`);

console.log('\n' + '='.repeat(80));
console.log('WHAT A FLAT BET ON EVERY MATCH WOULD HAVE RETURNED');
console.log('='.repeat(80));
const flatProfit = rows.reduce((a, x) => a + (x.won ? x.dutch - 1 : -1), 0);
console.log(`  ${rows.length} bets, best price per leg, no filtering:`);
console.log(`  profit = ${flatProfit.toFixed(2)} units   ROI = ${pct(flatProfit / rows.length)}`);
console.log(`  average overround = ${pct(rows.reduce((a, x) => a + x.overround, 0) / rows.length - 1)}`);
console.log(`  weighted EV across buckets = ${pct(totalEv / totalN)}`);

console.log('\n' + '='.repeat(80));
console.log('THE HURDLE YOUR MODEL HAS TO CLEAR');
console.log('='.repeat(80));
console.log('  To profit you need your hit rate to beat 1/price in the bucket you');
console.log('  actually bet in — not to beat a price you assumed.\n');
for (const [label, lo, hi] of buckets) {
  const b = rows.filter(r => r.dutch >= lo && r.dutch < hi);
  if (b.length < 5) continue;
  const avgPrice = b.reduce((a, x) => a + x.dutch, 0) / b.length;
  const needed = 1 / avgPrice;
  const actual = b.filter(x => x.won).length / b.length;
  console.log(`  At ${label} (avg ${avgPrice.toFixed(2)}): need > ${pct(needed)} to break even. Market delivers ${pct(actual)}. Gap to close: ${pct(needed - actual)}`);
}
