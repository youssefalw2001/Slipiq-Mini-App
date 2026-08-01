#!/usr/bin/env node
/*
  CALIBRATION LAYER for the SlipIQ first-set model.

  Problem being fixed: raw model_probability averages 20.16% while reality
  delivers 9.42% (ratio 0.467). Every downstream edge/EV number inherits that.

  Method (deliberately strict):
    - rows sorted by event_date, TIME-ORDERED split. train = first 70%, test = last 30%.
      Nothing is fitted on data used to score it.
    - Isotonic regression (PAVA) fitted on train only.
    - Benchmarked against dumb baselines so we learn whether the model adds
      anything at all:
        A) raw model probability
        B) global base rate (one number for everything)
        C) lookup table of base rate by (score, tournament_level)
        D) isotonic-calibrated model
        E) isotonic-calibrated model blended with the lookup table
    - Scored by Brier score (lower is better) and expected calibration error.

  If a lookup table beats the model, the model carries no information.
*/
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'artifacts/input/combined-2024-2026-enriched-first-set-scores.csv';
const OUT_DIR = 'artifacts/output';

// ---------- csv ----------
function parseCsv(t) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1];
    if (q) { if (c === '"' && n === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const h = rows[0];
  return rows.slice(1).filter(r => r.some(x => x !== '')).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (x) => `${(x * 100).toFixed(2)}%`;

const raw = parseCsv(fs.readFileSync(SRC, 'utf8'));
const rows = raw.map(r => ({
  date: String(r.event_date || '').slice(0, 10),
  strategy: r.strategy_label || r.strategy_id,
  score: String(r.score || '').trim(),
  level: String(r.tournament_level || 'unknown').toLowerCase(),
  surface: String(r.surface || 'unknown').toLowerCase(),
  p: num(r.model_probability),
  odds: num(r.bookmaker_odds),
  won: String(r.won).toLowerCase() === 'true',
  status: String(r.actual_score_status || '').toLowerCase(),
}))
  .filter(r => r.p != null && r.date && r.status === 'resolved' && r.score)
  .sort((a, b) => a.date.localeCompare(b.date));

console.log('='.repeat(84));
console.log('CALIBRATION BUILD');
console.log('='.repeat(84));
console.log(`Resolved rows: ${rows.length}`);
console.log(`Date range:    ${rows[0].date} -> ${rows[rows.length - 1].date}`);

const cut = Math.floor(rows.length * 0.70);
const train = rows.slice(0, cut);
const test = rows.slice(cut);
console.log(`\nTIME-ORDERED SPLIT (no leakage)`);
console.log(`  train: ${train.length} rows  ${train[0].date} -> ${train[train.length - 1].date}`);
console.log(`  test:  ${test.length} rows  ${test[0].date} -> ${test[test.length - 1].date}`);
console.log(`  train base rate: ${pct(train.filter(r => r.won).length / train.length)}`);
console.log(`  test  base rate: ${pct(test.filter(r => r.won).length / test.length)}`);

// ---------- isotonic regression via PAVA ----------
function fitIsotonic(xs, ys) {
  const idx = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const X = idx.map(i => xs[i]);
  const Y = idx.map(i => ys[i]);
  // blocks: {sumY, w, x_lo, x_hi}
  const blocks = [];
  for (let i = 0; i < X.length; i++) {
    blocks.push({ sum: Y[i], w: 1, lo: X[i], hi: X[i] });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.pop(); blocks.pop();
      blocks.push({ sum: a.sum + b.sum, w: a.w + b.w, lo: a.lo, hi: b.hi });
    }
  }
  return blocks.map(b => ({ lo: b.lo, hi: b.hi, v: b.sum / b.w }));
}

function predictIsotonic(model, x) {
  if (!model.length) return 0;
  if (x <= model[0].hi) return model[0].v;
  for (const b of model) if (x >= b.lo && x <= b.hi) return b.v;
  for (let i = 0; i < model.length - 1; i++) {
    if (x > model[i].hi && x < model[i + 1].lo) {
      const x0 = model[i].hi, x1 = model[i + 1].lo;
      const t = (x - x0) / Math.max(1e-9, x1 - x0);
      return model[i].v + t * (model[i + 1].v - model[i].v);
    }
  }
  return model[model.length - 1].v;
}

const iso = fitIsotonic(train.map(r => r.p), train.map(r => r.won ? 1 : 0));

// ---------- lookup table: base rate by (score, level) ----------
function buildLookup(data, keyFn, prior, priorWeight = 25) {
  const m = new Map();
  for (const r of data) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { w: 0, n: 0 });
    const e = m.get(k); e.n += 1; if (r.won) e.w += 1;
  }
  const out = new Map();
  for (const [k, e] of m) out.set(k, (e.w + prior * priorWeight) / (e.n + priorWeight));
  return out;
}
const globalRate = train.filter(r => r.won).length / train.length;
const keyScoreLevel = (r) => `${r.score}|${r.level}`;
const lookup = buildLookup(train, keyScoreLevel, globalRate);
const lookupPredict = (r) => lookup.has(keyScoreLevel(r)) ? lookup.get(keyScoreLevel(r)) : globalRate;

// ---------- metrics ----------
function brier(preds, ys) { return preds.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / preds.length; }
function logloss(preds, ys) {
  const e = 1e-12;
  return -preds.reduce((a, p, i) => { const q = Math.min(1 - e, Math.max(e, p)); return a + (ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q)); }, 0) / preds.length;
}
function ece(preds, ys, bins = 10) {
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const ix = preds.map((p, i) => [p, i]).filter(([p]) => p >= lo && (b === bins - 1 ? p <= hi : p < hi)).map(([, i]) => i);
    if (!ix.length) continue;
    const mp = ix.reduce((a, i) => a + preds[i], 0) / ix.length;
    const ma = ix.reduce((a, i) => a + ys[i], 0) / ix.length;
    total += (ix.length / preds.length) * Math.abs(mp - ma);
  }
  return total;
}

const yTest = test.map(r => r.won ? 1 : 0);
const models = {
  'A. raw model':                test.map(r => r.p),
  'B. global base rate':         test.map(() => globalRate),
  'C. lookup (score+level)':     test.map(r => lookupPredict(r)),
  'D. isotonic-calibrated':      test.map(r => predictIsotonic(iso, r.p)),
  'E. isotonic x lookup blend':  test.map(r => 0.5 * predictIsotonic(iso, r.p) + 0.5 * lookupPredict(r)),
};

console.log('\n' + '#'.repeat(84));
console.log('# OUT-OF-SAMPLE SCORES ON THE HELD-OUT TEST SET (lower Brier = better)');
console.log('#'.repeat(84));
console.log('\n  model                          Brier      LogLoss    ECE       mean pred   actual');
console.log('  ' + '-'.repeat(78));
const results = [];
for (const [name, preds] of Object.entries(models)) {
  const b = brier(preds, yTest), l = logloss(preds, yTest), e = ece(preds, yTest);
  const mp = preds.reduce((a, x) => a + x, 0) / preds.length;
  const ma = yTest.reduce((a, x) => a + x, 0) / yTest.length;
  results.push({ name, b, l, e, mp, ma });
  console.log(`  ${name.padEnd(30)} ${b.toFixed(5)}   ${l.toFixed(5)}   ${e.toFixed(4)}   ${pct(mp).padStart(8)}   ${pct(ma)}`);
}
const best = results.slice().sort((a, b) => a.b - b.b)[0];
const rawRes = results[0];
console.log(`\n  BEST: ${best.name}   (Brier ${best.b.toFixed(5)})`);
console.log(`  Raw model Brier ${rawRes.b.toFixed(5)} -> improvement ${pct((rawRes.b - best.b) / rawRes.b)}`);

const lookupRes = results.find(r => r.name.startsWith('C.'));
const isoRes = results.find(r => r.name.startsWith('D.'));
console.log('\n  THE KEY COMPARISON — does the model beat a dumb lookup table?');
console.log(`    lookup (score+level): Brier ${lookupRes.b.toFixed(5)}`);
console.log(`    calibrated model:     Brier ${isoRes.b.toFixed(5)}`);
if (isoRes.b < lookupRes.b) {
  console.log(`    >>> Model WINS by ${pct((lookupRes.b - isoRes.b) / lookupRes.b)}. It carries information beyond score+level.`);
} else {
  console.log(`    >>> Lookup table WINS. The model adds NOTHING beyond knowing`);
  console.log(`    >>> which scoreline and which tour level. That is the honest finding.`);
}

// ---------- reliability table before/after ----------
console.log('\n' + '#'.repeat(84));
console.log('# RELIABILITY ON TEST SET — before vs after calibration');
console.log('#'.repeat(84));
function reliability(preds, ys, label) {
  console.log(`\n  ${label}`);
  console.log('    predicted band      n     mean pred    actual     gap');
  console.log('    ' + '-'.repeat(58));
  const bands = [[0, .05], [.05, .10], [.10, .15], [.15, .20], [.20, .25], [.25, .35], [.35, 1]];
  for (const [lo, hi] of bands) {
    const ix = preds.map((p, i) => [p, i]).filter(([p]) => p >= lo && p < hi).map(([, i]) => i);
    if (ix.length < 15) continue;
    const mp = ix.reduce((a, i) => a + preds[i], 0) / ix.length;
    const ma = ix.reduce((a, i) => a + ys[i], 0) / ix.length;
    console.log(`    ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`.padEnd(20) + `${String(ix.length).padStart(5)}  ${pct(mp).padStart(9)}  ${pct(ma).padStart(9)}  ${(ma - mp >= 0 ? '+' : '') + pct(ma - mp)}`);
  }
}
reliability(models['A. raw model'], yTest, 'BEFORE (raw model_probability)');
reliability(models['D. isotonic-calibrated'], yTest, 'AFTER (isotonic calibrated)');

// ---------- does calibrated edge now rank correctly? ----------
console.log('\n' + '#'.repeat(84));
console.log('# DOES A CALIBRATED EDGE RANK CORRECTLY NOW?');
console.log('#'.repeat(84));
console.log('\n  (using the recorded odds, which are bucket placeholders - see caveat)\n');
function edgeQuintiles(label, pf) {
  const withOdds = test.filter(r => r.odds != null && r.odds > 1)
    .map(r => { const p = pf(r); return { ...r, pc: p, edge: p * r.odds - 1 }; })
    .sort((a, b) => a.edge - b.edge);
  if (withOdds.length < 50) { console.log(`  ${label}: not enough rows`); return; }
  const qn = 5, size = Math.floor(withOdds.length / qn);
  console.log(`  ${label}`);
  console.log('    quintile        n     avg edge     hit       ROI');
  console.log('    ' + '-'.repeat(52));
  for (let i = 0; i < qn; i++) {
    const b = withOdds.slice(i * size, i === qn - 1 ? withOdds.length : (i + 1) * size);
    const avgE = b.reduce((a, r) => a + r.edge, 0) / b.length;
    const hit = b.filter(r => r.won).length / b.length;
    const roi = b.reduce((a, r) => a + (r.won ? r.odds - 1 : -1), 0) / b.length;
    console.log(`    Q${i + 1}${i === 0 ? ' (low) ' : i === qn - 1 ? ' (high)' : '       '}   ${String(b.length).padStart(5)}  ${pct(avgE).padStart(9)}  ${pct(hit).padStart(7)}  ${(roi >= 0 ? '+' : '') + pct(roi)}`);
  }
  const pos = withOdds.filter(r => r.edge > 0);
  const posRoi = pos.length ? pos.reduce((a, r) => a + (r.won ? r.odds - 1 : -1), 0) / pos.length : NaN;
  console.log(`    bets with edge > 0: ${pos.length} of ${withOdds.length}   ROI ${Number.isFinite(posRoi) ? (posRoi >= 0 ? '+' : '') + pct(posRoi) : 'n/a'}`);
}
edgeQuintiles('BEFORE — raw probability', r => r.p);
edgeQuintiles('AFTER — calibrated probability', r => predictIsotonic(iso, r.p));

// ---------- export ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const model = {
  generated_at: new Date().toISOString(),
  method: 'isotonic regression (PAVA), time-ordered 70/30 split',
  source: SRC,
  train_rows: train.length,
  test_rows: test.length,
  train_date_range: [train[0].date, train[train.length - 1].date],
  test_date_range: [test[0].date, test[test.length - 1].date],
  global_base_rate: globalRate,
  isotonic_blocks: iso,
  lookup_score_level: Object.fromEntries(lookup),
  test_metrics: results.map(r => ({ model: r.name, brier: r.b, logloss: r.l, ece: r.e, mean_pred: r.mp, actual: r.ma })),
};
fs.writeFileSync(path.join(OUT_DIR, 'calibration_model.json'), JSON.stringify(model, null, 2));
console.log(`\nWrote ${OUT_DIR}/calibration_model.json`);
console.log(`  isotonic blocks: ${iso.length}   lookup keys: ${lookup.size}`);
