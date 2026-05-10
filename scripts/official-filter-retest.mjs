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
  const records = rows.slice(1).filter((r) => r.some((x) => String(x).trim())).map((items) => Object.fromEntries(headers.map((h, i) => [h, items[i] ?? ''])));
  return { headers, records };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n')}\n`;
}

function first(headers, names) {
  return names.find((name) => headers.includes(name)) ?? null;
}

function num(value) {
  const parsed = Number(String(value ?? '').replace(/[×x]/i, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function score(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!m) return '';
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a <= 7 && b <= 7 ? `${a}-${b}` : '';
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function rate(a, b) {
  return b > 0 ? a / b : 0;
}

function dateOf(row, cols) {
  return String(row[cols.eventDate] ?? '').slice(0, 10);
}

function eventKey(row, cols) {
  return String(row[cols.eventKey] ?? '').trim();
}

function isResolved(row, cols) {
  const actual = score(row[cols.actualScore]);
  const status = cols.actualStatus ? String(row[cols.actualStatus] ?? '').toLowerCase() : 'resolved';
  return Boolean(actual) && !/void|unknown|retired|cancel|walkover|abandon|postpone|ambiguous/.test(status);
}

function p2Won(actualScore) {
  const [a, b] = actualScore.split('-').map(Number);
  return b > a;
}

function dedupe(rows, cols) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = eventKey(row, cols) || `${dateOf(row, cols)}|${row[cols.match] ?? ''}|${row[cols.selectedScore] ?? ''}|${row[cols.odds] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.sort((a, b) => dateOf(a, cols).localeCompare(dateOf(b, cols)) || eventKey(a, cols).localeCompare(eventKey(b, cols)));
}

function officialBase(row, cols) {
  const selected = score(row[cols.selectedScore]);
  const odds = num(row[cols.odds]);
  const level = cols.tournamentLevel ? String(row[cols.tournamentLevel] ?? '').toLowerCase() : 'tour_other';
  const type = cols.matchType ? String(row[cols.matchType] ?? 'singles').toLowerCase() : 'singles';
  return selected === '4-6' && level === 'tour_other' && type === 'singles' && odds >= 5.5 && odds <= 7.5 && isResolved(row, cols);
}

function metrics(rows, cols) {
  let wins = 0;
  let losses = 0;
  let profit = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let losingStreak = 0;
  let worstLosingStreak = 0;
  const monthly = new Map();
  const actualScores = new Map();
  let p2Wins = 0;

  for (const row of rows) {
    const actual = score(row[cols.actualScore]);
    const odds = num(row[cols.odds]) ?? 0;
    const hit = actual === '4-6';
    const p = hit ? odds - 1 : -1;
    if (hit) wins += 1;
    else losses += 1;
    if (p2Won(actual)) p2Wins += 1;
    actualScores.set(actual, (actualScores.get(actual) ?? 0) + 1);
    profit += p;
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (p <= 0) losingStreak += 1;
    else losingStreak = 0;
    worstLosingStreak = Math.max(worstLosingStreak, losingStreak);
    const month = dateOf(row, cols).slice(0, 7);
    const cur = monthly.get(month) ?? { bets: 0, wins: 0, profit: 0 };
    cur.bets += 1;
    cur.profit += p;
    if (hit) cur.wins += 1;
    monthly.set(month, cur);
  }

  const bets = rows.length;
  const avgOdds = bets ? rows.reduce((sum, row) => sum + (num(row[cols.odds]) ?? 0), 0) / bets : 0;
  return {
    bets,
    wins,
    losses,
    hit_rate: round(rate(wins, bets), 4),
    breakeven_hit_rate: round(avgOdds > 0 ? 1 / avgOdds : 0, 4),
    p2_first_set_win_rate: round(rate(p2Wins, bets), 4),
    avg_odds: round(avgOdds, 3),
    profit_units: round(profit, 2),
    roi: round(rate(profit, bets), 4),
    max_drawdown_units: round(maxDrawdown, 2),
    worst_losing_streak: worstLosingStreak,
    positive_months: [...monthly.values()].filter((m) => m.profit > 0).length,
    total_months: monthly.size,
    actual_score_distribution: Object.fromEntries([...actualScores.entries()].sort((a, b) => b[1] - a[1])),
    monthly: Object.fromEntries([...monthly.entries()].sort().map(([month, m]) => [month, { ...m, roi: round(rate(m.profit, m.bets), 4) }]))
  };
}

function buildCols(headers) {
  const cols = {
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
    edge: first(headers, ['edge']),
    expectedValue: first(headers, ['expected_value']),
  };
  const missing = ['eventDate', 'eventKey', 'match', 'selectedScore', 'odds', 'actualScore'].filter((key) => !cols[key]);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}. Headers: ${headers.join(' | ')}`);
  return cols;
}

function between(odds, min, max, includeMax = true) {
  return includeMax ? odds >= min && odds <= max : odds >= min && odds < max;
}

function makeRule(label, description, predicate) {
  return { label, description, predicate };
}

function markdown(summary) {
  const rows = summary.rules.map((r) => ({
    rule: r.label,
    bets: r.metrics.bets,
    hit_rate: pct(r.metrics.hit_rate),
    breakeven: pct(r.metrics.breakeven_hit_rate),
    p2_win: pct(r.metrics.p2_first_set_win_rate),
    roi: pct(r.metrics.roi),
    profit: r.metrics.profit_units,
    max_dd: r.metrics.max_drawdown_units,
    worst_streak: r.metrics.worst_losing_streak,
  }));
  const headers = Object.keys(rows[0] ?? {});
  const table = rows.length ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${headers.map((h) => r[h]).join(' | ')} |`)].join('\n') : '';
  return `# Official Filter Retest\n\n## Inputs\n\n\`\`\`json\n${JSON.stringify(summary.input, null, 2)}\n\`\`\`\n\n## Rules\n\n${table}\n\n## Notes\n\n- This retest uses already-enriched rows; no API calls are made.\n- Baseline is 4-6 / tour_other / singles / odds 5.50-7.50 / resolved only.\n- The purpose is to compare odds-band filters and identify whether high odds are poisoning Official V2.\n`;
}

async function main() {
  const input = arg('input', 'artifacts/input/blind-sim-bets-enriched-first-set-scores.csv');
  const outDir = arg('output-dir', 'artifacts/output/official-filter-retest');
  const text = await fs.readFile(input, 'utf8');
  const { headers, records } = parseCsv(text);
  const cols = buildCols(headers);
  const officialRows = dedupe(records.filter((row) => officialBase(row, cols)), cols);

  const rules = [
    makeRule('Official V2 5.50-7.50', 'Current scanner baseline', (o) => between(o, 5.5, 7.5)),
    makeRule('Official V3 cap <7.25', 'Remove 7.25-7.50 poison band', (o) => o >= 5.5 && o < 7.25),
    makeRule('Official V3 cap <7.00', 'Remove all 7.xx odds', (o) => o >= 5.5 && o < 7.0),
    makeRule('Official V3 6.00-6.99', 'Mid odds band only', (o) => o >= 6.0 && o < 7.0),
    makeRule('Official V3 Strict 6.25-6.99', 'Stricter mid-high sweet spot', (o) => o >= 6.25 && o < 7.0),
    makeRule('Ultra V1 6.50-6.99', 'Existing ultra band', (o) => o >= 6.5 && o < 7.0),
    makeRule('Low 5.50-5.99', 'Low end audit', (o) => o >= 5.5 && o < 6.0),
    makeRule('Band 6.00-6.49', 'Lower mid audit', (o) => o >= 6.0 && o < 6.5),
    makeRule('Band 6.50-6.99', 'Ultra audit', (o) => o >= 6.5 && o < 7.0),
    makeRule('Band 7.00-7.24', 'Upper but below poison audit', (o) => o >= 7.0 && o < 7.25),
    makeRule('Poison Audit 7.25-7.50', 'High-end audit only, should likely avoid if negative', (o) => o >= 7.25 && o <= 7.5),
  ];

  const summary = {
    model_version: 'official_filter_retest_v1',
    created_at: new Date().toISOString(),
    input: {
      input_path: input,
      total_rows_loaded: records.length,
      official_base_rows: officialRows.length,
      first_date: officialRows[0] ? dateOf(officialRows[0], cols) : null,
      last_date: officialRows.at(-1) ? dateOf(officialRows.at(-1), cols) : null,
      column_mapping: cols,
    },
    rules: rules.map((rule) => {
      const rows = officialRows.filter((row) => rule.predicate(num(row[cols.odds]) ?? 0));
      return {
        label: rule.label,
        description: rule.description,
        metrics: metrics(rows, cols),
      };
    }),
    guardrails: [
      'Do not accept a rule from one holdout only. Compare with 2025-2026 and live settled results.',
      'Do not use model EV/edge as primary filter until calibrated against actual score outcomes.',
      '3-6 companion still needs real 3-6 odds; same-odds companion tests are proxy only.',
    ],
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'official-filter-retest-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'official-filter-retest-summary.md'), markdown(summary));

  const flatRows = summary.rules.map((r) => ({
    rule: r.label,
    description: r.description,
    bets: r.metrics.bets,
    wins: r.metrics.wins,
    losses: r.metrics.losses,
    hit_rate: r.metrics.hit_rate,
    breakeven_hit_rate: r.metrics.breakeven_hit_rate,
    p2_first_set_win_rate: r.metrics.p2_first_set_win_rate,
    avg_odds: r.metrics.avg_odds,
    profit_units: r.metrics.profit_units,
    roi: r.metrics.roi,
    max_drawdown_units: r.metrics.max_drawdown_units,
    worst_losing_streak: r.metrics.worst_losing_streak,
    positive_months: r.metrics.positive_months,
    total_months: r.metrics.total_months,
  }));
  await fs.writeFile(path.join(outDir, 'official-filter-retest-rules.csv'), writeCsv(Object.keys(flatRows[0] ?? {}), flatRows));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
