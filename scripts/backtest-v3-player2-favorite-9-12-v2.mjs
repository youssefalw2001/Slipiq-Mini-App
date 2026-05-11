#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.API_TENNIS_KEY;
const API_BASE = 'https://api.api-tennis.com/tennis/';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(',', '.').replace(/[x×+]/gi, '').trim());
  return Number.isFinite(n) ? n : null;
};
const norm = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const writeCsv = (headers, rows) => `${[headers.map(csvEscape).join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n')}\n`;

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateRange(start, stop) {
  const out = [];
  for (let d = start; d <= stop; d = addDays(d, 1)) out.push(d);
  return out;
}
function arr(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((x) => x && typeof x === 'object');
}
async function fetchApi(method, params = {}, attempt = 1) {
  if (!API_KEY) throw new Error('Missing API_TENNIS_KEY');
  const url = new URL(API_BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', API_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null && String(v) !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    if (attempt < 3 && res.status >= 500) {
      await sleep(500 * attempt);
      return fetchApi(method, params, attempt + 1);
    }
    throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (String(json.success) !== '1') {
    const raw = JSON.stringify(json).slice(0, 500);
    if (/no\s*(event|match|odd|data)|not\s*found|empty/i.test(raw)) return method === 'get_odds' ? {} : [];
    throw new Error(`${method} unsuccessful: ${raw}`);
  }
  return json.result;
}
function isDoubles(f) {
  return String(f.event_first_player ?? '').includes('/') || String(f.event_second_player ?? '').includes('/');
}
function tournamentLevel(f) {
  const text = `${f.tournament_name ?? ''} ${f.tournament_round ?? ''} ${f.event_type ?? ''}`.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}
function surfaceOf(f) {
  const raw = String(f.event_surface ?? f.surface ?? f.tournament_surface ?? f.court_surface ?? '').trim();
  if (raw) return raw;
  const text = `${f.tournament_name ?? ''} ${f.tournament_round ?? ''}`.toLowerCase();
  if (/grass|halle|stuttgart|queen|eastbourne|s hertogenbosch|nottingham|newport|mallorca/.test(text)) return 'Grass';
  if (/clay|roland|monte carlo|madrid|rome|barcelona|hamburg|bastad|gstaad|kitzbuhel|geneva|munich|estoril|bucharest|marrakech/.test(text)) return 'Clay';
  if (/hard|indian wells|miami|cincinnati|us open|australian|doha|dubai|shanghai|beijing|tokyo|atlanta|washington|winston/.test(text)) return 'Hard';
  return 'Unknown';
}
function cleanScorePart(v) {
  const n = Number(String(v ?? '').split('.')[0]);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}
function normalizeScore(v) {
  const m = String(v ?? '').match(/(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)/);
  if (!m) return '';
  const a = cleanScorePart(m[1]);
  const b = cleanScorePart(m[2]);
  return a == null || b == null ? '' : `${a}-${b}`;
}
function scanFirstSet(v) {
  if (v == null) return '';
  if (typeof v === 'string') return normalizeScore(v);
  if (Array.isArray(v)) {
    const first = v.find((x) => x && typeof x === 'object' && String(x.score_set ?? x.set ?? x.set_number ?? x.number ?? '') === '1');
    if (first) return scanFirstSet(first) || '';
    for (const x of v) {
      const found = scanFirstSet(x);
      if (found) return found;
    }
  }
  if (typeof v === 'object') {
    const setNum = String(v.score_set ?? v.set ?? v.set_number ?? v.number ?? '');
    const firstLike = setNum === '1' || /first|1st|set\s*1/i.test(String(v.name ?? v.label ?? v.score_part ?? ''));
    const a = v.score_first ?? v.home_score ?? v.player_1_score ?? v.score_home ?? v.score_team1 ?? v.first ?? v.player1;
    const b = v.score_second ?? v.away_score ?? v.player_2_score ?? v.score_away ?? v.score_team2 ?? v.second ?? v.player2;
    if (firstLike && a != null && b != null) {
      const left = cleanScorePart(a);
      const right = cleanScorePart(b);
      if (left != null && right != null) return `${left}-${right}`;
    }
    for (const [k, x] of Object.entries(v)) {
      if (/set[_\s-]?1|first|1st/i.test(k)) {
        const found = scanFirstSet(x);
        if (found) return found;
      }
    }
    for (const x of Object.values(v)) {
      const found = scanFirstSet(x);
      if (found) return found;
    }
  }
  return '';
}
function firstSetScore(f) {
  return scanFirstSet(f.scores) || scanFirstSet(f.event_scores) || scanFirstSet(f.score) || scanFirstSet(f.event_score) || normalizeScore(f.event_final_result ?? f.event_result ?? '');
}
function decimalOddsFromValue(v) {
  const direct = num(v);
  if (direct && direct > 1) return direct;
  if (Array.isArray(v)) {
    const odds = v.map(decimalOddsFromValue).filter(Number.isFinite);
    return odds.length ? Math.max(...odds) : null;
  }
  if (v && typeof v === 'object') {
    for (const k of ['odd', 'odds', 'price', 'value', 'decimal', 'coefficient']) {
      const n = num(v[k]);
      if (n && n > 1) return n;
    }
    const odds = Object.values(v).map(decimalOddsFromValue).filter(Number.isFinite);
    return odds.length ? Math.max(...odds) : null;
  }
  return null;
}
function extractExactScoreOdds(matchOdds, wanted = '4-6') {
  const markets = Object.entries(matchOdds ?? {});
  const preferred = markets.filter(([name]) => /correct\s*score|score/i.test(name) && /(1st|1\s*set|first|half)/i.test(name));
  const search = preferred.length ? preferred : markets.filter(([name]) => /correct\s*score|score/i.test(name));
  for (const [, market] of search) {
    if (!market || typeof market !== 'object') continue;
    for (const [key, val] of Object.entries(market)) {
      const labels = [key];
      if (val && typeof val === 'object') {
        for (const k of ['name', 'label', 'value', 'selection', 'odd_name', 'bet']) if (val[k] != null) labels.push(String(val[k]));
      }
      if (labels.some((label) => normalizeScore(label) === wanted)) {
        const odds = decimalOddsFromValue(val);
        if (odds) return odds;
      }
    }
  }
  return null;
}
function labelList(key, val) {
  const labels = [key];
  if (val && typeof val === 'object') {
    for (const k of ['name', 'label', 'value', 'selection', 'odd_name', 'bet', 'team', 'player', 'participant', 'runner']) if (val[k] != null) labels.push(String(val[k]));
  }
  return labels;
}
function mentionsPlayer(label, playerName) {
  const text = norm(label);
  const tokens = norm(playerName).split(' ').filter((x) => x.length >= 2);
  if (!tokens.length) return false;
  const last = tokens.at(-1);
  return Boolean((last && text.includes(last)) || (tokens.length >= 2 && tokens.slice(0, 2).every((t) => text.includes(t))));
}
function looksHome(label) { return /\b(home|player\s*1|p1|1)\b/i.test(String(label)); }
function looksAway(label) { return /\b(away|player\s*2|p2|2)\b/i.test(String(label)); }
function extractHomeAwayOdds(market) {
  let home = null, away = null, homeLabel = '', awayLabel = '';
  const entries = Object.entries(market ?? {});
  for (const [key, val] of entries) {
    const odds = decimalOddsFromValue(val);
    if (!odds) continue;
    const labels = labelList(key, val);
    if (!home && labels.some(looksHome)) { home = odds; homeLabel = labels.join(' / '); }
    if (!away && labels.some(looksAway)) { away = odds; awayLabel = labels.join(' / '); }
  }
  if ((!home || !away) && entries.length === 2) {
    const a = decimalOddsFromValue(entries[0][1]);
    const b = decimalOddsFromValue(entries[1][1]);
    if (a && b) {
      home = home || a;
      away = away || b;
      homeLabel = homeLabel || entries[0][0];
      awayLabel = awayLabel || entries[1][0];
    }
  }
  return home && away ? { player1_odds: home, player2_odds: away, player1_label: homeLabel, player2_label: awayLabel } : null;
}
function extractMatchWinnerOdds(matchOdds, player1, player2) {
  const result = { player1_odds: null, player2_odds: null, market: '', player1_label: '', player2_label: '' };
  const markets = Object.entries(matchOdds ?? {});
  for (const [marketName, market] of markets) {
    if (!market || typeof market !== 'object') continue;
    if (/^home\s*\/\s*away$|home\s*away|moneyline|match\s*winner|to\s*win|2\s*way/i.test(marketName) && !/set|game|score|total|handicap|spread|exact/i.test(marketName)) {
      const ha = extractHomeAwayOdds(market);
      if (ha) return { ...ha, market: marketName };
    }
  }
  for (const [marketName, market] of markets) {
    if (!market || typeof market !== 'object') continue;
    if (/set|game|score|total|handicap|spread|exact/i.test(marketName)) continue;
    let p1 = null, p2 = null, p1Label = '', p2Label = '';
    for (const [key, val] of Object.entries(market)) {
      const odds = decimalOddsFromValue(val);
      if (!odds) continue;
      const labels = labelList(key, val);
      if (!p1 && labels.some((label) => mentionsPlayer(label, player1))) { p1 = odds; p1Label = labels.join(' / '); }
      if (!p2 && labels.some((label) => mentionsPlayer(label, player2))) { p2 = odds; p2Label = labels.join(' / '); }
    }
    if (p1 && p2) return { player1_odds: p1, player2_odds: p2, market: marketName, player1_label: p1Label, player2_label: p2Label };
  }
  return result;
}
function groupedWin(score) { return ['3-6', '4-6', '5-7'].includes(score) ? 1 : 0; }
function strengthBucket(p1, p2, nearRatio, nearMaxOdds) {
  if (!p1 || !p2) return 'unknown';
  if (p2 < p1) return 'favorite';
  if (p2 / p1 <= nearRatio || p2 <= nearMaxOdds) return 'near_favorite';
  if (p2 <= 3.5) return 'underdog';
  return 'big_underdog';
}
function matchName(f) { return `${f.event_first_player ?? 'Player 1'} vs ${f.event_second_player ?? 'Player 2'}`; }
function startTime(f) {
  const date = String(f.event_date ?? '').slice(0, 10);
  const t = String(f.event_time ?? f.event_start_time ?? '').trim();
  return date ? `${date}T${/^\d{1,2}:\d{2}/.test(t) ? t.slice(0, 5) : '00:00'}:00Z` : '';
}
async function buildCandidates({ dateStart, dateStop, delayMs, nearRatio, nearMaxOdds }) {
  const rows = [], errors = [], samples = [];
  for (const date of dateRange(dateStart, dateStop)) {
    try {
      console.log(`Scanning ${date}`);
      const fixtures = arr(await fetchApi('get_fixtures', { date_start: date, date_stop: date }));
      await sleep(delayMs);
      const oddsResult = await fetchApi('get_odds', { date_start: date, date_stop: date });
      await sleep(delayMs);
      const fixtureByKey = new Map(fixtures.map((f) => [String(f.event_key), f]));
      for (const [eventKey, odds] of Object.entries(oddsResult ?? {})) {
        const f = fixtureByKey.get(String(eventKey));
        if (!f || isDoubles(f) || tournamentLevel(f) !== 'tour_other') continue;
        const exact = extractExactScoreOdds(odds, '4-6');
        if (!exact || exact < 6.25 || exact >= 7.0) continue;
        const score = firstSetScore(f);
        if (!score) continue;
        const player1 = String(f.event_first_player ?? '').trim();
        const player2 = String(f.event_second_player ?? '').trim();
        const mw = extractMatchWinnerOdds(odds, player1, player2);
        if ((!mw.player1_odds || !mw.player2_odds) && samples.length < 25) samples.push({ eventKey, date, match_name: matchName(f), markets: Object.keys(odds ?? {}).slice(0, 60) });
        const bucket = strengthBucket(mw.player1_odds, mw.player2_odds, nearRatio, nearMaxOdds);
        rows.push({
          event_key: eventKey,
          event_date: f.event_date ?? date,
          match_start_time: startTime(f),
          match_name: matchName(f),
          player1, player2,
          tournament: f.tournament_name ?? '',
          tournament_round: f.tournament_round ?? '',
          tournament_level: 'tour_other',
          surface: surfaceOf(f),
          first_set_score: score,
          grouped_win: groupedWin(score),
          exact_4_6_odds: exact,
          p1_match_odds: mw.player1_odds,
          p2_match_odds: mw.player2_odds,
          match_winner_market: mw.market,
          p1_match_label: mw.player1_label,
          p2_match_label: mw.player2_label,
          p2_strength_bucket: bucket,
          p2_is_favorite: bucket === 'favorite' ? 1 : 0,
          p2_is_favorite_or_near: ['favorite','near_favorite'].includes(bucket) ? 1 : 0,
          p2_odds_ratio_vs_p1: mw.player1_odds && mw.player2_odds ? Number((mw.player2_odds / mw.player1_odds).toFixed(4)) : '',
        });
      }
    } catch (e) {
      errors.push({ date, error: e instanceof Error ? e.message : String(e) });
      console.error(`Error on ${date}: ${errors.at(-1).error}`);
    }
  }
  return { rows, errors, samples };
}
function compound(events, { bank, risk, odds }) {
  let bankroll = bank, peak = bank, maxDd = 0, wins = 0, losses = 0, streak = 0, worstStreak = 0, flat = 0;
  const out = [];
  const sorted = [...events].sort((a,b) => String(a.match_start_time).localeCompare(String(b.match_start_time)) || String(a.event_key).localeCompare(String(b.event_key)));
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const stake = bankroll * risk;
    const win = Boolean(e.grouped_win);
    const profit = win ? stake * (odds - 1) : -stake;
    if (win) { wins++; streak = 0; flat += odds - 1; } else { losses++; streak++; worstStreak = Math.max(worstStreak, streak); flat -= 1; }
    bankroll += profit;
    peak = Math.max(peak, bankroll);
    const dd = peak > 0 ? (peak - bankroll) / peak : 0;
    maxDd = Math.max(maxDd, dd);
    out.push({ index: i + 1, ...e, scenario_grouped_odds: odds, stake: Number(stake.toFixed(2)), profit: Number(profit.toFixed(2)), bankroll_after: Number(bankroll.toFixed(2)), drawdown_pct: Number(dd.toFixed(4)) });
  }
  return { bets: sorted.length, wins, losses, hit_rate: sorted.length ? wins / sorted.length : 0, break_even_odds: wins ? sorted.length / wins : null, final_bankroll: bankroll, profit: bankroll - bank, return_pct: bankroll / bank - 1, flat_roi_units: sorted.length ? flat / sorted.length : 0, worst_losing_streak: worstStreak, max_drawdown_pct: maxDd, rows: out };
}
function brief(r) {
  return { bets: r.bets, wins: r.wins, losses: r.losses, hit_rate: Number(r.hit_rate.toFixed(4)), break_even_odds: r.break_even_odds == null ? null : Number(r.break_even_odds.toFixed(4)), final_bankroll: Number(r.final_bankroll.toFixed(2)), profit: Number(r.profit.toFixed(2)), return_pct: Number(r.return_pct.toFixed(4)), flat_roi_units: Number(r.flat_roi_units.toFixed(4)), worst_losing_streak: r.worst_losing_streak, max_drawdown_pct: Number(r.max_drawdown_pct.toFixed(4)) };
}
async function main() {
  const dateStart = arg('date-start', '2025-04-01');
  const dateStop = arg('date-stop', '2026-05-01');
  const outputDir = arg('output-dir', 'artifacts/output/v3-player2-favorite-9-12-backtest');
  const bank = Number(arg('bankroll', '5000')) || 5000;
  const risk = Number(arg('risk', '0.02')) || 0.02;
  const delayMs = Number(arg('delay-ms', '150')) || 0;
  const nearRatio = Number(arg('near-ratio', '1.15')) || 1.15;
  const nearMaxOdds = Number(arg('near-max-odds', '2.20')) || 2.20;
  const scenarioOdds = String(arg('scenario-odds', '3.00,3.30,3.50,3.60')).split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 1);
  const { rows, errors, samples } = await buildCandidates({ dateStart, dateStop, delayMs, nearRatio, nearMaxOdds });
  const filters = {
    v3_all: rows,
    v3_p2_favorite: rows.filter((r) => r.p2_strength_bucket === 'favorite'),
    v3_p2_favorite_or_near: rows.filter((r) => ['favorite','near_favorite'].includes(r.p2_strength_bucket)),
    v3_p2_favorite_hard_grass: rows.filter((r) => r.p2_strength_bucket === 'favorite' && /hard|grass/i.test(String(r.surface))),
    v3_p2_favorite_or_near_hard_grass: rows.filter((r) => ['favorite','near_favorite'].includes(r.p2_strength_bucket) && /hard|grass/i.test(String(r.surface))),
    v3_p2_unknown_match_odds: rows.filter((r) => r.p2_strength_bucket === 'unknown'),
    v3_p2_underdog_or_big: rows.filter((r) => ['underdog','big_underdog'].includes(r.p2_strength_bucket)),
  };
  const summary = { mode: 'v3_player2_favorite_9_12_backtest_v2_home_away_parser', config: { dateStart, dateStop, startingBankroll: bank, riskFraction: risk, scenarioOdds, delayMs, nearRatio, nearMaxOdds }, definitions: { v3_trigger: 'exact first-set 4-6 odds >= 6.25 and < 7.00, tour_other singles only', main_market_modeled: 'Player 2 & 9-12, wins on 3-6 / 4-6 / 5-7', player2_favorite: 'Player 2 Home/Away/match-winner odds lower than Player 1', warning: 'Grouped Player 2 & 9-12 odds are scenario odds here, not real historical grouped market odds.' }, candidate_rows: rows.length, match_winner_odds_rows: rows.filter((r) => r.p1_match_odds && r.p2_match_odds).length, p2_strength_counts: Object.fromEntries(['favorite','near_favorite','underdog','big_underdog','unknown'].map((b) => [b, rows.filter((r) => r.p2_strength_bucket === b).length])), errors, filter_results: {} };
  const allBtRows = [];
  for (const [name, xs] of Object.entries(filters)) {
    const wins = xs.filter((r) => r.grouped_win).length;
    summary.filter_results[name] = { rows: xs.length, wins, losses: xs.length - wins, hit_rate: xs.length ? Number((wins / xs.length).toFixed(4)) : 0, break_even_odds: wins ? Number((xs.length / wins).toFixed(4)) : null, scenarios: {} };
    for (const odds of scenarioOdds) {
      const bt = compound(xs, { bank, risk, odds });
      summary.filter_results[name].scenarios[`scenario_${odds}`] = brief(bt);
      if (['v3_all','v3_p2_favorite','v3_p2_favorite_or_near'].includes(name)) allBtRows.push(...bt.rows.map((r) => ({ filter: name, ...r })));
    }
  }
  await fs.mkdir(outputDir, { recursive: true });
  const headers = ['event_key','event_date','match_start_time','match_name','player1','player2','tournament','tournament_round','tournament_level','surface','first_set_score','grouped_win','exact_4_6_odds','p1_match_odds','p2_match_odds','match_winner_market','p1_match_label','p2_match_label','p2_strength_bucket','p2_is_favorite','p2_is_favorite_or_near','p2_odds_ratio_vs_p1'];
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-candidates.csv'), writeCsv(headers, rows));
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-backtest-rows.csv'), writeCsv(Object.keys(allBtRows[0] ?? { filter: '' }), allBtRows));
  await fs.writeFile(path.join(outputDir, 'raw-odds-market-samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-9-12-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
