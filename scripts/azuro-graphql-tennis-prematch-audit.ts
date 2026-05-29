#!/usr/bin/env tsx
/*
  First Set Lab / SlipIQ
  Azuro GraphQL-only tennis prematch correct-score audit script.

  SAFE MODE ONLY:
  - Does not place bets.
  - Does not create orders.
  - Does not sign wallet transactions.
  - Does not generate ready-to-submit calldata.

  Why this exists:
  - Previous integrations tried guessed REST routes and produced 404-driven MISSING_GAME rows.
  - This script uses the documented Azuro data-feed GraphQL subgraph for Polygon by default:
    https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon
  - HTTP/GraphQL transport failures are reported as API_ERROR and are never written as MISSING_GAME.

  Default behavior:
  - write_supabase=false
  - score_mode=protected3
  - chain=polygon

  Example:
    npx tsx scripts/azuro-graphql-tennis-prematch-audit.ts \
      --limit=50 \
      --score-mode=protected3 \
      --write-supabase=false

  Optional chain routing:
  - Polygon is built in from official Azuro docs.
  - For other chains, pass --subgraph-url explicitly. The script intentionally refuses
    to invent Arbitrum/Gnosis subgraph URLs.
*/

import fs from 'node:fs';
import path from 'node:path';

// -----------------------------
// Types
// -----------------------------

type ScoreMode = 'protected3' | 'gate2';
type AuditStatus = 'API_ERROR' | 'MISSING_GAME' | 'MISSING_MARKET' | 'MISSING_SCORE' | 'BAD_ODDS' | 'LOW_LIMIT' | 'BETTABLE';

type CliArgs = Record<string, string>;

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
  display_status?: string | null;
  status?: string | null;
};

type AzuroSport = { name?: string | null; slug?: string | null; sportId?: string | null };
type AzuroParticipant = { name?: string | null; image?: string | null; sortOrder?: string | number | null };
type AzuroLeague = { name?: string | null; slug?: string | null; country?: { name?: string | null } | null };
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
  margin?: string | number | null;
  outcomes: AzuroOutcome[];
};
type AzuroGame = {
  id: string;
  gameId: string;
  title: string;
  startsAt: string | number;
  state: string;
  sport: AzuroSport | null;
  league: AzuroLeague | null;
  participants: AzuroParticipant[];
  activeConditionsCount?: number;
  activePrematchConditionsCount?: number;
  activeLiveConditionsCount?: number;
};

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

// -----------------------------
// Constants and config
// -----------------------------

const ACTIVE_LANES = [
  'CORE_P1_ATP_GS_BET365',
  'CORE_P2_GS_REVERSE_STRETCH_BET365',
  'RESEARCH_P2_GS_26_46_BET365',
  'VIP_P2_V3_SHAPE',
] as const;

const POLYGON_DATA_FEED_SUBGRAPH = 'https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon';
const DEFAULT_SUPABASE_URL = 'https://qjvpkkcbscsypymxyker.supabase.co';

const GAMES_QUERY = `
query PrematchGames($first: Int!, $skip: Int!, $where: Game_filter) {
  games(first: $first, skip: $skip, where: $where, orderBy: startsAt, orderDirection: asc) {
    id
    gameId
    title
    startsAt
    state
    sport { name slug }
    league { name slug country { name } }
    participants { name image sortOrder }
    activeConditionsCount
    activePrematchConditionsCount
    activeLiveConditionsCount
  }
}`;

const GAME_CONDITIONS_QUERY = `
query GameConditions($gameId: ID!) {
  game(id: $gameId) {
    id
    gameId
    title
    state
    sport { name slug }
    league { name slug country { name } }
    participants { name image sortOrder }
    conditions(where: { state: "Active", isPrematchEnabled: true }) {
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

// -----------------------------
// Utilities
// -----------------------------

function parseArgs(): CliArgs {
  return Object.fromEntries(
    process.argv
      .slice(2)
      .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]])
  );
}

const args = parseArgs();

function arg(name: string, envName: string, fallback = ''): string {
  return args[name] ?? process.env[envName] ?? fallback;
}

const RUN_ID = arg('run-id', 'RUN_ID', `azuro_graphql_tennis_${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SUPABASE_URL = arg('supabase-url', 'SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/$/, '');
const SUPABASE_KEY = arg('supabase-key', 'SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_ANON_KEY ?? '');
const CHAIN = arg('chain', 'AZURO_CHAIN', 'polygon').toLowerCase();
const SUBGRAPH_URL = arg('subgraph-url', 'AZURO_DATA_FEED_SUBGRAPH_URL', CHAIN === 'polygon' ? POLYGON_DATA_FEED_SUBGRAPH : '');
const SCORE_MODE = arg('score-mode', 'SCORE_MODE', 'protected3') as ScoreMode;
const LIMIT = Number(arg('limit', 'LIMIT', '50')) || 50;
const MAX_GAME_PAGES = Number(arg('max-game-pages', 'MAX_GAME_PAGES', '10')) || 10;
const GAME_PAGE_SIZE = Math.min(Number(arg('game-page-size', 'GAME_PAGE_SIZE', '100')) || 100, 1000);
const MIN_EDGE = Number(arg('min-edge', 'MIN_EDGE', '0')) || 0;
const BANKROLL = Number(arg('bankroll', 'BANKROLL', '3000')) || 3000;
const RISK_PCT = Number(arg('risk-pct', 'RISK_PCT', '0.03')) || 0.03;
const MIN_GROUP_STAKE = Number(arg('min-group-stake', 'MIN_GROUP_STAKE', String(BANKROLL * RISK_PCT))) || BANKROLL * RISK_PCT;
const WRITE_SUPABASE = String(arg('write-supabase', 'WRITE_SUPABASE', 'false')).toLowerCase() === 'true';
const OUT_DIR = arg('out', 'OUT_DIR', 'artifacts/output/azuro-graphql-tennis-prematch-audit');
const FETCH_TIMEOUT_MS = Number(arg('timeout-ms', 'FETCH_TIMEOUT_MS', '20000')) || 20000;

function failConfig(message: string): never {
  throw new Error(`[CONFIG] ${message}`);
}

if (!['protected3', 'gate2'].includes(SCORE_MODE)) failConfig(`Invalid score mode: ${SCORE_MODE}`);
if (!SUBGRAPH_URL) failConfig(`No data-feed subgraph URL configured for chain=${CHAIN}. Pass --subgraph-url explicitly.`);
if (WRITE_SUPABASE && !SUPABASE_KEY) failConfig('write_supabase=true requires SUPABASE_SERVICE_ROLE_KEY or --supabase-key.');

function ensureDir(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }
function clean(v: unknown): string { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function lower(v: unknown): string { return clean(v).toLowerCase(); }
function num(v: unknown): number | null {
  if (v === null || v === undefined || clean(v) === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function csvEscape(v: unknown): string {
  const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeJson(file: string, value: unknown): void { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function writeCsv(file: string, rows: Record<string, unknown>[], fields: string[]): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, [fields.join(','), ...rows.map((r) => fields.map((f) => csvEscape(r[f])).join(','))].join('\n') + '\n', 'utf8');
}
function normalizeText(v: unknown): string {
  return clean(v)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function tokens(v: unknown): string[] {
  return normalizeText(v).split(' ').filter((t) => t.length > 0);
}
function initialsAwareNameTokens(name: string): string[] {
  const ts = tokens(name);
  const expanded = new Set(ts);
  for (const t of ts) if (t.length === 1) expanded.add(t[0]);
  return [...expanded];
}
function parsePlayers(matchName: string | null): [string, string] {
  const raw = clean(matchName)
    .replace(/\s+vs\.?\s+/i, ' v ')
    .replace(/\s+@\s+/i, ' v ')
    .replace(/\s+-\s+/i, ' v ');
  const parts = raw.split(/\s+v\s+/i).map(clean).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' v ')] : [raw, ''];
}
function playerMatches(signalPlayer: string, candidatePlayer: string): boolean {
  const sig = initialsAwareNameTokens(signalPlayer);
  const cand = initialsAwareNameTokens(candidatePlayer);
  if (!sig.length || !cand.length) return false;

  const sigLast = sig[sig.length - 1];
  const candLast = cand[cand.length - 1];
  const lastOk = sigLast === candLast || sigLast.includes(candLast) || candLast.includes(sigLast);
  const firstOk = sig[0]?.[0] === cand[0]?.[0] || sig.some((s) => cand.includes(s)) || cand.some((c) => sig.includes(c));
  return Boolean(lastOk && firstOk);
}
function gameParticipants(game: AzuroGame): string[] {
  const ps = Array.isArray(game.participants) ? game.participants.map((p) => clean(p.name)).filter(Boolean) : [];
  if (ps.length) return ps;
  return parsePlayers(game.title).filter(Boolean);
}
function matchScore(signal: SignalRow, game: AzuroGame): number {
  const [s1, s2] = parsePlayers(signal.match_name);
  const ps = gameParticipants(game);
  let score = 0;

  if (ps.length >= 2) {
    const direct = playerMatches(s1, ps[0]) && playerMatches(s2, ps[1]);
    const reverse = playerMatches(s1, ps[1]) && playerMatches(s2, ps[0]);
    if (direct || reverse) score += 10;
  }

  const gameText = normalizeText([game.title, ps.join(' '), game.league?.name, game.sport?.name, game.sport?.slug].join(' '));
  for (const t of tokens(s1)) if (t.length > 1 && gameText.includes(t)) score += 1;
  for (const t of tokens(s2)) if (t.length > 1 && gameText.includes(t)) score += 1;
  if (/tennis/.test(gameText)) score += 2;

  const signalTime = new Date(signal.starts_at || signal.event_date || '').getTime();
  const gameTime = Number(game.startsAt) < 100000000000 ? Number(game.startsAt) * 1000 : new Date(String(game.startsAt)).getTime();
  if (Number.isFinite(signalTime) && Number.isFinite(gameTime)) {
    const diffHours = Math.abs(signalTime - gameTime) / 36e5;
    if (diffHours <= 36) score += 3;
    if (diffHours <= 12) score += 2;
  }

  return score;
}
function groupedOdds(odds: Array<number | null>): number | null {
  const xs = odds.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 1);
  if (xs.length !== odds.length || !xs.length) return null;
  const implied = xs.reduce((acc, x) => acc + 1 / x, 0);
  return implied > 0 ? 1 / implied : null;
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
function scoreFromOutcomeTitle(title: string | null): string {
  const raw = clean(title).replace(/[–—-]/g, ':');
  const m = raw.match(/\b(\d)\s*[:]\s*(\d)\b/) || raw.match(/\b(\d)\s*-\s*(\d)\b/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function isFirstSetCorrectScoreMarket(condition: AzuroCondition): boolean {
  const title = normalizeText(condition.title);
  const first = /(^|\s)(first|1st|set 1|1 set)(\s|$)/.test(title);
  const score = /correct score|score/.test(title);
  return first && score;
}
function baselineGroupedOdds(signal: SignalRow, scores: string[]): { odds: number | null; source: string; hasAllScoreOdds: boolean } {
  const scoreOdds = scores.map((s) => num(signal.score_odds_json?.[s]));
  const g = groupedOdds(scoreOdds);
  if (g) return { odds: g, source: 'score_odds_json', hasAllScoreOdds: true };
  const fallback = num(signal.original_official_decimal_odds) ?? num(signal.official_decimal_odds);
  return { odds: fallback, source: fallback ? 'official_decimal_odds_fallback' : 'missing', hasAllScoreOdds: false };
}
function estimateGroupLimit(condition: AzuroCondition, outcomeRows: Array<{ score: string; odds: number | null }>): { maxGroupStake: number | null; minScoreMaxPayout: number | null; minScoreMaxBet: number | null } {
  const maxOutcomeLoss = num(condition.maxOutcomePotentialLoss);
  const currentLoss = num(condition.currentConditionPotentialLoss) ?? 0;
  if (maxOutcomeLoss === null) return { maxGroupStake: null, minScoreMaxPayout: null, minScoreMaxBet: null };
  const remainingPayoutCap = Math.max(0, maxOutcomeLoss - currentLoss);
  const odds = outcomeRows.map((r) => r.odds);
  const implied = odds.reduce((acc, o) => acc + (o && o > 1 ? 1 / o : 0), 0);
  if (!implied) return { maxGroupStake: null, minScoreMaxPayout: null, minScoreMaxBet: null };
  const minBet = Math.min(...odds.map((o) => (o && o > 1 ? remainingPayoutCap / o : Infinity)).filter(Number.isFinite));
  return {
    maxGroupStake: remainingPayoutCap * implied,
    minScoreMaxPayout: remainingPayoutCap,
    minScoreMaxBet: Number.isFinite(minBet) ? minBet : null,
  };
}

// -----------------------------
// Network clients
// -----------------------------

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithTimeout(SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`GraphQL transport failure: ${(err as Error).message}`);
  }

  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 700)}`);
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e: any) => e.message || JSON.stringify(e)).join(' | ')}`);
  }
  return body.data as T;
}

async function supabaseSelect(pathAndQuery: string): Promise<SignalRow[]> {
  if (!SUPABASE_KEY) throw new Error('Missing Supabase key for signal loading.');
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as SignalRow[];
}
async function supabaseInsert(rows: AuditRow[]): Promise<void> {
  if (!WRITE_SUPABASE) return;
  if (!rows.length) return;
  const validRows = rows.filter((r) => r.decision !== 'API_ERROR');
  if (!validRows.length) return;

  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/azuro_execution_audit_v1`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(validRows),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase insert HTTP ${res.status}: ${text.slice(0, 500)}`);
}

// -----------------------------
// Data loading and audit logic
// -----------------------------

async function loadSignals(): Promise<SignalRow[]> {
  const select = [
    'id', 'signal_key', 'event_date', 'starts_at', 'match_name', 'strategy_lane', 'public_signal_name',
    'score_odds_json', 'official_decimal_odds', 'original_official_decimal_odds', 'status', 'display_status',
  ].join(',');
  const lanes = ACTIVE_LANES.join(',');
  const query = `proof_vault_recent_receipts_v2_protected?select=${encodeURIComponent(select)}&strategy_lane=in.(${lanes})&order=event_date.desc&limit=${LIMIT}`;
  return supabaseSelect(query);
}

async function fetchPrematchTennisGames(): Promise<{ games: AzuroGame[]; apiErrors: string[] }> {
  const games: AzuroGame[] = [];
  const apiErrors: string[] = [];

  for (let page = 0; page < MAX_GAME_PAGES; page += 1) {
    const skip = page * GAME_PAGE_SIZE;
    try {
      const data = await graphql<{ games: AzuroGame[] }>(GAMES_QUERY, {
        first: GAME_PAGE_SIZE,
        skip,
        where: {
          state: 'Prematch',
          activePrematchConditionsCount_gt: 0,
        },
      });
      const batch = data.games || [];
      const tennis = batch.filter((g) => {
        const s = normalizeText([g.sport?.name, g.sport?.slug, g.title].join(' '));
        return s.includes('tennis');
      });
      games.push(...tennis);
      if (batch.length < GAME_PAGE_SIZE) break;
    } catch (err) {
      apiErrors.push((err as Error).message);
      break;
    }
  }

  return { games, apiErrors };
}

async function fetchGameConditions(gameId: string): Promise<{ game: (AzuroGame & { conditions: AzuroCondition[] }) | null; apiError: string | null }> {
  try {
    const data = await graphql<{ game: (AzuroGame & { conditions: AzuroCondition[] }) | null }>(GAME_CONDITIONS_QUERY, { gameId });
    return { game: data.game, apiError: null };
  } catch (err) {
    return { game: null, apiError: (err as Error).message };
  }
}

function chooseGameForSignal(signal: SignalRow, games: AzuroGame[]): { game: AzuroGame | null; score: number; candidates: Array<{ gameId: string; title: string; score: number }> } {
  const scored = games
    .map((g) => ({ game: g, score: matchScore(signal, g) }))
    .sort((a, b) => b.score - a.score);
  return {
    game: scored[0]?.score >= 8 ? scored[0].game : null,
    score: scored[0]?.score ?? 0,
    candidates: scored.slice(0, 5).map((x) => ({ gameId: x.game.id, title: x.game.title, score: x.score })),
  };
}

function pickCorrectScoreMarket(conditions: AzuroCondition[]): AzuroCondition | null {
  const firstSetMarkets = conditions.filter(isFirstSetCorrectScoreMarket);
  if (firstSetMarkets.length) return firstSetMarkets.sort((a, b) => clean(b.title).length - clean(a.title).length)[0];

  // Defensive fallback: a condition with tennis score-like outcomes and a title mentioning score/set.
  const scoreLike = conditions.filter((c) => {
    const outcomes = c.outcomes || [];
    const scoreOutcomes = outcomes.filter((o) => scoreFromOutcomeTitle(o.title)).length;
    const t = normalizeText(c.title);
    return scoreOutcomes >= 4 && /score|set/.test(t);
  });
  return scoreLike[0] || null;
}

function auditDecision(params: {
  signal: SignalRow;
  game: AzuroGame;
  condition: AzuroCondition | null;
  targetScores: string[];
  baseline: { odds: number | null; source: string; hasAllScoreOdds: boolean };
}): AuditRow {
  const { signal, game, condition, targetScores, baseline } = params;
  const modelBucket = signal.strategy_lane === 'CORE_P1_ATP_GS_BET365' || signal.strategy_lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365'
    ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP'
    : 'OPTIMIZED_VIP';

  const base: AuditRow = {
    run_id: RUN_ID,
    source: 'azuro_data_feed_graphql',
    signal_id: signal.id,
    signal_key: signal.signal_key,
    match_name: signal.match_name,
    event_date: signal.event_date,
    starts_at: signal.starts_at,
    strategy_lane: signal.strategy_lane,
    public_signal_name: signal.public_signal_name,
    model_bucket: modelBucket,
    target_scores: targetScores,
    baseline_grouped_odds: baseline.odds,
    azuro_game_id: game.id,
    azuro_game_title: game.title,
    azuro_league: clean(game.league?.name),
    azuro_sport: clean(game.sport?.name || game.sport?.slug),
    raw_match_json: game,
    raw_calculations_json: {
      score_mode: SCORE_MODE,
      chain: CHAIN,
      risk_pct: RISK_PCT,
      bankroll: BANKROLL,
      required_group_stake: MIN_GROUP_STAKE,
      baseline_source: baseline.source,
      baseline_has_all_target_scores: baseline.hasAllScoreOdds,
      subgraph_url: SUBGRAPH_URL,
    },
    decision: 'MISSING_MARKET',
    reason: '',
  };

  if (!condition) {
    return { ...base, decision: 'MISSING_MARKET', reason: 'Game matched, but no active prematch Correct Score - 1st Set market was found.' };
  }

  const outcomeMap = new Map<string, AzuroOutcome>();
  for (const o of condition.outcomes || []) {
    const score = scoreFromOutcomeTitle(o.title);
    if (score) outcomeMap.set(score, o);
  }

  const missing = targetScores.filter((s) => !outcomeMap.has(s));
  const outcomeRows = targetScores
    .map((score) => {
      const o = outcomeMap.get(score);
      return o ? { score, outcomeId: String(o.outcomeId), odds: num(o.currentOdds), title: o.title } : null;
    })
    .filter((x): x is { score: string; outcomeId: string; odds: number | null; title: string | null } => Boolean(x));

  const azuroGrouped = groupedOdds(outcomeRows.map((r) => r.odds));
  const limit = estimateGroupLimit(condition, outcomeRows);
  const scoreOutcomesJson = Object.fromEntries(outcomeRows.map((r) => [r.score, r]));

  const enrichedBase: AuditRow = {
    ...base,
    azuro_condition_id: String(condition.conditionId),
    azuro_market_title: condition.title,
    score_outcomes_json: scoreOutcomesJson,
    azuro_grouped_odds: azuroGrouped,
    edge_vs_baseline: azuroGrouped !== null && baseline.odds !== null ? azuroGrouped - baseline.odds : null,
    min_score_max_bet: limit.minScoreMaxBet,
    min_score_max_payout: limit.minScoreMaxPayout,
    max_group_stake: limit.maxGroupStake,
    raw_conditions_json: condition,
  };

  if (missing.length) {
    return { ...enrichedBase, decision: 'MISSING_SCORE', reason: `Correct-score market exists, but missing target scores: ${missing.join(', ')}` };
  }
  if (azuroGrouped === null) {
    return { ...enrichedBase, decision: 'BAD_ODDS', reason: 'Target scores exist, but one or more Azuro odds were missing or invalid.' };
  }
  if (baseline.odds === null) {
    return { ...enrichedBase, decision: 'BAD_ODDS', reason: 'Cannot compare Azuro grouped odds because baseline grouped/Web2 odds are missing.' };
  }
  if (azuroGrouped < baseline.odds + MIN_EDGE) {
    return { ...enrichedBase, decision: 'BAD_ODDS', reason: `Azuro grouped odds ${azuroGrouped.toFixed(4)} below required baseline+edge ${(baseline.odds + MIN_EDGE).toFixed(4)}.` };
  }
  if (limit.maxGroupStake !== null && limit.maxGroupStake < MIN_GROUP_STAKE) {
    return { ...enrichedBase, decision: 'LOW_LIMIT', reason: `Estimated max grouped stake ${limit.maxGroupStake.toFixed(2)} below required stake ${MIN_GROUP_STAKE.toFixed(2)}.` };
  }

  return { ...enrichedBase, decision: 'BETTABLE', reason: 'Game, market, target scores, odds comparison, and estimated limit checks passed.' };
}

async function auditSignals(): Promise<AuditRow[]> {
  const signals = await loadSignals();
  const { games, apiErrors } = await fetchPrematchTennisGames();

  if (apiErrors.length) {
    return signals.map((signal) => ({
      run_id: RUN_ID,
      source: 'azuro_data_feed_graphql',
      signal_id: signal.id,
      signal_key: signal.signal_key,
      match_name: signal.match_name,
      event_date: signal.event_date,
      starts_at: signal.starts_at,
      strategy_lane: signal.strategy_lane,
      public_signal_name: signal.public_signal_name,
      model_bucket: 'UNKNOWN',
      target_scores: scoreTargetsForLane(signal.strategy_lane, SCORE_MODE),
      baseline_grouped_odds: null,
      decision: 'API_ERROR',
      reason: `GraphQL game fetch failed. This is not MISSING_GAME. ${apiErrors.slice(0, 2).join(' | ')}`,
      raw_calculations_json: { api_errors: apiErrors, subgraph_url: SUBGRAPH_URL },
    }));
  }

  const rows: AuditRow[] = [];
  for (const signal of signals) {
    const targets = scoreTargetsForLane(signal.strategy_lane, SCORE_MODE);
    const baseline = baselineGroupedOdds(signal, targets);
    const chosen = chooseGameForSignal(signal, games);

    if (!chosen.game) {
      rows.push({
        run_id: RUN_ID,
        source: 'azuro_data_feed_graphql',
        signal_id: signal.id,
        signal_key: signal.signal_key,
        match_name: signal.match_name,
        event_date: signal.event_date,
        starts_at: signal.starts_at,
        strategy_lane: signal.strategy_lane,
        public_signal_name: signal.public_signal_name,
        model_bucket: signal.strategy_lane === 'CORE_P1_ATP_GS_BET365' || signal.strategy_lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365' ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP' : 'OPTIMIZED_VIP',
        target_scores: targets,
        baseline_grouped_odds: baseline.odds,
        decision: 'MISSING_GAME',
        reason: `GraphQL call succeeded, but no tennis prematch game matched by participant/title tokens. Best match score: ${chosen.score}.`,
        raw_calculations_json: {
          best_candidates: chosen.candidates,
          baseline_source: baseline.source,
          baseline_has_all_target_scores: baseline.hasAllScoreOdds,
        },
      });
      continue;
    }

    const conditionResult = await fetchGameConditions(chosen.game.id);
    if (conditionResult.apiError) {
      rows.push({
        run_id: RUN_ID,
        source: 'azuro_data_feed_graphql',
        signal_id: signal.id,
        signal_key: signal.signal_key,
        match_name: signal.match_name,
        event_date: signal.event_date,
        starts_at: signal.starts_at,
        strategy_lane: signal.strategy_lane,
        public_signal_name: signal.public_signal_name,
        model_bucket: signal.strategy_lane === 'CORE_P1_ATP_GS_BET365' || signal.strategy_lane === 'CORE_P2_GS_REVERSE_STRETCH_BET365' ? 'PUBLIC_MAIN_AND_OPTIMIZED_VIP' : 'OPTIMIZED_VIP',
        target_scores: targets,
        baseline_grouped_odds: baseline.odds,
        azuro_game_id: chosen.game.id,
        azuro_game_title: chosen.game.title,
        decision: 'API_ERROR',
        reason: `GraphQL condition fetch failed. This is not MISSING_MARKET. ${conditionResult.apiError}`,
        raw_match_json: chosen.game,
      });
      continue;
    }

    const gameWithConditions = conditionResult.game;
    const condition = pickCorrectScoreMarket(gameWithConditions?.conditions || []);
    rows.push(auditDecision({ signal, game: gameWithConditions || chosen.game, condition, targetScores: targets, baseline }));
  }
  return rows;
}

function summarize(rows: AuditRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.decision] = (out[r.decision] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}
function logRows(rows: AuditRow[]): void {
  for (const r of rows) {
    console.log([
      r.decision.padEnd(14),
      clean(r.strategy_lane).padEnd(36),
      clean(r.match_name).slice(0, 60).padEnd(60),
      r.reason,
    ].join(' | '));
  }
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const rows = await auditSignals();
  const summary = {
    run_id: RUN_ID,
    generated_at: new Date().toISOString(),
    source: 'azuro_data_feed_graphql',
    subgraph_url: SUBGRAPH_URL,
    chain: CHAIN,
    score_mode: SCORE_MODE,
    write_supabase: WRITE_SUPABASE,
    signals_checked: rows.length,
    decisions: summarize(rows),
    note: 'Safe GraphQL audit only. API errors are separated from MISSING_GAME and are not written as market coverage failures.',
  };

  const fields = [
    'run_id', 'source', 'signal_id', 'match_name', 'event_date', 'starts_at', 'strategy_lane', 'public_signal_name',
    'target_scores', 'baseline_grouped_odds', 'azuro_game_id', 'azuro_game_title', 'azuro_market_title', 'azuro_grouped_odds',
    'edge_vs_baseline', 'min_score_max_bet', 'min_score_max_payout', 'max_group_stake', 'decision', 'reason',
  ];

  writeJson(path.join(OUT_DIR, 'azuro_graphql_tennis_audit.json'), rows);
  writeJson(path.join(OUT_DIR, 'azuro_graphql_tennis_summary.json'), summary);
  writeCsv(path.join(OUT_DIR, 'azuro_graphql_tennis_audit.csv'), rows as unknown as Record<string, unknown>[], fields);
  fs.writeFileSync(path.join(OUT_DIR, 'azuro_graphql_tennis_report.md'), [
    '# Azuro GraphQL Tennis Prematch Audit',
    '',
    `Run ID: ${RUN_ID}`,
    `Generated: ${summary.generated_at}`,
    `Subgraph: ${SUBGRAPH_URL}`,
    `Score mode: ${SCORE_MODE}`,
    `Write Supabase: ${WRITE_SUPABASE}`,
    '',
    '## Decisions',
    ...Object.entries(summary.decisions).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Safety',
    '- No guessed REST routes.',
    '- No wallet signing.',
    '- No bet orders.',
    '- HTTP/GraphQL failures are API_ERROR, not MISSING_GAME.',
    '- Supabase writing defaults to false.',
  ].join('\n') + '\n', 'utf8');

  logRows(rows);
  console.log(JSON.stringify(summary, null, 2));

  if (WRITE_SUPABASE) {
    const writable = rows.filter((r) => r.decision !== 'API_ERROR');
    const hasValidStates = writable.some((r) => ['MISSING_MARKET', 'MISSING_SCORE', 'BAD_ODDS', 'LOW_LIMIT', 'BETTABLE'].includes(r.decision));
    if (!hasValidStates) {
      console.warn('Skipping Supabase write: no valid post-match audit state was calculated.');
    } else {
      await supabaseInsert(writable);
      console.log(`Inserted ${writable.length} non-API_ERROR audit rows into Supabase.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
