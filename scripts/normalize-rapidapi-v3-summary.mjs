#!/usr/bin/env node
/**
 * Normalize RapidAPI probe artifacts into SlipIQ V3 scanner summary format.
 *
 * Purpose:
 * - Read the generic RapidAPI probe CSV.
 * - Group detected 1st-set correct-score rows by likely market/event pointer.
 * - Emit upcoming_firstset_summary.json so the existing Supabase pusher can dry-run or ingest it.
 *
 * Safety:
 * - File-only transformer.
 * - No sportsbook login.
 * - No betting.
 * - No external network calls.
 */

import fs from 'node:fs';
import path from 'node:path';

const TARGET_SCORES = ['3:6', '4:6', '5:7'];

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    input: 'artifacts/output/rapidapi-oddsfeed-probe',
    csv: '',
    out: '',
    bookmaker: '1xBet',
    threshold: 3.3,
  };

  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--input=')) args.input = raw.slice('--input='.length);
    else if (raw.startsWith('--csv=')) args.csv = raw.slice('--csv='.length);
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--bookmaker=')) args.bookmaker = raw.slice('--bookmaker='.length);
    else if (raw.startsWith('--threshold=')) args.threshold = Number(raw.slice('--threshold='.length));
  }

  if (!args.csv) args.csv = path.join(args.input, 'normalized_candidate_odds.csv');
  if (!args.out) args.out = args.input;
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function groupedOdds(values) {
  if (values.some((v) => !(v > 1))) return null;
  return Number((1 / values.reduce((sum, v) => sum + 1 / v, 0)).toFixed(4));
}

function parseBool(value) {
  return ['true', '1', 'yes', 'y'].includes(normalizeText(value));
}

function parseNumber(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((v) => String(v).trim() !== '')).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    return obj;
  });
}

function inferGroupKey(row) {
  const pointer = String(row.pointer || '');
  const requestUrl = String(row.request_url || 'unknown_request');

  const cutPatterns = [
    /\.(outcomes?|selections?|bets?|prices?|odds)\[\d+\].*$/i,
    /\.(outcomes?|selections?|bets?|prices?|odds)\..*$/i,
  ];

  for (const re of cutPatterns) {
    if (re.test(pointer)) return `${requestUrl}::${pointer.replace(re, '')}`;
  }

  const eventMatch = pointer.match(/^(.+?\.(?:events?|fixtures?|matches?)\[\d+\])/i);
  if (eventMatch) return `${requestUrl}::${eventMatch[1]}`;

  return `${requestUrl}::${pointer || 'unknown_market'}`;
}

function guessFieldFromObjectText(text, fieldNames) {
  const raw = String(text || '');
  for (const field of fieldNames) {
    const re = new RegExp(`${field}["'\\s:=_-]{1,12}([^,"'|{}\\[\\]]{2,80})`, 'i');
    const match = raw.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function guessMatchName(rows) {
  const combined = rows.map((r) => r.object_text || '').join(' | ');
  const home = guessFieldFromObjectText(combined, ['home_team', 'homeTeam', 'home', 'player1', 'participant1']);
  const away = guessFieldFromObjectText(combined, ['away_team', 'awayTeam', 'away', 'player2', 'participant2']);

  if (home && away && home !== away) return `${home} vs ${away}`;

  const vsMatch = combined.match(/([A-Z][A-Za-z.' -]{2,40})\s+(?:vs|v|-|versus)\s+([A-Z][A-Za-z.' -]{2,40})/i);
  if (vsMatch) return `${vsMatch[1].trim()} vs ${vsMatch[2].trim()}`;

  return 'Unknown tennis match';
}

function buildSummary(rows, args) {
  const strict = rows.filter((row) => parseBool(row.bookmaker_matched) && parseBool(row.market_matched));
  const groups = new Map();

  for (const row of strict) {
    const score = String(row.score || '').trim();
    if (!TARGET_SCORES.includes(score)) continue;

    const decimal = parseNumber(row.decimal_odds);
    if (!decimal || decimal <= 1) continue;

    const key = inferGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        request_url: row.request_url || '',
        rows: [],
        scores: {},
      });
    }

    const group = groups.get(key);
    group.rows.push(row);

    // Keep the first likely strict hit per score. The probe sorts stronger rows first.
    if (!group.scores[score]) group.scores[score] = decimal;
  }

  const candidates = [];
  for (const group of groups.values()) {
    const o36 = group.scores['3:6'] || null;
    const o46 = group.scores['4:6'] || null;
    const o57 = group.scores['5:7'] || null;
    const hasAllScores = Boolean(o36 && o46 && o57);
    const grouped = hasAllScores ? groupedOdds([o36, o46, o57]) : null;
    const playable = Boolean(grouped && grouped >= args.threshold);
    const book = args.bookmaker || '1xBet';
    const officialBook = normalizeText(book).includes('bet365');

    candidates.push({
      scraped_at: nowIso(),
      source: 'rapidapi_oddsfeed_probe',
      match_name: guessMatchName(group.rows),
      match: guessMatchName(group.rows),
      tournament: null,
      player1: null,
      player2: null,
      bookmaker: book,
      price_source: book,
      request_url: group.request_url,
      odds_3_6_decimal: o36,
      odds_4_6_decimal: o46,
      odds_5_7_decimal: o57,
      odds_p2_6_3: o36,
      odds_p2_6_4: o46,
      odds_p2_7_5: o57,
      estimated_player2_9_12_odds: grouped,
      reconstructed_p2_9_12_odds: grouped,
      grouped_odds: grouped,
      total2_over_5_5_first_set_decimal: null,
      total2_over_5_5_first_set: null,
      playable,
      signal_tier: !hasAllScores ? 'SKIP' : playable ? (officialBook ? 'OFFICIAL' : 'WATCH') : 'SKIP',
      status: hasAllScores ? 'ok' : 'missing_scores',
      note: hasAllScores
        ? 'RapidAPI returned all V3 correct-score legs. Manual verification still required before execution.'
        : 'Missing one or more V3 legs: 3:6 / 4:6 / 5:7.',
      raw_rows_count: group.rows.length,
      raw_rows: group.rows.slice(0, 20),
    });
  }

  const actionable = candidates.filter((candidate) => candidate.playable);

  return {
    generated_at: nowIso(),
    mode: 'rapidapi_v3_normalized',
    source: 'rapidapi_oddsfeed_probe',
    safety: 'Read-only API artifact normalization. No sportsbook login. No betting. No credential storage.',
    target_bookmaker: args.bookmaker,
    target_market: '1st Set Correct Score',
    target_pattern: 'P2 V3 / 3:6 + 4:6 + 5:7',
    threshold: args.threshold,
    csv_input: args.csv,
    rows_loaded: rows.length,
    strict_rows_count: strict.length,
    candidates_count: candidates.length,
    actionable_count: actionable.length,
    availability: {
      candidate_rows_count: rows.length,
      bookmaker_matched_rows: rows.filter((r) => parseBool(r.bookmaker_matched)).length,
      first_set_correct_score_rows: rows.filter((r) => parseBool(r.market_matched)).length,
      exact_3_6_rows: rows.filter((r) => String(r.score).trim() === '3:6').length,
      exact_4_6_rows: rows.filter((r) => String(r.score).trim() === '4:6').length,
      exact_5_7_rows: rows.filter((r) => String(r.score).trim() === '5:7').length,
    },
    candidates,
    actionable_candidates: actionable,
    warning: 'WATCH means API/source-only signal. OFFICIAL requires bet365 baseline confirmation before using Telegram betting-intelligence alerts.',
  };
}

function main() {
  const args = parseArgs(process.argv);
  ensureDir(args.out);

  if (!fs.existsSync(args.csv)) {
    throw new Error(`Missing RapidAPI normalized CSV: ${args.csv}`);
  }

  const rows = parseCsv(fs.readFileSync(args.csv, 'utf8'));
  const summary = buildSummary(rows, args);

  fs.writeFileSync(path.join(args.out, 'rapidapi_v3_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(args.out, 'upcoming_firstset_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\nFINAL RAPIDAPI V3 NORMALIZED SUMMARY');
  console.log(JSON.stringify({
    generated_at: summary.generated_at,
    target_bookmaker: summary.target_bookmaker,
    rows_loaded: summary.rows_loaded,
    strict_rows_count: summary.strict_rows_count,
    candidates_count: summary.candidates_count,
    actionable_count: summary.actionable_count,
    availability: summary.availability,
  }, null, 2));
}

main();
