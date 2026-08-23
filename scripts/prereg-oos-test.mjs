#!/usr/bin/env node
/*
  PRE-REGISTERED OUT-OF-SAMPLE TEST
  Protocol: docs/PRE-REGISTERED-TEST-2026-08.md  (written before any data fetched)

  Tests the live scanner's frozen lane rules on 2026-05-07 .. 2026-08-20, a window
  that begins the day after the main research dataset ends.

  Differences from every other backtest in this repo, on purpose:
    - uses the lane's OWN named bookmaker, not Math.max across all books
    - no model probability, no EV gate, no edge gate (they are anti-predictive)
    - grouped units only, no booster overlay
    - gates used exactly as written, no variation

  NEVER prints the API key.

  Usage:
    API_TENNIS_KEY=... node scripts/prereg-oos-test.mjs
    node scripts/prereg-oos-test.mjs --date-start=2026-05-07 --date-stop=2026-08-20
*/
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
);

function loadKey() {
  for (const f of ['.env', '.env.local']) {
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*(API_TENNIS_KEY|API_TENNIS_API_KEY|APITENNIS_API_KEY)\s*=\s*(.+)\s*$/);
        if (m && m[2].trim()) return m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return process.env.API_TENNIS_KEY || process.env.API_TENNIS_API_KEY || process.env.APITENNIS_API_KEY || null;
}
const KEY = loadKey();
if (!KEY) {
  console.error('No API-Tennis key found. Set API_TENNIS_KEY env var or put it in .env (gitignored).');
  process.exit(2);
}

const BASE = 'https://api.api-tennis.com/tennis/';
const MARKET = args.market || 'Correct Score 1st Half';
const EVENT_TYPES = (args['event-type-keys'] || '265,266').split(',').map((s) => s.trim());
const DATE_START = args['date-start'] || '2026-05-07';
const DATE_STOP = args['date-stop'] || '2026-08-20';
const CHUNK_DAYS = Number(args['chunk-days'] || 5);
const OUT = args.out || 'artifacts/output/prereg-oos-test';
const SLEEP = Number(args.sleep || 400);

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v === undefined || v === null || clean(v) === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API ----------
let apiCalls = 0;
const apiErrors = [];
async function call(method, params = {}) {
  const url = new URL(BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && clean(v) !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      apiCalls++;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await res.text();
      let payload;
      try { payload = JSON.parse(text); } catch {
        apiErrors.push(`${method} non-JSON HTTP ${res.status}`);
        await sleep(800 * (attempt + 1)); continue;
      }
      if (String(payload.success) !== '1') {
        // surface the API's own message but never the URL (which contains the key)
        apiErrors.push(`${method} success!=1: ${JSON.stringify(payload).slice(0, 300)}`);
        await sleep(800 * (attempt + 1)); continue;
      }
      return payload.result;
    } catch (e) {
      apiErrors.push(`${method} threw: ${e?.message ?? e}`);
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

// ---------- helpers copied from the live scanner ----------
function tournamentGroup(fixture) {
  const t = clean(fixture?.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai', 'qatar open'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['barcelona', 'halle', 'queen', 'queens', 'london', 'stuttgart', 'charleston', 'washington', 'hamburg', 'tokyo', 'acapulco', 'eastbourne', 'rotterdam', 'basel', 'vienna', 'adelaide', 'brisbane', 'bad homburg', 'berlin', 'strasbourg', 'antwerp', 'dallas', 'rio', 'astana', 'chengdu', 'zhuhai', 'seoul'].some((k) => t.includes(k))) return 'STRONG_500_250';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}
function tourFromFixture(fixture) {
  const key = clean(fixture?.event_type_key);
  if (key === '265') return 'ATP';
  if (key === '266') return 'WTA';
  const s = `${fixture?.event_type_type ?? ''} ${fixture?.tournament_name ?? ''}`.toLowerCase();
  if (s.includes('wta') || s.includes('women')) return 'WTA';
  if (s.includes('atp') || s.includes('men')) return 'ATP';
  return 'UNKNOWN';
}
const groupedOdds = (values) => {
  const nums = values.map(num);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((s, v) => s + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
};
function scoreSkewBucket(odds) {
  const nums = odds.map(num);
  if (nums.length < 2 || nums.some((o) => !o || o <= 1)) return 'UNKNOWN';
  let ratio;
  if (nums.length === 2) ratio = Math.max(...nums) / Math.min(...nums);
  else ratio = nums[1] / ((nums[0] + nums[nums.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}
function bookOdds(market, scores, book) {
  return scores.map((s) => {
    const cell = market?.[s];
    if (!cell || typeof cell !== 'object') return null;
    if (cell[book] !== undefined) return num(cell[book]);
    for (const [bn, price] of Object.entries(cell)) {
      if (clean(bn).toLowerCase() === clean(book).toLowerCase()) return num(price);
    }
    return null;
  });
}
/*
  API-Tennis encodes a tiebreak set as games.tiebreakPoints, e.g. "7.9" / "6.7"
  means 7-6 with the breaker won 9-7. The games played is the INTEGER part.

  The repo's own parseFirstSetScore() does Number("7.9") -> 7.9, then
  looksLikeTennisSet(7.9, 6.7) -> false, then returns null. Net effect: every
  tiebreak first set is DROPPED from the sample rather than counted.

  A 7:6 / 6:7 first set is a guaranteed LOSS for all of these score groups, so
  dropping them removes certain losses. We truncate to games and keep them.
*/
function firstSetScore(fixture) {
  const scores = fixture?.scores;
  const arr = Array.isArray(scores) ? scores : (scores && typeof scores === 'object' ? Object.values(scores) : []);
  for (const s of arr) {
    if (clean(s?.score_set) !== '1') continue;
    const ra = num(s?.score_first), rb = num(s?.score_second);
    if (ra === null || rb === null) return null;
    const a = Math.trunc(ra), b = Math.trunc(rb);
    // must look like a completed tennis set once reduced to games
    const ok = (a === 6 && b <= 4) || (b === 6 && a <= 4) || (a === 7 && (b === 5 || b === 6)) || (b === 7 && (a === 5 || a === 6));
    if (!ok) return null;
    return `${a}:${b}`;
  }
  return null;
}
const isTiebreakSet = (s) => s === '7:6' || s === '6:7';

// ---------- frozen lanes (see protocol §2) ----------
const LANES = [
  { key: 'CORE_P1_ATP_GS_BET365', label: 'Core Cluster (Gate-2, as coded)', variant: 'GATE2',
    scores: ['6:3', '6:4'], books: ['bet365'], minGrouped: 2.50, maxGrouped: null,
    triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25, tour: 'ATP', tGroup: 'GRAND_SLAM', requiredSkew: null },
  { key: 'CORE_P1_ATP_GS_PROTECTED3', label: 'Core Cluster (Protected 3, README active)', variant: 'PROTECTED3',
    scores: ['6:2', '6:3', '6:4'], books: ['bet365'], minGrouped: 2.50, maxGrouped: null,
    triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25, tour: 'ATP', tGroup: 'GRAND_SLAM', requiredSkew: null },
  { key: 'VIP_P2_V3_SHAPE', label: 'V3 Cluster', variant: 'BOTH',
    scores: ['3:6', '4:6', '5:7'], books: ['bet365', '1xBet', '10Bet'], minGrouped: 3.50, maxGrouped: null,
    triggerScore: '4:6', triggerMin: 6.25, triggerMax: 6.99, tour: 'ANY', tGroup: 'ANY', requiredSkew: null },
  { key: 'RESEARCH_P2_GS_26_46_BET365', label: 'Research P2 GS Sniper', variant: 'BOTH',
    scores: ['2:6', '4:6'], books: ['bet365'], minGrouped: 2.50, maxGrouped: 4.50,
    triggerScore: '', triggerMin: null, triggerMax: null, tour: 'ANY', tGroup: 'GRAND_SLAM', requiredSkew: 'EXTREME' },
  { key: 'CORE_P2_GS_REVERSE_STRETCH', label: 'Reverse Stretch (README-derived, not in scanner)', variant: 'BOTH',
    scores: ['2:6', '4:6', '5:7'], books: ['bet365'], minGrouped: 2.50, maxGrouped: 4.50,
    triggerScore: '', triggerMin: null, triggerMax: null, tour: 'ANY', tGroup: 'GRAND_SLAM', requiredSkew: 'EXTREME' },
];

// ---------- date chunks ----------
function chunks(start, stop, days) {
  const out = [];
  let cur = new Date(`${start}T00:00:00Z`);
  const end = new Date(`${stop}T00:00:00Z`);
  while (cur <= end) {
    const a = new Date(cur);
    const b = new Date(cur); b.setUTCDate(b.getUTCDate() + days - 1);
    out.push([a.toISOString().slice(0, 10), (b > end ? end : b).toISOString().slice(0, 10)]);
    cur.setUTCDate(cur.getUTCDate() + days);
  }
  return out;
}

// ---------- main ----------
const stats = { fixtures_seen: 0, finished_singles: 0, with_set1_score: 0, with_market: 0, excluded_no_market: 0, excluded_no_score: 0 };
const signals = [];
const seen = new Set();

const windows = chunks(DATE_START, DATE_STOP, CHUNK_DAYS);
process.stderr.write(`window ${DATE_START} .. ${DATE_STOP}  (${windows.length} chunks of ${CHUNK_DAYS}d)\n`);

for (let wi = 0; wi < windows.length; wi++) {
  const [ds, dd] = windows[wi];
  process.stderr.write(`  [${wi + 1}/${windows.length}] ${ds}..${dd}`);

  const fixtures = [];
  const oddsMap = {};
  for (const et of EVENT_TYPES) {
    const fx = await call('get_fixtures', { date_start: ds, date_stop: dd, event_type_key: et });
    const arr = Array.isArray(fx) ? fx : (fx && typeof fx === 'object' ? Object.values(fx) : []);
    for (const f of arr) if (f?.event_key !== undefined) fixtures.push({ ...f, event_type_key: f.event_type_key ?? et });
    await sleep(SLEEP);
    const od = await call('get_odds', { date_start: ds, date_stop: dd, event_type_key: et });
    if (od && typeof od === 'object') for (const [k, v] of Object.entries(od)) oddsMap[String(k)] = v;
    await sleep(SLEEP);
  }
  process.stderr.write(`  fixtures=${fixtures.length} oddsKeys=${Object.keys(oddsMap).length}\n`);

  for (const f of fixtures) {
    stats.fixtures_seen++;
    const type = clean(f.event_type_type).toLowerCase();
    const status = clean(f.event_status).toLowerCase();
    if (type && !type.includes('singles')) continue;
    if (!status.includes('finished')) continue;
    stats.finished_singles++;

    const actual = firstSetScore(f);
    if (!actual) { stats.excluded_no_score++; continue; }
    stats.with_set1_score++;

    const market = oddsMap[String(f.event_key)]?.[MARKET];
    if (!market || typeof market !== 'object') { stats.excluded_no_market++; continue; }
    stats.with_market++;

    const tour = tourFromFixture(f);
    const tg = tournamentGroup(f);

    for (const lane of LANES) {
      if (lane.tour !== 'ANY' && lane.tour !== tour) continue;
      if (lane.tGroup !== 'ANY' && lane.tGroup !== tg) continue;

      for (const book of lane.books) {
        const odds = bookOdds(market, lane.scores, book);
        if (odds.some((v) => !v || v <= 1)) continue;
        const grouped = groupedOdds(odds);
        if (!grouped) continue;
        if (grouped < lane.minGrouped) continue;
        if (lane.maxGrouped && grouped > lane.maxGrouped) continue;
        const skew = scoreSkewBucket(odds);
        if (lane.requiredSkew && skew !== lane.requiredSkew) continue;
        let trig = null;
        if (lane.triggerScore) {
          trig = bookOdds(market, [lane.triggerScore], book)[0];
          if (!trig || trig < lane.triggerMin || trig > lane.triggerMax) continue;
        }
        // dedup: one signal per match per lane (scanner stableSignalKey ignores book)
        const dedupKey = `${f.event_key}:${lane.key}:${lane.scores.join('/')}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const wonBet = lane.scores.includes(actual);
        signals.push({
          lane: lane.key, lane_label: lane.label, event_date: clean(f.event_date),
          match: `${clean(f.event_first_player)} vs ${clean(f.event_second_player)}`,
          tournament: clean(f.tournament_name), tour, tournament_group: tg, book,
          score_cluster: lane.scores.join('/'), odds_json: JSON.stringify(Object.fromEntries(lane.scores.map((s, i) => [s, odds[i]]))),
          grouped_odds: grouped, skew, trigger_odds: trig ?? '', actual_first_set: actual,
          first_set_was_tiebreak: isTiebreakSet(actual),
          won: wonBet, profit_units: wonBet ? Number((grouped - 1).toFixed(4)) : -1,
        });
        break; // first qualifying book only
      }
    }
  }
}

// ---------- reporting ----------
function summarize(rows) {
  const n = rows.length;
  if (!n) return null;
  const w = rows.filter((r) => r.won).length;
  const units = rows.reduce((a, r) => a + r.profit_units, 0);
  const avg = rows.reduce((a, r) => a + r.grouped_odds, 0) / n;
  const p = w / n;
  const roi = units / n;
  const sdBet = Math.sqrt(p * (1 - p)) * avg;
  const se = sdBet / Math.sqrt(n);
  return { n, w, l: n - w, hit: p, avg, breakeven: 1 / avg, units, roi, se, t: se > 0 ? roi / se : 0,
           lo: roi - 1.96 * se, hi: roi + 1.96 * se };
}
const pc = (x) => `${(x * 100).toFixed(2)}%`;
const sg = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

function line(label, s) {
  if (!s) { console.log(`  ${label.padEnd(44)} no qualifying signals`); return; }
  console.log(`  ${label.padEnd(44)} n=${String(s.n).padStart(4)}  ${String(s.w).padStart(3)}W/${String(s.l).padStart(3)}L  hit=${pc(s.hit).padStart(7)}  avgGrp=${s.avg.toFixed(2).padStart(5)}  BE=${pc(s.breakeven).padStart(7)}  units=${(s.units >= 0 ? '+' : '') + s.units.toFixed(2).padStart(7)}  ROI=${sg(s.roi).padStart(8)}  t=${s.t.toFixed(2).padStart(5)}  95%CI[${sg(s.lo)}, ${sg(s.hi)}]`);
}

console.log('\n' + '='.repeat(150));
console.log(`PRE-REGISTERED OUT-OF-SAMPLE TEST   window ${DATE_START} .. ${DATE_STOP}`);
console.log('Protocol: docs/PRE-REGISTERED-TEST-2026-08.md (committed before fetch)');
console.log('='.repeat(150));
console.log(`\nData pipeline: api_calls=${apiCalls}  fixtures_seen=${stats.fixtures_seen}  finished_singles=${stats.finished_singles}`);
console.log(`  with set-1 score=${stats.with_set1_score}  with '${MARKET}' market=${stats.with_market}`);
console.log(`  excluded: no set-1 score=${stats.excluded_no_score}, no market=${stats.excluded_no_market}`);
if (stats.finished_singles) console.log(`  market coverage = ${pc(stats.with_market / stats.finished_singles)} of finished singles`);
if (apiErrors.length) {
  console.log(`\n  API issues (${apiErrors.length}), first 5:`);
  [...new Set(apiErrors)].slice(0, 5).forEach((e) => console.log(`    - ${e}`));
}

console.log('\n' + '-'.repeat(150));
console.log('PER-LANE');
console.log('-'.repeat(150));
for (const lane of LANES) line(lane.label, summarize(signals.filter((s) => s.lane === lane.key)));

const p3 = signals.filter((s) => ['CORE_P1_ATP_GS_PROTECTED3', 'CORE_P2_GS_REVERSE_STRETCH', 'RESEARCH_P2_GS_26_46_BET365', 'VIP_P2_V3_SHAPE'].includes(s.lane));
const g2 = signals.filter((s) => ['CORE_P1_ATP_GS_BET365', 'RESEARCH_P2_GS_26_46_BET365', 'VIP_P2_V3_SHAPE'].includes(s.lane));

console.log('\n' + '-'.repeat(150));
console.log('COMBINED MODELS');
console.log('-'.repeat(150));
line('*** PRIMARY: Optimized VIP Protected 3 ***', summarize(p3));
line('Secondary: Gate-2 variant (as coded)', summarize(g2));
line('Secondary: all lanes pooled', summarize(signals));

// ---------- the tiebreak-exclusion bias ----------
console.log('\n' + '='.repeat(150));
console.log("THE TIEBREAK-EXCLUSION BIAS  (repo's parseFirstSetScore drops these matches instead of counting them)");
console.log('='.repeat(150));
const tbAll = signals.filter((s) => s.first_set_was_tiebreak);
console.log(`  Signals whose first set went to a tiebreak: ${tbAll.length} of ${signals.length} (${signals.length ? pc(tbAll.length / signals.length) : 'n/a'})`);
console.log('  Every one of them is a GUARANTEED LOSS for these score groups. None are wins.');
console.log('  You cannot know in advance that a set will reach a tiebreak, so excluding them is look-ahead bias.\n');
console.log('  %-46s %s', 'accounting', 'result');
console.log('  ' + '-'.repeat(140));
for (const [name, rows] of [
  ['CORRECT — tiebreaks counted as losses', p3],
  ["REPO METHOD — tiebreak matches dropped", p3.filter((s) => !s.first_set_was_tiebreak)],
]) line(name, summarize(rows));
const sCorrect = summarize(p3), sRepo = summarize(p3.filter((s) => !s.first_set_was_tiebreak));
if (sCorrect && sRepo) {
  console.log(`\n  Dropping tiebreaks inflates hit rate by ${((sRepo.hit - sCorrect.hit) * 100).toFixed(2)} pts and ROI by ${((sRepo.roi - sCorrect.roi) * 100).toFixed(2)} pts.`);
  console.log('  Every historical number in README.md was produced with the inflated accounting.');
}

const prim = summarize(p3);
console.log('\n' + '='.repeat(150));
console.log('VERDICT AGAINST PRE-REGISTERED CRITERIA (protocol §5)');
console.log('='.repeat(150));
if (!prim || prim.n < 40) {
  console.log(`  n=${prim ? prim.n : 0} < 40  ->  TEST VOID. Sample too thin to read. No conclusion drawn.`);
} else {
  const r = prim.roi;
  const v = r >= 0.10 ? 'GENUINE SUPPORT — claimed edge survived unseen data (ROI >= +10%, n >= 100)'
    : r >= 0 ? 'WEAK / INCONCLUSIVE — consistent with no edge after vig'
    : r >= -0.10 ? 'CONSISTENT WITH NO EDGE'
    : r <= -0.15 ? 'CONSISTENT WITH THE -18.02% REAL-PRICE MEASUREMENT — market efficient, vig is the story'
    : 'NEGATIVE — consistent with no edge';
  console.log(`  Primary ROI = ${sg(r)} on n=${prim.n}  ->  ${v}`);
  if (r >= 0.10 && prim.n < 100) console.log('  NOTE: ROI clears +10% but n < 100, so the "genuine support" bar is NOT fully met.');
  console.log(`  95% CI on true ROI: [${sg(prim.lo)}, ${sg(prim.hi)}]  ${prim.lo > 0 ? '(excludes zero)' : '(INCLUDES ZERO — not significant)'}`);
  console.log('  Reminder from protocol §5: this test cannot prove an edge. ~325 settled bets are');
  console.log('  needed to detect a 15% edge at 95% confidence. One window is not validation.');
}

// ---------- artifacts ----------
fs.mkdirSync(OUT, { recursive: true });
const fields = ['lane','lane_label','event_date','match','tournament','tour','tournament_group','book','score_cluster','odds_json','grouped_odds','skew','trigger_odds','actual_first_set','first_set_was_tiebreak','won','profit_units'];
const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
fs.writeFileSync(path.join(OUT, 'signals.csv'), [fields.join(','), ...signals.map((r) => fields.map((f) => esc(r[f])).join(','))].join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({
  protocol: 'docs/PRE-REGISTERED-TEST-2026-08.md', window: [DATE_START, DATE_STOP], market: MARKET,
  generated_at: new Date().toISOString(), pipeline: stats, api_calls: apiCalls,
  api_error_sample: [...new Set(apiErrors)].slice(0, 10),
  per_lane: Object.fromEntries(LANES.map((l) => [l.key, summarize(signals.filter((s) => s.lane === l.key))])),
  primary_protected3: summarize(p3), secondary_gate2: summarize(g2), secondary_all: summarize(signals),
}, null, 2));
console.log(`\nArtifacts: ${OUT}/signals.csv  (${signals.length} rows)  and  ${OUT}/summary.json\n`);
