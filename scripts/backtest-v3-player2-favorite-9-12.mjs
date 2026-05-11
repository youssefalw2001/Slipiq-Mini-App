#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.API_TENNIS_KEY;
const API_BASE = 'https://api.api-tennis.com/tennis/';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.').replace(/[x×]/gi, '').trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n')}\n`;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(start, stop) {
  const dates = [];
  for (let d = start; d <= stop; d = addDays(d, 1)) dates.push(d);
  return dates;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((item) => item && typeof item === 'object');
}

async function fetchApi(method, params = {}, attempt = 1) {
  if (!API_KEY) throw new Error('Missing API_TENNIS_KEY environment variable.');
  const url = new URL(API_BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') url.searchParams.set(k, String(v));
  }
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    if (attempt < 3 && response.status >= 500) {
      await sleep(500 * attempt);
      return fetchApi(method, params, attempt + 1);
    }
    throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') {
    const raw = JSON.stringify(payload).slice(0, 700);
    if (/no\s*(event|match|odd|data)|not\s*found|empty/i.test(raw)) return method === 'get_odds' ? {} : [];
    throw new Error(`${method} unsuccessful: ${raw}`);
  }
  return payload.result;
}

function fixtureName(fixture) {
  return `${fixture.event_first_player ?? 'Player 1'} vs ${fixture.event_second_player ?? 'Player 2'}`;
}

function isDoubles(fixture) {
  return String(fixture.event_first_player ?? '').includes('/') || String(fixture.event_second_player ?? '').includes('/');
}

function tournamentLevel(fixture) {
  const text = `${fixture.tournament_name ?? ''} ${fixture.tournament_round ?? ''} ${fixture.event_type ?? ''}`.toLowerCase();
  if (/wimbledon|roland garros|french open|us open|australian open/.test(text)) return 'slam';
  if (/madrid|rome|monte carlo|indian wells|miami|cincinnati|shanghai|paris masters|canada|toronto|montreal|doha|dubai/.test(text)) return 'tour_premium';
  if (/challenger|w100|w75|w50|m100|m75|m50/.test(text)) return 'challenger';
  if (/m15|m25|w15|w25|itf/.test(text)) return 'itf';
  return 'tour_other';
}

function surfaceOf(fixture) {
  const raw = String(fixture.event_surface ?? fixture.surface ?? fixture.tournament_surface ?? fixture.court_surface ?? '').trim();
  if (raw) return raw;
  const text = `${fixture.tournament_name ?? ''} ${fixture.tournament_round ?? ''}`.toLowerCase();
  if (/grass|halle|stuttgart|queen|eastbourne|s hertogenbosch|nottingham|newport|mallorca/.test(text)) return 'Grass';
  if (/clay|roland|monte carlo|madrid|rome|barcelona|hamburg|bastad|gstaad|kitzbuhel|geneva|munich|estoril|bucharest|marrakech/.test(text)) return 'Clay';
  if (/hard|indian wells|miami|cincinnati|us open|australian|doha|dubai|shanghai|beijing|tokyo|atlanta|washington|winston/.test(text)) return 'Hard';
  return 'Unknown';
}

function parseStart(fixture) {
  const date = String(fixture.event_date ?? '').slice(0, 10);
  const time = String(fixture.event_time ?? fixture.event_start_time ?? '').trim();
  if (!date) return '';
  if (/^\d{1,2}:\d{2}/.test(time)) return `${date}T${time.slice(0, 5)}:00Z`;
  return `${date}T00:00:00Z`;
}

function cleanScorePart(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = Number(s.includes('.') ? s.split('.')[0] : s);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

function normalizeScore(value) {
  const m = String(value ?? '').trim().match(/(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)/);
  if (!m) return '';
  const a = cleanScorePart(m[1]);
  const b = cleanScorePart(m[2]);
  if (a == null || b == null) return '';
  return `${a}-${b}`;
}

function extractFirstSetScore(fixture) {
  const sources = [fixture.scores, fixture.event_scores, fixture.score, fixture.event_score];
  for (const source of sources) {
    const score = scanFirstSet(source);
    if (score) return score;
  }
  const final = normalizeScore(fixture.event_final_result ?? fixture.event_result ?? '');
  return final || '';
}

function scanFirstSet(value) {
  if (value == null) return '';
  if (typeof value === 'string') return normalizeScore(value);
  if (Array.isArray(value)) {
    const first = value.find((item) => item && typeof item === 'object' && String(item.score_set ?? item.set ?? item.set_number ?? item.number ?? '') === '1');
    if (first) {
      const found = scanFirstSet(first);
      if (found) return found;
    }
    for (const item of value) {
      const found = scanFirstSet(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const setNum = String(value.score_set ?? value.set ?? value.set_number ?? value.number ?? '');
    const firstLike = setNum === '1' || /first|1st|set\s*1/i.test(String(value.name ?? value.label ?? value.score_part ?? ''));
    const a = value.score_first ?? value.home_score ?? value.player_1_score ?? value.score_home ?? value.score_team1 ?? value.first ?? value.player1;
    const b = value.score_second ?? value.away_score ?? value.player_2_score ?? value.score_away ?? value.score_team2 ?? value.second ?? value.player2;
    if ((firstLike || setNum === '1') && a != null && b != null) {
      const left = cleanScorePart(a);
      const right = cleanScorePart(b);
      if (left != null && right != null) return `${left}-${right}`;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (/set[_\s-]?1|first|1st/i.test(key)) {
        const found = scanFirstSet(nested);
        if (found) return found;
      }
    }
    for (const nested of Object.values(value)) {
      const found = scanFirstSet(nested);
      if (found) return found;
    }
  }
  return '';
}

function decimalOddsFromValue(value) {
  const direct = num(value);
  if (direct && direct > 1) return direct;
  if (Array.isArray(value)) {
    const odds = value.map(decimalOddsFromValue).filter((x) => typeof x === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  if (value && typeof value === 'object') {
    const preferredKeys = ['odd', 'odds', 'price', 'value', 'decimal', 'coefficient'];
    for (const key of preferredKeys) {
      const n = num(value[key]);
      if (n && n > 1) return n;
    }
    const odds = Object.values(value).map(decimalOddsFromValue).filter((x) => typeof x === 'number');
    return odds.length ? Math.max(...odds) : null;
  }
  return null;
}

function extractExactScoreOdds(matchOdds, wantedScore = '4-6') {
  if (!matchOdds || typeof matchOdds !== 'object') return null;
  const markets = Object.entries(matchOdds);
  const preferred = markets.filter(([name]) => /correct\s*score|score/i.test(name) && /(1st|1\s*set|first|half)/i.test(name));
  const candidates = preferred.length ? preferred : markets.filter(([name]) => /correct\s*score|score/i.test(name));
  for (const [, market] of candidates) {
    if (!market || typeof market !== 'object') continue;
    for (const [rawKey, rawValue] of Object.entries(market)) {
      const keyScore = normalizeScore(rawKey);
      if (keyScore === wantedScore) {
        const odds = decimalOddsFromValue(rawValue);
        if (odds) return odds;
      }
      if (rawValue && typeof rawValue === 'object') {
        const label = String(rawValue.name ?? rawValue.label ?? rawValue.value ?? rawValue.selection ?? rawValue.odd_name ?? '').trim();
        if (normalizeScore(label) === wantedScore) {
          const odds = decimalOddsFromValue(rawValue);
          if (odds) return odds;
        }
      }
    }
  }
  return null;
}

function normName(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function playerTokens(name) {
  return normName(name).split(' ').filter((x) => x.length >= 2);
}

function selectionMentionsPlayer(selection, playerName) {
  const text = normName(selection);
  const tokens = playerTokens(playerName);
  if (!tokens.length) return false;
  const last = tokens.at(-1);
  if (last && text.includes(last)) return true;
  return tokens.length >= 2 && tokens.slice(0, 2).every((t) => text.includes(t));
}

function marketLooksLikeMatchWinner(name) {
  const s = String(name ?? '').toLowerCase();
  if (/correct|score|set|game|total|handicap|spread|winner.*games|exact/i.test(s)) return false;
  return /match\s*winner|winner|to\s*win|moneyline|2\s*way|full\s*time|home\s*away/i.test(s);
}

function extractLabels(rawKey, rawValue) {
  const labels = [rawKey];
  if (rawValue && typeof rawValue === 'object') {
    for (const key of ['name', 'label', 'value', 'selection', 'odd_name', 'bet', 'team', 'player', 'participant', 'runner']) {
      if (rawValue[key] != null) labels.push(String(rawValue[key]));
    }
  }
  return labels.filter(Boolean);
}

function extractMatchWinnerOdds(matchOdds, player1, player2) {
  const result = { player1_odds: null, player2_odds: null, market: '', player1_label: '', player2_label: '' };
  if (!matchOdds || typeof matchOdds !== 'object') return result;
  const markets = Object.entries(matchOdds);
  const likelyMarkets = markets.filter(([name]) => marketLooksLikeMatchWinner(name));
  const searchMarkets = likelyMarkets.length ? likelyMarkets : markets.filter(([name]) => !/correct|score|set|game|total|handicap|spread|exact/i.test(String(name ?? '').toLowerCase()));

  for (const [marketName, market] of searchMarkets) {
    if (!market || typeof market !== 'object') continue;
    let p1 = null;
    let p2 = null;
    let p1Label = '';
    let p2Label = '';
    for (const [rawKey, rawValue] of Object.entries(market)) {
      const labels = extractLabels(rawKey, rawValue);
      const odds = decimalOddsFromValue(rawValue);
      if (!odds) continue;
      if (!p1 && labels.some((label) => selectionMentionsPlayer(label, player1))) {
        p1 = odds;
        p1Label = labels.join(' / ');
      }
      if (!p2 && labels.some((label) => selectionMentionsPlayer(label, player2))) {
        p2 = odds;
        p2Label = labels.join(' / ');
      }
    }
    if (p1 && p2) {
      return { player1_odds: p1, player2_odds: p2, market: marketName, player1_label: p1Label, player2_label: p2Label };
    }
  }
  return result;
}

function isFinishedOrUseful(fixture) {
  const status = String(fixture.event_status ?? fixture.status ?? '').toLowerCase();
  if (!status) return true;
  if (/cancel|postpon|walkover|abandon|retired/.test(status)) return false;
  return true;
}

function groupedWin(score) {
  return ['3-6', '4-6', '5-7'].includes(score) ? 1 : 0;
}

function strengthBucket(player1Odds, player2Odds, nearRatio, nearMaxOdds) {
  if (!player1Odds || !player2Odds) return 'unknown';
  if (player2Odds < player1Odds) return 'favorite';
  const ratio = player2Odds / player1Odds;
  if (ratio <= nearRatio || player2Odds <= nearMaxOdds) return 'near_favorite';
  if (player2Odds <= 3.5) return 'underdog';
  return 'big_underdog';
}

async function buildCandidates({ dateStart, dateStop, delayMs, nearRatio, nearMaxOdds }) {
  const all = [];
  const errors = [];
  const rawOddsSamples = [];
  const dates = dateRange(dateStart, dateStop);
  for (const date of dates) {
    try {
      console.log(`Scanning ${date}`);
      const fixtures = normalizeArray(await fetchApi('get_fixtures', { date_start: date, date_stop: date }));
      await sleep(delayMs);
      const oddsResult = await fetchApi('get_odds', { date_start: date, date_stop: date });
      await sleep(delayMs);
      const fixtureByKey = new Map(fixtures.map((fixture) => [String(fixture.event_key), fixture]));
      for (const [eventKey, matchOdds] of Object.entries(oddsResult ?? {})) {
        const fixture = fixtureByKey.get(String(eventKey));
        if (!fixture || !isFinishedOrUseful(fixture) || isDoubles(fixture)) continue;
        const level = tournamentLevel(fixture);
        if (level !== 'tour_other') continue;
        const exactOdds = extractExactScoreOdds(matchOdds, '4-6');
        if (!exactOdds || exactOdds < 6.25 || exactOdds >= 7.0) continue;
        const firstSetScore = extractFirstSetScore(fixture);
        if (!firstSetScore) continue;
        const player1 = String(fixture.event_first_player ?? '').trim();
        const player2 = String(fixture.event_second_player ?? '').trim();
        const matchWinner = extractMatchWinnerOdds(matchOdds, player1, player2);
        const bucket = strengthBucket(matchWinner.player1_odds, matchWinner.player2_odds, nearRatio, nearMaxOdds);
        if ((!matchWinner.player1_odds || !matchWinner.player2_odds) && rawOddsSamples.length < 20) {
          rawOddsSamples.push({ eventKey, date, match_name: fixtureName(fixture), markets: Object.keys(matchOdds ?? {}).slice(0, 50) });
        }
        all.push({
          event_key: eventKey,
          event_date: fixture.event_date ?? date,
          match_start_time: parseStart(fixture),
          match_name: fixtureName(fixture),
          player1,
          player2,
          tournament: fixture.tournament_name ?? '',
          tournament_round: fixture.tournament_round ?? '',
          tournament_level: level,
          surface: surfaceOf(fixture),
          first_set_score: firstSetScore,
          grouped_win: groupedWin(firstSetScore),
          exact_4_6_odds: exactOdds,
          p1_match_odds: matchWinner.player1_odds,
          p2_match_odds: matchWinner.player2_odds,
          match_winner_market: matchWinner.market,
          p1_match_label: matchWinner.player1_label,
          p2_match_label: matchWinner.player2_label,
          p2_strength_bucket: bucket,
          p2_is_favorite: bucket === 'favorite' ? 1 : 0,
          p2_is_favorite_or_near: ['favorite', 'near_favorite'].includes(bucket) ? 1 : 0,
          p2_odds_ratio_vs_p1: matchWinner.player1_odds && matchWinner.player2_odds ? Number((matchWinner.player2_odds / matchWinner.player1_odds).toFixed(4)) : '',
        });
      }
    } catch (error) {
      errors.push({ date, error: error instanceof Error ? error.message : String(error) });
      console.error(`Error on ${date}: ${errors.at(-1).error}`);
    }
  }
  return { candidates: all, errors, rawOddsSamples, daysScanned: dates.length };
}

function compoundBacktest(events, { startingBankroll, riskFraction, odds }) {
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0;
  let currentLossStreak = 0;
  let worstLossStreak = 0;
  let wins = 0;
  let losses = 0;
  let flatProfitUnits = 0;
  const rows = [];
  const sorted = [...events].sort((a, b) => String(a.match_start_time).localeCompare(String(b.match_start_time)) || String(a.event_key).localeCompare(String(b.event_key)));
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    const stake = bankroll * riskFraction;
    const win = Boolean(event.grouped_win);
    const profit = win ? stake * (odds - 1) : -stake;
    if (win) {
      wins += 1;
      currentLossStreak = 0;
      flatProfitUnits += odds - 1;
    } else {
      losses += 1;
      currentLossStreak += 1;
      worstLossStreak = Math.max(worstLossStreak, currentLossStreak);
      flatProfitUnits -= 1;
    }
    bankroll += profit;
    peak = Math.max(peak, bankroll);
    const drawdown = peak > 0 ? (peak - bankroll) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    rows.push({
      index: index + 1,
      ...event,
      scenario_grouped_odds: odds,
      stake: Number(stake.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      bankroll_after: Number(bankroll.toFixed(2)),
      drawdown_pct: Number(drawdown.toFixed(4)),
    });
  }
  return {
    bets: sorted.length,
    wins,
    losses,
    hit_rate: sorted.length ? wins / sorted.length : 0,
    break_even_odds: wins ? sorted.length / wins : null,
    final_bankroll: bankroll,
    profit: bankroll - startingBankroll,
    return_pct: bankroll / startingBankroll - 1,
    flat_roi_units: sorted.length ? flatProfitUnits / sorted.length : 0,
    worst_losing_streak: worstLossStreak,
    max_drawdown_pct: maxDrawdown,
    rows,
  };
}

function summarizeBacktest(result) {
  return {
    bets: result.bets,
    wins: result.wins,
    losses: result.losses,
    hit_rate: Number(result.hit_rate.toFixed(4)),
    break_even_odds: result.break_even_odds == null ? null : Number(result.break_even_odds.toFixed(4)),
    final_bankroll: Number(result.final_bankroll.toFixed(2)),
    profit: Number(result.profit.toFixed(2)),
    return_pct: Number(result.return_pct.toFixed(4)),
    flat_roi_units: Number(result.flat_roi_units.toFixed(4)),
    worst_losing_streak: result.worst_losing_streak,
    max_drawdown_pct: Number(result.max_drawdown_pct.toFixed(4)),
  };
}

function filterSets(candidates) {
  return {
    v3_all: candidates,
    v3_p2_favorite: candidates.filter((c) => c.p2_strength_bucket === 'favorite'),
    v3_p2_favorite_or_near: candidates.filter((c) => ['favorite', 'near_favorite'].includes(c.p2_strength_bucket)),
    v3_p2_favorite_hard_grass: candidates.filter((c) => c.p2_strength_bucket === 'favorite' && /hard|grass/i.test(String(c.surface))),
    v3_p2_favorite_or_near_hard_grass: candidates.filter((c) => ['favorite', 'near_favorite'].includes(c.p2_strength_bucket) && /hard|grass/i.test(String(c.surface))),
    v3_p2_unknown_match_odds: candidates.filter((c) => c.p2_strength_bucket === 'unknown'),
    v3_p2_underdog_or_big: candidates.filter((c) => ['underdog', 'big_underdog'].includes(c.p2_strength_bucket)),
  };
}

async function main() {
  const dateStart = arg('date-start', '2025-04-01');
  const dateStop = arg('date-stop', '2026-05-01');
  const outputDir = arg('output-dir', 'artifacts/output/v3-player2-favorite-9-12-backtest');
  const startingBankroll = Number(arg('bankroll', '5000')) || 5000;
  const riskFraction = Number(arg('risk', '0.02')) || 0.02;
  const delayMs = Number(arg('delay-ms', '150')) || 0;
  const nearRatio = Number(arg('near-ratio', '1.15')) || 1.15;
  const nearMaxOdds = Number(arg('near-max-odds', '2.20')) || 2.20;
  const scenarioOdds = String(arg('scenario-odds', '3.00,3.30,3.50,3.60'))
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 1);

  const { candidates, errors, rawOddsSamples, daysScanned } = await buildCandidates({ dateStart, dateStop, delayMs, nearRatio, nearMaxOdds });
  const sets = filterSets(candidates);
  const summary = {
    mode: 'v3_player2_favorite_9_12_backtest_v1',
    config: { dateStart, dateStop, startingBankroll, riskFraction, scenarioOdds, delayMs, nearRatio, nearMaxOdds },
    definitions: {
      v3_trigger: 'exact first-set 4-6 odds >= 6.25 and < 7.00, tour_other singles only',
      main_market_modeled: 'Player 2 & 9-12, wins on 3-6 / 4-6 / 5-7',
      player2_favorite: 'player2 match-winner odds lower than player1 match-winner odds',
      player2_near_favorite: `player2 odds / player1 odds <= ${nearRatio} OR player2 match odds <= ${nearMaxOdds}`,
      warning: 'Grouped Player 2 & 9-12 odds are scenario odds here, not real historical grouped market odds.'
    },
    days_scanned: daysScanned,
    candidate_rows: candidates.length,
    match_winner_odds_rows: candidates.filter((c) => c.p1_match_odds && c.p2_match_odds).length,
    p2_strength_counts: Object.fromEntries(['favorite', 'near_favorite', 'underdog', 'big_underdog', 'unknown'].map((bucket) => [bucket, candidates.filter((c) => c.p2_strength_bucket === bucket).length])),
    errors,
    filter_results: {},
  };

  const allBacktestRows = [];
  for (const [filterName, rows] of Object.entries(sets)) {
    const baseWins = rows.filter((r) => r.grouped_win).length;
    summary.filter_results[filterName] = {
      rows: rows.length,
      wins: baseWins,
      losses: rows.length - baseWins,
      hit_rate: rows.length ? Number((baseWins / rows.length).toFixed(4)) : 0,
      break_even_odds: baseWins ? Number((rows.length / baseWins).toFixed(4)) : null,
      scenarios: {},
    };
    for (const odds of scenarioOdds) {
      const bt = compoundBacktest(rows, { startingBankroll, riskFraction, odds });
      summary.filter_results[filterName].scenarios[`scenario_${odds}`] = summarizeBacktest(bt);
      if (['v3_all', 'v3_p2_favorite', 'v3_p2_favorite_or_near'].includes(filterName)) {
        allBacktestRows.push(...bt.rows.map((r) => ({ filter: filterName, ...r })));
      }
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const candidateHeaders = ['event_key','event_date','match_start_time','match_name','player1','player2','tournament','tournament_round','tournament_level','surface','first_set_score','grouped_win','exact_4_6_odds','p1_match_odds','p2_match_odds','match_winner_market','p1_match_label','p2_match_label','p2_strength_bucket','p2_is_favorite','p2_is_favorite_or_near','p2_odds_ratio_vs_p1'];
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-candidates.csv'), writeCsv(candidateHeaders, candidates));
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-backtest-rows.csv'), writeCsv(Object.keys(allBacktestRows[0] ?? { filter: '' }), allBacktestRows));
  await fs.writeFile(path.join(outputDir, 'raw-odds-market-samples.json'), `${JSON.stringify(rawOddsSamples, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'v3-player2-favorite-9-12-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
