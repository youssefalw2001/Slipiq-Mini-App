#!/usr/bin/env tsx
/*
  First Set Lab / SlipIQ
  Azuro GraphQL tennis prematch correct-score audit script.

  SAFE MODE ONLY:
  - Does not place bets.
  - Does not create orders.
  - Does not sign wallet transactions.
  - Does not generate ready-to-submit calldata.

  This script intentionally uses the documented Azuro data-feed GraphQL pattern:
  1. games(first, skip, where: { state: 'Prematch', activeConditionsCount_gt: 0 })
  2. game(id) { conditions(where: { state: 'Active' }) { outcomes { currentOdds } } }

  It avoids undocumented fields/filters that previously caused API_ERROR rows.
  HTTP/GraphQL failures remain API_ERROR and are never counted as MISSING_GAME.
*/

import fs from 'node:fs';
import path from 'node:path';

type ScoreMode = 'protected3' | 'gate2';
type AuditStatus = 'API_ERROR' | 'MISSING_GAME' | 'MISSING_MARKET' | 'MISSING_SCORE' | 'BAD_ODDS' | 'LOW_LIMIT' | 'BETTABLE';
type Args = Record<string, string>;

type SignalRow = {
  id: string;
  signal_key: string | null;
  event_date: string | null;
  starts_at: string | null;
  match_name: string | null;
  strategy_lane: string | null;
  public_signal_name: string | null;
  score_odds_json: Record<string, unknown> | null;
  official_decimal_odds: string | number | null;
  original_official_decimal_odds: string | number | null;
};

type Sport = { name?: string | null; slug?: string | null };
type Participant = { name?: string | null; image?: string | null; sortOrder?: string | number | null };
type League = { name?: string | null; country?: { name?: string | null } | null };

type AzuroGame = {
  id: string;
  gameId: string;
  title: string;
  startsAt: string | number;
  state: string;
  sport?: Sport | null;
  league?: League | null;
  participants?: Participant[] | null;
  activeConditionsCount?: number;
};

type AzuroOutcome = {
  id: string;
  outcomeId: string;
  title: string | null;
  currentOdds: string | number | null;
};

type AzuroCondition = {
  id: string;
  conditionId: string;
  title: string | null;
  state: string;
  isPrematchEnabled: boolean;
  isLiveEnabled: boolean;
  isExpressForbidden: boolean;
  maxConditionPotentialLoss?: string | number | null;
  maxOutcomePotentialLoss?: string | number | null;
  currentConditionPotentialLoss?: string | number | null;
  outcomes: AzuroOutcome[];
};

type GameWithConditions = AzuroGame & { conditions: AzuroCondition[] };

type AuditRow = {
  run_id: string;
  source: string;
  signal_id: string | null;
  signal_key: string | null;
  match_name: string | null;
  event_date: string | null;
  starts_at: string | null;
  strategy_lane: string | null;
  public_signal_name: string | null;
  model_bucket: string;
  target_scores: string[];
  baseline_grouped_odds: number | null;
  azuro_game_id?: string | null;
  azuro_game_title?: string | null;
  azuro_league?: string | null;
  azuro_sport?: string | null;
  azuro_condition_id?: string | null;
  azuro_market_title?: string | null;
  score_outcomes_json?: Record<string, unknown>;
  azuro_grouped_odds?: number | null;
  edge_vs_baseline?: number | null;
  min_score_max_bet?: number | null;
  min_score_max_payout?: number | null;
  max_group_stake?: number | null;
  decision: AuditStatus;
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
] as const;

const DEFAULT_SUBGRAPH = 'https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon';
const DEFAULT_SUPABASE_URL = 'https://qjvpkkcbscsypymxyker.supabase.co';

const GAMES_QUERY = `
query Games($first: Int, $skip: Int, $where: Game_filter) {
  games(first: $first, skip: $skip, where: $where, orderBy: startsAt, orderDirection: asc) {
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

const GAME_CONDITIONS_QUERY = `
query GameConditions($gameId: ID!) {
  game(id: $gameId) {
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
      isPrematchEnabled
      isLiveEnabled
      isExpressForbidden
      maxConditionPotentialLoss
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
  return Object.fromEntries(
    process.argv
      .slice(2)
      .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]])
  );
}

const args = parseArgs();
const arg = (name: string, env: string, fallback = '') => args[name] ?? process.env[env] ?? fallback;

const RUN_ID = arg('run-id', 'RUN_ID', `azuro_graphql_tennis_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SUPABASE_URL = arg('supabase-url', 'SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SUPABASE_KEY = arg('supabase-key', 'SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_ANON_KEY ?? '');
const SUBGRAPH_URL = arg('subgraph-url', 'AZURO_DATA_FEED_SUBGRAPH_URL', DEFAULT_SUBGRAPH);
const SCORE_MODE = arg('score-mode', 'SCORE_MODE', 'protected3') as ScoreMode;
const LIMIT = Number(arg('limit', 'LIMIT', '50')) || 50;
const MAX_GAME_PAGES = Number(arg('max-game-pages', 'MAX_GAME_PAGES', '12')) || 12;
const GAME_PAGE_SIZE = Math.min(Number(arg('game-page-size', 'GAME_PAGE_SIZE', '100')) || 100, 1000);
const MIN_EDGE = Number(arg('min-edge', 'MIN_EDGE', '0')) || 0;
const BANKROLL = Number(arg('bankroll', 'BANKROLL', '3000')) || 3000;
const RISK_PCT = Number(arg('risk-pct', 'RISK_PCT', '0.03')) || 0.03;
const MIN_GROUP_STAKE = Number(arg('min-group-stake', 'MIN_GROUP_STAKE', String(BANKROLL * RISK_PCT))) || BANKROLL * RISK_PCT;
const WRITE_SUPABASE = String(arg('write-supabase', 'WRITE_SUPABASE', 'false')).toLowerCase() === 'true';
const OUT_DIR = arg('out', 'OUT_DIR', 'artifacts/output/azuro-graphql-tennis-prematch-audit');
const FETCH_TIMEOUT_MS = Number(arg('timeout-ms', 'FETCH_TIMEOUT_MS', '20000')) || 20000;

if (!['protected3', 'gate2'].includes(SCORE_MODE)) throw new Error(`Invalid score-mode: ${SCORE_MODE}`);
if (WRITE_SUPABASE && !SUPABASE_KEY) throw new Error('write_supabase=true requires SUPABASE_SERVICE_ROLE_KEY or --supabase-key');

function clean(v: unknown): string { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function norm(v: unknown): string {
  return clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(v: unknown): string[] { return norm(v).split(' ').filter(Boolean); }
function num(v: unknown): number | null {
  if (v === null || v === undefined || clean(v) === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file: string, value: unknown): void { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function csvEscape(v: unknown): string {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeCsv(file: string, rows: Record<string, unknown>[], fields: string[]): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8');
}
function modelBucket(lane: string | null): string {
  return lane === 'CORE_P1_ATP_GS_BET365' || lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365'
    ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP'
    : 'OPTIMIZED_VIP';
}
function parsePlayers(matchName: string | null): [string, string] {
  const raw = clean(matchName).replace(/\s+vs\.?\s+/i, ' v ').replace(/\s+@\s+/i, ' v ').replace(/\s+-\s+/i, ' v ');
  const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, ''];
}
function playerMatches(signalPlayer: string, candidatePlayer: string): boolean {
  const sig = tokens(signalPlayer);
  const cand = tokens(candidatePlayer);
  if (!sig.length || !cand.length) return false;
  const sigLast = sig[sig.length - 1];
  const candLast = cand[cand.length - 1];
  const lastOk = sigLast === candLast || sigLast.includes(candLast) || candLast.includes(sigLast);
  const firstOk = sig[0]?.[0] === cand[0]?.[0] || sig.some((s) => cand.includes(s)) || cand.some((c) => sig.includes(c));
  return lastOk && firstOk;
}
function gameParticipants(game: AzuroGame): string[] {
  const ps = (game.participants || []).map((p) => clean(p.name)).filter(Boolean);
  return ps.length ? ps : parsePlayers(game.title).filter(Boolean);
}
function gameStartMs(game: AzuroGame): number {
  const n = Number(game.startsAt);
  if (Number.isFinite(n)) return n < 100000000000 ? n * 1000 : n;
  return new Date(String(game.startsAt)).getTime();
}
function signalStartMs(signal: SignalRow): number {
  return new Date(signal.starts_at || signal.event_date || '').getTime();
}
function matchScore(signal: SignalRow, game: AzuroGame): number {
  const [s1, s2] = parsePlayers(signal.match_name);
  const ps = gameParticipants(game);
  let score = 0;
  if (ps.length >= 2) {
    if ((playerMatches(s1, ps[0]) && playerMatches(s2, ps[1])) || (playerMatches(s1, ps[1]) && playerMatches(s2, ps[0]))) score += 12;
  }
  const text = norm([game.title, ps.join(' '), game.league?.name, game.sport?.name, game.sport?.slug].join(' '));
  for (const t of [...tokens(s1), ...tokens(s2)]) if (t.length > 1 && text.includes(t)) score += 1;
  if (text.includes('tennis')) score += 2;
  const st = signalStartMs(signal);
  const gt = gameStartMs(game);
  if (Number.isFinite(st) && Number.isFinite(gt)) {
    const h = Math.abs(st - gt) / 36e5;
    if (h <= 36) score += 3;
    if (h <= 12) score += 2;
  }
  return score;
}
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
function scoreFromOutcome(title: string | null): string {
  const raw = clean(title).replace(/[–—-]/g, ':');
  const m = raw.match(/\b(\d)\s*[:]\s*(\d)\b/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function isFirstSetCorrectScoreMarket(condition: AzuroCondition): boolean {
  const title = norm(condition.title);
  return /first|1st|set 1|1 set/.test(title) && /score/.test(title);
}
function groupedOdds(odds: Array<number | null>): number | null {
  if (!odds.length || odds.some((o) => o === null || o <= 1)) return null;
  const implied = odds.reduce((s, o) => s + 1 / (o as number), 0);
  return implied > 0 ? 1 / implied : null;
}
function baselineGroupedOdds(signal: SignalRow, scores: string[]): { odds: number | null; source: string; hasAllScoreOdds: boolean } {
  const direct = groupedOdds(scores.map((s) => num(signal.score_odds_json?.[s])));
  if (direct) return { odds: direct, source: 'score_odds_json', hasAllScoreOdds: true };
  const fallback = num(signal.original_official_decimal_odds) ?? num(signal.official_decimal_odds);
  return { odds: fallback, source: fallback ? 'official_decimal_odds_fallback' : 'missing', hasAllScoreOdds: false };
}
function estimateLimit(condition: AzuroCondition, outcomeRows: Array<{ score: string; odds: number | null }>): { maxGroupStake: number | null; minScoreMaxPayout: number | null; minScoreMaxBet: number | null } {
  const maxOutcomeLoss = num(condition.maxOutcomePotentialLoss);
  const currentLoss = num(condition.currentConditionPotentialLoss) ?? 0;
  if (maxOutcomeLoss === null) return { maxGroupStake: null, minScoreMaxPayout: null, minScoreMaxBet: null };
  const remainingPayout = Math.max(0, maxOutcomeLoss - currentLoss);
  const implied = outcomeRows.reduce((s, r) => s + (r.odds && r.odds > 1 ? 1 / r.odds : 0), 0);
  if (!implied) return { maxGroupStake: null, minScoreMaxPayout: null, minScoreMaxBet: null };
  const minBet = Math.min(...outcomeRows.map((r) => (r.odds && r.odds > 1 ? remainingPayout / r.odds : Infinity)).filter(Number.isFinite));
  return { maxGroupStake: remainingPayout * implied, minScoreMaxPayout: remainingPayout, minScoreMaxBet: Number.isFinite(minBet) ? minBet : null };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}
async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(SUBGRAPH_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  } catch (err) {
    throw new Error(`GraphQL transport failure: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 700)}`);
  if (body.errors?.length) throw new Error(`GraphQL errors: ${body.errors.map((e: any) => e.message || JSON.stringify(e)).join(' | ')}`);
  return body.data as T;
}
async function supabaseSelect(pathAndQuery: string): Promise<SignalRow[]> {
  if (!SUPABASE_KEY) throw new Error('Missing Supabase key for signal loading.');
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as SignalRow[];
}
async function supabaseInsert(rows: AuditRow[]): Promise<void> {
  if (!WRITE_SUPABASE || !rows.length) return;
  const validRows = rows.filter((r) => r.decision !== 'API_ERROR');
  if (!validRows.length) return;
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/azuro_execution_audit_v1`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(validRows),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase insert HTTP ${res.status}: ${text.slice(0, 500)}`);
}

async function loadSignals(): Promise<SignalRow[]> {
  const select = ['id', 'signal_key', 'event_date', 'starts_at', 'match_name', 'strategy_lane', 'public_signal_name', 'score_odds_json', 'official_decimal_odds', 'original_official_decimal_odds'].join(',');
  const lanes = ACTIVE_LANES.join(',');
  return supabaseSelect(`proof_vault_recent_receipts_v2_protected?select=${encodeURIComponent(select)}&strategy_lane=in.(${lanes})&order=event_date.desc&limit=${LIMIT}`);
}
async function fetchPrematchTennisGames(): Promise<{ games: AzuroGame[]; apiErrors: string[] }> {
  const games: AzuroGame[] = [];
  const apiErrors: string[] = [];
  for (let page = 0; page < MAX_GAME_PAGES; page += 1) {
    try {
      const data = await graphql<{ games: AzuroGame[] }>(GAMES_QUERY, { first: GAME_PAGE_SIZE, skip: page * GAME_PAGE_SIZE, where: { state: 'Prematch', activeConditionsCount_gt: 0 } });
      const batch = data.games || [];
      games.push(...batch.filter((g) => norm([g.sport?.name, g.sport?.slug, g.title].join(' ')).includes('tennis')));
      if (batch.length < GAME_PAGE_SIZE) break;
    } catch (err) {
      apiErrors.push((err as Error).message);
      break;
    }
  }
  return { games, apiErrors };
}
async function fetchGameConditions(gameId: string): Promise<{ game: GameWithConditions | null; apiError: string | null }> {
  try {
    const data = await graphql<{ game: GameWithConditions | null }>(GAME_CONDITIONS_QUERY, { gameId });
    return { game: data.game, apiError: null };
  } catch (err) {
    return { game: null, apiError: (err as Error).message };
  }
}
function chooseGame(signal: SignalRow, games: AzuroGame[]): { game: AzuroGame | null; score: number; candidates: Array<{ gameId: string; title: string; score: number }> } {
  const scored = games.map((game) => ({ game, score: matchScore(signal, game) })).sort((a, b) => b.score - a.score);
  return { game: scored[0]?.score >= 8 ? scored[0].game : null, score: scored[0]?.score ?? 0, candidates: scored.slice(0, 5).map((x) => ({ gameId: x.game.id, title: x.game.title, score: x.score })) };
}
function pickMarket(conditions: AzuroCondition[]): AzuroCondition | null {
  const activePrematch = conditions.filter((c) => c.state === 'Active' && c.isPrematchEnabled !== false);
  const firstSet = activePrematch.filter(isFirstSetCorrectScoreMarket);
  if (firstSet.length) return firstSet.sort((a, b) => clean(b.title).length - clean(a.title).length)[0];
  const scoreLike = activePrematch.filter((c) => (c.outcomes || []).filter((o) => scoreFromOutcome(o.title)).length >= 4 && /score|set/.test(norm(c.title)));
  return scoreLike[0] || null;
}
function apiErrorRow(signal: SignalRow, message: string, extra: unknown = {}): AuditRow {
  return { run_id: RUN_ID, source: 'azuro_data_feed_graphql', signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, event_date: signal.event_date, starts_at: signal.starts_at, strategy_lane: signal.strategy_lane, public_signal_name: signal.public_signal_name, model_bucket: modelBucket(signal.strategy_lane), target_scores: scoreTargetsForLane(signal.strategy_lane, SCORE_MODE), baseline_grouped_odds: null, decision: 'API_ERROR', reason: message, raw_calculations_json: extra };
}
function missingGameRow(signal: SignalRow, chosen: ReturnType<typeof chooseGame>, baseline: ReturnType<typeof baselineGroupedOdds>, targets: string[]): AuditRow {
  return { run_id: RUN_ID, source: 'azuro_data_feed_graphql', signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, event_date: signal.event_date, starts_at: signal.starts_at, strategy_lane: signal.strategy_lane, public_signal_name: signal.public_signal_name, model_bucket: modelBucket(signal.strategy_lane), target_scores: targets, baseline_grouped_odds: baseline.odds, decision: 'MISSING_GAME', reason: `GraphQL succeeded, but no tennis prematch game matched by participant/title tokens. Best match score: ${chosen.score}.`, raw_calculations_json: { best_candidates: chosen.candidates, baseline_source: baseline.source, baseline_has_all_target_scores: baseline.hasAllScoreOdds } };
}
function auditDecision(signal: SignalRow, game: GameWithConditions, condition: AzuroCondition | null, targets: string[], baseline: ReturnType<typeof baselineGroupedOdds>): AuditRow {
  const base: AuditRow = { run_id: RUN_ID, source: 'azuro_data_feed_graphql', signal_id: signal.id, signal_key: signal.signal_key, match_name: signal.match_name, event_date: signal.event_date, starts_at: signal.starts_at, strategy_lane: signal.strategy_lane, public_signal_name: signal.public_signal_name, model_bucket: modelBucket(signal.strategy_lane), target_scores: targets, baseline_grouped_odds: baseline.odds, azuro_game_id: game.id, azuro_game_title: game.title, azuro_league: clean(game.league?.name), azuro_sport: clean(game.sport?.name || game.sport?.slug), raw_match_json: game, raw_calculations_json: { score_mode: SCORE_MODE, bankroll: BANKROLL, risk_pct: RISK_PCT, required_group_stake: MIN_GROUP_STAKE, baseline_source: baseline.source, baseline_has_all_target_scores: baseline.hasAllScoreOdds, subgraph_url: SUBGRAPH_URL }, decision: 'MISSING_MARKET', reason: '' };
  if (!condition) return { ...base, decision: 'MISSING_MARKET', reason: 'Game matched, but no active prematch Correct Score - 1st Set market was found.' };

  const outcomeMap = new Map<string, AzuroOutcome>();
  for (const outcome of condition.outcomes || []) {
    const score = scoreFromOutcome(outcome.title);
    if (score) outcomeMap.set(score, outcome);
  }
  const missing = targets.filter((s) => !outcomeMap.has(s));
  const outcomeRows = targets.map((score) => {
    const o = outcomeMap.get(score);
    return o ? { score, outcomeId: String(o.outcomeId), odds: num(o.currentOdds), title: o.title } : null;
  }).filter((x): x is { score: string; outcomeId: string; odds: number | null; title: string | null } => Boolean(x));
  const azuroGrouped = groupedOdds(outcomeRows.map((r) => r.odds));
  const lim = estimateLimit(condition, outcomeRows);
  const enriched: AuditRow = { ...base, azuro_condition_id: String(condition.conditionId), azuro_market_title: condition.title, score_outcomes_json: Object.fromEntries(outcomeRows.map((r) => [r.score, r])), azuro_grouped_odds: azuroGrouped, edge_vs_baseline: azuroGrouped !== null && baseline.odds !== null ? azuroGrouped - baseline.odds : null, min_score_max_bet: lim.minScoreMaxBet, min_score_max_payout: lim.minScoreMaxPayout, max_group_stake: lim.maxGroupStake, raw_conditions_json: condition };
  if (missing.length) return { ...enriched, decision: 'MISSING_SCORE', reason: `Correct-score market exists, but missing target scores: ${missing.join(', ')}` };
  if (azuroGrouped === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Target scores exist, but one or more Azuro odds were missing or invalid.' };
  if (baseline.odds === null) return { ...enriched, decision: 'BAD_ODDS', reason: 'Cannot compare Azuro grouped odds because baseline grouped/Web2 odds are missing.' };
  if (azuroGrouped < baseline.odds + MIN_EDGE) return { ...enriched, decision: 'BAD_ODDS', reason: `Azuro grouped odds ${azuroGrouped.toFixed(4)} below required baseline+edge ${(baseline.odds + MIN_EDGE).toFixed(4)}.` };
  if (lim.maxGroupStake !== null && lim.maxGroupStake < MIN_GROUP_STAKE) return { ...enriched, decision: 'LOW_LIMIT', reason: `Estimated max grouped stake ${lim.maxGroupStake.toFixed(2)} below required stake ${MIN_GROUP_STAKE.toFixed(2)}.` };
  return { ...enriched, decision: 'BETTABLE', reason: 'Game, market, target scores, odds comparison, and estimated limit checks passed.' };
}
async function auditSignals(): Promise<AuditRow[]> {
  const signals = await loadSignals();
  const { games, apiErrors } = await fetchPrematchTennisGames();
  if (apiErrors.length) return signals.map((s) => apiErrorRow(s, `GraphQL game fetch failed. This is not MISSING_GAME. ${apiErrors.slice(0, 2).join(' | ')}`, { api_errors: apiErrors, subgraph_url: SUBGRAPH_URL }));
  const rows: AuditRow[] = [];
  for (const signal of signals) {
    const targets = scoreTargetsForLane(signal.strategy_lane, SCORE_MODE);
    const baseline = baselineGroupedOdds(signal, targets);
    const chosen = chooseGame(signal, games);
    if (!chosen.game) { rows.push(missingGameRow(signal, chosen, baseline, targets)); continue; }
    const conditions = await fetchGameConditions(chosen.game.id);
    if (conditions.apiError) { rows.push(apiErrorRow(signal, `GraphQL condition fetch failed. This is not MISSING_MARKET. ${conditions.apiError}`, { azuro_game_id: chosen.game.id, azuro_game_title: chosen.game.title })); continue; }
    rows.push(auditDecision(signal, conditions.game || ({ ...chosen.game, conditions: [] } as GameWithConditions), pickMarket(conditions.game?.conditions || []), targets, baseline));
  }
  return rows;
}
function summarize(rows: AuditRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.decision] = (out[row.decision] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}
function logRows(rows: AuditRow[]): void {
  for (const row of rows) console.log([row.decision.padEnd(14), clean(row.strategy_lane).padEnd(36), clean(row.match_name).slice(0, 60).padEnd(60), row.reason].join(' | '));
}
async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const rows = await auditSignals();
  const summary = { run_id: RUN_ID, generated_at: new Date().toISOString(), source: 'azuro_data_feed_graphql', subgraph_url: SUBGRAPH_URL, score_mode: SCORE_MODE, write_supabase: WRITE_SUPABASE, signals_checked: rows.length, decisions: summarize(rows), note: 'Safe GraphQL audit only. API errors are separated from MISSING_GAME and are not written as market coverage failures.' };
  const fields = ['run_id', 'source', 'signal_id', 'match_name', 'event_date', 'starts_at', 'strategy_lane', 'public_signal_name', 'target_scores', 'baseline_grouped_odds', 'azuro_game_id', 'azuro_game_title', 'azuro_market_title', 'azuro_grouped_odds', 'edge_vs_baseline', 'min_score_max_bet', 'min_score_max_payout', 'max_group_stake', 'decision', 'reason'];
  writeJson(path.join(OUT_DIR, 'azuro_graphql_tennis_audit.json'), rows);
  writeJson(path.join(OUT_DIR, 'azuro_graphql_tennis_summary.json'), summary);
  writeCsv(path.join(OUT_DIR, 'azuro_graphql_tennis_audit.csv'), rows as unknown as Record<string, unknown>[], fields);
  fs.writeFileSync(path.join(OUT_DIR, 'azuro_graphql_tennis_report.md'), ['# Azuro GraphQL Tennis Prematch Audit', '', `Run ID: ${RUN_ID}`, `Generated: ${summary.generated_at}`, `Subgraph: ${SUBGRAPH_URL}`, `Score mode: ${SCORE_MODE}`, `Write Supabase: ${WRITE_SUPABASE}`, '', '## Decisions', ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`), '', '## Safety', '- No guessed REST routes.', '- No wallet signing.', '- No bet orders.', '- HTTP/GraphQL failures are API_ERROR, not MISSING_GAME.', '- Supabase writing defaults to false.'].join('\n') + '\n', 'utf8');
  logRows(rows);
  console.log(JSON.stringify(summary, null, 2));
  if (WRITE_SUPABASE) {
    const writable = rows.filter((r) => r.decision !== 'API_ERROR');
    const hasValidStates = writable.some((r) => ['MISSING_MARKET', 'MISSING_SCORE', 'BAD_ODDS', 'LOW_LIMIT', 'BETTABLE'].includes(r.decision));
    if (!hasValidStates) console.warn('Skipping Supabase write: no valid post-match audit state was calculated.');
    else { await supabaseInsert(writable); console.log(`Inserted ${writable.length} non-API_ERROR audit rows into Supabase.`); }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
