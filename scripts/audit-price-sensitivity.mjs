#!/usr/bin/env node
/*
  The Player 2 & 9-12 strategy, tested against the ONE variable that decides it: PRICE.
  Source numbers: docs/SLIPIQ_RECENT_MEMORY_2026-05-11.md section 2 (the 13-month API-Tennis run).
*/

const BETS = 2690, WINS = 906, LOSSES = 1784;
const HIT = WINS / BETS;
const BANKROLL = 5000, RISK = 0.02;

console.log('='.repeat(76));
console.log('THE 13-MONTH RUN: 2,690 bets, 906 wins, 33.68% hit rate');
console.log('='.repeat(76));
console.log(`Real grouped "Player 2 & 9-12" odds rows in that dataset: 0\n`);

const breakEven = 1 / HIT;
console.log(`Break-even odds = 1 / ${HIT.toFixed(4)} = ${breakEven.toFixed(3)}\n`);

console.log('EV per bet, and $5,000 compounded at 2% risk over 2,690 bets:\n');
console.log('  Odds   EV/bet     Final bankroll        Verdict');
console.log('  ' + '-'.repeat(64));
for (const O of [2.60, 2.80, 2.90, 2.97, 3.00, 3.10, 3.30, 3.50, 3.60]) {
  const ev = HIT * O - 1;
  const winMult = 1 + RISK * (O - 1);
  const lossMult = 1 - RISK;
  const logFinal = Math.log(BANKROLL) + WINS * Math.log(winMult) + LOSSES * Math.log(lossMult);
  const final = Math.exp(logFinal);
  const fmt = final > 1e6 ? `$${(final / 1e6).toFixed(2)}M` : final > 1000 ? `$${Math.round(final).toLocaleString()}` : `$${final.toFixed(2)}`;
  const verdict = ev < -0.02 ? 'LOSES MONEY' : ev < 0.015 ? 'coin flip / dead' : ev < 0.08 ? 'thin' : 'strong';
  console.log(`  ${O.toFixed(2)}   ${(ev * 100 >= 0 ? '+' : '')}${(ev * 100).toFixed(1)}%`.padEnd(19) + fmt.padEnd(22) + verdict);
}

console.log('\n' + '='.repeat(76));
console.log('HOW SURE ARE WE OF THE 33.68% HIT RATE?');
console.log('='.repeat(76));
const seP = Math.sqrt(HIT * (1 - HIT) / BETS);
const loP = HIT - 1.96 * seP, hiP = HIT + 1.96 * seP;
console.log(`n=2,690 is a GOOD sample. SE on hit rate = ${(seP * 100).toFixed(2)}%`);
console.log(`95% CI on hit rate:      ${(loP * 100).toFixed(2)}%  to  ${(hiP * 100).toFixed(2)}%`);
console.log(`95% CI on break-even:    ${(1 / hiP).toFixed(3)}  to  ${(1 / loP).toFixed(3)}`);
console.log(`\n  --> Your model is probably FINE. The hit rate is well measured.`);
console.log(`  --> But break-even sits at ~${breakEven.toFixed(2)}, and could be as high as ${(1 / loP).toFixed(2)}.`);
console.log(`  --> Which means: the price you actually get decides EVERYTHING.\n`);

console.log('='.repeat(76));
console.log('THE WHOLE BUSINESS IN ONE LINE');
console.log('='.repeat(76));
const at280 = HIT * 2.80 - 1, at350 = HIT * 3.50 - 1;
console.log(`  At 2.80 you lose ${Math.abs(at280 * 100).toFixed(1)}% per bet.`);
console.log(`  At 3.50 you make ${(at350 * 100).toFixed(1)}% per bet.`);
console.log(`  That is a ${(((3.50 - 2.80) / 2.80) * 100).toFixed(0)}% price difference between ruin and riches.`);
console.log(`  You have ZERO real observations of that price.\n`);

console.log('='.repeat(76));
console.log('HOW MANY REAL PRICE OBSERVATIONS TO SETTLE IT?');
console.log('='.repeat(76));
console.log('This is a question about the MEAN of available prices, not about win/loss.');
console.log('Prices cluster tightly, so this needs a SMALL sample:\n');
for (const sd of [0.30, 0.50]) {
  for (const moe of [0.15, 0.10]) {
    const n = Math.ceil(Math.pow((1.96 * sd) / moe, 2));
    console.log(`  If price SD ~${sd.toFixed(2)}, to know the mean within +/-${moe.toFixed(2)}: ${n} logged signals`);
  }
}
console.log('\n  --> 30 to 100 logged signals answers the only open question.');
console.log('  --> At 1-2 signals/day that is 3 to 7 WEEKS. Zero dollars risked.\n');
