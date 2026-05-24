#!/usr/bin/env node
/*
  First Set Lab / SlipIQ bookmaker portability audit.

  Purpose:
  - Start with the current Bet365 upgraded main model signals.
  - For the exact same matches and score groups, compare every other bookmaker
    available in the API Tennis first-set correct-score warehouse.
  - Find which books have complete coverage, equal-or-better grouped prices,
    and stronger historical units.

  No API calls. No Supabase writes. Artifact-only research.
*/

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const warehouseDir = params['warehouse-dir'] || 'combined-warehouse';
const outDir = params.out || 'artifacts/output/bookmaker-portability-audit';
const sourceBookmaker = String(params['source-bookmaker'] || 'bet365').toLowerCase();
const minSignals = Number(params['min-signals'] || '10');
const widePath = path.join(warehouseDir, 'first_set_correct_score_wide_combined.csv');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function safeNumber(v) {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}
async function streamCsv(filePath, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  let header = null;
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line && lineNo > 1) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells; continue; }
    if (!cells.some((c) => c !== '')) continue;
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
    await onRow(row, lineNo);
  }
}
function writeCsv(filePath, rows, fields) {
  ensureDir(path.dirname(filePath));
  const out = fs.createWriteStream(filePath, 'utf8');
  out.write(fields.join(',') + '\n');
  for (const row of rows) out.write(fields.map((f) => csvEscape(row[f])).join(',') + '\n');
  out.end();
}
function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}
function odds(row, score) { return safeNumber(row[`odds_${score.replace(':', '_')}`]); }
function groupedOdds(values) {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + 1 / v, 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
}
function decimalToAmerican(decimal) {
  const d = safeNumber(decimal);
  if (!d || d <= 1) return '';
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function scoreSkewBucket(values) {
  const nums = values.map(safeNumber);
  if (nums.length < 2 || nums.some((o) => !o || o <= 1)) return 'UNKNOWN';
  const ratio = nums.length === 2 ? Math.max(...nums) / Math.min(...nums) : nums[1] / ((nums[0] + nums[nums.length - 1]) / 2);
  if (ratio < 0.80) return 'LOW';
  if (ratio < 1.15) return 'MID';
  if (ratio < 1.75) return 'HIGH';
  return 'EXTREME';
}
function normalizeScore(v) { return clean(v).replace('-', ':'); }
function tour(row) {
  const key = clean(row.event_type_key);
  const type = `${row.event_type_type ?? ''} ${row.tournament_name ?? ''}`.toLowerCase();
  if (key === '265' || /\batp\b|men/.test(type)) return 'ATP';
  if (key === '266' || /\bwta\b|women/.test(type)) return 'WTA';
  return 'UNKNOWN';
}
function tournamentGroup(row) {
  const t = clean(row.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['barcelona', 'halle', 'queen', 'queens', 'london', 'stuttgart', 'charleston', 'washington', 'hamburg', 'tokyo', 'acapulco', 'eastbourne', 'rotterdam', 'basel', 'vienna', 'adelaide', 'brisbane', 'bad homburg', 'berlin', 'strasbourg', 'antwerp', 'dallas', 'rio', 'astana', 'chengdu', 'zhuhai', 'seoul'].some((k) => t.includes(k))) return 'STRONG_500_250';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}
function pct(n, d) { return d ? Number(((n / d) * 100).toFixed(2)) : 0; }

const lanes = [
  {
    lane_key: 'CORE_P1_ATP_GS_BET365', public_signal_name: 'Core Cluster',
    tour: 'ATP', tournament_group: 'GRAND_SLAM',
    target_scores: ['6:2', '6:3', '6:4'], qualifying_scores: ['6:3', '6:4'],
    trigger_score: '6:4', trigger_min: 5.00, trigger_max: 6.25,
    min_qualifying_grouped: 2.50, max_qualifying_grouped: null, required_skew: null,
  },
  {
    lane_key: 'CORE_P2_GS_REVERSE_STRETCH_BET365', public_signal_name: 'Reverse Stretch Cluster',
    tour: 'ANY', tournament_group: 'GRAND_SLAM',
    target_scores: ['2:6', '4:6', '5:7'], qualifying_scores: ['2:6', '4:6'],
    trigger_score: '', trigger_min: null, trigger_max: null,
    min_qualifying_grouped: 2.50, max_qualifying_grouped: 4.50, required_skew: 'EXTREME',
  },
];

function laneFixtureMatch(row, lane) {
  const rowTour = tour(row);
  const rowGroup = tournamentGroup(row);
  if (lane.tour !== 'ANY' && rowTour !== lane.tour) return false;
  if (lane.tournament_group !== 'ANY' && rowGroup !== lane.tournament_group) return false;
  return true;
}
function passSourceLane(row, lane) {
  if (clean(row.bookmaker).toLowerCase() !== sourceBookmaker) return { pass: false, reason: 'wrong_source_bookmaker' };
  if (!laneFixtureMatch(row, lane)) return { pass: false, reason: 'wrong_fixture_bucket' };
  const qualifyingOdds = lane.qualifying_scores.map((s) => odds(row, s));
  if (qualifyingOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_qualifying_scores' };
  const qualifyingGrouped = groupedOdds(qualifyingOdds);
  if (!qualifyingGrouped || qualifyingGrouped < lane.min_qualifying_grouped) return { pass: false, reason: 'qualifying_grouped_below_floor' };
  if (lane.max_qualifying_grouped && qualifyingGrouped > lane.max_qualifying_grouped) return { pass: false, reason: 'qualifying_grouped_above_ceiling' };
  const skew = scoreSkewBucket(qualifyingOdds);
  if (lane.required_skew && skew !== lane.required_skew) return { pass: false, reason: 'wrong_skew' };
  if (lane.trigger_score) {
    const triggerOdds = odds(row, lane.trigger_score);
    if (!triggerOdds || triggerOdds < lane.trigger_min || triggerOdds > lane.trigger_max) return { pass: false, reason: 'trigger_out_of_range' };
  }
  const targetOdds = lane.target_scores.map((s) => odds(row, s));
  if (targetOdds.some((v) => !v || v <= 1)) return { pass: false, reason: 'missing_protected_scores' };
  return { pass: true, qualifyingGrouped, protectedGrouped: groupedOdds(targetOdds), skew };
}

function ensureBook(bookStats, bookmaker) {
  const key = clean(bookmaker) || 'UNKNOWN';
  if (!bookStats.has(key)) {
    bookStats.set(key, {
      bookmaker: key,
      available_rows: 0,
      complete_rows: 0,
      equal_or_better_rows: 0,
      better_rows: 0,
      wins: 0,
      losses: 0,
      group_units: 0,
      receipt_units: 0,
      sum_grouped: 0,
      sum_delta: 0,
      lane_counts: new Map(),
    });
  }
  return bookStats.get(key);
}
function addLaneCount(stat, laneKey) {
  stat.lane_counts.set(laneKey, (stat.lane_counts.get(laneKey) || 0) + 1);
}

async function main() {
  if (!fs.existsSync(widePath)) {
    console.error(`Missing required warehouse file: ${widePath}`);
    process.exit(2);
  }
  ensureDir(outDir);

  const acceptedSignals = new Map();
  const sourceSignals = [];

  console.log('Pass 1: finding accepted source Bet365 upgraded model signals...');
  await streamCsv(widePath, (row) => {
    for (const lane of lanes) {
      const res = passSourceLane(row, lane);
      if (!res.pass) continue;
      const eventKey = clean(row.event_key);
      const firstSetScore = normalizeScore(row.first_set_score);
      if (!eventKey || !/^\d+:\d+$/.test(firstSetScore)) continue;
      const win = lane.target_scores.includes(firstSetScore);
      const exactReceiptOdds = win ? odds(row, firstSetScore) : null;
      const signal = {
        signal_id: `${eventKey}|${lane.lane_key}`,
        event_key: eventKey,
        event_date: row.event_date,
        event_time: row.event_time,
        match_name: row.match_name,
        tournament_name: row.tournament_name,
        lane_key: lane.lane_key,
        public_signal_name: lane.public_signal_name,
        target_scores: lane.target_scores,
        target_scores_text: lane.target_scores.join('/'),
        first_set_score: firstSetScore,
        result: win ? 'WIN' : 'LOSS',
        source_grouped_odds: res.protectedGrouped,
        source_grouped_american: decimalToAmerican(res.protectedGrouped),
        source_receipt_odds: exactReceiptOdds || '',
        source_receipt_american: exactReceiptOdds ? decimalToAmerican(exactReceiptOdds) : '',
        source_group_units: Number((win ? res.protectedGrouped - 1 : -1).toFixed(6)),
      };
      acceptedSignals.set(signal.signal_id, signal);
      sourceSignals.push(signal);
    }
  });

  const eventToSignals = new Map();
  for (const signal of sourceSignals) {
    if (!eventToSignals.has(signal.event_key)) eventToSignals.set(signal.event_key, []);
    eventToSignals.get(signal.event_key).push(signal);
  }

  const bookStats = new Map();
  const rowsOut = [];
  console.log(`Found ${sourceSignals.length} source signals. Pass 2: comparing other bookmakers...`);
  await streamCsv(widePath, (row) => {
    const eventKey = clean(row.event_key);
    if (!eventToSignals.has(eventKey)) return;
    const bookmaker = clean(row.bookmaker) || 'UNKNOWN';
    const signals = eventToSignals.get(eventKey);
    for (const signal of signals) {
      const stat = ensureBook(bookStats, bookmaker);
      stat.available_rows += 1;
      addLaneCount(stat, signal.lane_key);
      const targetOdds = signal.target_scores.map((score) => odds(row, score));
      const hasComplete = targetOdds.every((v) => v && v > 1);
      if (!hasComplete) {
        rowsOut.push({
          signal_id: signal.signal_id,
          event_date: signal.event_date,
          match_name: signal.match_name,
          lane_key: signal.lane_key,
          bookmaker,
          has_complete_scores: 'false',
          grouped_decimal_odds: '',
          grouped_american_odds: '',
          source_grouped_odds: signal.source_grouped_odds,
          price_delta_vs_source: '',
          equal_or_better_than_source: 'false',
          result: signal.result,
          group_profit_units: '',
          target_scores: signal.target_scores_text,
          first_set_score: signal.first_set_score,
        });
        continue;
      }
      const grouped = groupedOdds(targetOdds);
      const equalOrBetter = grouped >= signal.source_grouped_odds;
      const better = grouped > signal.source_grouped_odds;
      const win = signal.result === 'WIN';
      const receiptOdds = win ? odds(row, signal.first_set_score) : null;
      const groupUnits = win ? grouped - 1 : -1;
      const receiptUnits = win && receiptOdds ? receiptOdds - 1 : -1;

      stat.complete_rows += 1;
      if (equalOrBetter) stat.equal_or_better_rows += 1;
      if (better) stat.better_rows += 1;
      if (win) stat.wins += 1;
      else stat.losses += 1;
      stat.group_units += groupUnits;
      stat.receipt_units += receiptUnits;
      stat.sum_grouped += grouped;
      stat.sum_delta += grouped - signal.source_grouped_odds;

      rowsOut.push({
        signal_id: signal.signal_id,
        event_date: signal.event_date,
        match_name: signal.match_name,
        lane_key: signal.lane_key,
        bookmaker,
        has_complete_scores: 'true',
        grouped_decimal_odds: Number(grouped.toFixed(6)),
        grouped_american_odds: decimalToAmerican(grouped),
        source_grouped_odds: signal.source_grouped_odds,
        price_delta_vs_source: Number((grouped - signal.source_grouped_odds).toFixed(6)),
        equal_or_better_than_source: String(equalOrBetter),
        result: signal.result,
        group_profit_units: Number(groupUnits.toFixed(6)),
        target_scores: signal.target_scores_text,
        first_set_score: signal.first_set_score,
      });
    }
  });

  const sourceBets = sourceSignals.length;
  const summaryRows = [...bookStats.values()].map((s) => ({
    bookmaker: s.bookmaker,
    source_signals: sourceBets,
    available_rows: s.available_rows,
    complete_rows: s.complete_rows,
    coverage_pct: pct(s.complete_rows, sourceBets),
    equal_or_better_rows: s.equal_or_better_rows,
    equal_or_better_pct: pct(s.equal_or_better_rows, s.complete_rows),
    better_rows: s.better_rows,
    better_pct: pct(s.better_rows, s.complete_rows),
    wins: s.wins,
    losses: s.losses,
    hit_rate_pct: pct(s.wins, s.wins + s.losses),
    group_profit_units: Number(s.group_units.toFixed(6)),
    group_roi_pct: s.complete_rows ? Number(((s.group_units / s.complete_rows) * 100).toFixed(2)) : 0,
    receipt_profit_units: Number(s.receipt_units.toFixed(6)),
    avg_grouped_decimal_odds: s.complete_rows ? Number((s.sum_grouped / s.complete_rows).toFixed(6)) : 0,
    avg_grouped_american_odds: s.complete_rows ? decimalToAmerican(s.sum_grouped / s.complete_rows) : '',
    avg_price_delta_vs_source: s.complete_rows ? Number((s.sum_delta / s.complete_rows).toFixed(6)) : 0,
    core_rows: s.lane_counts.get('CORE_P1_ATP_GS_BET365') || 0,
    reverse_rows: s.lane_counts.get('CORE_P2_GS_REVERSE_STRETCH_BET365') || 0,
  })).sort((a, b) => {
    const aQualified = a.complete_rows >= minSignals ? 1 : 0;
    const bQualified = b.complete_rows >= minSignals ? 1 : 0;
    if (aQualified !== bQualified) return bQualified - aQualified;
    if (a.coverage_pct !== b.coverage_pct) return b.coverage_pct - a.coverage_pct;
    return b.group_profit_units - a.group_profit_units;
  });

  const recommended = summaryRows
    .filter((r) => r.complete_rows >= minSignals)
    .map((r) => ({
      ...r,
      automation_candidate_score: Number((r.coverage_pct * 0.50 + Math.max(r.equal_or_better_pct, 0) * 0.25 + Math.max(r.group_roi_pct, 0) * 0.25).toFixed(2)),
    }))
    .sort((a, b) => b.automation_candidate_score - a.automation_candidate_score);

  const summary = {
    generated_at: new Date().toISOString(),
    mode: 'bookmaker_portability_audit_from_warehouse',
    source_file: widePath,
    source_bookmaker: sourceBookmaker,
    source_signals: sourceBets,
    graded_source_signals: sourceBets,
    source_summary: {
      wins: sourceSignals.filter((s) => s.result === 'WIN').length,
      losses: sourceSignals.filter((s) => s.result === 'LOSS').length,
      group_profit_units: Number(sourceSignals.reduce((sum, s) => sum + s.source_group_units, 0).toFixed(6)),
      avg_grouped_decimal_odds: sourceSignals.length ? Number((sourceSignals.reduce((sum, s) => sum + s.source_grouped_odds, 0) / sourceSignals.length).toFixed(6)) : 0,
    },
    bookmaker_summary: summaryRows,
    recommended_candidates: recommended.slice(0, 15),
    notes: [
      'Coverage means the bookmaker had all exact scores needed for the same Bet365 source signal.',
      'Equal-or-better means the other bookmaker grouped price was >= the Bet365 grouped price for that same signal.',
      'This does not prove automation is allowed. Use only official permitted APIs for automated betting.',
    ],
  };

  writeJson(path.join(outDir, 'bookmaker_portability_summary.json'), summary);
  writeCsv(path.join(outDir, 'bookmaker_portability_book_summary.csv'), summaryRows, Object.keys(summaryRows[0] || {}));
  writeCsv(path.join(outDir, 'bookmaker_portability_recommended.csv'), recommended, Object.keys(recommended[0] || {}));
  writeCsv(path.join(outDir, 'bookmaker_portability_rows.csv'), rowsOut, ['signal_id','event_date','match_name','lane_key','bookmaker','has_complete_scores','grouped_decimal_odds','grouped_american_odds','source_grouped_odds','price_delta_vs_source','equal_or_better_than_source','result','group_profit_units','target_scores','first_set_score']);

  const report = [
    '# Bookmaker Portability Audit',
    '',
    `Generated: ${summary.generated_at}`,
    `Source bookmaker/model: ${sourceBookmaker} upgraded Core + Reverse`,
    `Source signals: ${sourceBets}`,
    '',
    '## Source model',
    `- Wins/Losses: ${summary.source_summary.wins}W / ${summary.source_summary.losses}L`,
    `- Group units: ${summary.source_summary.group_profit_units}`,
    `- Avg grouped odds: ${summary.source_summary.avg_grouped_decimal_odds}`,
    '',
    '## Top portability candidates',
    ...recommended.slice(0, 12).map((r) => `- ${r.bookmaker}: coverage ${r.coverage_pct}%, equal/better ${r.equal_or_better_pct}%, units ${r.group_profit_units}, ROI ${r.group_roi_pct}%, avg delta ${r.avg_price_delta_vs_source}`),
    '',
    '## Read this correctly',
    '- Good coverage + equal/better prices means the signal may port well to that book.',
    '- Poor coverage means the book cannot reliably copy the same score-group signal.',
    '- Strong historical ROI on another book does not mean automated betting is allowed. Use only official approved APIs.',
  ];
  fs.writeFileSync(path.join(outDir, 'bookmaker_portability_report.md'), report.join('\n'), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
