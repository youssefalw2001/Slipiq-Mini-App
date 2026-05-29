#!/usr/bin/env tsx
/*
  First Set Lab / SlipIQ
  Azuro V3 historical replay backtest.

  SAFE MODE ONLY:
  - No bets.
  - No orders.
  - No wallet signing.
  - No calldata.
  - No Supabase writes.

  This script targets the Azuro V3 decentralized subgraph schema variant where:
  - game status may be numeric or string.
  - condition status may be numeric or string.
  - outcome odds may be `odds` fixed point with 1e12 precision, or `currentOdds` decimal.
  - historical state is queried with block: { number }.

  It is deliberately defensive: API/schema failures are API_ERROR and are not treated
  as market non-coverage.
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

type GqlGame = {
  id: string;
  gameId?: string | number | null;
  title?: string | null;
  startsAt?: string | number | null;
  status?: string | number | null;
  state?: string | number | null;
  sportId?: string | number | null;
  sport?: { name?: string | null; slug?: string | null } | null;
  league?: { name?: string | null; country?: { name?: string | null } | null } | null;
  participants?: Array<{ name?: string | null; sortOrder?: string | number | null }> | null;
  activeConditionsCount?: number | null;
  conditions?: GqlCondition[] | null;
};

type GqlOutcome = {
  id: string;
  outcomeId?: string | number | null;
  title?: string | null;
  name?: string | null;
  odds?: string | number | null;
  currentOdds?: string | number | null;
};

type GqlCondition = {
  id: string;
  conditionId?: string | number | null;
  coreAddress?: string | null;
  title?: string | null;
  name?: string | null;
  status?: string | number | null;
  state?: string | number | null;
  margin?: string | number | null;
  maxOutcomeWin?: string | number | null;
  maxOutcomePotentialLoss?: string | number | null;
  currentConditionPotentialLoss?: string | number | null;
  outcomes?: GqlOutcome[] | null;
};

type AuditRow = {
  run_id: string;
  source: string;
  model_name: string;
  score_mode: ScoreMode;
  signal_id: string;
  signal_key: string | null;
  match_name: string | null;
  strategy_lane: string | null;
  starts_at: string | null;
  scanned_at: string | null;
  historical_timestamp: string | null;
  block_number: number | null;
  target_scores: string[];
  first_set_score: string | null;
  baseline_grouped_odds: number | null;
  baseline_units: number | null;
  azuro_game_id: string | null;
  azuro_game_title: string | null;
  azuro_condition_id: string | null;
  azuro_market_title: string | null;
  azuro_grouped_odds: number | null;
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
const DEFAULT_POLYGON_SUBGRAPH_ID = '5xDMqPyP6P5X6f2o5B1uQunrYj91mXyT68L9wGgDskK';
const DEFAULT_HOSTED: Record<string, string> = {
  polygon: 'https://api.thegraph.com/subgraphs/name/azuro-protocol/azuro-api-polygon-v3',
};
const DEFILLAMA_CHAIN: Record<string, string> = { polygon: 'polygon', gnosis: 'xdai', arbitrum: 'arbitrum', base: 'base' };
const TOKEN_DECIMALS: Record<string, number> = { polygon: 6, gnosis: 18, arbitrum: 6, base: 6 };

const GAMES_V3_QUERY = `
query GamesV3($first: Int, $skip: Int, $where: Game_filter, $block: Block_height) {
  games(first: $first, skip: $skip, where: $where, block: $block, orderBy: startsAt, orderDirection: asc) {
    id
    gameId
    title
    startsAt
    status
    sportId
    participants { name sortOrder }
  }
}`;

const GAME_WITH_CONDITIONS_V3_QUERY = `
query GameWithConditionsV3($gameId: ID!, $block: Block_height) {
  game(id: $gameId, block: $block) {
    id
    gameId
    title
    startsAt
    status
    sportId
    participants { name sortOrder }
    conditions {
      id
      conditionId
      coreAddress
      title
      status
      margin
      maxOutcomeWin
      outcomes {
        id
        outcomeId
        title
        odds
      }
    }
  }
}`;

const GAMES_COMPAT_QUERY = `
query GamesCompat($first: Int, $skip: Int, $where: Game_filter, $block: Block_height) {
  games(first: $first, skip: $skip, where: $where, block: $block, orderBy: startsAt, orderDirection: asc) {
    id
    gameId
    title
    startsAt
    state
    sport { name slug }
    league { name country { name } }
    participants { name sortOrder }
    activeConditionsCount
  }
}`;

const GAME_WITH_CONDITIONS_COMPAT_QUERY = `
query GameWithConditionsCompat($gameId: ID!, $block: Block_height) {
  game(id: $gameId, block: $block) {
    id
    gameId
    title
    startsAt
    state
    sport { name slug }
    league { name country { name } }
    participants { name sortOrder }
    conditions(where: { state: "Active" }) {
      id
      conditionId
      title
      state
      maxOutcomePotentialLoss
      currentConditionPotentialLoss
      outcomes {
        id
        outcomeId
        title
        currentOdds
      }
    }
  }
}`;

function parseArgs(): Args {
  return Object.fromEntries(process.argv.slice(2).map((x) => x.match(/^--([^=]+)=(.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m)).map((m) => [m[1], m[2]]));
}
const args = parseArgs();
function opt(name: string, env: string, fallback = ''): string {
  const a = args[name];
  if (a !== undefined && String(a).trim() !== '') return a;
  const e = process.env[env];
  if (e !== undefined && String(e).trim() !== '') return e;
  return fallback;
}

const RUN_ID = opt('run-id', 'RUN_ID', `azuro_v3_historical_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const CHAIN = opt('chain', 'AZURO_CHAIN', 'polygon').toLowerCase();
const SCORE_MODE = opt('score-mode', 'SCORE_MODE', 'protected3') as ScoreMode;
const SUPABASE_URL = opt('supabase-url', 'SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SUPABASE_KEY = opt('supabase-key', 'SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_ANON_KEY || '');
const GRAPH_API_KEY = opt('graph-api-key', 'THE_GRAPH_API_KEY', '');
const SUBGRAPH_ID = opt('subgraph-id', 'AZURO_SUBGRAPH_ID', CHAIN === 'polygon' ? DEFAULT_POLYGON_SUBGRAPH_ID : '');
const SUBGRAPH_URL = opt('subgraph-url', 'AZURO_HISTORICAL_SUBGRAPH_URL', GRAPH_API_KEY && SUBGRAPH_ID ? `https://gateway-market.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}` : DEFAULT_HOSTED[CHAIN] || '');
const SOURCE_VIEW = opt('source-view', 'SOURCE_VIEW', 'proof_vault_locked_model_rows_v1');
const LIMIT = Number(opt('limit', 'LIMIT', '10')) || 10;
const MIN_EDGE = Number(opt('min-edge', 'MIN_EDGE', '0')) || 0;
const REQUIRED_STAKE = Number(opt('required-stake', 'REQUIRED_STAKE', '90')) || 90;
const OUT_DIR = opt('out', 'OUT_DIR', 'artifacts/output/azuro-v3-historical-replay-backtest');
const TIMEOUT_MS = Number(opt('timeout-ms', 'FETCH_TIMEOUT_MS', '30000')) || 30000;
const GAME_PAGE_SIZE = Math.min(Number(opt('game-page-size', 'GAME_PAGE_SIZE', '100')) || 100, 1000);
const MAX_GAME_PAGES = Number(opt('max-game-pages', 'MAX_GAME_PAGES', '10')) || 10;

if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.');
if (!SUBGRAPH_URL) throw new Error('Missing Azuro subgraph URL. Provide --subgraph-url or THE_GRAPH_API_KEY + --subgraph-id.');
if (!['protected3', 'gate2'].includes(SCORE_MODE)) throw new Error(`Invalid score mode ${SCORE_MODE}`);

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
function groupedOdds(odds: Array<number | null>): number | null { if (!odds.length || odds.some((o) => o === null || o <= 1)) return null; const implied = odds.reduce((s, o) => s + 1 / (o as number), 0); return implied > 0 ? 1 / implied : null; }
function units(win: boolean | null, odds: number | null): number | null { if (win === null || odds === null) return null; return win ? odds - 1 : -1; }
function scoreTargets(lane: string | null, mode: ScoreMode): string[] {
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
function baselineOdds(signal: SignalRow, scores: string[]): number | null { return groupedOdds(scores.map((s) => num(signal.score_odds_json?.[s]))) ?? num(signal.original_official_decimal_odds) ?? num(signal.official_decimal_odds); }
function outcomeOdds(o: GqlOutcome): number | null { const fixed = num(o.odds); if (fixed !== null) return fixed > 1000000 ? fixed / 1e12 : fixed; return num(o.currentOdds); }
function outcomeScore(o: GqlOutcome): string { const m = clean(o.title || o.name).replace(/[–—-]/g, ':').match(/\b(\d)\s*[:]\s*(\d)\b/); return m ? `${m[1]}:${m[2]}` : ''; }
function marketTitle(c: GqlCondition): string { return clean(c.title || c.name); }
function isFirstSetScoreMarket(c: GqlCondition): boolean { const t = norm(marketTitle(c)); return /first|1st|set 1|1 set/.test(t) && /score/.test(t); }
function isActiveCondition(c: GqlCondition): boolean { const s = c.status ?? c.state; if (s === 1 || s === '1') return true; const t = norm(s); return t === 'created' || t === 'active' || t === 'prematch'; }
function decodePayout(raw: unknown): number | null { const n = num(raw); if (n === null) return null; return n / 10 ** (TOKEN_DECIMALS[CHAIN] ?? 6); }
function maxGroupStake(condition: GqlCondition, rows: Array<{ odds: number | null }>): number | null { const cap = decodePayout(condition.maxOutcomeWin ?? condition.maxOutcomePotentialLoss); if (cap === null) return null; const implied = rows.reduce((s, r) => s + (r.odds && r.odds > 1 ? 1 / r.odds : 0), 0); return implied ? cap * implied : null; }
function parsePlayers(matchName: string | null): [string, string] { const raw = clean(matchName).replace(/\s+vs\.?\s+/i, ' v ').replace(/\s+@\s+/i, ' v ').replace(/\s+-\s+/i, ' v '); const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean); return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, '']; }
function gamePlayers(g: GqlGame): string[] { const ps = (g.participants || []).map((p) => clean(p.name)).filter(Boolean); return ps.length ? ps : parsePlayers(g.title || '').filter(Boolean); }
function playerMatches(a: string, b: string): boolean { const at = tokens(a); const bt = tokens(b); if (!at.length || !bt.length) return false; const al = at.at(-1)!; const bl = bt.at(-1)!; const last = al === bl || al.includes(bl) || bl.includes(al); const first = at[0]?.[0] === bt[0]?.[0] || at.some((x) => bt.includes(x)) || bt.some((x) => at.includes(x)); return last && first; }
function gameStartMs(g: GqlGame): number { const n = Number(g.startsAt); if (Number.isFinite(n)) return n < 100000000000 ? n * 1000 : n; return new Date(String(g.startsAt || '')).getTime(); }
function signalStartMs(s: SignalRow): number { return new Date(s.starts_at || s.event_date || '').getTime(); }
function matchScore(signal: SignalRow, game: GqlGame): number { const [s1, s2] = parsePlayers(signal.match_name); const ps = gamePlayers(game); let score = 0; if (ps.length >= 2 && ((playerMatches(s1, ps[0]) && playerMatches(s2, ps[1])) || (playerMatches(s1, ps[1]) && playerMatches(s2, ps[0])))) score += 12; const text = norm([game.title, ps.join(' '), game.sport?.name, game.sport?.slug, game.sportId].join(' ')); for (const t of [...tokens(s1), ...tokens(s2)]) if (t.length > 1 && text.includes(t)) score += 1; const dh = Math.abs(signalStartMs(signal) - gameStartMs(game)) / 36e5; if (Number.isFinite(dh)) { if (dh <= 48) score += 2; if (dh <= 12) score += 2; } return score; }

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS); try { const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } }); const text = await res.text(); let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; } if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`); return body; } finally { clearTimeout(t); } }
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> { const body = await fetchJson(SUBGRAPH_URL, { method: 'POST', body: JSON.stringify({ query, variables }) }); if (body.errors?.length) throw new Error(body.errors.map((e: any) => e.message || JSON.stringify(e)).join(' | ')); return body.data as T; }
const blockCache = new Map<number, number>();
async function blockForTimestamp(ts: number): Promise<number> { if (blockCache.has(ts)) return blockCache.get(ts)!; const body = await fetchJson(`https://coins.llama.fi/block/${encodeURIComponent(DEFILLAMA_CHAIN[CHAIN] || CHAIN)}/${ts}`); const block = Number(body.height ?? body.block ?? body.number); if (!Number.isFinite(block)) throw new Error(`No block in DefiLlama response: ${JSON.stringify(body).slice(0, 200)}`); blockCache.set(ts, block); return block; }
async function loadSignals(): Promise<SignalRow[]> { const select = ['id','signal_key','event_date','starts_at','scanned_at','settled_at','match_name','strategy_lane','public_signal_name','score_cluster','score_odds_json','official_decimal_odds','original_official_decimal_odds','first_set_score','display_status','status','grouped_profit_units_calc'].join(','); const lanes = ACTIVE_LANES.join(','); let q = `${SOURCE_VIEW}?select=${encodeURIComponent(select)}&strategy_lane=in.(${lanes})&order=starts_at.desc&limit=${LIMIT}`; if (SOURCE_VIEW === 'proof_vault_locked_model_rows_v1') q += '&is_optimized_vip=is.true'; return fetchJson(`${SUPABASE_URL}/rest/v1/${q}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } }); }
async function fetchGames(block: number): Promise<{ games: GqlGame[]; schema: string }> { const whereVariants = [{ sportId: 100 }, {}, { activeConditionsCount_gt: 0 }]; let lastErr: Error | null = null; for (const where of whereVariants) { try { const all: GqlGame[] = []; for (let p = 0; p < MAX_GAME_PAGES; p += 1) { const data = await graphql<{ games: GqlGame[] }>(GAMES_V3_QUERY, { first: GAME_PAGE_SIZE, skip: p * GAME_PAGE_SIZE, where, block: { number: block } }); const batch = data.games || []; all.push(...batch); if (batch.length < GAME_PAGE_SIZE) break; } return { games: all, schema: 'v3' }; } catch (e) { lastErr = e as Error; } }
  try { const all: GqlGame[] = []; for (let p = 0; p < MAX_GAME_PAGES; p += 1) { const data = await graphql<{ games: GqlGame[] }>(GAMES_COMPAT_QUERY, { first: GAME_PAGE_SIZE, skip: p * GAME_PAGE_SIZE, where: { activeConditionsCount_gt: 0 }, block: { number: block } }); const batch = data.games || []; all.push(...batch.filter((g) => norm([g.sport?.name, g.sport?.slug, g.title].join(' ')).includes('tennis'))); if (batch.length < GAME_PAGE_SIZE) break; } return { games: all, schema: 'compat' }; } catch (e) { throw new Error(`V3 games query failed: ${lastErr?.message || 'unknown'} | Compat games query failed: ${(e as Error).message}`); } }
async function fetchGameConditions(gameId: string, block: number): Promise<{ game: GqlGame | null; conditions: GqlCondition[]; schema: string }> { try { const data = await graphql<{ game: GqlGame | null }>(GAME_WITH_CONDITIONS_V3_QUERY, { gameId, block: { number: block } }); return { game: data.game, conditions: data.game?.conditions || [], schema: 'v3' }; } catch (v3err) { try { const data = await graphql<{ game: GqlGame | null }>(GAME_WITH_CONDITIONS_COMPAT_QUERY, { gameId, block: { number: block } }); return { game: data.game, conditions: data.game?.conditions || [], schema: 'compat' }; } catch (compatErr) { throw new Error(`V3 condition query failed: ${(v3err as Error).message} | Compat condition query failed: ${(compatErr as Error).message}`); } } }
function pickGame(signal: SignalRow, games: GqlGame[]) { const scored = games.map((g) => ({ game: g, score: matchScore(signal, g) })).sort((a, b) => b.score - a.score); return { game: scored[0]?.score >= 8 ? scored[0].game : null, score: scored[0]?.score || 0, candidates: scored.slice(0, 5).map((x) => ({ id: x.game.id, title: x.game.title, score: x.score })) }; }
function pickMarket(conditions: GqlCondition[]): GqlCondition | null { const active = conditions.filter(isActiveCondition); const first = active.filter(isFirstSetScoreMarket); if (first.length) return first[0]; return active.find((c) => (c.outcomes || []).filter((o) => outcomeScore(o)).length >= 4 && /score|set/.test(norm(marketTitle(c)))) || null; }
function baseRow(signal: SignalRow, block: number | null, targets: string[], baseline: number | null, win: boolean | null): Omit<AuditRow, 'decision' | 'reason'> { return { run_id: RUN_ID, source: 'azuro_v3_historical_subgraph', model_name: `azuro_v3_historical_${SCORE_MODE}`, score_mode: SCORE_MODE, signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, strategy_lane: signal.strategy_lane, starts_at: signal.starts_at, scanned_at: signal.scanned_at, historical_timestamp: timestampForSignal(signal), block_number: block, target_scores: targets, first_set_score: signal.first_set_score, baseline_grouped_odds: baseline, baseline_units: units(win, baseline), azuro_game_id: null, azuro_game_title: null, azuro_condition_id: null, azuro_market_title: null, azuro_grouped_odds: null, azuro_units: null, hybrid_grouped_odds: baseline, hybrid_units: units(win, baseline), edge_vs_baseline: null, max_group_stake: null }; }
async function audit(signal: SignalRow): Promise<AuditRow> { const targets = scoreTargets(signal.strategy_lane, SCORE_MODE); const baseline = baselineOdds(signal, targets); const win = signal.first_set_score ? targets.includes(signal.first_set_score) : null; const ts = unixSeconds(timestampForSignal(signal)); if (!ts) return { ...baseRow(signal, null, targets, baseline, win), decision: 'API_ERROR', reason: 'Missing valid timestamp.' }; let block: number; try { block = await blockForTimestamp(ts); } catch (e) { return { ...baseRow(signal, null, targets, baseline, win), decision: 'API_ERROR', reason: `Block lookup failed: ${(e as Error).message}` }; } const base = baseRow(signal, block, targets, baseline, win); let gamesResp: { games: GqlGame[]; schema: string }; try { gamesResp = await fetchGames(block); } catch (e) { return { ...base, decision: 'API_ERROR', reason: `Historical games query failed: ${(e as Error).message}`, raw_calculations_json: { subgraph_url_configured: Boolean(SUBGRAPH_URL), subgraph_id: SUBGRAPH_ID || null } }; } const chosen = pickGame(signal, gamesResp.games); if (!chosen.game) return { ...base, decision: 'MISSING_GAME', reason: `No historical Azuro game matched at block ${block}; best score ${chosen.score}.`, raw_calculations_json: { schema: gamesResp.schema, best_candidates: chosen.candidates, games_returned: gamesResp.games.length } }; let condResp: { game: GqlGame | null; conditions: GqlCondition[]; schema: string }; try { condResp = await fetchGameConditions(chosen.game.id, block); } catch (e) { return { ...base, azuro_game_id: chosen.game.id, azuro_game_title: chosen.game.title || null, decision: 'API_ERROR', reason: `Historical conditions query failed: ${(e as Error).message}` }; } const market = pickMarket(condResp.conditions); if (!market) return { ...base, azuro_game_id: chosen.game.id, azuro_game_title: chosen.game.title || null, decision: 'MISSING_MARKET', reason: 'Game matched, but no active first-set correct-score market found.', raw_match_json: condResp.game || chosen.game, raw_conditions_json: condResp.conditions.slice(0, 20), raw_calculations_json: { schema: condResp.schema, conditions_returned: condResp.conditions.length } }; const outcomes = new Map<string, GqlOutcome>(); for (const o of market.outcomes || []) { const s = outcomeScore(o); if (s) outcomes.set(s, o); } const missing = targets.filter((s) => !outcomes.has(s)); const rows = targets.map((s) => { const o = outcomes.get(s); return o ? { score: s, odds: outcomeOdds(o), outcomeId: o.outcomeId, title: o.title } : null; }).filter(Boolean) as Array<{ score: string; odds: number | null; outcomeId?: string | number | null; title?: string | null }>; const azuroGrouped = groupedOdds(rows.map((r) => r.odds)); const stake = maxGroupStake(market, rows); const hybridOdds = azuroGrouped !== null && baseline !== null && azuroGrouped >= baseline + MIN_EDGE ? azuroGrouped : baseline; const enriched: Omit<AuditRow, 'decision' | 'reason'> = { ...base, azuro_game_id: chosen.game.id, azuro_game_title: chosen.game.title || null, azuro_condition_id: String(market.conditionId || market.id), azuro_market_title: marketTitle(market), azuro_grouped_odds: azuroGrouped, azuro_units: units(win, azuroGrouped), hybrid_grouped_odds: hybridOdds, hybrid_units: units(win, hybridOdds), edge_vs_baseline: azuroGrouped !== null && baseline !== null ? azuroGrouped - baseline : null, max_group_stake: stake, raw_match_json: condResp.game || chosen.game, raw_conditions_json: market, raw_calculations_json: { schema: condResp.schema, outcome_rows: rows, maxOutcomeWin: market.maxOutcomeWin, margin: market.margin } };
  if (missing.length) return { ...enriched, decision: 'MISSING_SCORE', reason: `First-set score market exists but missing targets: ${missing.join(', ')}` };
  if (azuroGrouped === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Target outcomes exist but one or more odds were missing/invalid.' };
  if (baseline === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Baseline odds missing, cannot compare.' };
  if (azuroGrouped < baseline + MIN_EDGE) return { ...enriched, decision: 'BAD_ODDS', reason: `Azuro grouped odds ${azuroGrouped.toFixed(4)} below baseline+edge ${(baseline + MIN_EDGE).toFixed(4)}.` };
  if (stake !== null && stake < REQUIRED_STAKE) return { ...enriched, decision: 'LOW_LIMIT', reason: `Max grouped stake ${stake.toFixed(2)} below required ${REQUIRED_STAKE.toFixed(2)}.` };
  return { ...enriched, decision: 'BETTABLE', reason: 'Historical game, market, target scores, odds, and limit checks passed.' };
}
function summarize(rows: AuditRow[]) { const decisions: Record<string, number> = {}; for (const r of rows) decisions[r.decision] = (decisions[r.decision] || 0) + 1; const sum = (xs: Array<number | null>) => xs.reduce((s, x) => s + (typeof x === 'number' && Number.isFinite(x) ? x : 0), 0); const bettable = rows.filter((r) => r.decision === 'BETTABLE'); return { run_id: RUN_ID, generated_at: new Date().toISOString(), source: 'azuro_v3_historical_subgraph', score_mode: SCORE_MODE, rows: rows.length, decisions: Object.fromEntries(Object.entries(decisions).sort()), baseline_units: sum(rows.map((r) => r.baseline_units)), azuro_bettable_rows: bettable.length, azuro_bettable_units: sum(bettable.map((r) => r.azuro_units)), hybrid_units: sum(rows.map((r) => r.hybrid_units)), note: 'API_ERROR is endpoint/schema/data access failure, not market coverage.' }; }
async function main() { ensureDir(OUT_DIR); const signals = await loadSignals(); const rows: AuditRow[] = []; for (const s of signals) { console.log(`V3 historical replay ${SCORE_MODE}: ${s.match_name}`); rows.push(await audit(s)); } const summary = summarize(rows); const fields = ['run_id','signal_id','match_name','strategy_lane','starts_at','scanned_at','block_number','target_scores','first_set_score','baseline_grouped_odds','baseline_units','azuro_game_id','azuro_game_title','azuro_market_title','azuro_grouped_odds','azuro_units','hybrid_grouped_odds','hybrid_units','edge_vs_baseline','max_group_stake','decision','reason']; writeJson(path.join(OUT_DIR, 'azuro_v3_historical_replay_rows.json'), rows); writeJson(path.join(OUT_DIR, 'azuro_v3_historical_replay_summary.json'), summary); writeCsv(path.join(OUT_DIR, 'azuro_v3_historical_replay_rows.csv'), rows as unknown as Record<string, unknown>[], fields); fs.writeFileSync(path.join(OUT_DIR, 'azuro_v3_historical_replay_report.md'), ['# Azuro V3 Historical Replay', '', `Run ID: ${RUN_ID}`, `Score mode: ${SCORE_MODE}`, `Subgraph ID: ${SUBGRAPH_ID || 'not set'}`, `Subgraph URL configured: ${Boolean(SUBGRAPH_URL)}`, '', '## Decisions', ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`), '', `Baseline units: ${summary.baseline_units}`, `Azuro BETTABLE units: ${summary.azuro_bettable_units}`, `Hybrid units: ${summary.hybrid_units}`, '', 'No wallet signing. No orders. No calldata.'].join('\n') + '\n', 'utf8'); console.log(JSON.stringify(summary, null, 2)); }
main().catch((err) => { console.error(err); process.exit(1); });
