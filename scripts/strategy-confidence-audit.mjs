#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (quoted) {
      if (c === '"' && n === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = rows[0] ?? [];
  const records = rows.slice(1).filter((items) => items.some((item) => String(item).trim() !== '')).map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ''])));
  return { headers, records };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(','))].join('\n')}\n`;
}

function first(headers, names) { return names.find((name) => headers.includes(name)) ?? null; }
function num(value) { const n = Number(String(value ?? '').replace(/[×x]/i, '').trim()); return Number.isFinite(n) ? n : null; }
function score(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!m) return '';
  const a = Number(m[1]); const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a <= 7 && b <= 7 ? `${a}-${b}` : '';
}
function round(value, d = 4) { return Number.isFinite(value) ? Number(value.toFixed(d)) : null; }
function rate(a, b) { return b > 0 ? a / b : 0; }
function pct(v) { return Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a'; }

function dateOf(row, c) { return String(row[c.eventDate] ?? '').slice(0, 10); }
function monthOf(row, c) { return dateOf(row, c).slice(0, 7); }
function eventKey(row, c) { return String(row[c.eventKey] ?? '').trim(); }

function cols(headers) {
  const c = {
    eventDate: first(headers, ['event_date', 'date', 'match_date']),
    eventKey: first(headers, ['event_key', 'match_id', 'fixture_id', 'id']),
    match: first(headers, ['match', 'match_name', 'event_name']),
    tournament: first(headers, ['tournament', 'tournament_name']),
    tournamentLevel: first(headers, ['tournament_level']),
    matchType: first(headers, ['match_type']),
    selectedScore: first(headers, ['score', 'selected_score', 'predicted_score']),
    odds: first(headers, ['bookmaker_odds', 'closing_odds', 'odds']),
    actualScore: first(headers, ['actual_first_set_score']),
    actualStatus: first(headers, ['actual_score_status', 'status']),
  };
  const missing = ['eventDate', 'eventKey', 'match', 'selectedScore', 'odds', 'actualScore'].filter((k) => !c[k]);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}. Headers: ${headers.join(' | ')}`);
  return c;
}

function resolved(row, c) {
  const actual = score(row[c.actualScore]);
  const status = c.actualStatus ? String(row[c.actualStatus] ?? '').toLowerCase() : 'resolved';
  return Boolean(actual) && !/void|unknown|retired|cancel|walkover|abandon|postpone|ambiguous/.test(status);
}

function dedupe(rows, c) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = eventKey(row, c) || `${dateOf(row, c)}|${row[c.match] ?? ''}|${row[c.selectedScore] ?? ''}|${row[c.odds] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.sort((a, b) => dateOf(a, c).localeCompare(dateOf(b, c)) || eventKey(a, c).localeCompare(eventKey(b, c)));
}

function officialBase(row, c) {
  const selected = score(row[c.selectedScore]);
  const odds = num(row[c.odds]);
  const level = c.tournamentLevel ? String(row[c.tournamentLevel] ?? '').toLowerCase() : 'tour_other';
  const type = c.matchType ? String(row[c.matchType] ?? 'singles').toLowerCase() : 'singles';
  return selected === '4-6' && level === 'tour_other' && type === 'singles' && odds >= 5.5 && odds <= 7.5 && resolved(row, c);
}

function between(odds, min, max, includeMax = false) { return includeMax ? odds >= min && odds <= max : odds >= min && odds < max; }

const RULES = [
  { id: 'official_v2_wide', label: 'Official V2 Wide 5.50-7.50', fn: (o) => between(o, 5.5, 7.5, true) },
  { id: 'official_v3_600_699', label: 'Official V3 6.00-6.99', fn: (o) => between(o, 6.0, 7.0) },
  { id: 'official_v3_strict_625_699', label: 'Official V3 Strict 6.25-6.99', fn: (o) => between(o, 6.25, 7.0) },
  { id: 'ultra_v1_650_699', label: 'Ultra V1 6.50-6.99', fn: (o) => between(o, 6.5, 7.0) },
  { id: 'high_odds_shadow_725_750', label: 'High Odds Shadow 7.25-7.50', fn: (o) => between(o, 7.25, 7.5, true) },
];

function profitFor(row, c, oddsHaircut = 0, oddsPctHaircut = 0) {
  const actual = score(row[c.actualScore]);
  const rawOdds = num(row[c.odds]) ?? 0;
  const adjustedOdds = Math.max(1.01, rawOdds * (1 - oddsPctHaircut) - oddsHaircut);
  return actual === '4-6' ? adjustedOdds - 1 : -1;
}

function metrics(rows, c, opts = {}) {
  let profit = 0, wins = 0, losses = 0, equity = 0, peak = 0, maxDrawdown = 0, streak = 0, worstStreak = 0;
  const monthly = new Map();
  for (const row of rows) {
    const p = profitFor(row, c, opts.oddsHaircut ?? 0, opts.oddsPctHaircut ?? 0);
    const hit = score(row[c.actualScore]) === '4-6';
    if (hit) wins += 1; else losses += 1;
    profit += p; equity += p; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (p <= 0) streak += 1; else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
    const month = monthOf(row, c);
    const m = monthly.get(month) ?? { bets: 0, wins: 0, profit: 0 };
    m.bets += 1; m.profit += p; if (hit) m.wins += 1;
    monthly.set(month, m);
  }
  const bets = rows.length;
  const avgOdds = bets ? rows.reduce((s, r) => s + (num(r[c.odds]) ?? 0), 0) / bets : 0;
  return {
    bets,
    wins,
    losses,
    hit_rate: round(rate(wins, bets), 4),
    breakeven_hit_rate: round(avgOdds > 0 ? 1 / avgOdds : 0, 4),
    avg_odds: round(avgOdds, 3),
    profit_units: round(profit, 2),
    roi: round(rate(profit, bets), 4),
    max_drawdown_units: round(maxDrawdown, 2),
    worst_losing_streak: worstStreak,
    positive_months: [...monthly.values()].filter((m) => m.profit > 0).length,
    total_months: monthly.size,
    monthly: Object.fromEntries([...monthly.entries()].sort().map(([month, m]) => [month, { ...m, roi: round(rate(m.profit, m.bets), 4) }])),
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    const g = m.get(k) ?? [];
    g.push(row);
    m.set(k, g);
  }
  return m;
}

function quantile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function bootstrapRoi(rows, c, iterations, seed = 42) {
  let state = seed >>> 0;
  const rand = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const rois = [];
  for (let i = 0; i < iterations; i += 1) {
    let profit = 0;
    for (let j = 0; j < rows.length; j += 1) {
      const r = rows[Math.floor(rand() * rows.length)];
      profit += profitFor(r, c);
    }
    rois.push(profit / rows.length);
  }
  return {
    iterations,
    p05: round(quantile(rois, 0.05), 4),
    p25: round(quantile(rois, 0.25), 4),
    median: round(quantile(rois, 0.5), 4),
    p75: round(quantile(rois, 0.75), 4),
    p95: round(quantile(rois, 0.95), 4),
    prob_positive: round(rois.filter((r) => r > 0).length / rois.length, 4),
    prob_roi_gt_10pct: round(rois.filter((r) => r > 0.10).length / rois.length, 4),
  };
}

function leaveOneMonthOut(rows, c) {
  const months = [...groupBy(rows, (r) => monthOf(r, c)).keys()].sort();
  return months.map((month) => {
    const kept = rows.filter((r) => monthOf(r, c) !== month);
    const removed = rows.filter((r) => monthOf(r, c) === month);
    return { removed_month: month, removed_bets: removed.length, kept: metrics(kept, c), removed: metrics(removed, c) };
  });
}

function rollingBlocks(rows, c, blockSize = 3) {
  const months = [...groupBy(rows, (r) => monthOf(r, c)).keys()].sort();
  const out = [];
  for (let i = 0; i <= months.length - blockSize; i += 1) {
    const blockMonths = new Set(months.slice(i, i + blockSize));
    const blockRows = rows.filter((r) => blockMonths.has(monthOf(r, c)));
    out.push({ block: [...blockMonths].join('_to_'), ...metrics(blockRows, c) });
  }
  return out;
}

function slippageStress(rows, c) {
  const cases = [
    { label: 'no_slippage', oddsHaircut: 0, oddsPctHaircut: 0 },
    { label: 'minus_0.05_decimal_odds', oddsHaircut: 0.05, oddsPctHaircut: 0 },
    { label: 'minus_0.10_decimal_odds', oddsHaircut: 0.10, oddsPctHaircut: 0 },
    { label: 'minus_0.20_decimal_odds', oddsHaircut: 0.20, oddsPctHaircut: 0 },
    { label: 'minus_2pct_odds', oddsHaircut: 0, oddsPctHaircut: 0.02 },
    { label: 'minus_5pct_odds', oddsHaircut: 0, oddsPctHaircut: 0.05 },
    { label: 'minus_10pct_odds', oddsHaircut: 0, oddsPctHaircut: 0.10 },
  ];
  return cases.map((x) => ({ label: x.label, ...metrics(rows, c, x) }));
}

function randomPlacebo(baseRows, targetRows, c, iterations = 500, seed = 99) {
  const targetCount = targetRows.length;
  let state = seed >>> 0;
  const rand = () => {
    state = (1103515245 * state + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const rois = [];
  for (let i = 0; i < iterations; i += 1) {
    const shuffled = [...baseRows].sort(() => rand() - 0.5).slice(0, targetCount);
    rois.push(metrics(shuffled, c).roi);
  }
  const targetRoi = metrics(targetRows, c).roi;
  return {
    iterations,
    target_count: targetCount,
    target_roi: targetRoi,
    placebo_p05: round(quantile(rois, 0.05), 4),
    placebo_median: round(quantile(rois, 0.50), 4),
    placebo_p95: round(quantile(rois, 0.95), 4),
    placebo_prob_beats_target: round(rois.filter((r) => r >= targetRoi).length / rois.length, 4),
  };
}

function scoreConfidence(ruleSummary) {
  const m = ruleSummary.metrics;
  const boot = ruleSummary.bootstrap;
  const slip = ruleSummary.slippage_stress;
  const leave = ruleSummary.leave_one_month_out;
  const blocks = ruleSummary.rolling_3_month_blocks;
  let points = 0;
  const reasons = [];

  if (m.bets >= 300) { points += 15; reasons.push('sample_size_good'); } else if (m.bets >= 150) { points += 8; reasons.push('sample_size_ok'); }
  if (m.roi >= 0.30) { points += 20; reasons.push('roi_very_strong'); } else if (m.roi >= 0.15) { points += 12; reasons.push('roi_positive'); } else if (m.roi > 0) { points += 5; reasons.push('roi_thin_positive'); }
  if (m.hit_rate > m.breakeven_hit_rate + 0.03) { points += 15; reasons.push('hit_rate_clear_above_breakeven'); }
  else if (m.hit_rate > m.breakeven_hit_rate + 0.01) { points += 8; reasons.push('hit_rate_above_breakeven'); }
  if (boot.prob_positive >= 0.95) { points += 15; reasons.push('bootstrap_positive_95plus'); }
  else if (boot.prob_positive >= 0.85) { points += 8; reasons.push('bootstrap_positive_85plus'); }
  if ((slip.find((s) => s.label === 'minus_5pct_odds')?.roi ?? -1) > 0) { points += 10; reasons.push('survives_5pct_odds_slippage'); }
  if ((slip.find((s) => s.label === 'minus_10pct_odds')?.roi ?? -1) > 0) { points += 5; reasons.push('survives_10pct_odds_slippage'); }
  const positiveLeave = leave.filter((x) => x.kept.roi > 0).length / Math.max(1, leave.length);
  if (positiveLeave >= 0.95) { points += 10; reasons.push('not_dependent_on_one_month'); }
  const positiveBlocks = blocks.filter((x) => x.roi > 0).length / Math.max(1, blocks.length);
  if (positiveBlocks >= 0.75) { points += 10; reasons.push('rolling_blocks_stable'); }
  else if (positiveBlocks >= 0.50) { points += 5; reasons.push('rolling_blocks_mixed'); }

  const confidence = Math.max(0, Math.min(100, points));
  return { confidence_score_0_100: confidence, reasons, positive_leave_one_month_out_rate: round(positiveLeave, 4), positive_rolling_block_rate: round(positiveBlocks, 4) };
}

function mdTable(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${headers.map((h) => r[h]).join(' | ')} |`)].join('\n');
}

function buildMarkdown(summary) {
  const overview = summary.rules.map((r) => ({
    rule: r.label,
    bets: r.metrics.bets,
    hit: pct(r.metrics.hit_rate),
    breakeven: pct(r.metrics.breakeven_hit_rate),
    roi: pct(r.metrics.roi),
    profit: r.metrics.profit_units,
    max_dd: r.metrics.max_drawdown_units,
    worst_streak: r.metrics.worst_losing_streak,
    boot_pos: pct(r.bootstrap.prob_positive),
    conf: r.confidence.confidence_score_0_100,
  }));
  return `# Strategy Confidence Audit\n\n## Overview\n\n${mdTable(overview)}\n\n## What this test does\n\n- Tests frozen rules on already-enriched rows.\n- Runs slippage stress, bootstrap resampling, leave-one-month-out, rolling 3-month blocks, and random placebo checks.\n- This is not live proof, but it is a stronger robustness test than simple historical ROI.\n\n## Guardrails\n\n${summary.guardrails.map((g) => `- ${g}`).join('\n')}\n`;
}

async function main() {
  const input = arg('input', 'artifacts/output/official-full-period-retest-auto/combined/combined-2024-2026-enriched-first-set-scores.csv');
  const outDir = arg('output-dir', 'artifacts/output/strategy-confidence-audit');
  const iterations = Number(arg('bootstrap-iterations', '1000')) || 1000;
  const { headers, records } = parseCsv(await fs.readFile(input, 'utf8'));
  const c = cols(headers);
  const baseRows = dedupe(records.filter((row) => officialBase(row, c)), c);

  const rules = RULES.map((rule) => {
    const rows = baseRows.filter((row) => rule.fn(num(row[c.odds]) ?? 0));
    const ruleSummary = {
      id: rule.id,
      label: rule.label,
      metrics: metrics(rows, c),
      slippage_stress: slippageStress(rows, c),
      bootstrap: bootstrapRoi(rows, c, iterations),
      leave_one_month_out: leaveOneMonthOut(rows, c),
      rolling_3_month_blocks: rollingBlocks(rows, c, 3),
      placebo_vs_random_official_base: randomPlacebo(baseRows, rows, c, 500),
    };
    ruleSummary.confidence = scoreConfidence(ruleSummary);
    return ruleSummary;
  });

  const summary = {
    model_version: 'strategy_confidence_audit_v1',
    created_at: new Date().toISOString(),
    input: {
      input_path: input,
      total_rows_loaded: records.length,
      official_base_rows: baseRows.length,
      first_date: baseRows[0] ? dateOf(baseRows[0], c) : null,
      last_date: baseRows.at(-1) ? dateOf(baseRows.at(-1), c) : null,
      bootstrap_iterations: iterations,
      columns: c,
    },
    rules,
    guardrails: [
      'This audit can raise confidence, but only settled live results can validate execution.',
      'A rule needs to survive slippage, bad months, bootstrap, and live odds before scaling stake.',
      'Treat confidence_score_0_100 as a robustness score, not a guarantee of future profit.',
      'If live odds differ from recorded bookmaker_odds, use the slippage stress section as the relevant benchmark.',
    ],
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'strategy-confidence-audit-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'strategy-confidence-audit-summary.md'), buildMarkdown(summary));

  const flat = rules.map((r) => ({
    rule: r.label,
    bets: r.metrics.bets,
    wins: r.metrics.wins,
    hit_rate: r.metrics.hit_rate,
    breakeven_hit_rate: r.metrics.breakeven_hit_rate,
    roi: r.metrics.roi,
    profit_units: r.metrics.profit_units,
    max_drawdown_units: r.metrics.max_drawdown_units,
    worst_losing_streak: r.metrics.worst_losing_streak,
    bootstrap_prob_positive: r.bootstrap.prob_positive,
    bootstrap_p05_roi: r.bootstrap.p05,
    bootstrap_median_roi: r.bootstrap.median,
    bootstrap_p95_roi: r.bootstrap.p95,
    confidence_score_0_100: r.confidence.confidence_score_0_100,
  }));
  await fs.writeFile(path.join(outDir, 'strategy-confidence-audit-rules.csv'), writeCsv(Object.keys(flat[0] ?? {}), flat));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
