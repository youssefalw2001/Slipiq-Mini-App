#!/usr/bin/env node
/*
  First Set Lab Azuro / DGPredict first-set correct-score coverage auditor.

  SAFE MODE ONLY:
  - Does not place bets.
  - Does not sign wallet transactions.
  - Checks whether open First Set Lab signals can be matched to Azuro/DGPredict
    markets, whether all exact-score legs exist, and whether grouped odds / limits
    are good enough.

  Required env:
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY

  Optional env / args:
  - AZURO_API_BASE or --azuro-api-base=https://...
  - AZURO_APP_ID or --app-id=dgpredict
  - AZURO_CHAIN_ID or --chain-id=137
  - AZURO_ENVIRONMENT or --environment=Polygon

  Because Azuro/DGPredict endpoints and app IDs can differ by deployment, the
  script is intentionally configurable and produces clear SKIP/API_ERROR rows
  rather than failing silently.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const SUPABASE_URL = args['supabase-url'] || process.env.SUPABASE_URL || 'https://qjvpkkcbscsypymxyker.supabase.co';
const SUPABASE_KEY = args['supabase-key'] || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const AZURO_API_BASE = (args['azuro-api-base'] || process.env.AZURO_API_BASE || 'https://api.azuro.org').replace(/\/$/, '');
const AZURO_APP_ID = args['app-id'] || process.env.AZURO_APP_ID || 'dgpredict';
const AZURO_CHAIN_ID = args['chain-id'] || process.env.AZURO_CHAIN_ID || '';
const AZURO_ENVIRONMENT = args.environment || process.env.AZURO_ENVIRONMENT || '';
const limit = Number(args.limit || process.env.LIMIT || '50') || 50;
const outDir = args.out || 'artifacts/output/azuro-dgpredict-coverage-audit';
const runId = args['run-id'] || `azuro_audit_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const writeSupabase = String(args['write-supabase'] || process.env.WRITE_SUPABASE || 'true') !== 'false';
const minEdge = Number(args['min-edge'] || process.env.MIN_EDGE || '0');
const minGroupStake = Number(args['min-group-stake'] || process.env.MIN_GROUP_STAKE || '5');

const FETCH_TIMEOUT_MS = Number(args.timeout || process.env.AZURO_TIMEOUT_MS || '15000') || 15000;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v) { return clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function num(v) { if (v === null || v === undefined || clean(v) === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function csvEscape(v) { const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(file, rows, fields) { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function groupedOdds(scoreOdds) { const xs = scoreOdds.map(num); if (xs.some((x) => !x || x <= 1)) return null; const implied = xs.reduce((s, x) => s + 1 / x, 0); return implied ? 1 / implied : null; }
function scoreTargetsForLane(lane) {
  if (lane === 'CORE_P1_ATP_GS_BET365') return ['6:2', '6:3', '6:4'];
  if (lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'RESEARCH_P2_GS_26_46_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'VIP_P2_V3_SHAPE') return ['3:6', '4:6', '5:7'];
  return [];
}
function parsePlayers(matchName) {
  const raw = clean(matchName)
    .replace(/\s+vs\.?\s+/i, ' v ')
    .replace(/\s+@\s+/i, ' v ')
    .replace(/\s+-\s+/i, ' v ');
  const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, ''];
}
function eventTimeWindow(signal) {
  const base = signal.starts_at || signal.event_date;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  return { from: new Date(d.getTime() - 12 * 3600 * 1000).toISOString(), to: new Date(d.getTime() + 36 * 3600 * 1000).toISOString() };
}
async function fetchJson(url, options = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}
async function supabaseSelect(pathAndQuery) {
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  return fetchJson(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } });
}
async function supabaseInsert(table, rows) {
  if (!writeSupabase || !rows.length) return null;
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');
  return fetchJson(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
}
function signalQuery() {
  const select = [
    'id', 'signal_key', 'event_date', 'starts_at', 'match_name', 'strategy_lane', 'public_signal_name', 'public_tier',
    'score_cluster', 'public_target', 'official_decimal_odds', 'original_official_decimal_odds', 'score_odds_json', 'status', 'display_status',
  ].join(',');
  const lanes = 'CORE_P1_ATP_GS_BET365,CORE_P2_GS_REVERSE_STRETCH_BET365,RESEARCH_P2_GS_26_46_BET365,VIP_P2_V3_SHAPE';
  // Prefer currently open signals if the view exposes them. If none exist, caller falls back to recent settled rows for dry-run market matching.
  return `proof_vault_recent_receipts_v2_protected?select=${encodeURIComponent(select)}&strategy_lane=in.(${lanes})&order=event_date.desc&limit=${limit}`;
}
async function loadSignals() {
  const rows = await supabaseSelect(signalQuery());
  return (rows || []).map((r) => {
    const targets = scoreTargetsForLane(r.strategy_lane);
    const scoreOdds = targets.map((s) => num(r.score_odds_json?.[s]));
    const baseline = groupedOdds(scoreOdds) || num(r.original_official_decimal_odds) || num(r.official_decimal_odds);
    return { ...r, target_scores: targets, baseline_grouped_odds: baseline };
  }).filter((r) => r.target_scores.length);
}
function buildGameSearchCandidates(signal) {
  const [p1, p2] = parsePlayers(signal.match_name);
  const q = encodeURIComponent(`${p1} ${p2}`.trim());
  const t = eventTimeWindow(signal);
  const params = new URLSearchParams();
  params.set('appId', AZURO_APP_ID);
  if (AZURO_CHAIN_ID) params.set('chainId', AZURO_CHAIN_ID);
  if (AZURO_ENVIRONMENT) params.set('environment', AZURO_ENVIRONMENT);
  params.set('sport', 'tennis');
  params.set('query', `${p1} ${p2}`.trim());
  if (t) { params.set('dateFrom', t.from); params.set('dateTo', t.to); }
  return [
    `${AZURO_API_BASE}/games?${params.toString()}`,
    `${AZURO_API_BASE}/feed/games?${params.toString()}`,
    `${AZURO_API_BASE}/api/games?${params.toString()}`,
    `${AZURO_API_BASE}/backend/games?${params.toString()}`,
    `${AZURO_API_BASE}/games/search?q=${q}`,
  ];
}
function flattenGames(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ['games', 'data', 'items', 'results']) if (Array.isArray(body[key])) return body[key];
  if (body.data && Array.isArray(body.data.games)) return body.data.games;
  return [];
}
function gameText(g) { return norm([g.title, g.name, g.game?.title, g.participants?.map?.((p) => p.name || p.title).join(' '), g.league?.name, g.tournament?.name].filter(Boolean).join(' ')); }
function chooseBestGame(signal, games) {
  const [p1, p2] = parsePlayers(signal.match_name).map(norm);
  const t = eventTimeWindow(signal);
  const scored = games.map((g) => {
    const tx = gameText(g);
    let score = 0;
    if (p1 && tx.includes(p1)) score += 4;
    if (p2 && tx.includes(p2)) score += 4;
    if (tx.includes('tennis')) score += 1;
    const start = g.startsAt || g.startTime || g.starts_at || g.date || g.startDate;
    if (start && t) {
      const ts = new Date(start).getTime();
      if (ts >= new Date(t.from).getTime() && ts <= new Date(t.to).getTime()) score += 2;
    }
    return { g, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 6 ? scored[0].g : null;
}
async function findGame(signal) {
  const urls = buildGameSearchCandidates(signal);
  const errors = [];
  for (const url of urls) {
    try {
      const body = await fetchJson(url);
      const games = flattenGames(body);
      const match = chooseBestGame(signal, games);
      if (match) return { game: match, raw: body, url };
    } catch (err) {
      errors.push(`${url} => ${err.message}`);
    }
  }
  return { game: null, raw: null, errors };
}
function conditionUrls(game) {
  const gameId = game.id || game.gameId || game.game?.id || game.azuroGameId;
  const params = new URLSearchParams();
  params.set('appId', AZURO_APP_ID);
  if (AZURO_CHAIN_ID) params.set('chainId', AZURO_CHAIN_ID);
  if (AZURO_ENVIRONMENT) params.set('environment', AZURO_ENVIRONMENT);
  params.set('gameId', String(gameId));
  return [
    `${AZURO_API_BASE}/conditions?${params.toString()}`,
    `${AZURO_API_BASE}/feed/conditions?${params.toString()}`,
    `${AZURO_API_BASE}/api/conditions?${params.toString()}`,
    `${AZURO_API_BASE}/backend/conditions?${params.toString()}`,
    `${AZURO_API_BASE}/games/${gameId}/conditions?${params.toString()}`,
  ];
}
function flattenConditions(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ['conditions', 'markets', 'data', 'items', 'results']) if (Array.isArray(body[key])) return body[key];
  if (body.data && Array.isArray(body.data.conditions)) return body.data.conditions;
  return [];
}
function isFirstSetCorrectScoreMarket(condition) {
  const tx = norm([condition.title, condition.name, condition.marketName, condition.market?.title, condition.market?.name].filter(Boolean).join(' '));
  return /first|1st/.test(tx) && /correct|score/.test(tx) && /score/.test(tx);
}
function extractOutcomes(condition) {
  const outcomes = condition.outcomes || condition.selections || condition.outcomeEntities || condition.odds || [];
  return Array.isArray(outcomes) ? outcomes : [];
}
function outcomeScore(outcome) {
  const raw = clean(outcome.title || outcome.name || outcome.label || outcome.outcomeName || outcome.selectionName || outcome.value || '').replace('-', ':');
  const m = raw.match(/\b(\d)\s*[:\-]\s*(\d)\b/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function outcomeOdds(outcome) {
  return num(outcome.odds) || num(outcome.price) || num(outcome.decimalOdds) || (num(outcome.currentOdds) ? num(outcome.currentOdds) : null);
}
function findConditionForScores(conditions, scores) {
  const firstSetMarkets = conditions.filter(isFirstSetCorrectScoreMarket);
  const candidates = firstSetMarkets.length ? firstSetMarkets : conditions.filter((c) => extractOutcomes(c).some((o) => scores.includes(outcomeScore(o))));
  let best = null;
  for (const c of candidates) {
    const outcomes = extractOutcomes(c);
    const scoreMap = Object.fromEntries(outcomes.map((o) => [outcomeScore(o), o]).filter(([s]) => s));
    const hits = scores.filter((s) => scoreMap[s]).length;
    if (!best || hits > best.hits) best = { condition: c, scoreMap, hits };
  }
  return best;
}
async function getConditions(game) {
  const urls = conditionUrls(game);
  const errors = [];
  for (const url of urls) {
    try {
      const body = await fetchJson(url);
      const conditions = flattenConditions(body);
      if (conditions.length) return { conditions, raw: body, url };
    } catch (err) {
      errors.push(`${url} => ${err.message}`);
    }
  }
  return { conditions: [], raw: null, errors };
}
function calcUrls(conditionId, outcomeId) {
  const payload = { appId: AZURO_APP_ID, chainId: AZURO_CHAIN_ID || undefined, environment: AZURO_ENVIRONMENT || undefined, conditionId, outcomeId };
  return [
    { url: `${AZURO_API_BASE}/bet/calculation`, method: 'POST', body: payload },
    { url: `${AZURO_API_BASE}/backend/betting/calculation`, method: 'POST', body: payload },
    { url: `${AZURO_API_BASE}/api/betting/calculation`, method: 'POST', body: payload },
    { url: `${AZURO_API_BASE}/calculation`, method: 'POST', body: payload },
  ];
}
function calcResponseOdds(body) { return num(body?.odds) || num(body?.data?.odds) || num(body?.result?.odds); }
function calcResponseMaxBet(body) { return num(body?.maxBet) || num(body?.data?.maxBet) || num(body?.result?.maxBet); }
function calcResponseMaxPayout(body) { return num(body?.maxPayout) || num(body?.data?.maxPayout) || num(body?.result?.maxPayout); }
async function calculateOutcome(conditionId, outcomeId, fallbackOdds) {
  const errors = [];
  for (const c of calcUrls(conditionId, outcomeId)) {
    try {
      const body = await fetchJson(c.url, { method: c.method, body: JSON.stringify(c.body) });
      return { raw: body, odds: calcResponseOdds(body) || fallbackOdds, maxBet: calcResponseMaxBet(body), maxPayout: calcResponseMaxPayout(body), url: c.url };
    } catch (err) {
      errors.push(`${c.url} => ${err.message}`);
    }
  }
  return { raw: { errors }, odds: fallbackOdds, maxBet: null, maxPayout: null, url: null };
}
function decisionFor(result) {
  if (!result.azuro_game_id) return ['MISSING_GAME', 'No matching Azuro/DGPredict tennis game found'];
  if (!result.azuro_condition_id) return ['MISSING_MARKET', 'No first-set correct-score condition/market found'];
  const scores = result.target_scores || [];
  const outcomeScores = Object.keys(result.score_outcomes_json || {});
  const missing = scores.filter((s) => !outcomeScores.includes(s));
  if (missing.length) return ['MISSING_SCORE', `Missing target scores: ${missing.join(', ')}`];
  if (!result.azuro_grouped_odds) return ['BAD_ODDS', 'Could not calculate Azuro grouped odds'];
  if (result.baseline_grouped_odds && result.edge_vs_baseline < minEdge) return ['BAD_ODDS', `Azuro grouped odds below baseline by ${Math.abs(result.edge_vs_baseline).toFixed(4)}`];
  if (result.max_group_stake !== null && result.max_group_stake < minGroupStake) return ['LOW_LIMIT', `Max grouped stake ${result.max_group_stake.toFixed(2)} below ${minGroupStake}`];
  return ['BETTABLE', 'All target scores found and grouped odds/limits pass configured thresholds'];
}
function maxGroupStake(outcomeRows) {
  const rows = outcomeRows.filter((r) => num(r.odds) && (num(r.maxBet) || num(r.maxPayout)));
  if (!rows.length) return null;
  const caps = rows.map((r) => {
    const byBet = num(r.maxBet) ? num(r.maxBet) * num(r.odds) : Infinity;
    const byPayout = num(r.maxPayout) || Infinity;
    return Math.min(byBet, byPayout);
  }).filter((x) => Number.isFinite(x));
  if (!caps.length) return null;
  const groupReturnCap = Math.min(...caps);
  const impliedSum = outcomeRows.reduce((s, r) => s + (num(r.odds) ? 1 / num(r.odds) : 0), 0);
  return impliedSum ? groupReturnCap * impliedSum : null;
}
async function auditSignal(signal) {
  const targetScores = signal.target_scores;
  const baseResult = {
    run_id: runId,
    signal_id: signal.id,
    signal_key: signal.signal_key,
    match_name: signal.match_name,
    event_date: signal.event_date,
    starts_at: signal.starts_at,
    strategy_lane: signal.strategy_lane,
    public_signal_name: signal.public_signal_name,
    model_bucket: signal.strategy_lane === 'CORE_P1_ATP_GS_BET365' || signal.strategy_lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365' ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP' : 'OPTIMIZED_VIP',
    target_scores: targetScores,
    baseline_grouped_odds: signal.baseline_grouped_odds,
  };
  try {
    const gameSearch = await findGame(signal);
    if (!gameSearch.game) {
      const row = { ...baseResult, decision: 'MISSING_GAME', reason: `No game match. ${gameSearch.errors?.slice(0, 2).join(' | ') || ''}`, raw_match_json: gameSearch.raw || { errors: gameSearch.errors || [] } };
      return row;
    }
    const game = gameSearch.game;
    const azuroGameId = String(game.id || game.gameId || game.game?.id || game.azuroGameId || '');
    const conditionResult = await getConditions(game);
    const picked = findConditionForScores(conditionResult.conditions, targetScores);
    if (!picked?.condition) {
      const row = { ...baseResult, azuro_game_id: azuroGameId, azuro_game_title: clean(game.title || game.name || game.game?.title), azuro_league: clean(game.league?.name || game.tournament?.name), azuro_sport: clean(game.sport?.name || game.sport), decision: 'MISSING_MARKET', reason: `No first-set correct-score market found. ${conditionResult.errors?.slice(0, 2).join(' | ') || ''}`, raw_match_json: game, raw_conditions_json: conditionResult.raw || { errors: conditionResult.errors || [] } };
      return row;
    }
    const condition = picked.condition;
    const conditionId = String(condition.conditionId || condition.id || condition.marketId || '');
    const outcomeRows = [];
    const rawCalcs = {};
    for (const score of targetScores) {
      const outcome = picked.scoreMap[score];
      if (!outcome) continue;
      const outcomeId = String(outcome.outcomeId || outcome.id || outcome.selectionId || outcome.selection_id || '');
      const fallbackOdds = outcomeOdds(outcome);
      const calc = outcomeId && conditionId ? await calculateOutcome(conditionId, outcomeId, fallbackOdds) : { odds: fallbackOdds, maxBet: null, maxPayout: null, raw: { skipped: 'missing conditionId/outcomeId' } };
      outcomeRows.push({ score, outcomeId, odds: calc.odds, maxBet: calc.maxBet, maxPayout: calc.maxPayout, title: clean(outcome.title || outcome.name || outcome.label) });
      rawCalcs[score] = calc.raw;
    }
    const azuroGrouped = groupedOdds(outcomeRows.map((r) => r.odds));
    const mgs = maxGroupStake(outcomeRows);
    const minMaxBet = outcomeRows.some((r) => num(r.maxBet)) ? Math.min(...outcomeRows.map((r) => num(r.maxBet)).filter((x) => x !== null)) : null;
    const minMaxPayout = outcomeRows.some((r) => num(r.maxPayout)) ? Math.min(...outcomeRows.map((r) => num(r.maxPayout)).filter((x) => x !== null)) : null;
    const row = {
      ...baseResult,
      azuro_game_id: azuroGameId,
      azuro_game_title: clean(game.title || game.name || game.game?.title),
      azuro_league: clean(game.league?.name || game.tournament?.name),
      azuro_sport: clean(game.sport?.name || game.sport),
      azuro_condition_id: conditionId,
      azuro_market_title: clean(condition.title || condition.name || condition.marketName || condition.market?.title),
      score_outcomes_json: Object.fromEntries(outcomeRows.map((r) => [r.score, r])),
      azuro_grouped_odds: azuroGrouped,
      edge_vs_baseline: azuroGrouped && signal.baseline_grouped_odds ? azuroGrouped - signal.baseline_grouped_odds : null,
      min_score_max_bet: minMaxBet,
      min_score_max_payout: minMaxPayout,
      max_group_stake: mgs,
      raw_match_json: game,
      raw_conditions_json: condition,
      raw_calculations_json: rawCalcs,
    };
    const [decision, reason] = decisionFor(row);
    row.decision = decision;
    row.reason = reason;
    return row;
  } catch (err) {
    return { ...baseResult, decision: 'API_ERROR', reason: err.message, raw_match_json: { error: err.stack || err.message } };
  }
}
function summarize(rows) {
  const by = new Map();
  for (const r of rows) by.set(r.decision, (by.get(r.decision) || 0) + 1);
  return Object.fromEntries([...by.entries()].sort());
}
async function main() {
  ensureDir(outDir);
  const signals = await loadSignals();
  const rows = [];
  for (const signal of signals) {
    console.log(`Auditing ${signal.match_name} ${signal.strategy_lane}`);
    rows.push(await auditSignal(signal));
  }
  const fields = ['run_id','signal_id','match_name','event_date','starts_at','strategy_lane','public_signal_name','target_scores','baseline_grouped_odds','azuro_game_id','azuro_game_title','azuro_market_title','azuro_grouped_odds','edge_vs_baseline','min_score_max_bet','min_score_max_payout','max_group_stake','decision','reason'];
  writeCsv(path.join(outDir, 'azuro_dgpredict_coverage_audit.csv'), rows, fields);
  writeJson(path.join(outDir, 'azuro_dgpredict_coverage_audit.json'), rows);
  const summary = { run_id: runId, generated_at: new Date().toISOString(), azuro_api_base: AZURO_API_BASE, app_id: AZURO_APP_ID, chain_id: AZURO_CHAIN_ID, environment: AZURO_ENVIRONMENT, signals_checked: rows.length, decisions: summarize(rows), note: 'No bets placed. Coverage/odds/liquidity audit only.' };
  writeJson(path.join(outDir, 'azuro_dgpredict_coverage_summary.json'), summary);
  fs.writeFileSync(path.join(outDir, 'azuro_dgpredict_coverage_report.md'), ['# Azuro / DGPredict Coverage Audit', '', `Run ID: ${runId}`, `Generated: ${summary.generated_at}`, `API base: ${AZURO_API_BASE}`, `App ID: ${AZURO_APP_ID}`, `Signals checked: ${rows.length}`, '', '## Decisions', ...Object.entries(summary.decisions).map(([k,v]) => `- ${k}: ${v}`), '', '## Notes', '- No wallet signing.', '- No bets placed.', '- BETTABLE only means the API audit found all score legs and configured odds/limit checks passed.', '- Still require manual wallet confirmation and legal/compliance review before staking.'].join('\n') + '\n', 'utf8');
  if (writeSupabase) await supabaseInsert('azuro_execution_audit_v1', rows);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
