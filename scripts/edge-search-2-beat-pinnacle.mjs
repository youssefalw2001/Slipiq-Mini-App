#!/usr/bin/env node
/*
  EDGE SEARCH, ROUND 2 — "BEAT THE SHARP"
  =======================================
  DISCLOSURE: this hypothesis was formed AFTER seeing round-1 results (the vig map
  showed Home/Away at ~1.9% margin and revealed Pinnacle is in the feed). It is
  therefore a second-round test and carries a multiple-testing penalty. Round 1
  tested 4 hypotheses; this is the 5th. Treat t-stats accordingly: with K=5 the
  expected best-of-noise t is ~1.79.

  THE ESTABLISHED IDEA (not invented here)
  Pinnacle is a low-margin, high-limit book that does not restrict winners. Its
  price is the closest thing to the true probability. The standard professional
  play is not to model the sport at all: it is to find another book offering a
  price meaningfully longer than Pinnacle's vig-free fair price, and take it.

    pinnacle_fair_prob = (1/pinn_side) / (1/pinn_home + 1/pinn_away)   <- vig removed
    fair_odds          = 1 / pinnacle_fair_prob
    value              = best_other_book_price / fair_odds - 1
    bet if value >= threshold

  Markets tested: 'Home/Away' (match winner) and 'Home/Away (1st Set)'.
  Both are true 2-way complementary markets, so no handicap-line ambiguity.

  Threshold is selected on TRAIN and applied ONCE to HOLDOUT.
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
const KEY = loadKey(); if (!KEY) { console.error('No key.'); process.exit(2); }

const DATE_START = args['date-start'] || '2025-09-01';
const DATE_STOP = args['date-stop'] || '2026-08-20';
const CHUNK = Number(args['chunk-days'] || 7);
const SLEEP = Number(args.sleep || 320);
const OUT = args.out || 'artifacts/output/edge-search';
const PINN = ['pncl', 'pinnacle'];

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let apiCalls = 0;
async function call(method, params = {}) {
  const url = new URL('https://api.api-tennis.com/tennis/');
  url.searchParams.set('method', method); url.searchParams.set('APIkey', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && clean(v) !== '') url.searchParams.set(k, String(v));
  for (let a = 0; a < 3; a++) {
    try { apiCalls++; const r = await fetch(url); const p = JSON.parse(await r.text()); if (String(p.success) === '1') return p.result; } catch {}
    await sleep(700 * (a + 1));
  }
  return null;
}
function setsList(f) {
  const sc = f?.scores;
  return Array.isArray(sc) ? sc : (sc && typeof sc === 'object' ? Object.values(sc) : []);
}
function firstSetWinner(f) {
  for (const s of setsList(f)) {
    if (clean(s?.score_set) !== '1') continue;
    const a = Math.trunc(Number(s?.score_first)), b = Math.trunc(Number(s?.score_second));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const ok = (a === 6 && b <= 4) || (b === 6 && a <= 4) || (a === 7 && (b === 5 || b === 6)) || (b === 7 && (a === 5 || a === 6));
    if (!ok) return null;
    return a > b ? 'Home' : 'Away';
  }
  return null;
}
function matchWinner(f) {
  let h = 0, a = 0;
  for (const s of setsList(f)) {
    const x = Math.trunc(Number(s?.score_first)), y = Math.trunc(Number(s?.score_second));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x > y) h++; else if (y > x) a++;
  }
  if (h === a) return null;
  return h > a ? 'Home' : 'Away';
}
function level(f) {
  const t = clean(f?.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'slam';
  if (/challenger/.test(t)) return 'challenger';
  if (/\b(itf|m15|m25|w15|w25|w35|w50|w75|w100|w125)\b/.test(t)) return 'itf';
  return 'tour';
}
function chunks(s, e, d) {
  const o = []; let c = new Date(`${s}T00:00:00Z`); const end = new Date(`${e}T00:00:00Z`);
  while (c <= end) { const A = new Date(c); const B = new Date(c); B.setUTCDate(B.getUTCDate() + d - 1); o.push([A.toISOString().slice(0, 10), (B > end ? end : B).toISOString().slice(0, 10)]); c.setUTCDate(c.getUTCDate() + d); }
  return o;
}

const MARKETS = [['Home/Away', matchWinner], ['Home/Away (1st Set)', firstSetWinner]];
const rows = [];   // one row per (match, market, side) with a non-Pinnacle price
let noPinn = 0, withPinn = 0;

const wins = chunks(DATE_START, DATE_STOP, CHUNK);
process.stderr.write(`beat-pinnacle ${DATE_START}..${DATE_STOP} ${wins.length} chunks\n`);
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
  process.stderr.write(`  [${i + 1}/${wins.length}] ${ds}\n`);

  for (const f of fixtures) {
    const type = clean(f.event_type_type).toLowerCase();
    if (type && !type.includes('singles')) continue;
    if (!clean(f.event_status).toLowerCase().includes('finished')) continue;
    const block = odds[String(f.event_key)];
    if (!block || typeof block !== 'object') continue;

    for (const [mkt, resolver] of MARKETS) {
      const market = block[mkt];
      if (!market || typeof market !== 'object') continue;
      const winner = resolver(f);
      if (!winner) continue;

      // collect per-book prices for Home/Away
      const px = { Home: {}, Away: {} };
      for (const [outcome, books] of Object.entries(market)) {
        const side = /home/i.test(outcome) ? 'Home' : (/away/i.test(outcome) ? 'Away' : null);
        if (!side || !books || typeof books !== 'object') continue;
        for (const [bn, bv] of Object.entries(books)) { const v = num(bv); if (v && v > 1) px[side][clean(bn)] = v; }
      }
      const pinnKey = (side) => Object.keys(px[side]).find((b) => PINN.includes(b.toLowerCase()));
      const ph = pinnKey('Home'), pa = pinnKey('Away');
      if (!ph || !pa) { noPinn++; continue; }
      withPinn++;
      const pinnH = px.Home[ph], pinnA = px.Away[pa];
      const tot = 1 / pinnH + 1 / pinnA;
      if (!Number.isFinite(tot) || tot <= 0) continue;

      for (const side of ['Home', 'Away']) {
        const fairProb = (1 / (side === 'Home' ? pinnH : pinnA)) / tot;
        const fairOdds = 1 / fairProb;
        // best price EXCLUDING pinnacle itself
        let bestBook = null, bestPrice = null;
        for (const [bn, v] of Object.entries(px[side])) {
          if (PINN.includes(bn.toLowerCase())) continue;
          if (bestPrice === null || v > bestPrice) { bestPrice = v; bestBook = bn; }
        }
        if (bestPrice === null) continue;
        rows.push({
          date: clean(f.event_date), market: mkt, level: level(f), side,
          match: `${clean(f.event_first_player)} vs ${clean(f.event_second_player)}`,
          pinn_fair_odds: Number(fairOdds.toFixed(4)), pinn_vig: Number((tot - 1).toFixed(4)),
          best_book: bestBook, best_price: bestPrice,
          value: Number((bestPrice / fairOdds - 1).toFixed(5)),
          won: winner === side,
        });
      }
    }
  }
}

// ---------------- analysis ----------------
const pc = (x) => `${(x * 100).toFixed(2)}%`;
const sg = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
function ev(bets) {
  const n = bets.length; if (!n) return null;
  const w = bets.filter((b) => b.won).length;
  const units = bets.reduce((a, b) => a + (b.won ? b.best_price - 1 : -1), 0);
  const avg = bets.reduce((a, b) => a + b.best_price, 0) / n;
  const p = w / n, roi = units / n;
  const se = (Math.sqrt(p * (1 - p)) * avg) / Math.sqrt(n);
  return { n, w, hit: p, avg, be: 1 / avg, units, roi, se, t: se ? roi / se : 0, lo: roi - 1.96 * se, hi: roi + 1.96 * se };
}
function line(label, s) {
  if (!s) return console.log(`  ${label.padEnd(42)} (no bets)`);
  console.log(`  ${label.padEnd(42)} n=${String(s.n).padStart(5)} hit=${pc(s.hit).padStart(7)} avgOdds=${s.avg.toFixed(2).padStart(6)} units=${(s.units >= 0 ? '+' : '') + s.units.toFixed(1).padStart(7)} ROI=${sg(s.roi).padStart(8)} t=${s.t.toFixed(2).padStart(6)} 95%CI[${sg(s.lo)},${sg(s.hi)}]`);
}

rows.sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(rows.length * 0.70);
const TRAIN = rows.slice(0, cut), HOLD = rows.slice(cut);

console.log('\n' + '='.repeat(140));
console.log(`EDGE SEARCH 2 — BEAT THE SHARP (Pinnacle as fair-value benchmark)   api_calls=${apiCalls}`);
console.log('='.repeat(140));
console.log(`  candidate rows: ${rows.length}   (market,side) pairs with a Pinnacle reference and another book quoted`);
console.log(`  market observations WITH Pinnacle: ${withPinn}   WITHOUT (skipped): ${noPinn}`);
if (rows.length) {
  console.log(`  train ${TRAIN[0].date}..${TRAIN.at(-1).date} (n=${TRAIN.length})   holdout ${HOLD[0].date}..${HOLD.at(-1).date} (n=${HOLD.length})`);
  const mv = rows.reduce((a, r) => a + r.pinn_vig, 0) / rows.length;
  console.log(`  mean Pinnacle two-way margin: ${pc(mv)}  (compare: correct-score at bet365 ~13-17%)`);
}

console.log('\n' + '-'.repeat(140));
console.log('BASELINE — bet EVERY side at best non-Pinnacle price (no selection at all)');
console.log('-'.repeat(140));
for (const [mkt] of MARKETS) line(mkt, ev(rows.filter((r) => r.market === mkt)));
line('both markets pooled', ev(rows));

console.log('\n' + '-'.repeat(140));
console.log('TRAIN — ROI by value bucket (value = best_price / pinnacle_fair_odds - 1)');
console.log('-'.repeat(140));
const BUCKETS = [[-1, 0], [0, 0.01], [0.01, 0.02], [0.02, 0.03], [0.03, 0.05], [0.05, 0.10], [0.10, 9]];
for (const [lo, hi] of BUCKETS) {
  const b = TRAIN.filter((r) => r.value >= lo && r.value < hi);
  if (b.length >= 60) line(`value ${lo === -1 ? '<0' : `${(lo * 100).toFixed(0)}%`} to ${(hi * 100).toFixed(0)}%`, ev(b));
}

console.log('\n' + '-'.repeat(140));
console.log('THRESHOLD SELECTED ON TRAIN, THEN APPLIED ONCE TO HOLDOUT');
console.log('-'.repeat(140));
let bestTh = null;
for (const th of [0, 0.01, 0.02, 0.03, 0.05]) {
  const b = TRAIN.filter((r) => r.value >= th);
  const s = ev(b);
  if (!s || s.n < 150) continue;
  console.log(`  TRAIN value >= ${pc(th).padStart(6)}  ->  n=${String(s.n).padStart(5)} ROI=${sg(s.roi).padStart(8)} t=${s.t.toFixed(2)}`);
  if (bestTh === null || s.roi > bestTh.roi) bestTh = { th, roi: s.roi };
}
if (bestTh) {
  console.log(`\n  Threshold chosen on train: value >= ${pc(bestTh.th)}  (train ROI ${sg(bestTh.roi)})`);
  console.log('  >>> SINGLE HOLDOUT TEST <<<');
  const h = ev(HOLD.filter((r) => r.value >= bestTh.th));
  line(`HOLDOUT value >= ${pc(bestTh.th)}`, h);
  if (h) {
    const verdict = h.lo > 0 ? 'SURVIVES — CI excludes zero (still only 1 window; K=5 penalty applies)'
      : h.roi > 0 ? 'positive point estimate but CI includes zero — NOT established'
      : 'FAILS — no edge on holdout';
    console.log(`\n  VERDICT: ${verdict}`);
    console.log(`  With K=5 hypotheses tested, expected best-of-noise t ~1.79. Observed t = ${h.t.toFixed(2)}.`);
  }
  console.log('\n  Holdout breakdown by market:');
  for (const [mkt] of MARKETS) line(`  ${mkt}`, ev(HOLD.filter((r) => r.value >= bestTh.th && r.market === mkt)));
  console.log('  Holdout breakdown by level:');
  for (const lv of ['slam', 'tour', 'challenger', 'itf']) {
    const s = ev(HOLD.filter((r) => r.value >= bestTh.th && r.level === lv));
    if (s && s.n >= 30) line(`  ${lv}`, s);
  }
  console.log('  Which books supply the value (holdout):');
  const byBook = {};
  for (const r of HOLD.filter((x) => x.value >= bestTh.th)) (byBook[r.best_book] ??= []).push(r);
  for (const [b, v] of Object.entries(byBook).sort((a, b2) => b2[1].length - a[1].length).slice(0, 8)) {
    const s = ev(v); console.log(`    ${b.padEnd(14)} n=${String(s.n).padStart(4)} ROI=${sg(s.roi).padStart(8)}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
const fields = ['date', 'market', 'level', 'side', 'match', 'pinn_fair_odds', 'pinn_vig', 'best_book', 'best_price', 'value', 'won'];
const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
fs.writeFileSync(path.join(OUT, 'beat-pinnacle.csv'), [fields.join(','), ...rows.map((r) => fields.map((f) => esc(r[f])).join(','))].join('\n') + '\n');
console.log(`\nArtifact: ${OUT}/beat-pinnacle.csv (${rows.length} rows)\n`);
