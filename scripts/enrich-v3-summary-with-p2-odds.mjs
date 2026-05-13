#!/usr/bin/env node
/*!
 * Optional SlipIQ V3 enrichment step.
 *
 * Adds Player 2 match odds to an odds scanner summary before pushing to Supabase.
 * This lets the V3 push script require both:
 * - synthetic P2 match-odds filter, and
 * - live grouped first-set correct-score price confirmation.
 *
 * Input methods:
 * 1) --p2-odds-json='{"Darderi L.":1.42,"Rublev A.":6.5}'
 * 2) --p2-odds-file=path/to/map.json
 * 3) existing row.player2_match_odds already present in summary
 *
 * This script is read-only and never places bets.
 */

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const inputPath = params.input || 'artifacts/output/oddsportal-upcoming-firstset/upcoming_firstset_summary.json';
const outputPath = params.output || inputPath;
const jsonArg = params['p2-odds-json'] || process.env.P2_MATCH_ODDS_JSON || '';
const fileArg = params['p2-odds-file'] || process.env.P2_MATCH_ODDS_FILE || '';

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function key(s) {
  return String(s || '').trim().toLowerCase();
}

function loadMap() {
  let map = {};
  if (fileArg && fs.existsSync(fileArg)) {
    map = { ...map, ...JSON.parse(fs.readFileSync(fileArg, 'utf8')) };
  }
  if (jsonArg) {
    map = { ...map, ...JSON.parse(jsonArg) };
  }
  const normalized = new Map();
  for (const [k, v] of Object.entries(map)) {
    const n = asNumber(v);
    if (n) normalized.set(key(k), n);
  }
  return normalized;
}

function p1(row) {
  return row.home_team || row.player1 || row.player_one || '';
}
function p2(row) {
  return row.away_team || row.player2 || row.player_two || '';
}
function matchName(row) {
  return `${p1(row)} vs ${p2(row)}`;
}
function reverseMatchName(row) {
  return `${p2(row)} vs ${p1(row)}`;
}

function enrichRow(row, oddsMap) {
  const existing = asNumber(row.player2_match_odds ?? row.p2_match_odds ?? row.odd_2 ?? row.Odd_2);
  if (existing) return { ...row, player2_match_odds: existing, p2_match_odds_enrichment_source: row.p2_match_odds_enrichment_source || 'existing' };

  const candidates = [
    p2(row),
    matchName(row),
    reverseMatchName(row),
    row.match_link,
  ].filter(Boolean).map(key);

  for (const c of candidates) {
    if (oddsMap.has(c)) {
      return { ...row, player2_match_odds: oddsMap.get(c), p2_match_odds_enrichment_source: 'map' };
    }
  }
  return { ...row, p2_match_odds_enrichment_source: 'missing' };
}

function enrichArray(rows, oddsMap) {
  return Array.isArray(rows) ? rows.map((row) => enrichRow(row, oddsMap)) : rows;
}

if (!fs.existsSync(inputPath)) {
  throw new Error(`Missing summary JSON: ${inputPath}`);
}

const summary = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const oddsMap = loadMap();

summary.actionable_candidates = enrichArray(summary.actionable_candidates, oddsMap);
summary.candidates = enrichArray(summary.candidates, oddsMap);
summary.target_bookmaker_rows_top_50 = enrichArray(summary.target_bookmaker_rows_top_50, oddsMap);
summary.v3_p2_match_odds_enrichment = {
  generated_at: new Date().toISOString(),
  map_entries: oddsMap.size,
  actionable_with_p2_match_odds: (summary.actionable_candidates || []).filter((row) => asNumber(row.player2_match_odds)).length,
  actionable_total: (summary.actionable_candidates || []).length,
  note: 'P2 match odds may come from the scanner row itself or an optional enrichment map. Telegram alerts require this value by default.',
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  event: 'v3_enrichment_done',
  inputPath,
  outputPath,
  ...summary.v3_p2_match_odds_enrichment,
}, null, 2));
