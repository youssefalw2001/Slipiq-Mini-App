#!/usr/bin/env node
/*
SlipIQ / First Set Lab live scanner.

Optimized launch version from Signal Room Risk Optimizer plus dry-run comfort layer:
- Core WTA Mirror grouped gate raised to 2.60
- VIP P2 V3 grouped gate raised to 3.50
- Core edge capped at 10 signals/day
- VIP edge capped at 5 signals/day
- Comfort layer: Home/Away (1st Set), Grand Slam only, 1xBet favorite, odds 1.50-1.65
- Comfort cap is separate from exact-score edge caps
- Bookmaker names hidden in Telegram, stored internally only
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const apiKey = process.env.API_TENNIS_KEY || process.env.APITENNIS_API_KEY || process.env.API_TENNIS_API_KEY;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const coreChatId = process.env.TELEGRAM_CORE_CHAT_ID || '';
const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID || '';
const sendTelegram = String(params['send-telegram'] ?? process.env.SEND_TELEGRAM ?? 'false').toLowerCase() === 'true';
const outDir = params.out || 'artifacts/output/api-tennis-live-first-set-lab-scanner';
const baseUrl = 'https://api.api-tennis.com/tennis/';
const marketName = params.market || 'Correct Score 1st Half';
const comfortMarketName = params['comfort-market'] || process.env.COMFORT_MARKET_NAME || 'Home/Away (1st Set)';
const eventTypeKeys = (params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266').split(',').map((s) => s.trim()).filter(Boolean);
const maxMinutesToStart = Number(params['max-minutes-to-start'] ?? process.env.MAX_MINUTES_TO_START ?? '2160');
const minMinutesToStart = Number(params['min-minutes-to-start'] ?? process.env.MIN_MINUTES_TO_START ?? '0');
const coreDailyCap = Number(params['core-daily-cap'] ?? process.env.CORE_DAILY_CAP ?? '10');
const vipDailyCap = Number(params['vip-daily-cap'] ?? process.env.VIP_DAILY_CAP ?? '5');
const coreComfortDailyCap = Number(params['core-comfort-daily-cap'] ?? process.env.CORE_COMFORT_DAILY_CAP ?? '1');
const vipComfortDailyCap = Number(params['vip-comfort-daily-cap'] ?? process.env.VIP_COMFORT_DAILY_CAP ?? '2');
const now = new Date();

const isoDate = (offsetDays = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const dateStart = params['date-start'] || process.env.API_TENNIS_DATE_START || isoDate(0);
const dateStop = params['date-stop'] || process.env.API_TENNIS_DATE_STOP || isoDate(2);

if (!apiKey) {
  console.error('Missing API Tennis key. Add API_TENNIS_KEY, APITENNIS_API_KEY, or API_TENNIS_API_KEY.');
  process.exit(2);
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/[_-]/g, ' ');
const safeNumber = (v) => {
  if (v === undefined || v === null || clean(v) === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const groupedOdds = (values) => {
  const nums = values.map(safeNumber);
  if (nums.some((v) => !v || v <= 1)) return null;
  const implied = nums.reduce((sum, v) => sum + (1 / v), 0);
  return implied > 0 ? Number((1 / implied).toFixed(6)) : null;
};
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
const fmtOdds = (v) => (v === null || v === undefined || v === '' ? 'n/a' : Number(v).toFixed(2));
const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const writeCsv = (filePath, rows, fields) => {
  ensureDir(path.dirname(filePath));
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((f) => csvEscape(row[f])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};
const writeJson = (filePath, data) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

function tournamentGroup(fixture) {
  const t = clean(fixture?.tournament_name).toLowerCase();
  if (['australian open', 'roland garros', 'french open', 'wimbledon', 'us open'].some((k) => t.includes(k))) return 'GRAND_SLAM';
  if (['indian wells', 'miami', 'monte carlo', 'madrid', 'rome', 'italian open', 'canada', 'canadian open', 'toronto', 'montreal', 'cincinnati', 'shanghai', 'paris', 'beijing', 'wuhan', 'doha', 'dubai', 'qatar open'].some((k) => t.includes(k))) return 'MASTERS_1000';
  if (['barcelona', 'halle', 'queen', 'queens', 'london', 'stuttgart', 'charleston', 'washington', 'hamburg', 'tokyo', 'acapulco', 'eastbourne', 'rotterdam', 'basel', 'vienna', 'adelaide', 'brisbane', 'bad homburg', 'berlin', 'strasbourg', 'antwerp', 'dallas', 'rio', 'astana', 'chengdu', 'zhuhai', 'seoul'].some((k) => t.includes(k))) return 'STRONG_500_250';
  if (['challenger', 'itf', 'm25', 'm15', 'w15', 'w25', 'w35', 'w50', 'w75', 'w100', 'w125'].some((k) => t.includes(k))) return 'LOWER_TIER';
  return 'OTHER_TOUR';
}
function tourFromFixture(fixture) {
  const key = clean(fixture?.event_type_key);
  if (key === '265') return 'ATP';
  if (key === '266') return 'WTA';
  const s = `${fixture?.event_type_type ?? ''} ${fixture?.tournament_name ?? ''}`.toLowerCase();
  if (s.includes('wta') || s.includes('women')) return 'WTA';
  if (s.includes('atp') || s.includes('men')) return 'ATP';
  return 'UNKNOWN';
}
function startsAtIso(fixture) {
  const date = clean(fixture?.event_date);
  const time = clean(fixture?.event_time || '00:00');
  if (!date) return null;
  const d = new Date(`${date}T${time.length === 5 ? time + ':00' : time}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function minutesToStart(fixture) {
  const start = startsAtIso(fixture);
  if (!start) return null;
  return Math.round((new Date(start).getTime() - now.getTime()) / 60000);
}
function matchName(fixture) {
  const p1 = clean(fixture?.event_first_player);
  const p2 = clean(fixture?.event_second_player);
  return p1 && p2 ? `${p1} vs ${p2}` : clean(fixture?.event_name || fixture?.event_key || 'Unknown match');
}
function eventStatus(fixture) {
  return clean(fixture?.event_status || fixture?.event_live || fixture?.event_status_info || 'upcoming');
}
function allBookmakersForScores(market, scores) {
  const set = new Set();
  for (const score of scores) {
    const obj = market?.[score];
    if (obj && typeof obj === 'object') for (const b of Object.keys(obj)) set.add(b);
  }
  return [...set].sort();
}
function getBookOdds(market, scores, book) {
  return scores.map((score) => safeNumber(market?.[score]?.[book]));
}
function breakEven(odds) {
  return odds ? 1 / odds : null;
}
function historicalStatsForLane(laneKey) {
  const stats = {
    CORE_P1_ATP_GS_BET365: { hit: 0.3934, roi: 0.1704, sample: 544 },
    CORE_P1_MIRROR_WTA_OTHER: { hit: 0.3934, roi: 0.1704, sample: 544 },
    VIP_P1_ATP_GS_MULTI: { hit: 0.3853, roi: 0.1760, sample: 571 },
    VIP_P2_V3_SHAPE: { hit: 0.3853, roi: 0.1760, sample: 571 },
    COMFORT_FIRST_SET_FAVORITE_GS_1XBET: { hit: 0.7517, roi: 0.1992, sample: 149 },
  };
  return stats[laneKey] || { hit: null, roi: null, sample: 0 };
}

const lanes = [
  {
    key: 'CORE_P1_ATP_GS_BET365', access: 'CORE_AND_VIP', books: ['bet365'], scores: ['6:3', '6:4'],
    sideText: 'Player 1 wins first set 6:3 or 6:4', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25,
    minGrouped: 2.50, tierFloorA: 2.50, tierFloorS: 3.10, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', publicLabel: 'Core Cluster', quality: 4
  },
  {
    key: 'CORE_P1_MIRROR_WTA_OTHER', access: 'CORE_AND_VIP', books: ['bet365', '1xBet'], scores: ['6:3', '6:4', '7:5'],
    sideText: 'Player 1 wins first set 6:3, 6:4, or 7:5', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 8.00,
    minGrouped: 2.60, tierFloorA: 2.60, tierFloorS: 2.90, tour: 'WTA', tournamentGroup: 'OTHER_TOUR', publicLabel: 'Mirror Cluster', quality: 2
  },
  {
    key: 'VIP_P1_ATP_GS_MULTI', access: 'VIP_ONLY', books: ['bet365', '1xBet', '10Bet'], scores: ['6:3', '6:4'],
    sideText: 'Player 1 wins first set 6:3 or 6:4', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25,
    minGrouped: 2.60, tierFloorA: 2.60, tierFloorS: 3.10, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', publicLabel: 'Core Cluster Plus', quality: 3
  },
  {
    key: 'VIP_P2_V3_SHAPE', access: 'VIP_ONLY', books: ['bet365', '1xBet', '10Bet'], scores: ['3:6', '4:6', '5:7'],
    sideText: 'Player 2 wins first set 6:3, 6:4, or 7:5', triggerScore: '4:6', triggerMin: 6.25, triggerMax: 6.99,
    minGrouped: 3.50, tierFloorA: 3.50, tierFloorS: 3.75, tour: 'ANY', tournamentGroup: 'ANY', publicLabel: 'V3 Cluster', quality: 2
  },
];

async function fetchApiTennis(method, apiParams = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(apiParams)) {
    if (value !== undefined && value !== null && clean(value) !== '') url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${method} non-JSON ${res.status}: ${text.slice(0, 800)}`); }
  if (!res.ok || String(payload.success) !== '1') throw new Error(`${method} failed HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 1600)}`);
  return payload.result;
}
async function fetchCombined(method, baseParams) {
  const chunks = [];
  const errors = [];
  for (const eventTypeKey of eventTypeKeys) {
    try {
      chunks.push({ eventTypeKey, result: await fetchApiTennis(method, { ...baseParams, event_type_key: eventTypeKey }) });
    } catch (err) {
      errors.push({ method, eventTypeKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { chunks, errors };
}
function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
}
function mergeFixtures(chunks) {
  const map = new Map();
  for (const chunk of chunks) for (const fixture of normalizeArray(chunk.result)) if (fixture?.event_key !== undefined) map.set(String(fixture.event_key), fixture);
  return [...map.values()];
}
function mergeOdds(chunks) {
  const merged = {};
  for (const chunk of chunks) {
    const result = chunk.result && typeof chunk.result === 'object' ? chunk.result : {};
    for (const [matchKey, odds] of Object.entries(result)) merged[matchKey] = odds;
  }
  return merged;
}
function buildFixtureMap(fixtures) {
  const map = new Map();
  for (const f of fixtures) if (f?.event_key !== undefined) map.set(String(f.event_key), f);
  return map;
}
function tierFor(grouped, lane) {
  if (grouped >= lane.tierFloorS) return 'S';
  if (grouped >= lane.tierFloorA) return 'A';
  return 'B';
}
function optionPriceForBook(market, labels, book) {
  if (!market || typeof market !== 'object') return null;
  const wanted = labels.map(norm);
  for (const [label, prices] of Object.entries(market)) {
    const labelNorm = norm(label);
    if (!wanted.some((w) => w && (labelNorm === w || labelNorm.includes(w) || w.includes(labelNorm)))) continue;
    if (prices && typeof prices === 'object') {
      if (prices[book] !== undefined) return safeNumber(prices[book]);
      for (const [bookName, price] of Object.entries(prices)) if (norm(bookName) === norm(book)) return safeNumber(price);
    } else {
      const n = safeNumber(prices);
      if (n) return n;
    }
  }
  return null;
}
function buildExactScoreRows(matchKey, matchOdds, fixture, tour, tGroup, mins) {
  const rows = [];
  const market = matchOdds?.[marketName];
  if (!market || typeof market !== 'object') return rows;
  for (const lane of lanes) {
    if (lane.tour !== 'ANY' && lane.tour !== tour) continue;
    if (lane.tournamentGroup !== 'ANY' && lane.tournamentGroup !== tGroup) continue;
    const seenBooks = allBookmakersForScores(market, lane.scores);
    for (const book of lane.books) {
      if (!seenBooks.includes(book)) continue;
      const odds = getBookOdds(market, lane.scores, book);
      if (odds.some((v) => !v || v <= 1)) continue;
      const grouped = groupedOdds(odds);
      if (!grouped || grouped < lane.minGrouped) continue;
      const triggerOdds = safeNumber(market?.[lane.triggerScore]?.[book]);
      if (!triggerOdds || triggerOdds < lane.triggerMin || triggerOdds > lane.triggerMax) continue;
      const tier = tierFor(grouped, lane);
      const hist = historicalStatsForLane(lane.key);
      const be = breakEven(grouped);
      const edge = hist.hit !== null && be !== null ? hist.hit - be : null;
      const row = {
        signal_type: 'exact_score_cluster', selected_side: '', selected_side_odds: '', market_source: marketName,
        scanned_at: new Date().toISOString(), event_key: String(matchKey), starts_at: startsAtIso(fixture) || '',
        event_date: clean(fixture.event_date), event_time: clean(fixture.event_time), minutes_to_start: mins,
        event_status: eventStatus(fixture), player1: clean(fixture.event_first_player), player2: clean(fixture.event_second_player),
        match_name: matchName(fixture), tour, tournament_group: tGroup, tournament_name: clean(fixture.tournament_name),
        internal_bookmaker: book, market_name: marketName, strategy_lane: lane.key, public_signal_name: lane.publicLabel,
        access: lane.access, score_cluster: lane.scores.join('/'), public_target: lane.sideText, trigger_score: lane.triggerScore,
        trigger_odds: triggerOdds, score_odds_json: JSON.stringify(Object.fromEntries(lane.scores.map((s, i) => [s, odds[i]]))),
        grouped_odds: grouped, break_even_hit_rate: be, historical_hit_rate: hist.hit, historical_roi: hist.roi,
        historical_sample: hist.sample, model_edge_vs_breakeven: edge, public_tier: tier, signal_quality: lane.quality,
      };
      row.signal_key = [row.event_key, row.strategy_lane, row.signal_type, row.score_cluster, row.public_tier].join(':');
      rows.push(row);
    }
  }
  return rows;
}
function buildComfortRows(matchKey, matchOdds, fixture, tour, tGroup, mins) {
  const rows = [];
  if (tGroup !== 'GRAND_SLAM') return rows;
  const market = matchOdds?.[comfortMarketName];
  if (!market || typeof market !== 'object') return rows;
  const book = '1xBet';
  const p1Name = clean(fixture.event_first_player);
  const p2Name = clean(fixture.event_second_player);
  const p1Odds = optionPriceForBook(market, ['Home', '1', 'Player 1', p1Name], book);
  const p2Odds = optionPriceForBook(market, ['Away', '2', 'Player 2', p2Name], book);
  if (!p1Odds || !p2Odds) return rows;
  const selectedSide = p1Odds <= p2Odds ? 'P1' : 'P2';
  const selectedOdds = selectedSide === 'P1' ? p1Odds : p2Odds;
  if (selectedOdds < 1.50 || selectedOdds >= 1.65) return rows;
  const hist = historicalStatsForLane('COMFORT_FIRST_SET_FAVORITE_GS_1XBET');
  const be = breakEven(selectedOdds);
  const edge = hist.hit !== null && be !== null ? hist.hit - be : null;
  const target = selectedSide === 'P1' ? 'Player 1 to win the first set' : 'Player 2 to win the first set';
  const row = {
    signal_type: 'first_set_winner', selected_side: selectedSide, selected_side_odds: selectedOdds, market_source: comfortMarketName,
    scanned_at: new Date().toISOString(), event_key: String(matchKey), starts_at: startsAtIso(fixture) || '',
    event_date: clean(fixture.event_date), event_time: clean(fixture.event_time), minutes_to_start: mins,
    event_status: eventStatus(fixture), player1: p1Name, player2: p2Name,
    match_name: matchName(fixture), tour, tournament_group: tGroup, tournament_name: clean(fixture.tournament_name),
    internal_bookmaker: book, market_name: comfortMarketName, strategy_lane: 'COMFORT_FIRST_SET_FAVORITE_GS_1XBET', public_signal_name: 'Grand Slam Comfort',
    access: 'CORE_AND_VIP', score_cluster: '', public_target: target, trigger_score: '', trigger_odds: '',
    score_odds_json: JSON.stringify({ P1: p1Odds, P2: p2Odds }), grouped_odds: selectedOdds,
    break_even_hit_rate: be, historical_hit_rate: hist.hit, historical_roi: hist.roi, historical_sample: hist.sample,
    model_edge_vs_breakeven: edge, public_tier: 'Comfort', signal_quality: 6,
  };
  row.signal_key = [row.event_key, row.strategy_lane, row.signal_type, row.selected_side, row.public_tier].join(':');
  rows.push(row);
  return rows;
}
function buildCandidateRows(oddsResult, fixturesByKey) {
  const rows = [];
  for (const [matchKey, matchOdds] of Object.entries(oddsResult)) {
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const tour = tourFromFixture(fixture);
    const tGroup = tournamentGroup(fixture);
    const mins = minutesToStart(fixture);
    if (mins === null || mins < minMinutesToStart || mins > maxMinutesToStart) continue;
    rows.push(...buildExactScoreRows(matchKey, matchOdds, fixture, tour, tGroup, mins));
    rows.push(...buildComfortRows(matchKey, matchOdds, fixture, tour, tGroup, mins));
  }
  return rows;
}
function dedupeSignals(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.event_key, r.strategy_lane, r.signal_type, r.selected_side || r.score_cluster].join(':');
    const prev = groups.get(key);
    if (!prev || signalRank(r) > signalRank(prev)) groups.set(key, r);
  }
  return [...groups.values()].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || signalRank(b) - signalRank(a));
}
function tierRank(tier) {
  return { Comfort: 4, S: 3, A: 2, B: 1 }[tier] || 0;
}
function signalRank(row) {
  if (row.signal_type === 'first_set_winner') {
    return Number(row.historical_hit_rate || 0) * 1000000 + Number(row.model_edge_vs_breakeven || 0) * 100000 + Number(row.signal_quality || 0) * 10000 - Math.abs(Number(row.selected_side_odds || 0) - 1.58) * 100;
  }
  return tierRank(row.public_tier) * 1000000 + Number(row.signal_quality || 0) * 100000 + Number(row.model_edge_vs_breakeven || 0) * 10000 + Number(row.grouped_odds || 0) * 100 + Number(row.trigger_odds || 0);
}
function capSignalsForRoom(rows, roomName, cap) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r.event_date || 'unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const selected = [];
  for (const [day, arr] of [...byDay.entries()].sort()) {
    const ranked = arr.sort((a, b) => signalRank(b) - signalRank(a));
    const keep = [];
    const usedEvents = new Set();
    for (const r of ranked) {
      if (usedEvents.has(r.event_key)) continue;
      usedEvents.add(r.event_key);
      keep.push({ ...r, telegram_room: roomName });
      if (cap > 0 && keep.length >= cap) break;
    }
    selected.push(...keep);
  }
  return selected.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || signalRank(b) - signalRank(a));
}
function buildSelectedRoomSignals(signals) {
  const exactSignals = signals.filter((r) => r.signal_type !== 'first_set_winner');
  const comfortSignals = signals.filter((r) => r.signal_type === 'first_set_winner');
  const coreEdgeRows = capSignalsForRoom(exactSignals.filter((r) => r.access === 'CORE_AND_VIP'), 'Core', coreDailyCap);
  const vipEdgeRows = capSignalsForRoom(exactSignals, 'VIP', vipDailyCap);
  const coreComfortRows = capSignalsForRoom(comfortSignals, 'Core', coreComfortDailyCap);
  const vipComfortRows = capSignalsForRoom(comfortSignals, 'VIP', vipComfortDailyCap);
  return [...coreEdgeRows, ...vipEdgeRows, ...coreComfortRows, ...vipComfortRows].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || String(a.telegram_room).localeCompare(String(b.telegram_room)) || signalRank(b) - signalRank(a));
}
function telegramMessage(row) {
  const be = row.break_even_hit_rate ? pct(row.break_even_hit_rate) : 'n/a';
  const hist = row.historical_hit_rate ? pct(row.historical_hit_rate) : 'n/a';
  const edge = row.model_edge_vs_breakeven !== null && row.model_edge_vs_breakeven !== undefined && row.model_edge_vs_breakeven !== '' ? `${(Number(row.model_edge_vs_breakeven) * 100).toFixed(1)} pts` : 'n/a';
  const dateTime = `${row.event_date || ''} ${row.event_time || ''} UTC`.trim();
  const mins = row.minutes_to_start !== null && row.minutes_to_start !== undefined ? `${row.minutes_to_start} min` : 'n/a';
  if (row.signal_type === 'first_set_winner') {
    return [
      '🎾 SlipIQ First Set Lab Comfort Signal', '', `Room: ${row.telegram_room}`, `Signal: ${row.public_signal_name}`,
      `Match: ${row.match_name}`, `Tournament: ${row.tournament_name || row.tournament_group}`, `Start: ${dateTime}`,
      `Time to start: ${mins}`, '', 'Target:', row.public_target, '', `Approx Odds: ${fmtOdds(row.selected_side_odds || row.grouped_odds)}`,
      `Break-even: ${be}`, `Historical Comfort Hit Rate: ${hist}`, `Historical Edge: +${edge}`, `Historical Sample: ${row.historical_sample || 'n/a'} signals`, '',
      'Paper-tracked signal. Probability edge, not a guaranteed pick.'
    ].join('\n');
  }
  return [
    `🎾 SlipIQ First Set Lab ${row.public_tier}-Tier`, '', `Room: ${row.telegram_room}`, `Signal: ${row.public_signal_name}`,
    `Match: ${row.match_name}`, `Tournament: ${row.tournament_name || row.tournament_group}`, `Start: ${dateTime}`,
    `Time to start: ${mins}`, '', 'Target Cluster:', row.public_target, '', `Grouped Odds: ${fmtOdds(row.grouped_odds)}`,
    `Break-even: ${be}`, `Historical Room Hit Rate: ${hist}`, `Historical Edge: +${edge}`, `Historical Sample: ${row.historical_sample || 'n/a'} signals`, '',
    'Paper-tracked signal. Probability edge, not a guaranteed pick.'
  ].join('\n');
}
async function sendTelegramMessage(chatId, text) {
  if (!telegramBotToken || !chatId) return { ok: false, skipped: true, reason: 'missing bot token or chat id' };
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok !== true) return { ok: false, status: res.status, payload };
  return { ok: true, message_id: payload.result?.message_id };
}
async function routeAndSend(selectedRows) {
  const sent = [];
  for (const row of selectedRows) {
    const chatId = row.telegram_room === 'Core' ? coreChatId : vipChatId;
    const message = telegramMessage(row);
    let result = { ok: false, skipped: true, reason: 'SEND_TELEGRAM=false' };
    if (sendTelegram) result = await sendTelegramMessage(chatId, message);
    sent.push({ ...row, telegram_sent: String(result.ok === true), telegram_result_json: JSON.stringify(result), telegram_message_preview: message });
  }
  return sent;
}

const fields = ['signal_type', 'selected_side', 'selected_side_odds', 'market_source', 'scanned_at', 'signal_key', 'event_key', 'starts_at', 'event_date', 'event_time', 'minutes_to_start', 'event_status', 'player1', 'player2', 'match_name', 'tour', 'tournament_group', 'tournament_name', 'internal_bookmaker', 'market_name', 'strategy_lane', 'public_signal_name', 'access', 'score_cluster', 'public_target', 'trigger_score', 'trigger_odds', 'score_odds_json', 'grouped_odds', 'break_even_hit_rate', 'historical_hit_rate', 'historical_roi', 'historical_sample', 'model_edge_vs_breakeven', 'public_tier', 'signal_quality'];
const selectedFields = [...fields, 'telegram_room'];
const sentFields = [...selectedFields, 'telegram_sent', 'telegram_result_json', 'telegram_message_preview'];

async function main() {
  ensureDir(outDir);
  const summary = { generated_at: new Date().toISOString(), date_start: dateStart, date_stop: dateStop, market_name: marketName, comfort_market_name: comfortMarketName, send_telegram: sendTelegram, bookmaker_names_hidden_in_telegram: true, core_daily_cap: coreDailyCap, vip_daily_cap: vipDailyCap, core_comfort_daily_cap: coreComfortDailyCap, vip_comfort_daily_cap: vipComfortDailyCap, min_minutes_to_start: minMinutesToStart, max_minutes_to_start: maxMinutesToStart, fixture_count: 0, odds_match_count: 0, raw_candidate_rows: 0, deduped_candidate_signals: 0, selected_room_signals: 0, core_signals: 0, vip_signals: 0, vip_only_signals: 0, comfort_signals: 0, exact_score_signals: 0, telegram_messages_attempted: 0, telegram_messages_sent: 0, by_room: {}, by_lane: {}, by_tier: {}, by_signal_type: {}, errors: [] };
  const fixtureFetch = await fetchCombined('get_fixtures', { date_start: dateStart, date_stop: dateStop });
  summary.errors.push(...fixtureFetch.errors);
  const fixtures = mergeFixtures(fixtureFetch.chunks);
  const fixturesByKey = buildFixtureMap(fixtures);
  summary.fixture_count = fixtures.length;
  const oddsFetch = await fetchCombined('get_odds', { date_start: dateStart, date_stop: dateStop });
  summary.errors.push(...oddsFetch.errors);
  const oddsResult = mergeOdds(oddsFetch.chunks);
  summary.odds_match_count = Object.keys(oddsResult).length;
  const rawRows = buildCandidateRows(oddsResult, fixturesByKey);
  const candidateSignals = dedupeSignals(rawRows);
  const selectedSignals = buildSelectedRoomSignals(candidateSignals);
  const sentRows = await routeAndSend(selectedSignals);
  summary.raw_candidate_rows = rawRows.length;
  summary.deduped_candidate_signals = candidateSignals.length;
  summary.selected_room_signals = selectedSignals.length;
  summary.core_signals = selectedSignals.filter((r) => r.telegram_room === 'Core').length;
  summary.vip_signals = selectedSignals.filter((r) => r.telegram_room === 'VIP').length;
  summary.vip_only_signals = selectedSignals.filter((r) => r.telegram_room === 'VIP' && r.access === 'VIP_ONLY').length;
  summary.comfort_signals = selectedSignals.filter((r) => r.signal_type === 'first_set_winner').length;
  summary.exact_score_signals = selectedSignals.filter((r) => r.signal_type !== 'first_set_winner').length;
  summary.telegram_messages_attempted = sentRows.length;
  summary.telegram_messages_sent = sentRows.filter((r) => r.telegram_sent === 'true').length;
  for (const r of selectedSignals) {
    summary.by_room[r.telegram_room] = (summary.by_room[r.telegram_room] || 0) + 1;
    summary.by_lane[r.strategy_lane] = (summary.by_lane[r.strategy_lane] || 0) + 1;
    summary.by_tier[r.public_tier] = (summary.by_tier[r.public_tier] || 0) + 1;
    summary.by_signal_type[r.signal_type] = (summary.by_signal_type[r.signal_type] || 0) + 1;
  }
  writeCsv(path.join(outDir, 'first_set_lab_live_raw_candidates.csv'), rawRows, fields);
  writeCsv(path.join(outDir, 'first_set_lab_live_signals.csv'), selectedSignals, selectedFields);
  writeCsv(path.join(outDir, 'first_set_lab_live_telegram_log.csv'), sentRows, sentFields);
  writeJson(path.join(outDir, 'first_set_lab_live_summary.json'), summary);
  const lines = ['# SlipIQ First Set Lab Live Scanner', '', `Generated: ${summary.generated_at}`, `Date range: ${dateStart} to ${dateStop}`, `Exact-score market: ${marketName}`, `Comfort market: ${comfortMarketName}`, `Telegram sending: ${sendTelegram ? 'ON' : 'OFF / dry-run'}`, 'Bookmaker names hidden in Telegram: yes', `Core edge daily cap: ${coreDailyCap}`, `VIP edge daily cap: ${vipDailyCap}`, `Core comfort daily cap: ${coreComfortDailyCap}`, `VIP comfort daily cap: ${vipComfortDailyCap}`, '', '## Counts', `Fixtures: ${summary.fixture_count}`, `Odds matches: ${summary.odds_match_count}`, `Raw candidate rows: ${summary.raw_candidate_rows}`, `Deduped candidate signals before room caps: ${summary.deduped_candidate_signals}`, `Selected room signals after caps: ${summary.selected_room_signals}`, `Exact-score signals: ${summary.exact_score_signals}`, `Comfort signals: ${summary.comfort_signals}`, `Core signals: ${summary.core_signals}`, `VIP signals: ${summary.vip_signals}`, `VIP-only signals: ${summary.vip_only_signals}`, `Telegram messages attempted: ${summary.telegram_messages_attempted}`, `Telegram messages sent: ${summary.telegram_messages_sent}`, '', '## Room counts', '```json', JSON.stringify(summary.by_room, null, 2), '```', '', '## Lane counts', '```json', JSON.stringify(summary.by_lane, null, 2), '```', '', '## Signal type counts', '```json', JSON.stringify(summary.by_signal_type, null, 2), '```', '', '## Signals', ...(selectedSignals.length ? selectedSignals.map((r) => `- ${r.public_tier} | ${r.telegram_room} | ${r.public_signal_name} | ${r.match_name} | ${r.tournament_name} | ${r.event_date} ${r.event_time} UTC | odds=${fmtOdds(r.selected_side_odds || r.grouped_odds)} | target=${r.public_target}`) : ['None']), '', '## Notes', 'Telegram messages intentionally hide bookmaker names. Internal CSV keeps bookmaker for paper tracking and grading.', 'Comfort signals use Home/Away (1st Set) and first_set_winner settlement logic.', 'This workflow is a probability/price-intelligence alert system, not automatic betting.', '', '## Errors', summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None'];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_live_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_live_fatal_error.json'), { generated_at: new Date().toISOString(), error: err instanceof Error ? err.stack || err.message : String(err) });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
