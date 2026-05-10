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
function writeCsv(headers, rows) { return `${[headers.map(csvEscape).join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n')}\n`; }
function first(headers, names) { return names.find((name) => headers.includes(name)) ?? null; }
function num(value) { const n = Number(String(value ?? '').replace(/[×x]/i, '').trim()); return Number.isFinite(n) ? n : null; }
function score(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!m) return '';
  const a = Number(m[1]); const b = Number(m[2]);
  return a >= 0 && b >= 0 && a <= 7 && b <= 7 ? `${a}-${b}` : '';
}
function rate(a, b) { return b > 0 ? a / b : 0; }
function round(v, d = 4) { return Number.isFinite(v) ? Number(v.toFixed(d)) : null; }

function cols(headers) {
  const c = {
    eventDate: first(headers, ['event_date', 'date', 'match_date']),
    signalTs: first(headers, ['signal_timestamp', 'Signal_Timestamp', 'found_at', 'created_at', 'observed_at']),
    matchStart: first(headers, ['match_start_time', 'Match_Start_Time', 'event_start_time', 'start_time']),
    eventKey: first(headers, ['event_key', 'match_id', 'fixture_id', 'id']),
    match: first(headers, ['match', 'match_name', 'event_name']),
    tournamentLevel: first(headers, ['tournament_level']),
    matchType: first(headers, ['match_type']),
    selectedScore: first(headers, ['score', 'selected_score', 'predicted_score', 'scoreline']),
    odds: first(headers, ['bookmaker_odds', 'closing_odds', 'odds']),
    actualScore: first(headers, ['actual_first_set_score']),
    actualStatus: first(headers, ['actual_score_status', 'status'])
  };
  const missing = ['eventDate', 'eventKey', 'match', 'selectedScore', 'odds'].filter((k) => !c[k]);
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}. Headers: ${headers.join(' | ')}`);
  return c;
}

function dt(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
function dateOf(row, c) { return String(row[c.eventDate] ?? '').slice(0, 10); }
function eventKey(row, c) { return String(row[c.eventKey] ?? '').trim(); }
function resolved(row, c) {
  if (!c.actualScore) return true;
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
  const odds = num(row[c.odds]);
  const level = c.tournamentLevel ? String(row[c.tournamentLevel] ?? '').toLowerCase() : 'tour_other';
  const type = c.matchType ? String(row[c.matchType] ?? 'singles').toLowerCase() : 'singles';
  return score(row[c.selectedScore]) === '4-6' && level === 'tour_other' && type === 'singles' && odds >= 5.5 && odds <= 7.5 && resolved(row, c);
}
function profit(row, c) {
  if (!c.actualScore) return 0;
  return score(row[c.actualScore]) === '4-6' ? (num(row[c.odds]) ?? 0) - 1 : -1;
}
function metrics(rows, c) {
  let wins = 0, p = 0;
  for (const row of rows) {
    if (c.actualScore && score(row[c.actualScore]) === '4-6') wins += 1;
    p += profit(row, c);
  }
  return {
    bets: rows.length,
    wins,
    losses: rows.length - wins,
    hit_rate: round(rate(wins, rows.length), 4),
    profit_units: round(p, 2),
    roi: round(rate(p, rows.length), 4)
  };
}
function leadMinutes(row, c) {
  const signal = c.signalTs ? dt(row[c.signalTs]) : null;
  const start = c.matchStart ? dt(row[c.matchStart]) : null;
  if (!signal || !start) return null;
  return Math.round((start.getTime() - signal.getTime()) / 60000);
}
function leadBucket(m) {
  if (m === null) return 'timing_unproven_missing_timestamp';
  if (m < 0) return 'past_start_or_bad_timestamp';
  if (m < 30) return 'lead_0_29';
  if (m < 60) return 'lead_30_59';
  if (m < 120) return 'lead_60_119';
  if (m < 240) return 'lead_120_239';
  if (m < 360) return 'lead_240_359';
  return 'lead_360_plus';
}

async function main() {
  const input = arg('input', 'artifacts/input/combined-2024-2026-enriched-first-set-scores.csv');
  const outDir = arg('output-dir', 'artifacts/output/execution-feasibility-backtest');
  const { headers, records } = parseCsv(await fs.readFile(input, 'utf8'));
  const c = cols(headers);
  const base = dedupe(records.filter((r) => officialBase(r, c)), c);
  const rules = [
    { id: 'official_v2_wide_550_750', label: 'Official V2 Wide 5.50-7.50', fn: (o) => o >= 5.5 && o <= 7.5 },
    { id: 'official_v3_600_699', label: 'Official V3 6.00-6.99', fn: (o) => o >= 6.0 && o < 7.0 },
    { id: 'official_v3_strict_625_699', label: 'Official V3 Strict 6.25-6.99', fn: (o) => o >= 6.25 && o < 7.0 },
    { id: 'ultra_v1_650_699', label: 'Ultra V1 6.50-6.99', fn: (o) => o >= 6.5 && o < 7.0 },
  ];
  const enrichedRows = [];
  const summaries = [];
  for (const rule of rules) {
    const rows = base.filter((r) => rule.fn(num(r[c.odds]) ?? 0));
    const withTiming = rows.filter((r) => leadMinutes(r, c) !== null);
    const preStart = rows.filter((r) => { const m = leadMinutes(r, c); return m !== null && m > 0; });
    const preferred = rows.filter((r) => { const m = leadMinutes(r, c); return m !== null && m >= 120 && m <= 299; });
    const buckets = {};
    for (const row of rows) buckets[leadBucket(leadMinutes(row, c))] = (buckets[leadBucket(leadMinutes(row, c))] ?? 0) + 1;
    summaries.push({
      id: rule.id,
      label: rule.label,
      ...metrics(rows, c),
      rows_with_signal_and_start_time: withTiming.length,
      timing_coverage_rate: round(rate(withTiming.length, rows.length), 4),
      pre_start_rows: preStart.length,
      pre_start_rate_among_timed: round(rate(preStart.length, withTiming.length), 4),
      preferred_120_299_rows: preferred.length,
      preferred_120_299_rate_among_timed: round(rate(preferred.length, withTiming.length), 4),
      lead_buckets: buckets,
      execution_feasibility_verdict: withTiming.length === 0 ? 'ODDS_FEASIBLE_BUT_TIMING_UNPROVEN_IN_THIS_CSV' : preStart.length / withTiming.length >= 0.95 ? 'TIMING_FEASIBLE_PRE_START' : 'TIMING_MIXED_OR_UNPROVEN'
    });
    for (const row of rows) {
      enrichedRows.push({
        rule: rule.id,
        event_date: dateOf(row, c),
        event_key: eventKey(row, c),
        match: row[c.match],
        odds: row[c.odds],
        actual_first_set_score: c.actualScore ? row[c.actualScore] : '',
        lead_minutes: leadMinutes(row, c),
        lead_bucket: leadBucket(leadMinutes(row, c)),
        signal_timestamp: c.signalTs ? row[c.signalTs] : '',
        match_start_time: c.matchStart ? row[c.matchStart] : '',
        timing_status: leadMinutes(row, c) === null ? 'timing_unproven_missing_timestamp' : leadMinutes(row, c) > 0 ? 'pre_start' : 'past_start_or_bad_timestamp'
      });
    }
  }
  const summary = {
    model_version: 'execution_feasibility_backtest_v1',
    input: { input_path: input, total_rows_loaded: records.length, official_base_rows: base.length, column_mapping: c },
    key_warning: c.signalTs && c.matchStart ? 'CSV contains timing columns, pre-start feasibility can be checked.' : 'CSV lacks signal_timestamp and/or match_start_time, so this backtest proves historical odds-band feasibility but cannot prove pre-start execution timing.',
    summaries,
    interpretation: [
      'If timing_coverage_rate is 0, use this as odds-band evidence only.',
      'To prove execution timing historically, the blind-sim CSV must include signal_timestamp and match_start_time.',
      'For actual live execution feasibility, use the live observation cycle with lead_minutes and odds tracking.'
    ]
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'execution-feasibility-backtest-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'execution-feasibility-backtest-rows.csv'), writeCsv(Object.keys(enrichedRows[0] ?? { rule: '' }), enrichedRows));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
