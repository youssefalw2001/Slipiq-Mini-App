#!/usr/bin/env node
/*
  THE STUDY: what grouped price for "Player 2 & 9-12" (first set 3-6 / 4-6 / 5-7)
  was ACTUALLY available, using real api-tennis Correct Score 1st Half odds?

  Methodology chosen to be MAXIMALLY GENEROUS to the strategy:
    - best (highest) price per leg across ALL bookmakers = full line shopping
    - dutch across books allowed (you can bet each leg wherever it's cheapest)
  If it fails under these assumptions, it fails under any assumption.

  Also measures:
    - real base rate of the 9-12 group (did the first set actually land there?)
    - bookmaker overround on the first-set correct-score market
    - market-implied probability vs actual outcome frequency

  Never prints the API key.
*/
import fs from 'node:fs';

const BASE = 'https://api.api-tennis.com/tennis/';
const TARGETS = ['3:6', '4:6', '5:7'];
const BREAK_EVEN = 2.969;

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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      return json;
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return null;
}

const args = Object.fromEntries(process.argv.slice(2).map(a => a.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const DATES = (args.dates || '2026-07-06,2026-07-13,2026-07-20,2026-06-15,2026-06-22,2026-05-18,2026-04-20,2026-03-16').split(',');
const LIMIT = Number(args.limit || 400);
const norm = (s) => String(s ?? '').trim().replace(/\s/g, '').replace('-', ':');

function firstSetOf(fixture) {
  const s = Array.isArray(fixture.scores) ? fixture.scores.find(x => String(x.score_set) === '1') : null;
  if (!s) return null;
  const a = Math.trunc(Number(s.score_first));
  const b = Math.trunc(Number(s.score_second));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `${a}:${b}`;
}

// ---------- gather fixtures ----------
const pool = [];
for (const d of DATES) {
  const fx = await call('get_fixtures', { date_start: d, date_stop: d });
  const arr = Array.isArray(fx?.result) ? fx.result : [];
  for (const f of arr) {
    const type = String(f.event_type_type || '').toLowerCase();
    if (!type.includes('singles')) continue;
    if (!String(f.event_status || '').toLowerCase().includes('finished')) continue;
    const fs1 = firstSetOf(f);
    if (!fs1) continue;
    pool.push({ ...f, _firstSet: fs1, _date: d });
  }
  process.stderr.write(`  ${d}: pool=${pool.length}\n`);
}
process.stderr.write(`Total finished singles with a first-set score: ${pool.length}\n`);

// spread the sample across dates
const sample = [];
const byDate = new Map();
for (const f of pool) { if (!byDate.has(f._date)) byDate.set(f._date, []); byDate.get(f._date).push(f); }
let idx = 0;
while (sample.length < LIMIT) {
  let added = false;
  for (const [, arr] of byDate) { if (arr[idx]) { sample.push(arr[idx]); added = true; if (sample.length >= LIMIT) break; } }
  if (!added) break;
  idx += 1;
}
process.stderr.write(`Sampling ${sample.length} fixtures for odds...\n`);

// ---------- pull odds ----------
const rows = [];
let noMarket = 0, partialLegs = 0;
for (let i = 0; i < sample.length; i++) {
  const f = sample[i];
  if (i % 25 === 0) process.stderr.write(`  odds ${i}/${sample.length}\n`);
  const od = await call('get_odds', { match_key: f.event_key });
  const result = od?.result;
  if (!result || typeof result !== 'object') { noMarket++; continue; }
  const block = result[String(f.event_key)] ?? Object.values(result)[0];
  if (!block || typeof block !== 'object') { noMarket++; continue; }
  const csKey = Object.keys(block).find(n => /correct score 1st half/i.test(n));
  if (!csKey) { noMarket++; continue; }
  const market = block[csKey];
  if (!market || typeof market !== 'object') { noMarket++; continue; }

  // best price per outcome across all books
  const best = {};
  for (const [outcome, books] of Object.entries(market)) {
    const prices = (typeof books === 'object' && books !== null ? Object.values(books) : [books])
      .map(Number).filter(v => Number.isFinite(v) && v > 1);
    if (prices.length) best[norm(outcome)] = Math.max(...prices);
  }

  const legs = TARGETS.map(t => best[t]).filter(v => Number.isFinite(v));
  if (legs.length < 3) { partialLegs++; continue; }

  const dutch = 1 / legs.reduce((a, p) => a + 1 / p, 0);
  const overround = Object.values(best).reduce((a, p) => a + 1 / p, 0);
  const won = TARGETS.includes(f._firstSet);

  rows.push({
    date: f._date,
    match: `${f.event_first_player} vs ${f.event_second_player}`,
    tournament: f.tournament_name,
    firstSet: f._firstSet,
    leg36: best['3:6'], leg46: best['4:6'], leg57: best['5:7'],
    dutch, overround, outcomes: Object.keys(best).length, won,
  });
  await new Promise(r => setTimeout(r, 120));
}

// ---------- report ----------
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const q = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))] : NaN;
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

console.log('\n' + '='.repeat(78));
console.log('REAL GROUPED PRICE STUDY — "Player 2 & 9-12" (first set 3-6 / 4-6 / 5-7)');
console.log('='.repeat(78));
console.log(`Fixtures with usable 3-leg pricing: ${rows.length}`);
console.log(`Skipped - no 1st-half CS market:    ${noMarket}`);
console.log(`Skipped - fewer than 3 legs:        ${partialLegs}`);
if (!rows.length) { console.log('No usable rows.'); process.exit(1); }

const dutches = rows.map(r => r.dutch);
console.log('\n--- ACHIEVABLE GROUPED PRICE (best book per leg) ---');
console.log(`  mean   ${mean(dutches).toFixed(3)}`);
console.log(`  median ${q(dutches, .5).toFixed(3)}`);
console.log(`  p10    ${q(dutches, .1).toFixed(3)}    p90 ${q(dutches, .9).toFixed(3)}`);
console.log(`  min    ${Math.min(...dutches).toFixed(3)}    max ${Math.max(...dutches).toFixed(3)}`);

const above = (t) => rows.filter(r => r.dutch >= t).length / rows.length;
console.log('\n--- HOW OFTEN DOES THE PRICE CLEAR THE BAR? ---');
console.log(`  >= 2.969 (break-even at 33.68% hit): ${pct(above(BREAK_EVEN))}`);
console.log(`  >= 3.30  (the "strong" case):         ${pct(above(3.30))}`);
console.log(`  >= 3.50  (the $17.5M assumption):     ${pct(above(3.50))}`);

console.log('\n--- BOOKMAKER MARGIN ON THIS MARKET ---');
const ors = rows.map(r => r.overround);
console.log(`  mean total implied probability: ${mean(ors).toFixed(4)}  (1.00 = zero margin)`);
console.log(`  => average overround: ${pct(mean(ors) - 1)}`);
console.log(`  median outcomes priced: ${q(rows.map(r => r.outcomes), .5)}`);

console.log('\n--- ACTUAL BASE RATE vs MARKET PRICE (all sampled matches) ---');
const winRate = rows.filter(r => r.won).length / rows.length;
const impliedRaw = mean(dutches.map(d => 1 / d));
console.log(`  first set actually landed 3-6/4-6/5-7: ${pct(winRate)}  (${rows.filter(r => r.won).length}/${rows.length})`);
console.log(`  market implied (margin-loaded):        ${pct(impliedRaw)}`);
console.log(`  market implied (margin removed):       ${pct(impliedRaw / mean(ors))}`);

console.log('\n--- WHAT YOUR 33.68% MODEL EARNS AT THESE REAL PRICES ---');
for (const [label, price] of [['mean', mean(dutches)], ['median', q(dutches, .5)], ['p90 (best 10%)', q(dutches, .9)], ['max', Math.max(...dutches)]]) {
  const ev = 0.3368 * price - 1;
  console.log(`  at ${label} price ${price.toFixed(3)}: EV/bet = ${ev >= 0 ? '+' : ''}${pct(ev)}  ${ev > 0 ? '<-- PROFITABLE' : ''}`);
}

fs.mkdirSync('artifacts/output', { recursive: true });
const headers = ['date', 'match', 'tournament', 'firstSet', 'leg36', 'leg46', 'leg57', 'dutch', 'overround', 'outcomes', 'won'];
fs.writeFileSync('artifacts/output/real_grouped_price_study.csv',
  [headers.join(','), ...rows.map(r => headers.map(h => {
    const v = r[h]; const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(','))].join('\n') + '\n');
console.log('\nWrote artifacts/output/real_grouped_price_study.csv');
