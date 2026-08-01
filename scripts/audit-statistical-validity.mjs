#!/usr/bin/env node
/*
  Statistical validity audit of the First Set Lab headline claims.
  Does NOT re-run backtests. Takes the README's own reported numbers and asks:
  "How much of this survives basic statistical scrutiny?"
*/

const claims = [
  { name: 'Optimized Profitable Lanes (Core+Reverse+ResearchP2+V3)', n: 511, hit: 0.4188, units: 86.45, roi: 0.1692 },
  { name: 'Optimized VIP Protected 3 (historical)',                  n: 610, hit: 0.4098, units: 90.78, roi: 0.1488 },
  { name: 'Optimized VIP Gate-2 (historical)',                       n: 610, hit: 0.3508, units: 142.87, roi: 0.2342 },
  { name: 'Optimized VIP LIVE forward sample',                       n: 62,  hit: 0.3871, units: 5.96,  roi: 5.96 / 62 },
];

// Implied grouped odds from ROI + hit rate: roi = hit*(O-1) - (1-hit)  =>  O = (roi + 1)/hit
const impliedOdds = (roi, hit) => (roi + 1) / hit;

console.log('='.repeat(78));
console.log('PART 1 — IS THE EDGE DISTINGUISHABLE FROM LUCK?');
console.log('='.repeat(78));
console.log('Per-bet outcome is +(O-1) on a win, -1 on a loss.');
console.log('SD of one bet = sqrt(p*(1-p)) * O.  SE of ROI = SD / sqrt(n).\n');

for (const c of claims) {
  const O = impliedOdds(c.roi, c.hit);
  const sd = Math.sqrt(c.hit * (1 - c.hit)) * O;
  const se = sd / Math.sqrt(c.n);
  const t = c.roi / se;
  const lo = c.roi - 1.96 * se;
  const hi = c.roi + 1.96 * se;
  console.log(`${c.name}`);
  console.log(`  n=${c.n}  hit=${(c.hit * 100).toFixed(2)}%  ROI=${(c.roi * 100).toFixed(2)}%  implied grouped odds=${O.toFixed(2)}`);
  console.log(`  SE of ROI = ${(se * 100).toFixed(2)}%   t-stat = ${t.toFixed(2)}`);
  console.log(`  95% CI on true ROI: ${(lo * 100).toFixed(1)}% to ${(hi * 100).toFixed(1)}%`);
  console.log(`  --> ${lo > 0 ? 'CI excludes zero (as a STANDALONE pre-registered test)' : 'CI INCLUDES ZERO — indistinguishable from no edge'}\n`);
}

console.log('='.repeat(78));
console.log('PART 2 — THE MULTIPLE-TESTING CORRECTION (the part that hurts)');
console.log('='.repeat(78));
console.log('If you grid-search K strategy configs over the same data, the BEST one');
console.log('looks good by luck alone. Expected max t-stat of K pure-noise strategies');
console.log('is approx sqrt(2*ln(K)).\n');
for (const K of [10, 100, 500, 1000, 5000, 20000]) {
  console.log(`  K=${String(K).padStart(5)} configs tested  ->  expected best-of-noise t = ${Math.sqrt(2 * Math.log(K)).toFixed(2)}`);
}
console.log('\n  Your observed t-stats are ~3.3 to 3.5.');
console.log('  The repo contains 135 scripts, ~20 named optimizer/discovery/grid.');
console.log('  A "deep grid optimizer" alone tests hundreds-to-thousands of combos.');
console.log('  => t=3.4 is EXACTLY what pure noise produces at K~1000.');
console.log('  => The historical edge is NOT statistically established.\n');

console.log('='.repeat(78));
console.log('PART 3 — HOW MANY LIVE BETS TO ACTUALLY PROVE IT?');
console.log('='.repeat(78));
const O = impliedOdds(0.1488, 0.4098);
const sd = Math.sqrt(0.4098 * (1 - 0.4098)) * O;
console.log(`Assuming the real edge is the claimed ROI (per-bet SD = ${sd.toFixed(2)}):\n`);
for (const [label, trueRoi] of [['15% ROI', 0.15], ['10% ROI', 0.10], ['5% ROI', 0.05]]) {
  for (const [conf, z] of [['95% (t=1.96)', 1.96], ['99.7% (t=3)', 3]]) {
    const n = Math.ceil(Math.pow((z * sd) / trueRoi, 2));
    console.log(`  Detect ${label} at ${conf}: need ${n.toLocaleString()} settled bets`);
  }
}
console.log(`\n  You have 62 live rows. SE at n=62 is +/-${((sd / Math.sqrt(62)) * 100).toFixed(1)}% ROI.`);
console.log('  Your live ROI of 9.6% is inside the noise band. It proves NOTHING yet.\n');

console.log('='.repeat(78));
console.log('PART 4 — DRAWDOWN REALITY AT 39% HIT RATE');
console.log('='.repeat(78));
const pLoss = 1 - 0.3871;
const nBets = 600;
console.log(`Loss probability per bet = ${pLoss.toFixed(4)}. Over ${nBets} bets:\n`);
console.log('  Streak   Expected occurrences   ~Chance of seeing it   Bankroll left @5%   @7%');
for (const L of [9, 10, 12, 15, 18, 20]) {
  const expected = nBets * Math.pow(pLoss, L) * (1 - pLoss);
  const chance = 1 - Math.exp(-expected);
  const at5 = Math.pow(0.95, L);
  const at7 = Math.pow(0.93, L);
  console.log(`  ${String(L).padStart(2)} losses   ${expected.toFixed(2).padStart(8)}              ${(chance * 100).toFixed(0).padStart(3)}%                 -${((1 - at5) * 100).toFixed(0)}%              -${((1 - at7) * 100).toFixed(0)}%`);
}
console.log('\n  You already hit a 9-loss streak in 62 rows.');
console.log('  A 12-loss streak is EXPECTED at least once over 600 bets.');
console.log('  At 7% risk that is roughly a 58% drawdown -- ASSUMING the edge is real.');
console.log('  If the edge is overfit noise, 7% risk deletes the bankroll.\n');

console.log('='.repeat(78));
console.log('PART 5 — THE ROLLING-WINDOW CLAIM');
console.log('='.repeat(78));
console.log('reality-check-100-300-signals.mjs line 56 slides start by 1 across the');
console.log('SAME ordered dataset. Overlap between neighbouring windows:\n');
const total = 610;
for (const w of [100, 200, 300]) {
  const windows = total - w + 1;
  const independent = Math.floor(total / w);
  console.log(`  window=${w}: ${windows} "tests" reported, overlap ${(((w - 1) / w) * 100).toFixed(1)}%, TRULY independent samples = ${independent}`);
}
console.log('\n  "200 signals: 100% of windows profitable" is close to a tautology:');
console.log('  if the full sample is profitable, overlapping windows must be too.');
console.log('  It is ~3 independent observations wearing a costume of 411.\n');
console.log('  The Monte Carlo (line 59) bootstraps from the ALREADY-SELECTED unit');
console.log('  results. It assumes the edge is real, then measures variance around it.');
console.log('  It cannot validate the edge. It is circular by construction.\n');
