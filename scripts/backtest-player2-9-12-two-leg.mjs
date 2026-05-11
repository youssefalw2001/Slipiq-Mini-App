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
        const label = String(rawValue.name ?? rawValue.label ?? rawValue.value ?? rawValue.selection ?? '').trim();
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

function looksLikeGroupedMarketName(name) {
  const s = String(name ?? '').toLowerCase();
  return /(winner|win).*?(exact\s*games|total\s*games|games|9\s*[-–]\s*12)|((exact\s*games|total\s*games|games).*?(winner|win))|set\s*winner.*games/i.test(s);
}

function looksLikePlayer2_9_12Selection(label, player2) {
  const s = String(label ?? '').toLowerCase();
  const hasBucket = /9\s*[-–]\s*12/.test(s);
  if (!hasBucket) return false;
  if (/player\s*2|p2|second\s*player|away/.test(s)) return true;
  return selectionMentionsPlayer(label, player2);
}

function extractGroupedPlayer2_9_12Odds(matchOdds, player2) {
  if (!matchOdds || typeof matchOdds !== 'object') return { odds: null, market: '', selection: '' };
  const markets = Object.entries(matchOdds);
  const likelyMarkets = markets.filter(([name]) => looksLikeGroupedMarketName(name));
  const searchMarkets = likelyMarkets.length ? likelyMarkets : markets;

  for (const [marketName, market] of searchMarkets) {
    if (!market || typeof market !== 'object') continue;
    for (const [rawKey, rawValue] of Object.entries(market)) {
      const labels = [rawKey];
      if (rawValue && typeof rawValue === 'object') {
        for (const k of ['name', 'label', 'value', 'selection', 'odd_name', 'bet', 'handicap']) {
          if (rawValue[k] != null) labels.push(String(rawValue[k]));
        }
      }
      const label = labels.find((x) => looksLikePlayer2_9_12Selection(x, player2));
      if (!label) continue;
      const odds = decimalOddsFromValue(rawValue);
      if (odds) return { odds, market: marketName, selection: label };
    }
  }
  return { odds: null, market: '', selection: '' };
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

function ruleForCandidate(exactOdds) {
  const rules = [];
  if (exactOdds >= 6.25 && exactOdds < 7.0) rules.push('v3_strict_625_699');
  if (exactOdds >= 6.5 && exactOdds < 7.0) rules.push('ultra_650_699');
  return rules;
}

async function buildCandidates({ dateStart, dateStop, delayMs }) {
  const all = [];
  const errors = [];
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
        if (!exactOdds) continue;
        const rules = ruleForCandidate(exactOdds);
        if (!rules.length) continue;
        const player2 = String(fixture.event_second_player ?? '').trim();
        const grouped = extractGroupedPlayer2_9_12Odds(matchOdds, player2);
        const firstSetScore = extractFirstSetScore(fixture);
        const base = {
          event_key: eventKey,
          event_date: fixture.event_date ?? date,
          match_start_time: parseStart(fixture),
          match_name: fixtureName(fixture),
          player1: fixture.event_first_player ?? '',
          player2,
          tournament: fixture.tournament_name ?? '',
          tournament_round: fixture.tournament_round ?? '',
          tournament_level: level,
          first_set_score: firstSetScore,
          grouped_result: firstSetScore ? (groupedWin(firstSetScore) ? 'won' : 'lost') : 'unknown',
          exact_4_6_odds: exactOdds,
          grouped_player2_9_12_odds: grouped.odds,
          grouped_market_name: grouped.market,
          grouped_selection_label: grouped.selection,
          grouped_odds_found: grouped.odds ? 'true' : 'false',
        };
        for (const rule of rules) all.push({ ...base, rule });
      }
    } catch (error) {
      errors.push({ date, error: error instanceof Error ? error.message : String(error) });
      console.error(`Error on ${date}: ${errors.at(-1).error}`);
    }
  }
  return { candidates: all, errors, daysScanned: dates.length };
}

function compoundBacktest(events, { startingBankroll, riskFraction, getOdds, winKey = 'win' }) {
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0;
  let currentLossStreak = 0;
  let worstLossStreak = 0;
  let wins = 0;
  let losses = 0;
  let profitFlatUnits = 0;
  const rows = [];
  events.forEach((event, index) => {
    const odds = getOdds(event);
    const stake = bankroll * riskFraction;
    const win = Boolean(event[winKey]);
    let profit;
    if (win) {
      profit = stake * (odds - 1);
      wins += 1;
      currentLossStreak = 0;
      profitFlatUnits += odds - 1;
    } else {
      profit = -stake;
      losses += 1;
      currentLossStreak += 1;
      worstLossStreak = Math.max(worstLossStreak, currentLossStreak);
      profitFlatUnits -= 1;
    }
    bankroll += profit;
    peak = Math.max(peak, bankroll);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - bankroll) / peak : 0);
    rows.push({
      index: index + 1,
      ...event,
      odds,
      stake: Number(stake.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      bankroll_after: Number(bankroll.toFixed(2)),
      drawdown_pct: Number((peak > 0 ? (peak - bankroll) / peak : 0).toFixed(4)),
    });
  });
  return {
    bets: events.length,
    wins,
    losses,
    hit_rate: events.length ? wins / events.length : 0,
    final_bankroll: bankroll,
    profit: bankroll - startingBankroll,
    return_pct: bankroll / startingBankroll - 1,
    flat_roi_units: events.length ? profitFlatUnits / events.length : 0,
    worst_losing_streak: worstLossStreak,
    max_drawdown_pct: maxDrawdown,
    rows,
  };
}

function pairTwoLegParlays(candidates, getLegOdds) {
  const sorted = [...candidates].sort((a, b) => String(a.match_start_time).localeCompare(String(b.match_start_time)) || String(a.event_key).localeCompare(String(b.event_key)));
  const pairs = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const oddsA = getLegOdds(a);
    const oddsB = getLegOdds(b);
    if (!oddsA || !oddsB) continue;
    pairs.push({
      pair_no: pairs.length + 1,
      rule: a.rule,
      event_date_1: a.event_date,
      event_date_2: b.event_date,
      match_1: a.match_name,
      match_2: b.match_name,
      score_1: a.first_set_score,
      score_2: b.first_set_score,
      leg1_win: groupedWin(a.first_set_score),
      leg2_win: groupedWin(b.first_set_score),
      win: groupedWin(a.first_set_score) && groupedWin(b.first_set_score) ? 1 : 0,
      leg1_odds: oddsA,
      leg2_odds: oddsB,
      parlay_odds: oddsA * oddsB,
      leg1_grouped_real_odds: a.grouped_player2_9_12_odds,
      leg2_grouped_real_odds: b.grouped_player2_9_12_odds,
      leg1_exact_4_6_odds: a.exact_4_6_odds,
      leg2_exact_4_6_odds: b.exact_4_6_odds,
    });
  }
  return pairs;
}

function summarizeBacktest(result) {
  return {
    bets: result.bets,
    wins: result.wins,
    losses: result.losses,
    hit_rate: Number(result.hit_rate.toFixed(4)),
    final_bankroll: Number(result.final_bankroll.toFixed(2)),
    profit: Number(result.profit.toFixed(2)),
    return_pct: Number(result.return_pct.toFixed(4)),
    flat_roi_units: Number(result.flat_roi_units.toFixed(4)),
    worst_losing_streak: result.worst_losing_streak,
    max_drawdown_pct: Number(result.max_drawdown_pct.toFixed(4)),
  };
}

function average(values) {
  const xs = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

async function main() {
  const dateStart = arg('date-start', '2025-04-01');
  const dateStop = arg('date-stop', '2026-05-01');
  const outputDir = arg('output-dir', 'artifacts/output/player2-9-12-two-leg-backtest');
  const startingBankroll = Number(arg('bankroll', '5000')) || 5000;
  const riskFraction = Number(arg('risk', '0.02')) || 0.02;
  const delayMs = Number(arg('delay-ms', '150')) || 0;
  const scenarioOdds = String(arg('scenario-odds', '2.80,3.00,3.30,3.50,3.60'))
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 1);

  const { candidates, errors, daysScanned } = await buildCandidates({ dateStart, dateStop, delayMs });
  const settledCandidates = candidates.filter((c) => ['won', 'lost'].includes(c.grouped_result));
  const rules = ['v3_strict_625_699', 'ultra_650_699'];
  const summary = {
    mode: 'player2_9_12_two_leg_backtest_v1',
    config: { dateStart, dateStop, startingBankroll, riskFraction, scenarioOdds, delayMs },
    days_scanned: daysScanned,
    candidate_rows: candidates.length,
    settled_candidate_rows: settledCandidates.length,
    grouped_real_odds_rows: settledCandidates.filter((c) => c.grouped_player2_9_12_odds).length,
    errors,
    rules: {},
  };

  const allParlayRows = [];
  const allStraightRows = [];

  for (const rule of rules) {
    const ruleRows = settledCandidates.filter((c) => c.rule === rule);
    summary.rules[rule] = {
      settled_rows: ruleRows.length,
      grouped_wins: ruleRows.filter((c) => c.grouped_result === 'won').length,
      grouped_losses: ruleRows.filter((c) => c.grouped_result === 'lost').length,
      grouped_hit_rate: ruleRows.length ? Number((ruleRows.filter((c) => c.grouped_result === 'won').length / ruleRows.length).toFixed(4)) : 0,
      real_grouped_odds_rows: ruleRows.filter((c) => c.grouped_player2_9_12_odds).length,
      avg_real_grouped_odds: average(ruleRows.map((c) => c.grouped_player2_9_12_odds)),
      straight: {},
      two_leg: {},
    };

    const realOddsRows = ruleRows.filter((c) => c.grouped_player2_9_12_odds);
    if (realOddsRows.length) {
      const straightEvents = realOddsRows.map((c) => ({ ...c, win: groupedWin(c.first_set_score) }));
      const straight = compoundBacktest(straightEvents, { startingBankroll, riskFraction, getOdds: (e) => e.grouped_player2_9_12_odds });
      summary.rules[rule].straight.real_grouped_odds = summarizeBacktest(straight);
      allStraightRows.push(...straight.rows.map((r) => ({ mode: 'real_grouped_odds', rule, ...r })));

      const pairs = pairTwoLegParlays(realOddsRows, (e) => e.grouped_player2_9_12_odds);
      const twoLeg = compoundBacktest(pairs, { startingBankroll, riskFraction, getOdds: (e) => e.parlay_odds });
      summary.rules[rule].two_leg.real_grouped_odds = summarizeBacktest(twoLeg);
      allParlayRows.push(...twoLeg.rows.map((r) => ({ mode: 'real_grouped_odds', rule, ...r })));
    }

    for (const odds of scenarioOdds) {
      const straightEvents = ruleRows.map((c) => ({ ...c, win: groupedWin(c.first_set_score), scenario_leg_odds: odds }));
      const straight = compoundBacktest(straightEvents, { startingBankroll, riskFraction, getOdds: () => odds });
      summary.rules[rule].straight[`scenario_${odds}`] = summarizeBacktest(straight);
      allStraightRows.push(...straight.rows.map((r) => ({ mode: `scenario_${odds}`, rule, ...r })));

      const pairs = pairTwoLegParlays(ruleRows, () => odds);
      const twoLeg = compoundBacktest(pairs, { startingBankroll, riskFraction, getOdds: (e) => e.parlay_odds });
      summary.rules[rule].two_leg[`scenario_${odds}`] = summarizeBacktest(twoLeg);
      allParlayRows.push(...twoLeg.rows.map((r) => ({ mode: `scenario_${odds}`, rule, ...r })));
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  const candidateHeaders = ['rule','event_key','event_date','match_start_time','match_name','player1','player2','tournament','tournament_round','tournament_level','first_set_score','grouped_result','exact_4_6_odds','grouped_player2_9_12_odds','grouped_market_name','grouped_selection_label','grouped_odds_found'];
  await fs.writeFile(path.join(outputDir, 'player2-9-12-candidates.csv'), writeCsv(candidateHeaders, candidates));
  await fs.writeFile(path.join(outputDir, 'two-leg-parlay-backtest-rows.csv'), writeCsv(Object.keys(allParlayRows[0] ?? { mode: '', rule: '' }), allParlayRows));
  await fs.writeFile(path.join(outputDir, 'straight-backtest-rows.csv'), writeCsv(Object.keys(allStraightRows[0] ?? { mode: '', rule: '' }), allStraightRows));
  await fs.writeFile(path.join(outputDir, 'player2-9-12-two-leg-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
