#!/usr/bin/env node
/*
  OUTSIDE THE BOX: stop testing one market. Test EVERY market api-tennis offers,
  and look for the two things that are real edges rather than fitted noise:

    1. LOW VIG  - which markets have small bookmaker margin after line shopping?
                  (edge must exceed the tax; a 17% tax is unbeatable, a 2% tax is not)
    2. ARBITRAGE - best price across books where total implied prob < 1.00.
                  That is guaranteed profit, no model required, pure math.

  Method: best available price per outcome across ALL bookmakers (line shopping),
  then total implied probability = sum(1/best_price). Below 1.00 = arb.

  Never prints the API key.
*/
import fs from 'node:fs';

const BASE = 'https://api.api-tennis.com/tennis/';
function loadKey() {
  if (fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^(API_TENNIS_KEY|API_TENNIS_API_KEY|APITENNIS_API_KEY)\s*=\s*(.+)$/);
      if (m && m[2].trim()) return m[2].trim();
    }
  }
  return process.env.API_TENNIS_KEY || null;
}
const KEY = loadKey();
if (!KEY) { console.error('No API key.'); process.exit(2); }

async function call(method, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(url); return await r.json(); }
    catch { await new Promise(r => setTimeout(r, 600)); }
  }
  return null;
}

const args = Object.fromEntries(process.argv.slice(2).map(a => a.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const DATES = (args.dates || '2026-07-20,2026-07-13,2026-07-06,2026-06-22,2026-06-15,2026-05-18').split(',');
const LIMIT = Number(args.limit || 180);

// gather finished singles
const pool = [];
for (const d of DATES) {
  const fx = await call('get_fixtures', { date_start: d, date_stop: d });
  for (const f of (Array.isArray(fx?.result) ? fx.result : [])) {
    if (!String(f.event_type_type || '').toLowerCase().includes('singles')) continue;
    if (!String(f.event_status || '').toLowerCase().includes('finished')) continue;
    pool.push(f);
  }
}
process.stderr.write(`pool=${pool.length}\n`);
const sample = pool.slice(0, LIMIT);

const bookNames = new Map();
const marketStats = new Map(); // market -> {overrounds:[], arbs:0, matches:0, outcomeCounts:[], bookCounts:[]}
const arbExamples = [];

for (let i = 0; i < sample.length; i++) {
  const f = sample[i];
  if (i % 25 === 0) process.stderr.write(`  ${i}/${sample.length}\n`);
  const od = await call('get_odds', { match_key: f.event_key });
  const result = od?.result;
  if (!result || typeof result !== 'object') continue;
  const block = result[String(f.event_key)] ?? Object.values(result)[0];
  if (!block || typeof block !== 'object') continue;

  for (const [marketName, market] of Object.entries(block)) {
    if (!market || typeof market !== 'object') continue;
    const best = {}; const booksSeen = new Set();
    for (const [outcome, books] of Object.entries(market)) {
      let prices = [];
      if (books && typeof books === 'object') {
        for (const [bn, bv] of Object.entries(books)) {
          bookNames.set(bn, (bookNames.get(bn) || 0) + 1);
          booksSeen.add(bn);
          const v = Number(bv);
          if (Number.isFinite(v) && v > 1) prices.push(v);
        }
      } else { const v = Number(books); if (Number.isFinite(v) && v > 1) prices = [v]; }
      if (prices.length) best[outcome] = Math.max(...prices);
    }
    const outcomes = Object.keys(best);
    if (outcomes.length < 2) continue;
    const overround = outcomes.reduce((a, o) => a + 1 / best[o], 0);
    if (!Number.isFinite(overround) || overround <= 0) continue;

    if (!marketStats.has(marketName)) marketStats.set(marketName, { overrounds: [], arbs: 0, matches: 0, outcomeCounts: [], bookCounts: [] });
    const st = marketStats.get(marketName);
    st.overrounds.push(overround);
    st.matches += 1;
    st.outcomeCounts.push(outcomes.length);
    st.bookCounts.push(booksSeen.size);
    if (overround < 1.0) {
      st.arbs += 1;
      if (arbExamples.length < 8) arbExamples.push({ match: `${f.event_first_player} vs ${f.event_second_player}`, market: marketName, overround, best });
    }
  }
  await new Promise(r => setTimeout(r, 110));
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (x) => `${(x * 100).toFixed(2)}%`;

console.log('\n' + '='.repeat(96));
console.log('BOOKMAKERS AVAILABLE ON YOUR KEY');
console.log('='.repeat(96));
[...bookNames.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${String(c).padStart(6)} quotes   ${n}`));

console.log('\n' + '='.repeat(96));
console.log('MARKET EFFICIENCY — best price across ALL books (full line shopping)');
console.log('='.repeat(96));
console.log('  Overround 1.00 = zero margin. Below 1.00 = ARBITRAGE (guaranteed profit).');
console.log('  Your edge must be BIGGER than the margin, so low margin = where edges can live.\n');
console.log('  Market                              n    outcomes  books  median vig   best case   ARBS');
console.log('  ' + '-'.repeat(92));

const sorted = [...marketStats.entries()].filter(([, s]) => s.matches >= 10).sort((a, b) => med(a[1].overrounds) - med(b[1].overrounds));
for (const [name, s] of sorted) {
  const mv = med(s.overrounds) - 1;
  const bestCase = Math.min(...s.overrounds) - 1;
  console.log(
    `  ${name.slice(0, 34).padEnd(34)} ${String(s.matches).padStart(4)}   ` +
    `${med(s.outcomeCounts).toFixed(0).padStart(6)}   ${med(s.bookCounts).toFixed(0).padStart(4)}   ` +
    `${pct(mv).padStart(9)}   ${pct(bestCase).padStart(9)}   ${String(s.arbs).padStart(4)}`
  );
}

console.log('\n' + '='.repeat(96));
console.log('ARBITRAGE FOUND?');
console.log('='.repeat(96));
const totalArbs = [...marketStats.values()].reduce((a, s) => a + s.arbs, 0);
const totalObs = [...marketStats.values()].reduce((a, s) => a + s.matches, 0);
console.log(`  ${totalArbs} arbitrage opportunities out of ${totalObs} market observations (${pct(totalArbs / Math.max(1, totalObs))})`);
if (arbExamples.length) {
  for (const a of arbExamples) {
    console.log(`\n  ${a.match}`);
    console.log(`    market: ${a.market}   total implied prob: ${a.overround.toFixed(4)}  => guaranteed ${pct(1 / a.overround - 1)} return`);
    for (const [o, p] of Object.entries(a.best).slice(0, 6)) console.log(`      ${o}: ${p}`);
  }
} else {
  console.log('  None. After line shopping every market still carries positive margin.');
}

console.log('\n' + '='.repeat(96));
console.log('THE LOWEST-VIG MARKETS (where a real edge could actually survive)');
console.log('='.repeat(96));
for (const [name, s] of sorted.slice(0, 6)) {
  const mv = med(s.overrounds) - 1;
  console.log(`  ${name.padEnd(36)} median vig ${pct(mv).padStart(8)}  -> you must beat the market by >${pct(mv)}`);
}
console.log('\n  Compare: first-set correct score, the market you were betting, was ~17%.');
