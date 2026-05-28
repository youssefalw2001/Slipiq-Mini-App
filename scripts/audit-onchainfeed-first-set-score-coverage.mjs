#!/usr/bin/env node
/*
  First Set Lab / SlipIQ Onchainfeed Azuro V3 coverage auditor.

  SAFE MODE ONLY:
  - Does not sign EIP-712 payloads.
  - Does not submit orders.
  - Does not store or require private keys.
  - Checks whether First Set Lab Protected-3 target score groups can be mapped
    to Onchainfeed/Azuro tennis first-set correct-score markets with enough
    quoted liquidity before any execution layer is considered.

  Intended use:
  - Run manually via GitHub Actions.
  - Write audit rows to public.azuro_execution_audit_v1 using service role only.
  - Treat BETTABLE as execution-readiness, not a bet recommendation.
*/

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const SUPABASE_URL = args['supabase-url'] || process.env.SUPABASE_URL || 'https://qjvpkkcbscsypymxyker.supabase.co';
const SUPABASE_KEY = args['supabase-key'] || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const AZURO_API_BASE = (args['azuro-api-base'] || process.env.AZURO_API_BASE || 'https://api.onchainfeed.org/api/v1/public').replace(/\/$/, '');
const AZURO_ENVIRONMENT = args.environment || process.env.AZURO_ENVIRONMENT || 'PolygonUSDT';
const AZURO_CHAIN_ID = args['chain-id'] || process.env.AZURO_CHAIN_ID || '';
const APP_ID = args['app-id'] || process.env.AZURO_APP_ID || 'dgpredict';
const BETTOR = args.bettor || process.env.BETTOR_ADDRESS || '0x0000000000000000000000000000000000000000';
const TOKEN_DECIMALS = Number(args['token-decimals'] || process.env.BET_TOKEN_DECIMALS || '6') || 6;
const LIMIT = Number(args.limit || process.env.LIMIT || '50') || 50;
const MIN_GROUP_STAKE = Number(args['min-group-stake'] || process.env.MIN_GROUP_STAKE || '5') || 5;
const MIN_EDGE = Number(args['min-edge'] || process.env.MIN_EDGE || '0');
const STAKE_PROBE = Number(args['stake-probe'] || process.env.STAKE_PROBE || '1') || 1;
const WRITE_SUPABASE = String(args['write-supabase'] || process.env.WRITE_SUPABASE || 'true') !== 'false';
const SIGNAL_VIEW = args['signal-view'] || process.env.SIGNAL_VIEW || 'proof_vault_recent_receipts_v2_protected';
const OUT_DIR = args.out || process.env.OUT_DIR || 'artifacts/output/onchainfeed-first-set-score-audit';
const RUN_ID = args['run-id'] || `onchainfeed_audit_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const FETCH_TIMEOUT_MS = Number(args.timeout || process.env.ONCHAINFEED_TIMEOUT_MS || '15000') || 15000;

const ACTIVE_LANES = [
  'CORE_P1_ATP_GS_BET365',
  'CORE_P2_GS_REVERSE_STRETCH_BET365',
  'RESEARCH_P2_GS_26_46_BET365',
  'VIP_P2_V3_SHAPE',
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9:.-]+/g, ' ')
    .trim();
}

function num(value) {
  if (value === null || value === undefined || clean(value) === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeScore(value) {
  const m = clean(value).replace('-', ':').match(/\b(\d+)\s*:\s*(\d+)\b/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function decimalOdds(value) {
  const n = num(value);
  if (!n || n <= 1) return null;
  return n > 1000000 ? n / 1e12 : n;
}

function humanAmount(value) {
  const n = num(value);
  if (n === null || n < 0) return null;
  const s = String(value);
  if (s.includes('.')) return n;
  if (n >= 100000) {
    try {
      return Number(BigInt(s)) / 10 ** TOKEN_DECIMALS;
    } catch {
      return n;
    }
  }
  return n;
}

function csvEscape(value) {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, rows, fields) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, [fields.join(','), ...rows.map((row) => fields.map((f) => csvEscape(row[f])).join(','))].join('\n') + '\n', 'utf8');
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function firstDefined(obj, paths) {
  for (const pathName of paths) {
    const value = pathName.split('.').reduce((acc, key) => {
      if (!acc || typeof acc !== 'object') return undefined;
      return acc[key];
    }, obj);
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return undefined;
}

function arrayish(value) {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === 'object');
  return [];
}

function flattenList(body, keys = ['games', 'conditions', 'markets', 'data', 'items', 'results']) {
  if (Array.isArray(body)) return arrayish(body);
  if (!body || typeof body !== 'object') return [];
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return arrayish(value);
    if (value && typeof value === 'object') {
      for (const nested of keys) {
        if (Array.isArray(value[nested])) return arrayish(value[nested]);
      }
    }
  }
  return [];
}

function scoreTargetsForLane(lane) {
  if (lane === 'CORE_P1_ATP_GS_BET365') return ['6:2', '6:3', '6:4'];
  if (lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'RESEARCH_P2_GS_26_46_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'VIP_P2_V3_SHAPE') return ['3:6', '4:6', '5:7'];
  return [];
}

function groupedOdds(scoreOdds) {
  const odds = scoreOdds.map(decimalOdds);
  if (odds.some((x) => !x || x <= 1)) return null;
  const implied = odds.reduce((sum, x) => sum + 1 / x, 0);
  return implied ? 1 / implied : null;
}

function oddsFromScoreJson(scoreOddsJson, targets) {
  const obj = scoreOddsJson && typeof scoreOddsJson === 'object' ? scoreOddsJson : {};
  return targets.map((score) => obj[score] ?? obj[score.replace(':', '-')] ?? obj[score.replace(':', '_')]);
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
  return {
    from: new Date(d.getTime() - 12 * 3600 * 1000).toISOString(),
    to: new Date(d.getTime() + 36 * 3600 * 1000).toISOString(),
  };
}

async function fetchJson(url, options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: ctl.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { text };
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function supabaseSelect(pathAndQuery) {
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return fetchJson(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
  });
}

async function supabaseInsert(table, rows) {
  if (!WRITE_SUPABASE || !rows.length) return;
  if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  await fetchJson(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
}

function signalQuery() {
  const select = [
    'id',
    'signal_key',
    'event_date',
    'starts_at',
    'match_name',
    'strategy_lane',
    'public_signal_name',
    'public_tier',
    'score_cluster',
    'public_target',
    'official_decimal_odds',
    'original_official_decimal_odds',
    'score_odds_json',
    'status',
    'display_status',
  ].join(',');
  return `${SIGNAL_VIEW}?select=${encodeURIComponent(select)}&strategy_lane=in.(${ACTIVE_LANES.join(',')})&order=event_date.desc&limit=${LIMIT}`;
}

async function loadSignals() {
  const rows = await supabaseSelect(signalQuery());
  return (rows || [])
    .map((row) => {
      const targets = scoreTargetsForLane(row.strategy_lane);
      const scoreOdds = oddsFromScoreJson(row.score_odds_json, targets);
      const baseline = groupedOdds(scoreOdds) || decimalOdds(row.original_official_decimal_odds) || decimalOdds(row.official_decimal_odds);
      return { ...row, target_scores: targets, baseline_grouped_odds: baseline };
    })
    .filter((row) => row.target_scores.length);
}

function gameSearchUrls(signal) {
  const [p1, p2] = parsePlayers(signal.match_name);
  const t = eventTimeWindow(signal);
  const params = new URLSearchParams();
  params.set('environment', AZURO_ENVIRONMENT);
  params.set('appId', APP_ID);
  params.set('sport', 'tennis');
  params.set('query', `${p1} ${p2}`.trim());
  if (AZURO_CHAIN_ID) params.set('chainId', AZURO_CHAIN_ID);
  if (t) {
    params.set('dateFrom', t.from);
    params.set('dateTo', t.to);
    params.set('from', t.from);
    params.set('to', t.to);
  }
  const q = encodeURIComponent(`${p1} ${p2}`.trim());
  return [
    `${AZURO_API_BASE}/games?${params}`,
    `${AZURO_API_BASE}/feed/games?${params}`,
    `${AZURO_API_BASE}/market-manager/games?${params}`,
    `${AZURO_API_BASE}/games/search?q=${q}&environment=${encodeURIComponent(AZURO_ENVIRONMENT)}`,
  ];
}

function gameText(game) {
  return norm([
    game.title,
    game.name,
    game.game?.title,
    game.eventName,
    game.matchName,
    arrayish(game.participants).map((p) => p.name || p.title).join(' '),
    arrayish(game.competitors).map((p) => p.name || p.title).join(' '),
    game.league?.name,
    game.tournament?.name,
    game.sport?.name,
    game.sport,
  ].filter(Boolean).join(' '));
}

function chooseBestGame(signal, games) {
  const [p1, p2] = parsePlayers(signal.match_name).map(norm);
  const t = eventTimeWindow(signal);
  const scored = games.map((game) => {
    const tx = gameText(game);
    let score = 0;
    if (p1 && tx.includes(p1)) score += 4;
    if (p2 && tx.includes(p2)) score += 4;
    if (tx.includes('tennis')) score += 1;
    const start = firstDefined(game, ['startsAt', 'startTime', 'starts_at', 'date', 'startDate']);
    if (start && t) {
      const ts = new Date(start).getTime();
      if (ts >= new Date(t.from).getTime() && ts <= new Date(t.to).getTime()) score += 2;
    }
    return { game, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.score >= 6 ? scored[0].game : null;
}

async function findGame(signal) {
  const errors = [];
  for (const url of gameSearchUrls(signal)) {
    try {
      const body = await fetchJson(url);
      const games = flattenList(body, ['games', 'data', 'items', 'results']);
      const match = chooseBestGame(signal, games);
      if (match) return { game: match, url, raw: body };
    } catch (error) {
      errors.push(`${url} => ${error.message}`);
    }
  }
  return { game: null, errors };
}

function gameId(game) {
  return clean(firstDefined(game, ['id', 'gameId', 'game.id', 'azuroGameId', 'eventId']));
}

function conditionUrls(game) {
  const id = gameId(game);
  const params = new URLSearchParams();
  params.set('environment', AZURO_ENVIRONMENT);
  params.set('appId', APP_ID);
  params.set('gameId', id);
  if (AZURO_CHAIN_ID) params.set('chainId', AZURO_CHAIN_ID);
  return [
    `${AZURO_API_BASE}/conditions?${params}`,
    `${AZURO_API_BASE}/feed/conditions?${params}`,
    `${AZURO_API_BASE}/market-manager/conditions?${params}`,
    `${AZURO_API_BASE}/games/${encodeURIComponent(id)}/conditions?${params}`,
  ];
}

function isFirstSetCorrectScoreMarket(condition) {
  const tx = norm([
    condition.title,
    condition.name,
    condition.marketName,
    condition.market?.title,
    condition.market?.name,
    condition.period,
    condition.scope,
    condition.type,
  ].filter(Boolean).join(' '));
  return (/first|1st|set 1|1 set/.test(tx) || condition.setNumber === 1 || condition.periodNumber === 1)
    && /correct|score/.test(tx)
    && /score/.test(tx)
    && !/match correct score/.test(tx);
}

function extractOutcomes(condition) {
  return arrayish(firstDefined(condition, ['outcomes', 'selections', 'outcomeEntities', 'odds', 'market.outcomes']));
}

function outcomeScore(outcome) {
  return normalizeScore(firstDefined(outcome, ['title', 'name', 'label', 'outcomeName', 'selectionName', 'value']) || '');
}

function outcomeId(outcome) {
  return clean(firstDefined(outcome, ['outcomeId', 'id', 'selectionId', 'selection_id']));
}

function outcomeOdds(outcome) {
  return decimalOdds(firstDefined(outcome, ['odds', 'price', 'decimalOdds', 'currentOdds', 'valueOdds']));
}

function findConditionForScores(conditions, scores) {
  const firstSetMarkets = conditions.filter(isFirstSetCorrectScoreMarket);
  const candidates = firstSetMarkets.length ? firstSetMarkets : conditions.filter((condition) => {
    const outcomes = extractOutcomes(condition);
    return outcomes.some((outcome) => scores.includes(outcomeScore(outcome)));
  });
  let best = null;
  for (const condition of candidates) {
    const outcomes = extractOutcomes(condition);
    const scoreMap = Object.fromEntries(outcomes.map((outcome) => [outcomeScore(outcome), outcome]).filter(([score]) => score));
    const hits = scores.filter((score) => scoreMap[score]).length;
    if (!best || hits > best.hits) best = { condition, scoreMap, hits };
  }
  return best;
}

async function getConditions(game) {
  const errors = [];
  for (const url of conditionUrls(game)) {
    try {
      const body = await fetchJson(url);
      const conditions = flattenList(body, ['conditions', 'markets', 'data', 'items', 'results']);
      if (conditions.length) return { conditions, raw: body, url };
    } catch (error) {
      errors.push(`${url} => ${error.message}`);
    }
  }
  return { conditions: [], errors };
}

function calcPayloads(conditionId, outcomeId, amountRaw) {
  const common = {
    environment: AZURO_ENVIRONMENT,
    appId: APP_ID,
    chainId: AZURO_CHAIN_ID || undefined,
    bettor: BETTOR,
    account: BETTOR,
  };
  const bet = { conditionId, outcomeId, amount: amountRaw || undefined };
  return [
    { path: '/bet/orders/calculate', body: { ...common, bets: [bet] } },
    { path: '/bet/orders/calculate', body: { ...common, conditionId, outcomeId, amount: amountRaw || undefined } },
    { path: '/bet/calculation', body: { ...common, bets: [bet] } },
    { path: '/bet/calculation', body: { ...common, conditionId, outcomeId, amount: amountRaw || undefined } },
  ];
}

function unwrapCalc(body) {
  if (Array.isArray(body)) return body[0] || {};
  if (!body || typeof body !== 'object') return {};
  for (const key of ['data', 'result', 'calculation', 'order']) {
    if (Array.isArray(body[key])) return body[key][0] || {};
    if (body[key] && typeof body[key] === 'object') return body[key];
  }
  return body;
}

function calcOdds(body) {
  const x = unwrapCalc(body);
  return decimalOdds(firstDefined(x, ['odds', 'decimalOdds', 'price', 'bet.odds']));
}

function calcMaxBet(body) {
  const x = unwrapCalc(body);
  return humanAmount(firstDefined(x, ['maxBet', 'maxStake', 'maxAmount', 'limits.maxBet', 'limits.maxStake']));
}

function calcMaxPayout(body) {
  const x = unwrapCalc(body);
  return humanAmount(firstDefined(x, ['maxPayout', 'maxWin', 'limits.maxPayout', 'limits.maxWin']));
}

async function calculateOutcome(conditionId, outcomeIdValue, fallbackOdds, amountRaw = '') {
  const errors = [];
  for (const candidate of calcPayloads(conditionId, outcomeIdValue, amountRaw)) {
    try {
      const raw = await fetchJson(`${AZURO_API_BASE}${candidate.path}`, {
        method: 'POST',
        body: JSON.stringify(candidate.body),
      });
      return {
        raw,
        url: `${AZURO_API_BASE}${candidate.path}`,
        odds: calcOdds(raw) || fallbackOdds,
        maxBet: calcMaxBet(raw),
        maxPayout: calcMaxPayout(raw),
      };
    } catch (error) {
      errors.push(`${candidate.path} => ${error.message}`);
    }
  }
  return { raw: { errors }, url: null, odds: fallbackOdds, maxBet: null, maxPayout: null };
}

function stakeProbeRaw() {
  return String(Math.round(STAKE_PROBE * 10 ** TOKEN_DECIMALS));
}

function maxGroupStake(outcomeRows) {
  const rows = outcomeRows.filter((row) => decimalOdds(row.odds) && (num(row.maxBet) || num(row.maxPayout)));
  if (!rows.length) return null;
  const caps = rows.map((row) => {
    const odds = decimalOdds(row.odds);
    const byBet = num(row.maxBet) ? num(row.maxBet) * odds : Infinity;
    const byPayout = num(row.maxPayout) || Infinity;
    return Math.min(byBet, byPayout);
  }).filter((x) => Number.isFinite(x));
  if (!caps.length) return null;
  const groupReturnCap = Math.min(...caps);
  const impliedSum = outcomeRows.reduce((sum, row) => {
    const odds = decimalOdds(row.odds);
    return sum + (odds ? 1 / odds : 0);
  }, 0);
  return impliedSum ? groupReturnCap * impliedSum : null;
}

function decisionFor(row) {
  if (!row.azuro_game_id) return ['MISSING_GAME', 'No matching Onchainfeed/Azuro tennis game found'];
  if (!row.azuro_condition_id) return ['MISSING_MARKET', 'No first-set correct-score market found'];
  const scores = row.target_scores || [];
  const outcomeScores = Object.keys(row.score_outcomes_json || {});
  const missing = scores.filter((score) => !outcomeScores.includes(score));
  if (missing.length) return ['MISSING_SCORE', `Missing target scores: ${missing.join(', ')}`];
  if (!row.azuro_grouped_odds) return ['BAD_ODDS', 'Could not calculate Onchainfeed grouped odds'];
  if (row.baseline_grouped_odds && row.edge_vs_baseline < MIN_EDGE) return ['BAD_ODDS', `Onchainfeed grouped odds below configured edge threshold: ${row.edge_vs_baseline}`];
  if (row.max_group_stake === null) return ['LOW_LIMIT', 'Could not verify max grouped stake from calculation API'];
  if (row.max_group_stake < MIN_GROUP_STAKE) return ['LOW_LIMIT', `Max grouped stake ${row.max_group_stake.toFixed(2)} below ${MIN_GROUP_STAKE}`];
  return ['BETTABLE', 'All target scores found and odds/liquidity checks passed. Audit only; no signature or order submitted.'];
}

async function auditSignal(signal) {
  const base = {
    run_id: RUN_ID,
    source: 'onchainfeed_safe_mode_audit',
    signal_id: signal.id,
    signal_key: signal.signal_key,
    match_name: signal.match_name,
    event_date: signal.event_date,
    starts_at: signal.starts_at,
    strategy_lane: signal.strategy_lane,
    public_signal_name: signal.public_signal_name,
    model_bucket: signal.strategy_lane === 'CORE_P1_ATP_GS_BET365' || signal.strategy_lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365'
      ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP'
      : 'OPTIMIZED_VIP',
    target_scores: signal.target_scores,
    baseline_grouped_odds: signal.baseline_grouped_odds,
  };
  try {
    const gameSearch = await findGame(signal);
    if (!gameSearch.game) {
      return { ...base, decision: 'MISSING_GAME', reason: `No game match. ${gameSearch.errors?.slice(0, 2).join(' | ') || ''}`, raw_match_json: { errors: gameSearch.errors || [] } };
    }

    const game = gameSearch.game;
    const id = gameId(game);
    const conditionResult = await getConditions(game);
    const picked = findConditionForScores(conditionResult.conditions, signal.target_scores);
    if (!picked?.condition) {
      return {
        ...base,
        azuro_game_id: id,
        azuro_game_title: clean(firstDefined(game, ['title', 'name', 'game.title', 'eventName', 'matchName'])),
        azuro_league: clean(firstDefined(game, ['league.name', 'tournament.name', 'competition.name'])),
        azuro_sport: clean(firstDefined(game, ['sport.name', 'sport', 'sportSlug'])),
        decision: 'MISSING_MARKET',
        reason: `No first-set correct-score condition/market found. ${conditionResult.errors?.slice(0, 2).join(' | ') || ''}`,
        raw_match_json: game,
        raw_conditions_json: conditionResult.raw || { errors: conditionResult.errors || [] },
      };
    }

    const condition = picked.condition;
    const conditionId = clean(firstDefined(condition, ['conditionId', 'id', 'condition.id', 'marketId']));
    const outcomeRows = [];
    const rawCalcs = {};
    for (const score of signal.target_scores) {
      const outcome = picked.scoreMap[score];
      if (!outcome) continue;
      const oid = outcomeId(outcome);
      const fallbackOdds = outcomeOdds(outcome);
      const calc = oid && conditionId
        ? await calculateOutcome(conditionId, oid, fallbackOdds, stakeProbeRaw())
        : { odds: fallbackOdds, maxBet: null, maxPayout: null, raw: { skipped: 'missing conditionId/outcomeId' } };
      outcomeRows.push({ score, outcomeId: oid, odds: calc.odds, maxBet: calc.maxBet, maxPayout: calc.maxPayout, title: clean(firstDefined(outcome, ['title', 'name', 'label'])) });
      rawCalcs[score] = calc.raw;
    }

    const odds = outcomeRows.map((row) => row.odds);
    const azuroGrouped = groupedOdds(odds);
    const mgs = maxGroupStake(outcomeRows);
    const minMaxBet = outcomeRows.some((row) => num(row.maxBet)) ? Math.min(...outcomeRows.map((row) => num(row.maxBet)).filter((x) => x !== null)) : null;
    const minMaxPayout = outcomeRows.some((row) => num(row.maxPayout)) ? Math.min(...outcomeRows.map((row) => num(row.maxPayout)).filter((x) => x !== null)) : null;

    const row = {
      ...base,
      azuro_game_id: id,
      azuro_game_title: clean(firstDefined(game, ['title', 'name', 'game.title', 'eventName', 'matchName'])),
      azuro_league: clean(firstDefined(game, ['league.name', 'tournament.name', 'competition.name'])),
      azuro_sport: clean(firstDefined(game, ['sport.name', 'sport', 'sportSlug'])),
      azuro_condition_id: conditionId,
      azuro_market_title: clean(firstDefined(condition, ['title', 'name', 'marketName', 'market.title', 'market.name'])),
      score_outcomes_json: Object.fromEntries(outcomeRows.map((row) => [row.score, row])),
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
  } catch (error) {
    return { ...base, decision: 'API_ERROR', reason: error.message, raw_match_json: { error: error.stack || error.message } };
  }
}

function summarize(rows) {
  const out = {};
  for (const row of rows) out[row.decision] = (out[row.decision] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

async function main() {
  ensureDir(OUT_DIR);
  console.log(JSON.stringify({ run_id: RUN_ID, api_base: AZURO_API_BASE, environment: AZURO_ENVIRONMENT, app_id: APP_ID, limit: LIMIT, write_supabase: WRITE_SUPABASE }, null, 2));
  const signals = await loadSignals();
  const rows = [];
  for (const signal of signals) {
    console.log(`Auditing ${signal.match_name} ${signal.strategy_lane}`);
    rows.push(await auditSignal(signal));
  }
  const fields = ['run_id','source','signal_id','match_name','event_date','starts_at','strategy_lane','public_signal_name','target_scores','baseline_grouped_odds','azuro_game_id','azuro_game_title','azuro_market_title','azuro_grouped_odds','edge_vs_baseline','min_score_max_bet','min_score_max_payout','max_group_stake','decision','reason'];
  writeCsv(path.join(OUT_DIR, 'onchainfeed_first_set_score_audit.csv'), rows, fields);
  writeJson(path.join(OUT_DIR, 'onchainfeed_first_set_score_audit.json'), rows);
  const summary = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    api_base: AZURO_API_BASE,
    environment: AZURO_ENVIRONMENT,
    app_id: APP_ID,
    signals_checked: rows.length,
    decisions: summarize(rows),
    note: 'SAFE MODE: no signatures, no orders, no wallet actions. BETTABLE means coverage/odds/liquidity audit passed configured thresholds only.',
  };
  writeJson(path.join(OUT_DIR, 'onchainfeed_first_set_score_summary.json'), summary);
  fs.writeFileSync(path.join(OUT_DIR, 'onchainfeed_first_set_score_report.md'), [
    '# Onchainfeed / Azuro First-Set Score Coverage Audit',
    '',
    `Run ID: ${RUN_ID}`,
    `Generated: ${summary.generated_at}`,
    `API base: ${AZURO_API_BASE}`,
    `Environment: ${AZURO_ENVIRONMENT}`,
    `Signals checked: ${rows.length}`,
    '',
    '## Decisions',
    ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Safety Notes',
    '- No private keys are read.',
    '- No EIP-712 payloads are signed.',
    '- No orders are submitted.',
    '- BETTABLE means all target scores were found and configured odds/liquidity checks passed.',
    '- Manual legal/compliance and wallet review is required before any live execution phase.',
  ].join('\n') + '\n', 'utf8');
  if (WRITE_SUPABASE) await supabaseInsert('azuro_execution_audit_v1', rows);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
