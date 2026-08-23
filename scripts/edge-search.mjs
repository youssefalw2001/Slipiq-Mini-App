#!/usr/bin/env node
/*
  HONEST EDGE SEARCH
  ==================
  Not a grid search. Four pre-specified hypotheses, each grounded in a known
  market phenomenon, each tested ONCE on a time-based holdout.

  Rule for this script: the hypotheses below are fixed. I do not add a fifth
  after seeing results, and I do not tune thresholds inside a hypothesis.

  H1  LINE SHOPPING / ARBITRAGE. Best price across all books per outcome. If total
      implied probability < 1.00 the bet is risk-free. Pure math, no model.
  H2  VIG MAP. Median bookmaker margin per market, at best price. An edge must
      exceed the margin, so this tells us which markets are even winnable.
  H3  FAVOURITE-LONGSHOT BIAS in first-set correct score, with tiebreaks CORRECTLY
      counted (the repo's parser dropped them). Bet the shortest-priced exact score.
  H4  BEST-PRICE vs SINGLE-BOOK. Does line shopping across 7 books flip any price
      segment from negative to positive?

  Method: chronological split. Train = first 70% of dates, Holdout = last 30%.
  Anything discovered on train is stated, then tested once on holdout.

  Never prints the API key.
*/
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
function loadKey() {
  for (const f of ['.env', '.env.local']) if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*(API_TENNIS_KEY|API_TENNIS_API_KEY|APITENNIS_API_KEY)\s*=\s*(.+)\s*$/);
      if (m && m[2].trim()) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return process.env.API_TENNIS_KEY || null;
}
const KEY = loadKey();
if (!KEY) { console.error('No API-Tennis key.'); process.exit(2); }

const BASE = 'https://api.api-tennis.com/tennis/';
const CS = 'Correct Score 1st Half';
const DATE_START = args['date-start'] || '2025-09-01';
const DATE_STOP = args['date-stop'] || '2026-08-20';
const CHUNK = Number(args['chunk-days'] || 7);
const SLEEP = Number(args.sleep || 320);
const OUT = args.out || 'artifacts/output/edge-search';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let apiCalls = 0;
async function call(method, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('method', method); url.searchParams.set('APIkey', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && clean(v) !== '') url.searchParams.set(k, String(v));
  for (let a = 0; a < 3; a++) {
    try { apiCalls++; const r = await fetch(url); const t = await r.text(); const p = JSON.parse(t); if (String(p.success) === '1') return p.result; }
    catch { /* retry */ }
    await sleep(700 * (a + 1));
  }
  return null;
}
// correct tiebreak-aware set-1 parser
function firstSet(fixture) {
  const sc = fixture?.scores;
  const arr = Array.isArray(sc) ? sc : (sc && typeof sc === 'object' ? Object.values(sc) : []);
  for (const s of arr) {
    if (clean(s?.score_set) !== '1') continue;
    const a = Math.trunc(Number(s?.score_first)), b = Math.trunc(Number(s?.score_second));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const ok = (a === 6 && b <= 4) || (b === 6 && a <= 4) || (a === 7 && (b === 5 || b === 6)) || (b === 7 && (a === 5 || a === 6));
    return ok ? `${a}:${b}` : null;
  }
  return null;
}
function level(fixture) {
  const t = clean(fixture?.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'slam';
  if (/challenger/.test(t)) return 'challenger';
  if (/\b(itf|m15|m25|w15|w25|w35|w50|w75|w100|w125)\b/.test(t)) return 'itf';
  return 'tour';
}
function chunks(s, e, d) {
  const out = []; let c = new Date(`${s}T00:00:00Z`); const end = new Date(`${e}T00:00:00Z`);
  while (c <= end) { const a = new Date(c); const b = new Date(c); b.setUTCDate(b.getUTCDate() + d - 1); out.push([a.toISOString().slice(0, 10), (b > end ? end : b).toISOString().slice(0, 10)]); c.setUTCDate(c.getUTCDate() + d); }
  return out;
}

// ---------------- fetch ----------------
const csRows = [];                       // one row per match: prices per score + actual
const vig = new Map();                   // market -> {best:[], perBook:Map, arbs, n, outcomes:[]}
const arbEx = [];
const seenBooks = new Map();
let finished = 0, withCS = 0, tbCount = 0;

const wins = chunks(DATE_START, DATE_STOP, CHUNK);
process.stderr.write(`edge-search ${DATE_START}..${DATE_STOP}  ${wins.length} chunks\n`);
for (let i = 0; i < wins.length; i++) {
  const [ds, dd] = wins[i];
  const fixtures = []; const odds = {};
  for (const et of ['265', '266']) {
    const fx = await call('get_fixtures', { date_start: ds, date_stop: dd, event_type_key: et });
    for (const f of (Array.isArray(fx) ? fx : Object.values(fx || {}))) if (f?.event_key !== undefined) fixtures.push(f);
    await sleep(SLEEP);
    const od = await call('get_odds', { date_start: ds, date_stop: dd, event_type_key: et });
    if (od && typeof od === 'object') for (const [k, v] of Object.entries(od)) odds[String(k)] = v;
    await sleep(SLEEP);
  }
  process.stderr.write(`  [${i + 1}/${wins.length}] ${ds} fx=${fixtures.length}\n`);

  for (const f of fixtures) {
    const type = clean(f.event_type_type).toLowerCase();
    if (type && !type.includes('singles')) continue;
    if (!clean(f.event_status).toLowerCase().includes('finished')) continue;
    const actual = firstSet(f);
    if (!actual) continue;
    finished++;
    if (actual === '7:6' || actual === '6:7') tbCount++;
    const block = odds[String(f.event_key)];
    if (!block || typeof block !== 'object') continue;

    // H2 vig map across every market
    for (const [mkt, market] of Object.entries(block)) {
      if (!market || typeof market !== 'object') continue;
      const best = {}; const byBook = {};
      for (const [outcome, books] of Object.entries(market)) {
        if (!books || typeof books !== 'object') { const v = num(books); if (v && v > 1) best[outcome] = v; continue; }
        let mx = null;
        for (const [bn, bv] of Object.entries(books)) {
          const v = num(bv); if (!v || v <= 1) continue;
          seenBooks.set(bn, (seenBooks.get(bn) || 0) + 1);
          if (mx === null || v > mx) mx = v;
          (byBook[bn] ??= {})[outcome] = v;
        }
        if (mx !== null) best[outcome] = mx;
      }
      const outs = Object.keys(best);
      if (outs.length < 2) continue;
      const tot = outs.reduce((a, o) => a + 1 / best[o], 0);
      if (!Number.isFinite(tot) || tot <= 0) continue;
      if (!vig.has(mkt)) vig.set(mkt, { best: [], single: [], arbs: 0, n: 0, outs: [] });
      const st = vig.get(mkt);
      st.best.push(tot); st.n++; st.outs.push(outs.length);
      for (const [bn, om] of Object.entries(byBook)) {
        const ks = Object.keys(om);
        if (ks.length === outs.length) { const t2 = ks.reduce((a, o) => a + 1 / om[o], 0); if (Number.isFinite(t2) && t2 > 0) st.single.push(t2); }
      }
      if (tot < 1.0) { st.arbs++; if (arbEx.length < 10) arbEx.push({ match: `${clean(f.event_first_player)} vs ${clean(f.event_second_player)}`, date: clean(f.event_date), mkt, tot, best }); }
    }

    // H3/H4 correct-score dataset
    const market = block[CS];
    if (!market || typeof market !== 'object') continue;
    withCS++;
    const best = {}; const b365 = {};
    for (const [score, books] of Object.entries(market)) {
      if (!books || typeof books !== 'object') continue;
      let mx = null;
      for (const [bn, bv] of Object.entries(books)) {
        const v = num(bv); if (!v || v <= 1) continue;
        if (mx === null || v > mx) mx = v;
        if (clean(bn).toLowerCase() === 'bet365') b365[score] = v;
      }
      if (mx !== null) best[score] = mx;
    }
    if (Object.keys(best).length < 6) continue;
    csRows.push({ date: clean(f.event_date), level: level(f), match: `${clean(f.event_first_player)} vs ${clean(f.event_second_player)}`, tournament: clean(f.tournament_name), actual, best, b365 });
  }
}

// ---------------- analysis helpers ----------------
const pc = (x) => `${(x * 100).toFixed(2)}%`;
const sg = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function ev(bets) { // bets: [{odds, won}]
  const n = bets.length; if (!n) return null;
  const w = bets.filter((b) => b.won).length;
  const units = bets.reduce((a, b) => a + (b.won ? b.odds - 1 : -1), 0);
  const avg = bets.reduce((a, b) => a + b.odds, 0) / n;
  const p = w / n, roi = units / n;
  const se = (Math.sqrt(p * (1 - p)) * avg) / Math.sqrt(n);
  return { n, w, hit: p, avg, be: 1 / avg, units, roi, se, t: se ? roi / se : 0, lo: roi - 1.96 * se, hi: roi + 1.96 * se };
}
function row(label, s) {
  if (!s) return console.log(`  ${label.padEnd(40)} (no bets)`);
  console.log(`  ${label.padEnd(40)} n=${String(s.n).padStart(5)} hit=${pc(s.hit).padStart(7)} avgOdds=${s.avg.toFixed(2).padStart(6)} BE=${pc(s.be).padStart(7)} ROI=${sg(s.roi).padStart(8)} t=${s.t.toFixed(2).padStart(6)} 95%CI[${sg(s.lo)},${sg(s.hi)}]`);
}

csRows.sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(csRows.length * 0.70);
const TRAIN = csRows.slice(0, cut), HOLD = csRows.slice(cut);

console.log('\n' + '='.repeat(140));
console.log(`HONEST EDGE SEARCH   ${DATE_START} .. ${DATE_STOP}   api_calls=${apiCalls}`);
console.log('='.repeat(140));
console.log(`  finished singles with a valid set-1 score : ${finished}`);
console.log(`  of those, first set went to TIEBREAK      : ${tbCount}  (${pc(tbCount / Math.max(1, finished))})  <-- the repo dropped all of these`);
console.log(`  matches with '${CS}' prices              : ${withCS}`);
console.log(`  correct-score dataset rows               : ${csRows.length}   train=${TRAIN.length} holdout=${HOLD.length}`);
if (csRows.length) console.log(`  train ${TRAIN[0]?.date}..${TRAIN.at(-1)?.date}   holdout ${HOLD[0]?.date}..${HOLD.at(-1)?.date}`);

console.log('\n' + '-'.repeat(140));
console.log('H1  ARBITRAGE — best price across all books, total implied probability < 1.00');
console.log('-'.repeat(140));
const totArb = [...vig.values()].reduce((a, s) => a + s.arbs, 0);
const totObs = [...vig.values()].reduce((a, s) => a + s.n, 0);
console.log(`  ${totArb} arbitrage opportunities in ${totObs} market observations (${pc(totArb / Math.max(1, totObs))})`);
if (arbEx.length) for (const a of arbEx.slice(0, 5)) console.log(`    ${a.date} ${a.match} | ${a.mkt} | total=${a.tot.toFixed(4)} => risk-free ${pc(1 / a.tot - 1)}`);
else console.log('  None. After full line shopping every market still carries positive margin.');

console.log('\n' + '-'.repeat(140));
console.log('H2  VIG MAP — where can an edge even survive?  (best price across all books)');
console.log('-'.repeat(140));
console.log('  market                                    n   outs  median vig(best)  median vig(1 book)  gain from shopping  arbs');
console.log('  ' + '-'.repeat(130));
const sorted = [...vig.entries()].filter(([, s]) => s.n >= 200).sort((a, b) => med(a[1].best) - med(b[1].best));
for (const [m, s] of sorted.slice(0, 16)) {
  const vb = med(s.best) - 1, vs = med(s.single) - 1;
  console.log(`  ${m.slice(0, 40).padEnd(40)} ${String(s.n).padStart(5)} ${med(s.outs).toFixed(0).padStart(5)}   ${pc(vb).padStart(14)}   ${(Number.isNaN(vs) ? 'n/a' : pc(vs)).padStart(16)}   ${(Number.isNaN(vs) ? 'n/a' : pc(vs - vb)).padStart(16)}   ${String(s.arbs).padStart(4)}`);
}

// H3: favourite-longshot bias, tiebreaks included
function shortestScoreBet(r, priceMap) {
  const entries = Object.entries(priceMap).filter(([, v]) => v && v > 1);
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  const [score, odds] = entries[0];
  return { odds, won: score === r.actual, score };
}
console.log('\n' + '-'.repeat(140));
console.log('H3  FAVOURITE-LONGSHOT BIAS — bet the SHORTEST-priced first-set exact score (tiebreaks counted)');
console.log('-'.repeat(140));
console.log('  TRAIN (discovery):');
row('shortest score, best price', ev(TRAIN.map((r) => shortestScoreBet(r, r.best)).filter(Boolean)));
console.log('  by price band, TRAIN:');
for (const [lo, hi] of [[1, 5], [5, 6], [6, 7], [7, 8], [8, 10], [10, 99]]) {
  const b = TRAIN.map((r) => shortestScoreBet(r, r.best)).filter((x) => x && x.odds >= lo && x.odds < hi);
  if (b.length >= 50) row(`  price ${lo}-${hi}`, ev(b));
}
console.log('\n  HOLDOUT (single test, no tuning):');
row('shortest score, best price', ev(HOLD.map((r) => shortestScoreBet(r, r.best)).filter(Boolean)));

console.log('\n  Reference: EVERY score bet, all outcomes, best price (the market baseline)');
const allBets = [];
for (const r of csRows) for (const [s, o] of Object.entries(r.best)) if (o > 1) allBets.push({ odds: o, won: s === r.actual });
row('all outcomes pooled', ev(allBets));
console.log('  by price band, full sample:');
for (const [lo, hi] of [[1, 5], [5, 7], [7, 9], [9, 12], [12, 16], [16, 22], [22, 999]]) {
  const b = allBets.filter((x) => x.odds >= lo && x.odds < hi);
  if (b.length >= 100) row(`  price ${lo}-${hi}`, ev(b));
}

console.log('\n' + '-'.repeat(140));
console.log('H4  DOES LINE SHOPPING FLIP ANYTHING? best-of-all-books vs bet365 alone, shortest score');
console.log('-'.repeat(140));
row('bet365 only', ev(csRows.map((r) => shortestScoreBet(r, r.b365)).filter(Boolean)));
row('best of all books', ev(csRows.map((r) => shortestScoreBet(r, r.best)).filter(Boolean)));

console.log('\n' + '-'.repeat(140));
console.log('TRUE base rate of each first-set score (tiebreaks included) — the number the model should have known');
console.log('-'.repeat(140));
const dist = {};
for (const r of csRows) dist[r.actual] = (dist[r.actual] || 0) + 1;
for (const [s, c] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  const fair = csRows.length / c;
  console.log(`  ${s.padEnd(6)} ${pc(c / csRows.length).padStart(7)}   fair odds ${fair.toFixed(2).padStart(7)}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'correct-score-dataset.json'), JSON.stringify(csRows));
fs.writeFileSync(path.join(OUT, 'vig-map.json'), JSON.stringify([...vig.entries()].map(([m, s]) => ({
  market: m, n: s.n, median_vig_best: med(s.best) - 1, median_vig_single: med(s.single) - 1, arbs: s.arbs, median_outcomes: med(s.outs),
})).sort((a, b) => a.median_vig_best - b.median_vig_best), null, 2));
console.log(`\nBooks seen: ${[...seenBooks.keys()].join(', ')}`);
console.log(`Artifacts in ${OUT}/\n`);
