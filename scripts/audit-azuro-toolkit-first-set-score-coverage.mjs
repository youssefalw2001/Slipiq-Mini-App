#!/usr/bin/env node
/*
  SlipIQ / First Set Lab - Azuro Toolkit first-set score coverage audit.

  Safe audit only:
  - Reads locked First Set Lab receipt rows from Supabase.
  - Uses @azuro-org/toolkit feed helpers instead of guessed REST /games paths.
  - Checks game, first-set score market, target outcomes, odds, and optional limits.
  - Writes artifacts and optional Supabase audit rows.
*/

import fs from 'node:fs';
import path from 'node:path';
import {
  GameState,
  searchGames,
  getGamesByFilters,
  getConditionsByGameIds,
  getBetCalculation,
} from '@azuro-org/toolkit';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const SUPABASE_URL = args['supabase-url'] || process.env.SUPABASE_URL || 'https://qjvpkkcbscsypymxyker.supabase.co';
const SUPABASE_KEY = args['supabase-key'] || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CHAIN_ID = Number(args['chain-id'] || process.env.AZURO_CHAIN_ID || '137');
const ACCOUNT = args.account || process.env.AZURO_ACCOUNT || undefined;
const LIMIT = Number(args.limit || process.env.LIMIT || '50') || 50;
const PER_PAGE = Number(args['per-page'] || process.env.AZURO_PER_PAGE || '100') || 100;
const OUT_DIR = args.out || 'artifacts/output/azuro-toolkit-first-set-score-audit';
const RUN_ID = args['run-id'] || `azuro_toolkit_audit_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const WRITE_SUPABASE = String(args['write-supabase'] || process.env.WRITE_SUPABASE || 'true') !== 'false';
const MIN_GROUP_STAKE = Number(args['min-group-stake'] || process.env.MIN_GROUP_STAKE || '5') || 5;
const MIN_EDGE = Number(args['min-edge'] || process.env.MIN_EDGE || '0');

const ACTIVE_LANES = [
  'CORE_P1_ATP_GS_BET365',
  'CORE_P2_GS_REVERSE_STRETCH_BET365',
  'RESEARCH_P2_GS_26_46_BET365',
  'VIP_P2_V3_SHAPE',
];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v) { return clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9:.-]+/g, ' ').trim(); }
function n(v) { if (v === null || v === undefined || clean(v) === '') return null; const x = Number(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; }
function dec(v) { const x = n(v); if (!x || x <= 1) return null; return x > 1000000 ? x / 1e12 : x; }
function csvEscape(v) { const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(file, rows, fields) { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }

function scoreTargetsForLane(lane) {
  if (lane === 'CORE_P1_ATP_GS_BET365') return ['6:2', '6:3', '6:4'];
  if (lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'RESEARCH_P2_GS_26_46_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'VIP_P2_V3_SHAPE') return ['3:6', '4:6', '5:7'];
  return [];
}

function parsePlayers(matchName) {
  const raw = clean(matchName).replace(/\s+vs\.?\s+/i, ' v ').replace(/\s+@\s+/i, ' v ').replace(/\s+-\s+/i, ' v ');
  const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, ''];
}

function playerParts(name) {
  const raw = norm(name).replace(/\./g, ' ');
  const tokens = raw.split(/\s+/).filter(Boolean);
  const initials = tokens.filter((t) => t.length === 1);
  const words = tokens.filter((t) => t.length > 1);
  const surname = words.length ? words[words.length - 1] : (tokens[tokens.length - 1] || '');
  return { raw, tokens, initials, words, surname };
}

function scoreFromTitle(value) {
  const m = clean(value).replace('-', ':').match(/\b(\d+)\s*:\s*(\d+)\b/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function groupedOdds(values) {
  const xs = values.map(dec);
  if (!xs.length || xs.some((x) => !x || x <= 1)) return null;
  const implied = xs.reduce((sum, x) => sum + 1 / x, 0);
  return implied ? 1 / implied : null;
}

function baselineOdds(row) {
  const targets = scoreTargetsForLane(row.strategy_lane);
  const sj = row.score_odds_json && typeof row.score_odds_json === 'object' ? row.score_odds_json : {};
  const fromScores = targets.map((s) => sj[s]).filter((x) => x !== undefined);
  return fromScores.length === targets.length
    ? groupedOdds(fromScores)
    : dec(row.original_official_decimal_odds) || dec(row.official_decimal_odds) || dec(row.original_receipt_decimal_odds) || dec(row.receipt_decimal_odds);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  return body;
}

async function supabaseSelect(pathAndQuery) {
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return fetchJson(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } });
}

async function supabaseInsert(table, rows) {
  if (!WRITE_SUPABASE || !rows.length) return;
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  await fetchJson(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
}

function signalQuery() {
  const select = [
    'id','signal_key','scanned_at','event_date','starts_at','status','display_status','match_name','strategy_lane',
    'public_signal_name','public_tier','score_cluster','public_target','official_decimal_odds','receipt_decimal_odds',
    'original_score_cluster','original_public_target','original_public_signal_name','original_official_decimal_odds','original_receipt_decimal_odds','score_odds_json','protection_type'
  ].join(',');
  return `proof_vault_recent_receipts_v2_protected?select=${encodeURIComponent(select)}&strategy_lane=in.(${ACTIVE_LANES.join(',')})&order=scanned_at.desc&limit=${LIMIT}`;
}

async function loadSignals() {
  const rows = await supabaseSelect(signalQuery());
  return (rows || []).map((row) => ({
    ...row,
    target_scores: scoreTargetsForLane(row.strategy_lane),
    baseline_grouped_odds: baselineOdds(row),
  })).filter((row) => row.target_scores.length);
}

function gameText(game) {
  return norm([
    game.title,
    game.slug,
    game.sport?.name,
    game.sport?.slug,
    game.league?.name,
    game.country?.name,
    ...(Array.isArray(game.participants) ? game.participants.map((p) => p.name) : []),
  ].filter(Boolean).join(' '));
}

function playerMatchScore(player, text) {
  if (!player.surname) return 0;
  let score = 0;
  if (text.includes(player.surname)) score += 6;
  if (player.raw && text.includes(player.raw)) score += 3;
  for (const word of player.words) {
    if (word !== player.surname && word.length > 2 && text.includes(word)) score += 1;
  }
  for (const init of player.initials) {
    const initialRegex = new RegExp(`\\b${init}[a-z]+\\s+${player.surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (initialRegex.test(text)) score += 1;
  }
  return score;
}

function gameScore(signal, game) {
  const [p1Raw, p2Raw] = parsePlayers(signal.match_name);
  const p1 = playerParts(p1Raw);
  const p2 = playerParts(p2Raw);
  const tx = gameText(game);
  const eventMs = new Date(signal.starts_at || signal.event_date || signal.scanned_at).getTime();
  let score = playerMatchScore(p1, tx) + playerMatchScore(p2, tx);
  if (tx.includes('tennis')) score += 1;
  const startsAt = Number(game.startsAt || 0) * 1000;
  if (eventMs && startsAt && Math.abs(startsAt - eventMs) <= 72 * 3600 * 1000) score += 2;
  return { score, text: tx, title: clean(game.title || game.slug || game.gameId || game.id), startsAt: game.startsAt };
}

function chooseGame(signal, games) {
  const scored = (games || []).map((game) => ({ game, ...gameScore(signal, game) })).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 12 ? scored[0].game : null;
}

function topCandidates(signal, games, n = 5) {
  return (games || [])
    .map((game) => ({ gameId: game.gameId || game.id, title: clean(game.title || game.slug), startsAt: game.startsAt, ...gameScore(signal, game) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

async function discoverGame(signal) {
  const [p1, p2] = parsePlayers(signal.match_name);
  const pp1 = playerParts(p1);
  const pp2 = playerParts(p2);
  const queries = [`${p1} ${p2}`.trim(), `${pp1.surname} ${pp2.surname}`.trim(), pp1.surname, pp2.surname, p1, p2]
    .filter((q, i, arr) => clean(q).length >= 3 && arr.indexOf(q) === i);
  const errors = [];
  const diagnostics = [];
  for (const query of queries) {
    try {
      const result = await searchGames({ chainId: CHAIN_ID, query, page: 1, perPage: PER_PAGE });
      const games = result?.games || [];
      diagnostics.push({ method: 'searchGames', query, count: games.length, top: topCandidates(signal, games, 3) });
      const game = chooseGame(signal, games);
      if (game) return { game, method: 'searchGames', raw: games, diagnostics };
    } catch (error) {
      errors.push(`searchGames(${query}) => ${error.message}`);
    }
  }
  for (const state of [GameState.Prematch, GameState.Live]) {
    try {
      const result = await getGamesByFilters({ chainId: CHAIN_ID, state, sportSlug: 'tennis', page: 1, perPage: PER_PAGE });
      const games = result?.games || [];
      diagnostics.push({ method: 'getGamesByFilters', state, count: games.length, top: topCandidates(signal, games, 5) });
      const game = chooseGame(signal, games);
      if (game) return { game, method: `getGamesByFilters:${state}`, raw: games, diagnostics };
    } catch (error) {
      errors.push(`getGamesByFilters(${state}) => ${error.message}`);
    }
  }
  return { game: null, method: null, raw: null, errors, diagnostics };
}

function isFirstSetScore(condition) {
  const tx = norm(condition.title || '');
  return (/first|1st|set 1|1 set/.test(tx) && tx.includes('score') && !tx.includes('match correct score'));
}

function findCondition(conditions, targets) {
  const list = Array.isArray(conditions) ? conditions : (conditions?.conditions || conditions?.items || []);
  const candidates = list.filter(isFirstSetScore);
  const fallback = candidates.length ? candidates : list;
  let best = null;
  for (const condition of fallback) {
    const scoreMap = Object.fromEntries((condition.outcomes || []).map((outcome) => [scoreFromTitle(outcome.title), outcome]).filter(([score]) => score));
    const hits = targets.filter((score) => scoreMap[score]).length;
    if (!best || hits > best.hits) best = { condition, scoreMap, hits };
  }
  return best?.hits ? best : null;
}

async function calcLimit(conditionId, outcomeId) {
  try {
    return await getBetCalculation({ chainId: CHAIN_ID, selections: [{ conditionId, outcomeId }], account: ACCOUNT });
  } catch (error) {
    return { error: error.message };
  }
}

function maxGroupStake(rows) {
  if (rows.some((r) => !dec(r.odds) || !n(r.maxBet))) return null;
  const caps = rows.map((r) => n(r.maxBet) * dec(r.odds));
  const groupReturnCap = Math.min(...caps);
  const implied = rows.reduce((sum, r) => sum + 1 / dec(r.odds), 0);
  return implied ? groupReturnCap * implied : null;
}

function classify(row) {
  if (!row.azuro_game_id) return ['MISSING_GAME', 'No Azuro Toolkit game matched this signal'];
  if (!row.azuro_condition_id) return ['MISSING_MARKET', 'Game found but no first-set correct-score market/condition matched'];
  const found = Object.keys(row.score_outcomes_json || {});
  const missing = row.target_scores.filter((score) => !found.includes(score));
  if (missing.length) return ['MISSING_SCORE', `Missing target score outcomes: ${missing.join(', ')}`];
  if (!row.azuro_grouped_odds) return ['BAD_ODDS', 'Target scores found but odds were missing/unparseable'];
  if (row.baseline_grouped_odds && row.edge_vs_baseline < MIN_EDGE) return ['BAD_ODDS', `Azuro grouped odds edge below threshold: ${row.edge_vs_baseline}`];
  if (row.max_group_stake === null) return ['LIMIT_UNKNOWN', 'Coverage passed, but getBetCalculation did not return maxBet for every score'];
  if (row.max_group_stake < MIN_GROUP_STAKE) return ['LOW_LIMIT', `Max grouped stake ${row.max_group_stake.toFixed(2)} below ${MIN_GROUP_STAKE}`];
  return ['BETTABLE', 'Toolkit found game, market, target scores, odds, and configured minimum liquidity'];
}

async function auditSignal(signal) {
  const base = {
    source: 'azuro_toolkit_first_set_score_audit',
    run_id: RUN_ID,
    signal_id: signal.id,
    signal_key: signal.signal_key,
    match_name: signal.match_name,
    event_date: signal.event_date,
    starts_at: signal.starts_at,
    strategy_lane: signal.strategy_lane,
    public_signal_name: signal.original_public_signal_name || signal.public_signal_name,
    model_bucket: ['CORE_P1_ATP_GS_BET365','CORE_P2_GS_REVERSE_STRETCH_BET365'].includes(signal.strategy_lane) ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP' : 'OPTIMIZED_VIP',
    target_scores: signal.target_scores,
    baseline_grouped_odds: signal.baseline_grouped_odds,
  };
  try {
    const found = await discoverGame(signal);
    if (!found.game) {
      const reason = `No Toolkit game matched. Diagnostics: ${JSON.stringify((found.diagnostics || []).slice(0, 4))}`;
      return { ...base, decision: 'MISSING_GAME', reason, score_outcomes_json: {}, raw_match_json: { errors: found.errors || [], diagnostics: found.diagnostics || [] }, raw_conditions_json: null, raw_calculations_json: null };
    }
    const game = found.game;
    const gameId = game.gameId || game.id;
    const conditionsResult = await getConditionsByGameIds({ chainId: CHAIN_ID, gameIds: [gameId] });
    const conditions = Array.isArray(conditionsResult) ? conditionsResult : (conditionsResult?.conditions || conditionsResult?.items || conditionsResult?.data || []);
    const picked = findCondition(conditions, signal.target_scores);
    if (!picked) {
      const row = { ...base, azuro_game_id: gameId, azuro_game_title: game.title, azuro_league: game.league?.name, azuro_sport: game.sport?.name, score_outcomes_json: {}, raw_match_json: { game, discovery: found.diagnostics || [] }, raw_conditions_json: conditionsResult, raw_calculations_json: null };
      const [decision, reason] = classify(row);
      return { ...row, decision, reason };
    }
    const condition = picked.condition;
    const outcomeRows = [];
    const calcs = {};
    for (const score of signal.target_scores) {
      const outcome = picked.scoreMap[score];
      if (!outcome) continue;
      const calc = await calcLimit(condition.conditionId || condition.id, outcome.outcomeId || outcome.id);
      calcs[score] = calc;
      outcomeRows.push({
        score,
        outcomeId: outcome.outcomeId || outcome.id,
        odds: dec(outcome.odds || outcome.currentOdds || outcome.price),
        title: outcome.title,
        maxBet: n(calc.maxBet),
        maxPayout: n(calc.maxPayout),
        minBet: n(calc.minBet),
      });
    }
    const azuroGrouped = groupedOdds(outcomeRows.map((r) => r.odds));
    const row = {
      ...base,
      azuro_game_id: gameId,
      azuro_game_title: game.title,
      azuro_league: game.league?.name,
      azuro_sport: game.sport?.name,
      azuro_condition_id: condition.conditionId || condition.id,
      azuro_market_title: condition.title,
      score_outcomes_json: Object.fromEntries(outcomeRows.map((r) => [r.score, r])),
      azuro_grouped_odds: azuroGrouped,
      edge_vs_baseline: azuroGrouped && signal.baseline_grouped_odds ? azuroGrouped - signal.baseline_grouped_odds : null,
      min_score_max_bet: outcomeRows.every((r) => n(r.maxBet) !== null) ? Math.min(...outcomeRows.map((r) => n(r.maxBet))) : null,
      min_score_max_payout: outcomeRows.every((r) => n(r.maxPayout) !== null) ? Math.min(...outcomeRows.map((r) => n(r.maxPayout))) : null,
      max_group_stake: maxGroupStake(outcomeRows),
      raw_match_json: { game, discovery: found.diagnostics || [] },
      raw_conditions_json: condition,
      raw_calculations_json: calcs,
    };
    const [decision, reason] = classify(row);
    return { ...row, decision, reason };
  } catch (error) {
    return { ...base, decision: 'API_ERROR', reason: error.message, score_outcomes_json: {}, raw_match_json: { error: error.stack || error.message }, raw_conditions_json: null, raw_calculations_json: null };
  }
}

function summarize(rows) {
  const out = {};
  for (const row of rows) out[row.decision] = (out[row.decision] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

function csvRow(row) {
  return {
    run_id: row.run_id,
    match_name: row.match_name,
    event_date: row.event_date,
    strategy_lane: row.strategy_lane,
    target_scores: row.target_scores,
    baseline_grouped_odds: row.baseline_grouped_odds,
    azuro_game_id: row.azuro_game_id,
    azuro_game_title: row.azuro_game_title,
    azuro_market_title: row.azuro_market_title,
    azuro_grouped_odds: row.azuro_grouped_odds,
    edge_vs_baseline: row.edge_vs_baseline,
    min_score_max_bet: row.min_score_max_bet,
    min_score_max_payout: row.min_score_max_payout,
    max_group_stake: row.max_group_stake,
    decision: row.decision,
    reason: row.reason,
  };
}

async function main() {
  ensureDir(OUT_DIR);
  console.log(JSON.stringify({ run_id: RUN_ID, chain_id: CHAIN_ID, limit: LIMIT, per_page: PER_PAGE }, null, 2));
  const signals = await loadSignals();
  const rows = [];
  for (const signal of signals) {
    console.log(`Toolkit audit ${signal.match_name} ${signal.strategy_lane}`);
    rows.push(await auditSignal(signal));
  }
  const fields = ['run_id','match_name','event_date','strategy_lane','target_scores','baseline_grouped_odds','azuro_game_id','azuro_game_title','azuro_market_title','azuro_grouped_odds','edge_vs_baseline','min_score_max_bet','min_score_max_payout','max_group_stake','decision','reason'];
  writeCsv(path.join(OUT_DIR, 'azuro_toolkit_first_set_score_audit.csv'), rows.map(csvRow), fields);
  writeJson(path.join(OUT_DIR, 'azuro_toolkit_first_set_score_audit.json'), rows);
  const summary = { run_id: RUN_ID, generated_at: new Date().toISOString(), chain_id: CHAIN_ID, signals_checked: rows.length, decisions: summarize(rows), note: 'Safe Toolkit coverage audit only. No signing, no order creation, no wallet action. Matching is surname-aware and diagnostics are stored in raw_match_json.' };
  writeJson(path.join(OUT_DIR, 'azuro_toolkit_first_set_score_summary.json'), summary);
  fs.writeFileSync(path.join(OUT_DIR, 'azuro_toolkit_first_set_score_report.md'), ['# Azuro Toolkit First-Set Score Audit', '', `Run ID: ${RUN_ID}`, `Generated: ${summary.generated_at}`, `Chain ID: ${CHAIN_ID}`, `Signals checked: ${rows.length}`, '', '## Decisions', ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`), '', '## Notes', '- Uses @azuro-org/toolkit searchGames/getGamesByFilters/getConditionsByGameIds/getBetCalculation.', '- Matching is surname-aware for abbreviated names like C. Ruud vs T. Paul.', '- Safe audit only: no signing, no order creation, no wallet action.'].join('\n') + '\n', 'utf8');
  if (WRITE_SUPABASE) await supabaseInsert('azuro_execution_audit_v1', rows);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
