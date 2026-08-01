#!/usr/bin/env node
/*
  Five-minute feasibility probe.
  Question: does api-tennis return first-set Correct Score odds for the
  3-6 / 4-6 / 5-7 legs, on the SAME fixture, at the SAME time?
  If not, the "Player 2 & 9-12" dutch is not reconstructable and everything
  downstream is fiction.

  Never prints the API key.
*/
import fs from 'node:fs';

const BASE = 'https://api.api-tennis.com/tennis/';

function loadKey() {
  for (const f of ['.env']) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^(API_TENNIS_KEY|API_TENNIS_API_KEY|APITENNIS_API_KEY)\s*=\s*(.+)$/);
      if (m && m[2].trim()) return m[2].trim();
    }
  }
  return process.env.API_TENNIS_KEY || null;
}
const KEY = loadKey();
if (!KEY) { console.error('No API key found.'); process.exit(2); }
const mask = (s) => String(s).replaceAll(KEY, `***${KEY.slice(-4)}`);

async function call(method, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const safeUrl = mask(url.toString());
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json, raw: text.slice(0, 400), safeUrl };
}

const args = Object.fromEntries(process.argv.slice(2).map(a => a.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const dateStart = args.date_start || '2026-07-20';
const dateStop = args.date_stop || '2026-07-22';

console.log('='.repeat(74));
console.log('STEP 1 - Does the key work?');
console.log('='.repeat(74));
const events = await call('get_events');
console.log(`HTTP ${events.status}  success=${events.json?.success}`);
if (events.json?.result) {
  console.log(`Event types available: ${events.json.result.map(r => `${r.event_type_key}:${r.event_type_type}`).join(', ')}`);
} else {
  console.log(`Body: ${mask(events.raw)}`);
  process.exit(1);
}

console.log('\n' + '='.repeat(74));
console.log(`STEP 2 - Fixtures ${dateStart} to ${dateStop}`);
console.log('='.repeat(74));
const fx = await call('get_fixtures', { date_start: dateStart, date_stop: dateStop });
const fixtures = Array.isArray(fx.json?.result) ? fx.json.result : [];
console.log(`HTTP ${fx.status}  fixtures returned: ${fixtures.length}`);
if (!fixtures.length) { console.log(`Body: ${mask(fx.raw)}`); process.exit(1); }

const finished = fixtures.filter(f => String(f.event_status || '').toLowerCase().includes('finished'));
console.log(`Finished fixtures: ${finished.length}`);
const singles = finished.filter(f => String(f.event_type_type || '').toLowerCase().includes('singles'));
console.log(`Finished singles:  ${singles.length}`);
if (singles[0]) {
  const s = singles[0];
  console.log(`\nSample: ${s.event_first_player} vs ${s.event_second_player}`);
  console.log(`  key=${s.event_key}  tournament=${s.tournament_name}  final=${s.event_final_result}`);
  console.log(`  set scores: ${JSON.stringify(s.scores?.slice(0, 2) ?? null)}`);
}

console.log('\n' + '='.repeat(74));
console.log('STEP 3 - THE REAL QUESTION: what odds markets come back?');
console.log('='.repeat(74));

const targets = ['3-6', '4-6', '5-7'];
let probed = 0, withCS = 0, withAll3 = 0;
const marketNames = new Map();
const examples = [];

for (const f of singles.slice(0, 12)) {
  const od = await call('get_odds', { match_key: f.event_key });
  probed += 1;
  const result = od.json?.result;
  if (!result || typeof result !== 'object') continue;
  const block = result[String(f.event_key)] ?? Object.values(result)[0];
  if (!block || typeof block !== 'object') continue;

  for (const name of Object.keys(block)) marketNames.set(name, (marketNames.get(name) || 0) + 1);

  // find any market that looks like a first-set / 1st-half correct score
  const csKeys = Object.keys(block).filter(n => /correct score/i.test(n) && /(1st|first|half|set)/i.test(n));
  if (!csKeys.length) continue;
  withCS += 1;

  for (const csKey of csKeys) {
    const market = block[csKey];
    if (!market || typeof market !== 'object') continue;
    const outcomes = Object.keys(market);
    const found = {};
    for (const t of targets) {
      const hit = outcomes.find(o => o.replace(/\s/g, '').replace(':', '-') === t);
      if (hit) {
        const books = market[hit];
        const price = typeof books === 'object' ? Object.values(books)[0] : books;
        found[t] = { outcome: hit, price, bookCount: typeof books === 'object' ? Object.keys(books).length : 1 };
      }
    }
    const n = Object.keys(found).length;
    if (n === 3) withAll3 += 1;
    if (examples.length < 3) {
      examples.push({ match: `${f.event_first_player} vs ${f.event_second_player}`, market: csKey, outcomesSample: outcomes.slice(0, 12), found, legsFound: n });
    }
  }
  await new Promise(r => setTimeout(r, 250));
}

console.log(`Fixtures probed for odds: ${probed}`);
console.log(`With a first-set correct-score market: ${withCS}`);
console.log(`With ALL THREE legs (3-6, 4-6, 5-7):  ${withAll3}\n`);

console.log('--- All market names seen (count = fixtures offering it) ---');
[...marketNames.entries()].sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}x  ${n}`));

console.log('\n--- Examples ---');
for (const ex of examples) {
  console.log(`\n${ex.match}`);
  console.log(`  market: ${ex.market}`);
  console.log(`  outcomes: ${ex.outcomesSample.join(' | ')}`);
  console.log(`  target legs found: ${ex.legsFound}/3`);
  for (const [leg, info] of Object.entries(ex.found)) {
    console.log(`    ${leg} -> "${info.outcome}" @ ${info.price} (${info.bookCount} book(s))`);
  }
  const prices = Object.values(ex.found).map(f => Number(f.price)).filter(Number.isFinite);
  if (prices.length === 3) {
    const dutch = 1 / prices.reduce((a, p) => a + 1 / p, 0);
    console.log(`    >>> DUTCHED GROUPED PRICE = ${dutch.toFixed(3)}  (break-even needed: 2.969)`);
  }
}

console.log('\n' + '='.repeat(74));
console.log('VERDICT');
console.log('='.repeat(74));
if (withAll3 > 0) console.log(`RECONSTRUCTABLE. ${withAll3}/${probed} fixtures had all 3 legs. Full backfill is viable.`);
else if (withCS > 0) console.log(`PARTIAL. First-set correct-score exists but not all 3 legs together. Dutch is unreliable.`);
else console.log(`NOT AVAILABLE on this plan/endpoint. The grouped price cannot be reconstructed from api-tennis odds.`);
