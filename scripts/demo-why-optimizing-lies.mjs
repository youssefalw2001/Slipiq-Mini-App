#!/usr/bin/env node
/*
  DEMONSTRATION: "just optimize harder until you find a profitable filter"

  Setup:
    - 277 REAL matches, REAL api-tennis prices, REAL first-set outcomes
    - The true edge of this market is measured at -18% (the bookmaker margin)
    - I attach 8 features to every match that are PURE RANDOM NUMBERS.
      They contain zero information. They are not tennis data. They are noise.
    - Then I grid-search filter combinations on that noise to maximise ROI,
      exactly the way an optimizer script does.

  If searching can turn pure noise into a "profitable strategy", then finding
  a profitable strategy is not evidence that an edge exists.
*/
import fs from 'node:fs';

const text = fs.readFileSync('artifacts/output/real_grouped_price_study.csv', 'utf8');
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
const base = lines.slice(1).map(l => {
  const v = parseLine(l);
  const o = Object.fromEntries(headers.map((h, i) => [h, v[i]]));
  return { dutch: Number(o.dutch), won: o.won === 'true' };
}).filter(r => Number.isFinite(r.dutch));

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const FEATURES = ['noise_a', 'noise_b', 'noise_c', 'noise_d', 'noise_e', 'noise_f', 'noise_g', 'noise_h'];
const THRESHOLDS = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
const MIN_BETS = 30;

function roiOf(rows) {
  if (!rows.length) return { n: 0, roi: -Infinity, hit: 0, units: 0 };
  const units = rows.reduce((a, r) => a + (r.won ? r.dutch - 1 : -1), 0);
  const wins = rows.filter(r => r.won).length;
  return { n: rows.length, roi: units / rows.length, hit: wins / rows.length, units };
}

function runSearch(seed) {
  const rand = mulberry32(seed);
  const rows = base.map(r => {
    const o = { ...r };
    for (const f of FEATURES) o[f] = rand();
    return o;
  });

  let best = null, tested = 0;
  // single-feature filters
  for (const f of FEATURES) {
    for (const t of THRESHOLDS) {
      for (const dir of ['>', '<']) {
        tested++;
        const sub = rows.filter(r => dir === '>' ? r[f] > t : r[f] < t);
        const m = roiOf(sub);
        if (m.n >= MIN_BETS && (!best || m.roi > best.roi)) best = { ...m, rule: `${f} ${dir} ${t}` };
      }
    }
  }
  // two-feature combos
  for (let i = 0; i < FEATURES.length; i++) {
    for (let j = i + 1; j < FEATURES.length; j++) {
      for (const t1 of THRESHOLDS) {
        for (const t2 of THRESHOLDS) {
          for (const d1 of ['>', '<']) {
            for (const d2 of ['>', '<']) {
              tested++;
              const f1 = FEATURES[i], f2 = FEATURES[j];
              const sub = rows.filter(r =>
                (d1 === '>' ? r[f1] > t1 : r[f1] < t1) &&
                (d2 === '>' ? r[f2] > t2 : r[f2] < t2));
              const m = roiOf(sub);
              if (m.n >= MIN_BETS && (!best || m.roi > best.roi)) best = { ...m, rule: `${f1} ${d1} ${t1}  AND  ${f2} ${d2} ${t2}` };
            }
          }
        }
      }
    }
  }
  return { best, tested };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

console.log('='.repeat(78));
console.log('THE BASELINE (what the market actually pays)');
console.log('='.repeat(78));
const all = roiOf(base);
console.log(`  All ${all.n} real matches, no filter:`);
console.log(`  hit rate ${pct(all.hit)}   profit ${all.units.toFixed(2)}u   ROI ${pct(all.roi)}`);
console.log(`  This is the truth. There is no edge in this market.\n`);

console.log('='.repeat(78));
console.log('NOW I OPTIMIZE. On features that are literally random numbers.');
console.log('='.repeat(78));
const first = runSearch(20260730);
console.log(`  Filter combinations tested: ${first.tested.toLocaleString()}`);
console.log(`\n  *** BEST "STRATEGY" FOUND ***`);
console.log(`  Rule:      ${first.best.rule}`);
console.log(`  Bets:      ${first.best.n}`);
console.log(`  Hit rate:  ${pct(first.best.hit)}`);
console.log(`  Profit:    +${first.best.units.toFixed(2)} units`);
console.log(`  ROI:       ${pct(first.best.roi)}`);
console.log(`\n  Looks like a monster, right? Beautiful ROI. Decent sample.`);
console.log(`  Those features are RANDOM NUMBERS. They know nothing about tennis.`);
console.log(`  The real edge of every one of those bets is ${pct(all.roi)}.\n`);

console.log('='.repeat(78));
console.log('AND IT IS NOT A FLUKE — 20 INDEPENDENT SEARCHES ON FRESH NOISE');
console.log('='.repeat(78));
const rois = [];
for (let s = 1; s <= 20; s++) {
  const { best } = runSearch(s * 7919);
  rois.push(best.roi);
  console.log(`  search ${String(s).padStart(2)}: best ROI found = ${(best.roi >= 0 ? '+' : '') + pct(best.roi)}   (n=${best.n}, hit ${pct(best.hit)})`);
}
const avg = rois.reduce((a, b) => a + b, 0) / rois.length;
console.log(`\n  Average "best ROI" discovered from pure noise: ${(avg >= 0 ? '+' : '') + pct(avg)}`);
console.log(`  Searches that found a "profitable strategy": ${rois.filter(r => r > 0).length}/20`);

console.log('\n' + '='.repeat(78));
console.log('THE POINT');
console.log('='.repeat(78));
console.log(`  A market that truly pays ${pct(all.roi)} produced "strategies" averaging ${(avg >= 0 ? '+' : '') + pct(avg)}`);
console.log('  every single time I looked hard enough, using data with NO information.');
console.log('');
console.log('  Searching does not FIND edges. Searching MANUFACTURES them.');
console.log('  The harder I optimize, the better the fake result gets.');
console.log('');
console.log('  This is why "test more, optimize more" cannot rescue the strategy.');
console.log('  More searching produces more convincing illusions, not more truth.');
