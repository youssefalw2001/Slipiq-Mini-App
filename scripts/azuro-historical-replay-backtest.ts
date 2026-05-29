#!/usr/bin/env tsx
/*
  First Set Lab / SlipIQ
  Azuro historical block replay backtest.

  SAFE MODE ONLY:
  - Does not place bets.
  - Does not create orders.
  - Does not sign wallet transactions.
  - Does not generate calldata.
  - Defaults write_supabase=false.

  Purpose:
  Replays settled First Set Lab signals against a historical Azuro V3 subgraph at the
  block nearest to each signal scan/start timestamp. This is not a proof claim unless
  the subgraph returns historical games, first-set correct-score conditions, target
  outcomes, odds, and max payout/liquidity fields for the original block.

  Required for Supabase read:
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY

  Main flow per signal:
  1. Resolve timestamp -> chain block number using DefiLlama block API.
  2. Query historical Azuro games at that block.
  3. Match game by player/name/time tokens.
  4. Query historical active conditions for that game at that block.
  5. Locate first-set correct-score market.
  6. Classify Baseline / Azuro-only / Hybrid eligibility.

  Notes:
  - The default hosted-service URLs are configurable. If api.thegraph.com is disabled
    for the deployment, pass a gateway URL with your Graph API key through --subgraph-url.
  - API_ERROR is not a coverage result. Only MISSING_GAME, MISSING_MARKET,
    MISSING_SCORE, BAD_ODDS, LOW_LIMIT, and BETTABLE are audit states.
*/

import fs from 'node:fs';
import path from 'node:path';

type ScoreMode = 'protected3' | 'gate2';
type Decision = 'API_ERROR' | 'MISSING_GAME' | 'MISSING_MARKET' | 'MISSING_SCORE' | 'BAD_ODDS' | 'LOW_LIMIT' | 'BETTABLE';
type Args = Record<string, string>;

type SignalRow = {
  id: string;
  signal_key: string | null;
  event_date: string | null;
  starts_at: string | null;
  scanned_at: string | null;
  settled_at: string | null;
  match_name: string | null;
  strategy_lane: string | null;
  public_signal_name: string | null;
  score_cluster: string | null;
  score_odds_json: Record<string, unknown> | null;
  official_decimal_odds: string | number | null;
  original_official_decimal_odds: string | number | null;
  first_set_score: string | null;
  display_status: string | null;
  status: string | null;
  grouped_profit_units_calc: string | number | null;
};

type AzuroGame = {
  id: string;
  gameId?: string | null;
  title?: string | null;
  startsAt?: string | number | null;
  state?: string | null;
  sport?: { name?: string | null; slug?: string | null } | null;
  league?: { name?: string | null; country?: { name?: string | null } | null } | null;
  participants?: Array<{ name?: string | null; image?: string | null; sortOrder?: string | number | null }> | null;
  activeConditionsCount?: number | null;
};

type AzuroOutcome = {
  id: string;
  outcomeId?: string | number | null;
  title?: string | null;
  currentOdds?: string | number | null;
};

type AzuroCondition = {
  id: string;
  conditionId?: string | number | null;
  coreAddress?: string | null;
  title?: string | null;
  status?: string | null;
  state?: string | null;
  margin?: string | number | null;
  maxOutcomeWin?: string | number | null;
  maxOutcomePotentialLoss?: string | number | null;
  currentConditionPotentialLoss?: string | number | null;
  isPrematchEnabled?: boolean | null;
  outcomes?: AzuroOutcome[] | null;
};

type AuditRow = {
  run_id: string;
  model_name: string;
  source: string;
  score_mode: ScoreMode;
  signal_id: string;
  signal_key: string | null;
  match_name: string | null;
  strategy_lane: string | null;
  event_date: string | null;
  starts_at: string | null;
  scanned_at: string | null;
  historical_timestamp: string | null;
  chain: string;
  block_number: number | null;
  target_scores: string[];
  first_set_score: string | null;
  baseline_grouped_odds: number | null;
  baseline_win: boolean | null;
  baseline_units: number | null;
  azuro_game_id: string | null;
  azuro_game_title: string | null;
  azuro_condition_id: string | null;
  azuro_market_title: string | null;
  azuro_grouped_odds: number | null;
  azuro_win: boolean | null;
  azuro_units: number | null;
  hybrid_grouped_odds: number | null;
  hybrid_units: number | null;
  edge_vs_baseline: number | null;
  max_group_stake: number | null;
  decision: Decision;
  reason: string;
  raw_match_json?: unknown;
  raw_conditions_json?: unknown;
  raw_calculations_json?: unknown;
};

const ACTIVE_LANES = [
  'CORE_P1_ATP_GS_BET365',
  'CORE_P2_GS_REVERSE_STRETCH_BET365',
  'RESEARCH_P2_GS_26_46_BET365',
  'VIP_P2_V3_SHAPE',
];

const DEFAULT_SUPABASE_URL = 'https://qjvpkkcbscsypymxyker.supabase.co';
const DEFAULT_SUBGRAPHS: Record<string, string> = {
  polygon: 'https://api.thegraph.com/subgraphs/name/azuro-protocol/azuro-api-polygon-v3',
  gnosis: 'https://api.thegraph.com/subgraphs/name/azuro-protocol/azuro-api-gnosis-v3',
  arbitrum: 'https://api.thegraph.com/subgraphs/name/azuro-protocol/azuro-api-arbitrum-v3',
  base: 'https://api.thegraph.com/subgraphs/name/azuro-protocol/azuro-api-base-v3',
};
const DEFILLAMA_CHAIN: Record<string, string> = {
  polygon: 'polygon',
  gnosis: 'xdai',
  arbitrum: 'arbitrum',
  base: 'base',
};
const TOKEN_DECIMALS: Record<string, number> = {
  polygon: 6,
  gnosis: 18,
  arbitrum: 6,
  base: 6,
};

const GAMES_AT_BLOCK_QUERY = `
query GamesAtBlock($first: Int, $skip: Int, $where: Game_filter, $block: Block_height) {
  games(first: $first, skip: $skip, where: $where, block: $block, orderBy: startsAt, orderDirection: asc) {
    id
    gameId
    title
    startsAt
    state
    sport { name slug }
    league { name country { name } }
    participants { name image sortOrder }
    activeConditionsCount
  }
}`;

const GAME_CONDITIONS_AT_BLOCK_QUERY = `
query GameConditionsAtBlock($gameId: ID!, $block: Block_height) {
  game(id: $gameId, block: $block) {
    id
    gameId
    title
    startsAt
    state
    sport { name slug }
    league { name country { name } }
    participants { name image sortOrder }
    conditions(where: { state: "Active" }) {
      id
      conditionId
      title
      state
      status
      isPrematchEnabled
      maxOutcomeWin
      maxOutcomePotentialLoss
      currentConditionPotentialLoss
      margin
      outcomes {
        id
        outcomeId
        title
        currentOdds
      }
    }
  }
}`;

const CONDITIONS_BY_GAME_AT_BLOCK_QUERY = `
query ConditionsByGameAtBlock($gameId: String!, $block: Block_height) {
  conditions(where: { game: $gameId }, block: $block, first: 1000) {
    id
    conditionId
    coreAddress
    title
    state
    status
    maxOutcomeWin
    maxOutcomePotentialLoss
    currentConditionPotentialLoss
    margin
    outcomes {
      id
      outcomeId
      title
      currentOdds
    }
  }
}`;

function parseArgs(): Args {
  return Object.fromEntries(
    process.argv.slice(2)
      .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]])
  );
}
const args = parseArgs();
const arg = (name: string, env: string, fallback = '') => args[name] ?? process.env[env] ?? fallback;

const RUN_ID = arg('run-id', 'RUN_ID', `azuro_historical_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SUPABASE_URL = arg('supabase-url', 'SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SUPABASE_KEY = arg('supabase-key', 'SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_ANON_KEY ?? '');
const CHAIN = arg('chain', 'AZURO_CHAIN', 'polygon').toLowerCase();
const SUBGRAPH_URL = arg('subgraph-url', 'AZURO_HISTORICAL_SUBGRAPH_URL', DEFAULT_SUBGRAPHS[CHAIN] || '');
const SCORE_MODE = arg('score-mode', 'SCORE_MODE', 'protected3') as ScoreMode;
const SOURCE_VIEW = arg('source-view', 'SOURCE_VIEW', 'proof_vault_locked_model_rows_v1');
const LIMIT = Number(arg('limit', 'LIMIT', '70')) || 70;
const MAX_GAME_PAGES = Number(arg('max-game-pages', 'MAX_GAME_PAGES', '10')) || 10;
const GAME_PAGE_SIZE = Math.min(Number(arg('game-page-size', 'GAME_PAGE_SIZE', '100')) || 100, 1000);
const MIN_EDGE = Number(arg('min-edge', 'MIN_EDGE', '0')) || 0;
const BANKROLL = Number(arg('bankroll', 'BANKROLL', '3000')) || 3000;
const RISK_PCT = Number(arg('risk-pct', 'RISK_PCT', '0.03')) || 0.03;
const REQUIRED_STAKE = Number(arg('required-stake', 'REQUIRED_STAKE', String(BANKROLL * RISK_PCT))) || BANKROLL * RISK_PCT;
const WRITE_SUPABASE = String(arg('write-supabase', 'WRITE_SUPABASE', 'false')).toLowerCase() === 'true';
const OUT_DIR = arg('out', 'OUT_DIR', 'artifacts/output/azuro-historical-replay-backtest');
const FETCH_TIMEOUT_MS = Number(arg('timeout-ms', 'FETCH_TIMEOUT_MS', '25000')) || 25000;

if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.');
if (!SUBGRAPH_URL) throw new Error(`No Azuro historical subgraph URL configured for chain=${CHAIN}. Pass --subgraph-url.`);
if (!['protected3', 'gate2'].includes(SCORE_MODE)) throw new Error(`Invalid --score-mode=${SCORE_MODE}`);

function clean(v: unknown): string { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v: unknown): string { return clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function tokens(v: unknown): string[] { return norm(v).split(' ').filter(Boolean); }
function num(v: unknown): number | null { if (v === null || v === undefined || clean(v) === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file: string, value: unknown): void { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function csvEscape(v: unknown): string { const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function writeCsv(file: string, rows: Record<string, unknown>[], fields: string[]): void { ensureDir(path.dirname(file)); fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8'); }
function timestampForSignal(s: SignalRow): string | null { return s.scanned_at || s.starts_at || s.event_date; }
function unixSeconds(ts: string | null): number | null { if (!ts) return null; const ms = new Date(ts).getTime(); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; }
function scoreTargetsForLane(lane: string | null, mode: ScoreMode): string[] {
  if (mode === 'gate2') {
    if (lane === 'CORE_P1_ATP_GS_BET365') return ['6:3', '6:4'];
    if (lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365') return ['2:6', '4:6'];
    if (lane === 'RESEARCH_P2_GS_26_46_BET365') return ['2:6', '4:6'];
    if (lane === 'VIP_P2_V3_SHAPE') return ['4:6', '5:7'];
    return [];
  }
  if (lane === 'CORE_P1_ATP_GS_BET365') return ['6:2', '6:3', '6:4'];
  if (lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'RESEARCH_P2_GS_26_46_BET365') return ['2:6', '4:6', '5:7'];
  if (lane === 'VIP_P2_V3_SHAPE') return ['3:6', '4:6', '5:7'];
  return [];
}
function groupedOdds(odds: Array<number | null>): number | null { if (!odds.length || odds.some((o) => o === null || o <= 1)) return null; const implied = odds.reduce((s, o) => s + 1 / (o as number), 0); return implied > 0 ? 1 / implied : null; }
function baselineGroupedOdds(signal: SignalRow, scores: string[]): number | null {
  const direct = groupedOdds(scores.map((score) => num(signal.score_odds_json?.[score])));
  if (direct) return direct;
  return num(signal.original_official_decimal_odds) ?? num(signal.official_decimal_odds);
}
function unitsFor(win: boolean | null, odds: number | null): number | null { if (win === null || odds === null) return null; return win ? odds - 1 : -1; }
function scoreFromOutcome(title: string | null | undefined): string { const m = clean(title).replace(/[–—-]/g, ':').match(/\b(\d)\s*[:]\s*(\d)\b/); return m ? `${m[1]}:${m[2]}` : ''; }
function isFirstSetScoreMarket(c: AzuroCondition): boolean { const t = norm(c.title); return /first|1st|set 1|1 set/.test(t) && /score/.test(t); }
function parsePlayers(matchName: string | null): [string, string] { const raw = clean(matchName).replace(/\s+vs\.?\s+/i, ' v ').replace(/\s+@\s+/i, ' v ').replace(/\s+-\s+/i, ' v '); const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean); return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, '']; }
function playerMatches(signalPlayer: string, candidatePlayer: string): boolean { const sig = tokens(signalPlayer); const cand = tokens(candidatePlayer); if (!sig.length || !cand.length) return false; const sigLast = sig[sig.length - 1]; const candLast = cand[cand.length - 1]; const lastOk = sigLast === candLast || sigLast.includes(candLast) || candLast.includes(sigLast); const firstOk = sig[0]?.[0] === cand[0]?.[0] || sig.some((s) => cand.includes(s)) || cand.some((c) => sig.includes(c)); return lastOk && firstOk; }
function gamePlayers(g: AzuroGame): string[] { const ps = (g.participants || []).map((p) => clean(p.name)).filter(Boolean); return ps.length ? ps : parsePlayers(g.title || '').filter(Boolean); }
function gameStartMs(g: AzuroGame): number { const n = Number(g.startsAt); if (Number.isFinite(n)) return n < 100000000000 ? n * 1000 : n; return new Date(String(g.startsAt || '')).getTime(); }
function signalStartMs(s: SignalRow): number { return new Date(s.starts_at || s.event_date || '').getTime(); }
function matchScore(signal: SignalRow, game: AzuroGame): number {
  const [s1, s2] = parsePlayers(signal.match_name);
  const ps = gamePlayers(game);
  let score = 0;
  if (ps.length >= 2 && ((playerMatches(s1, ps[0]) && playerMatches(s2, ps[1])) || (playerMatches(s1, ps[1]) && playerMatches(s2, ps[0])))) score += 12;
  const text = norm([game.title, ps.join(' '), game.league?.name, game.sport?.name, game.sport?.slug].join(' '));
  for (const t of [...tokens(s1), ...tokens(s2)]) if (t.length > 1 && text.includes(t)) score += 1;
  if (text.includes('tennis')) score += 2;
  const diffH = Math.abs(signalStartMs(signal) - gameStartMs(game)) / 36e5;
  if (Number.isFinite(diffH)) { if (diffH <= 48) score += 2; if (diffH <= 12) score += 2; }
  return score;
}
function decodeTokenAmount(raw: string | number | null | undefined): number | null { const n = num(raw); if (n === null) return null; return n / 10 ** (TOKEN_DECIMALS[CHAIN] ?? 6); }
function maxGroupStake(condition: AzuroCondition, outcomeRows: Array<{ odds: number | null }>): number | null {
  const cap = decodeTokenAmount(condition.maxOutcomeWin ?? condition.maxOutcomePotentialLoss);
  if (cap === null) return null;
  const implied = outcomeRows.reduce((s, r) => s + (r.odds && r.odds > 1 ? 1 / r.odds : 0), 0);
  return implied > 0 ? cap * implied : null;
}

const blockCache = new Map<number, number>();
async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    return body;
  } finally { clearTimeout(timer); }
}
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await fetchJson(SUBGRAPH_URL, { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (body.errors?.length) throw new Error(body.errors.map((e: any) => e.message || JSON.stringify(e)).join(' | '));
  return body.data as T;
}
async function blockForTimestamp(ts: number): Promise<number> {
  if (blockCache.has(ts)) return blockCache.get(ts)!;
  const chainName = DEFILLAMA_CHAIN[CHAIN] || CHAIN;
  const body = await fetchJson(`https://coins.llama.fi/block/${encodeURIComponent(chainName)}/${ts}`);
  const block = Number(body.height ?? body.block ?? body.number);
  if (!Number.isFinite(block)) throw new Error(`No block height returned for ${CHAIN} ${ts}: ${JSON.stringify(body).slice(0, 200)}`);
  blockCache.set(ts, block);
  return block;
}
async function supabaseSelect(pathAndQuery: string): Promise<SignalRow[]> {
  const body = await fetchJson(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } });
  return body as SignalRow[];
}
async function loadSignals(): Promise<SignalRow[]> {
  const select = ['id','signal_key','event_date','starts_at','scanned_at','settled_at','match_name','strategy_lane','public_signal_name','score_cluster','score_odds_json','official_decimal_odds','original_official_decimal_odds','first_set_score','display_status','status','grouped_profit_units_calc'].join(',');
  const lanes = ACTIVE_LANES.join(',');
  let query = `${SOURCE_VIEW}?select=${encodeURIComponent(select)}&strategy_lane=in.(${lanes})&order=starts_at.desc&limit=${LIMIT}`;
  if (SOURCE_VIEW === 'proof_vault_locked_model_rows_v1') query += '&is_optimized_vip=is.true';
  return supabaseSelect(query);
}
async function fetchGamesAtBlock(block: number): Promise<AzuroGame[]> {
  const games: AzuroGame[] = [];
  for (let page = 0; page < MAX_GAME_PAGES; page += 1) {
    const data = await graphql<{ games: AzuroGame[] }>(GAMES_AT_BLOCK_QUERY, { first: GAME_PAGE_SIZE, skip: page * GAME_PAGE_SIZE, where: { activeConditionsCount_gt: 0 }, block: { number: block } });
    const batch = data.games || [];
    games.push(...batch.filter((g) => norm([g.sport?.name, g.sport?.slug, g.title].join(' ')).includes('tennis')));
    if (batch.length < GAME_PAGE_SIZE) break;
  }
  return games;
}
async function fetchConditionsForGameAtBlock(gameId: string, block: number): Promise<{ game: AzuroGame | null; conditions: AzuroCondition[] }> {
  try {
    const data = await graphql<{ game: (AzuroGame & { conditions?: AzuroCondition[] }) | null }>(GAME_CONDITIONS_AT_BLOCK_QUERY, { gameId, block: { number: block } });
    return { game: data.game, conditions: data.game?.conditions || [] };
  } catch (err) {
    const data = await graphql<{ conditions: AzuroCondition[] }>(CONDITIONS_BY_GAME_AT_BLOCK_QUERY, { gameId, block: { number: block } });
    return { game: null, conditions: data.conditions || [] };
  }
}
function chooseGame(signal: SignalRow, games: AzuroGame[]): { game: AzuroGame | null; score: number; candidates: Array<{ id: string; title: string | null | undefined; score: number }> } {
  const scored = games.map((game) => ({ game, score: matchScore(signal, game) })).sort((a, b) => b.score - a.score);
  return { game: scored[0]?.score >= 8 ? scored[0].game : null, score: scored[0]?.score ?? 0, candidates: scored.slice(0, 5).map((x) => ({ id: x.game.id, title: x.game.title, score: x.score })) };
}
function pickMarket(conditions: AzuroCondition[]): AzuroCondition | null {
  const usable = conditions.filter((c) => !c.isPrematchEnabled || c.isPrematchEnabled !== false);
  const firstSet = usable.filter(isFirstSetScoreMarket);
  if (firstSet.length) return firstSet.sort((a, b) => clean(b.title).length - clean(a.title).length)[0];
  return usable.find((c) => (c.outcomes || []).filter((o) => scoreFromOutcome(o.title)).length >= 4 && /score|set/.test(norm(c.title))) || null;
}
function buildApiError(signal: SignalRow, reason: string, extra: unknown): AuditRow {
  const targets = scoreTargetsForLane(signal.strategy_lane, SCORE_MODE);
  const baseline = baselineGroupedOdds(signal, targets);
  const win = signal.first_set_score ? targets.includes(signal.first_set_score) : null;
  return { run_id: RUN_ID, model_name: `azuro_historical_${SCORE_MODE}`, source: 'azuro_historical_subgraph', score_mode: SCORE_MODE, signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, strategy_lane: signal.strategy_lane, event_date: signal.event_date, starts_at: signal.starts_at, scanned_at: signal.scanned_at, historical_timestamp: timestampForSignal(signal), chain: CHAIN, block_number: null, target_scores: targets, first_set_score: signal.first_set_score, baseline_grouped_odds: baseline, baseline_win: win, baseline_units: unitsFor(win, baseline), azuro_game_id: null, azuro_game_title: null, azuro_condition_id: null, azuro_market_title: null, azuro_grouped_odds: null, azuro_win: null, azuro_units: null, hybrid_grouped_odds: baseline, hybrid_units: unitsFor(win, baseline), edge_vs_baseline: null, max_group_stake: null, decision: 'API_ERROR', reason, raw_calculations_json: extra };
}
async function auditSignal(signal: SignalRow): Promise<AuditRow> {
  const targets = scoreTargetsForLane(signal.strategy_lane, SCORE_MODE);
  const baseline = baselineGroupedOdds(signal, targets);
  const win = signal.first_set_score ? targets.includes(signal.first_set_score) : null;
  const ts = timestampForSignal(signal);
  const sec = unixSeconds(ts);
  if (sec === null) return buildApiError(signal, 'Missing valid historical timestamp for signal.', { ts });
  let block: number;
  try { block = await blockForTimestamp(sec); } catch (err) { return buildApiError(signal, `Block lookup failed: ${(err as Error).message}`, { timestamp: ts, unix_seconds: sec }); }
  let games: AzuroGame[];
  try { games = await fetchGamesAtBlock(block); } catch (err) { return { ...buildApiError(signal, `Historical games query failed: ${(err as Error).message}`, { block }), block_number: block }; }
  const chosen = chooseGame(signal, games);
  const base: Omit<AuditRow, 'decision' | 'reason'> = { run_id: RUN_ID, model_name: `azuro_historical_${SCORE_MODE}`, source: 'azuro_historical_subgraph', score_mode: SCORE_MODE, signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, strategy_lane: signal.strategy_lane, event_date: signal.event_date, starts_at: signal.starts_at, scanned_at: signal.scanned_at, historical_timestamp: ts, chain: CHAIN, block_number: block, target_scores: targets, first_set_score: signal.first_set_score, baseline_grouped_odds: baseline, baseline_win: win, baseline_units: unitsFor(win, baseline), azuro_game_id: chosen.game?.id || null, azuro_game_title: chosen.game?.title || null, azuro_condition_id: null, azuro_market_title: null, azuro_grouped_odds: null, azuro_win: null, azuro_units: null, hybrid_grouped_odds: baseline, hybrid_units: unitsFor(win, baseline), edge_vs_baseline: null, max_group_stake: null, raw_calculations_json: { best_candidates: chosen.candidates, required_stake: REQUIRED_STAKE, subgraph_url: SUBGRAPH_URL } };
  if (!chosen.game) return { ...base, decision: 'MISSING_GAME', reason: `No historical Azuro tennis game matched at block ${block}. Best score: ${chosen.score}.` };
  let conditionPayload: { game: AzuroGame | null; conditions: AzuroCondition[] };
  try { conditionPayload = await fetchConditionsForGameAtBlock(chosen.game.id, block); } catch (err) { return { ...base, decision: 'API_ERROR', reason: `Historical conditions query failed: ${(err as Error).message}` }; }
  const condition = pickMarket(conditionPayload.conditions);
  if (!condition) return { ...base, raw_match_json: conditionPayload.game || chosen.game, raw_conditions_json: conditionPayload.conditions, decision: 'MISSING_MARKET', reason: 'Game matched historically, but no first-set correct-score market was found.' };
  const outcomeMap = new Map<string, AzuroOutcome>();
  for (const o of condition.outcomes || []) { const score = scoreFromOutcome(o.title); if (score) outcomeMap.set(score, o); }
  const missing = targets.filter((score) => !outcomeMap.has(score));
  const outcomeRows = targets.map((score) => { const o = outcomeMap.get(score); return o ? { score, outcomeId: o.outcomeId, odds: num(o.currentOdds), title: o.title } : null; }).filter(Boolean) as Array<{ score: string; outcomeId: string | number | null | undefined; odds: number | null; title: string | null | undefined }>;
  const azuroGrouped = groupedOdds(outcomeRows.map((o) => o.odds));
  const groupStake = maxGroupStake(condition, outcomeRows);
  const edge = azuroGrouped !== null && baseline !== null ? azuroGrouped - baseline : null;
  const enriched: Omit<AuditRow, 'decision' | 'reason'> = { ...base, azuro_condition_id: String(condition.conditionId || condition.id), azuro_market_title: condition.title || null, azuro_grouped_odds: azuroGrouped, azuro_win: win, azuro_units: unitsFor(win, azuroGrouped), hybrid_grouped_odds: azuroGrouped !== null && baseline !== null && azuroGrouped >= baseline + MIN_EDGE ? azuroGrouped : baseline, hybrid_units: unitsFor(win, azuroGrouped !== null && baseline !== null && azuroGrouped >= baseline + MIN_EDGE ? azuroGrouped : baseline), edge_vs_baseline: edge, max_group_stake: groupStake, raw_match_json: conditionPayload.game || chosen.game, raw_conditions_json: condition, raw_calculations_json: { ...base.raw_calculations_json as object, outcome_rows: outcomeRows, max_outcome_win_raw: condition.maxOutcomeWin, max_outcome_potential_loss_raw: condition.maxOutcomePotentialLoss } };
  if (missing.length) return { ...enriched, decision: 'MISSING_SCORE', reason: `First-set score market exists but missing targets: ${missing.join(', ')}` };
  if (azuroGrouped === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Target outcomes exist but one or more historical odds are missing/invalid.' };
  if (baseline === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Baseline grouped odds missing, cannot compare.' };
  if (azuroGrouped < baseline + MIN_EDGE) return { ...enriched, decision: 'BAD_ODDS', reason: `Azuro grouped odds ${azuroGrouped.toFixed(4)} below baseline+edge ${(baseline + MIN_EDGE).toFixed(4)}.` };
  if (groupStake !== null && groupStake < REQUIRED_STAKE) return { ...enriched, decision: 'LOW_LIMIT', reason: `Historical max grouped stake ${groupStake.toFixed(2)} below required stake ${REQUIRED_STAKE.toFixed(2)}.` };
  return { ...enriched, decision: 'BETTABLE', reason: 'Historical Azuro game, market, target scores, odds, and limit checks passed.' };
}
function summarizeRows(rows: AuditRow[]) {
  const byDecision: Record<string, number> = {};
  for (const r of rows) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
  const valid = rows.filter((r) => r.decision !== 'API_ERROR');
  const bettable = rows.filter((r) => r.decision === 'BETTABLE');
  const sum = (xs: Array<number | null | undefined>) => xs.reduce((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0);
  const wins = (xs: AuditRow[]) => xs.filter((r) => r.baseline_win === true).length;
  return {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    source: 'azuro_historical_subgraph',
    chain: CHAIN,
    subgraph_url: SUBGRAPH_URL,
    score_mode: SCORE_MODE,
    source_view: SOURCE_VIEW,
    rows: rows.length,
    decisions: Object.fromEntries(Object.entries(byDecision).sort()),
    valid_rows: valid.length,
    baseline_rows: rows.filter((r) => r.baseline_units !== null).length,
    baseline_wins: wins(rows),
    baseline_units: sum(rows.map((r) => r.baseline_units)),
    azuro_bettable_rows: bettable.length,
    azuro_bettable_wins: wins(bettable),
    azuro_bettable_units: sum(bettable.map((r) => r.azuro_units)),
    hybrid_rows: rows.filter((r) => r.hybrid_units !== null).length,
    hybrid_units: sum(rows.map((r) => r.hybrid_units)),
    note: 'API_ERROR rows are transport/schema/data-access failures, not market coverage results.',
  };
}
async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const signals = await loadSignals();
  const rows: AuditRow[] = [];
  for (const s of signals) {
    console.log(`Historical replay ${s.match_name} ${s.strategy_lane}`);
    rows.push(await auditSignal(s));
  }
  const summary = summarizeRows(rows);
  const fields = ['run_id','model_name','signal_id','match_name','strategy_lane','starts_at','scanned_at','historical_timestamp','chain','block_number','target_scores','first_set_score','baseline_grouped_odds','baseline_units','azuro_game_id','azuro_game_title','azuro_market_title','azuro_grouped_odds','azuro_units','hybrid_grouped_odds','hybrid_units','edge_vs_baseline','max_group_stake','decision','reason'];
  writeJson(path.join(OUT_DIR, 'azuro_historical_replay_rows.json'), rows);
  writeJson(path.join(OUT_DIR, 'azuro_historical_replay_summary.json'), summary);
  writeCsv(path.join(OUT_DIR, 'azuro_historical_replay_rows.csv'), rows as unknown as Record<string, unknown>[], fields);
  fs.writeFileSync(path.join(OUT_DIR, 'azuro_historical_replay_report.md'), ['# Azuro Historical Replay Backtest', '', `Run ID: ${RUN_ID}`, `Generated: ${summary.generated_at}`, `Chain: ${CHAIN}`, `Subgraph: ${SUBGRAPH_URL}`, `Score mode: ${SCORE_MODE}`, `Source view: ${SOURCE_VIEW}`, '', '## Decisions', ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`), '', '## Units', `- Baseline units: ${summary.baseline_units}`, `- Azuro BETTABLE units: ${summary.azuro_bettable_units}`, `- Hybrid units: ${summary.hybrid_units}`, '', '## Safety', '- No wallet signing.', '- No bet orders.', '- No calldata.', '- write_supabase defaults to false.', '- API_ERROR rows are excluded from coverage conclusions.'].join('\n') + '\n', 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
