#!/usr/bin/env node
/*
SlipIQ / First Set Lab live scanner.

Scans API Tennis first-set correct-score odds, builds Core/VIP signals,
hides bookmaker names in Telegram, and stores bookmaker internally in artifacts.
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
const eventTypeKeys = (params['event-type-keys'] || process.env.API_TENNIS_EVENT_TYPE_KEYS || '265,266').split(',').map((s) => s.trim()).filter(Boolean);
const maxMinutesToStart = Number(params['max-minutes-to-start'] ?? process.env.MAX_MINUTES_TO_START ?? '2160');
const minMinutesToStart = Number(params['min-minutes-to-start'] ?? process.env.MIN_MINUTES_TO_START ?? '0');
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
const pct = (v) => `${(v * 100).toFixed(1)}%`;
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
    CORE_P1_ATP_GS_BET365: { hit: 0.4321, roi: 0.2764, sample: 162 },
    VIP_P1_ATP_GS_MULTI: { hit: 0.4188, roi: 0.2072, sample: 320 },
    VIP_P1_MIRROR_WTA_OTHER: { hit: 0.4704, roi: 0.2144, sample: 270 },
    VIP_P2_V3_SHAPE: { hit: 0.5758, roi: 0.3432, sample: 99 },
  };
  return stats[laneKey] || { hit: null, roi: null, sample: 0 };
}

const lanes = [
  {
    key: 'CORE_P1_ATP_GS_BET365', access: 'CORE_AND_VIP', books: ['bet365'], scores: ['6:3', '6:4'],
    sideText: 'Player 1 wins first set 6:3 or 6:4', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25,
    minGrouped: 2.50, tierFloorA: 2.50, tierFloorS: 3.10, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', publicLabel: 'Core Cluster'
  },
  {
    key: 'VIP_P1_ATP_GS_MULTI', access: 'VIP_ONLY', books: ['bet365', '1xBet', '10Bet'], scores: ['6:3', '6:4'],
    sideText: 'Player 1 wins first set 6:3 or 6:4', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 6.25,
    minGrouped: 2.60, tierFloorA: 2.60, tierFloorS: 3.10, tour: 'ATP', tournamentGroup: 'GRAND_SLAM', publicLabel: 'Core Cluster Plus'
  },
  {
    key: 'VIP_P1_MIRROR_WTA_OTHER', access: 'VIP_ONLY', books: ['bet365', '1xBet'], scores: ['6:3', '6:4', '7:5'],
    sideText: 'Player 1 wins first set 6:3, 6:4, or 7:5', triggerScore: '6:4', triggerMin: 5.00, triggerMax: 8.00,
    minGrouped: 2.30, tierFloorA: 2.35, tierFloorS: 2.60, tour: 'WTA', tournamentGroup: 'OTHER_TOUR', publicLabel: 'Mirror Cluster'
  },
  {
    key: 'VIP_P2_V3_SHAPE', access: 'VIP_ONLY', books: ['bet365', '1xBet', '10Bet'], scores: ['3:6', '4:6', '5:7'],
    sideText: 'Player 2 wins first set 6:3, 6:4, or 7:5', triggerScore: '4:6', triggerMin: 6.25, triggerMax: 6.99,
    minGrouped: 3.05, tierFloorA: 3.20, tierFloorS: 3.30, tour: 'ANY', tournamentGroup: 'ANY', publicLabel: 'V3 Cluster'
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
function buildCandidateRows(oddsResult, fixturesByKey) {
  const rows = [];
  for (const [matchKey, matchOdds] of Object.entries(oddsResult)) {
    const fixture = fixturesByKey.get(String(matchKey)) || {};
    const market = matchOdds?.[marketName];
    if (!market || typeof market !== 'object') continue;
    const tour = tourFromFixture(fixture);
    const tGroup = tournamentGroup(fixture);
    const mins = minutesToStart(fixture);
    if (mins === null || mins < minMinutesToStart || mins > maxMinutesToStart) continue;
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
          scanned_at: new Date().toISOString(), event_key: String(matchKey), starts_at: startsAtIso(fixture) || '',
          event_date: clean(fixture.event_date), event_time: clean(fixture.event_time), minutes_to_start: mins,
          event_status: eventStatus(fixture), player1: clean(fixture.event_first_player), player2: clean(fixture.event_second_player),
          match_name: matchName(fixture), tour, tournament_group: tGroup, tournament_name: clean(fixture.tournament_name),
          internal_bookmaker: book, market_name: marketName, strategy_lane: lane.key, public_signal_name: lane.publicLabel,
          access: lane.access, score_cluster: lane.scores.join('/'), public_target: lane.sideText, trigger_score: lane.triggerScore,
          trigger_odds: triggerOdds, score_odds_json: JSON.stringify(Object.fromEntries(lane.scores.map((s, i) => [s, odds[i]]))),
          grouped_odds: grouped, break_even_hit_rate: be, historical_hit_rate: hist.hit, historical_roi: hist.roi,
          historical_sample: hist.sample, model_edge_vs_breakeven: edge, public_tier: tier,
        };
        row.signal_key = [row.event_key, row.strategy_lane, row.access, row.score_cluster, row.public_tier].join(':');
        rows.push(row);
      }
    }
  }
  return rows;
}
function dedupeSignals(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.event_key, r.strategy_lane, r.access, r.score_cluster].join(':');
    const prev = groups.get(key);
    if (!prev || Number(r.grouped_odds) > Number(prev.grouped_odds)) groups.set(key, r);
  }
  return [...groups.values()].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || Number(b.grouped_odds) - Number(a.grouped_odds));
}
function telegramMessage(row, roomName) {
  const be = row.break_even_hit_rate ? pct(row.break_even_hit_rate) : 'n/a';
  const hist = row.historical_hit_rate ? pct(row.historical_hit_rate) : 'n/a';
  const edge = row.model_edge_vs_breakeven !== null && row.model_edge_vs_breakeven !== undefined ? `${(row.model_edge_vs_breakeven * 100).toFixed(1)} pts` : 'n/a';
  const dateTime = `${row.event_date || ''} ${row.event_time || ''} UTC`.trim();
  const mins = row.minutes_to_start !== null && row.minutes_to_start !== undefined ? `${row.minutes_to_start} min` : 'n/a';
  return [
    `🎾 SlipIQ First Set Lab ${row.public_tier}-Tier`, '', `Room: ${roomName}`, `Signal: ${row.public_signal_name}`,
    `Match: ${row.match_name}`, `Tournament: ${row.tournament_name || row.tournament_group}`, `Start: ${dateTime}`,
    `Time to start: ${mins}`, '', 'Target Cluster:', row.public_target, '', `Grouped Odds: ${fmtOdds(row.grouped_odds)}`,
    `Break-even: ${be}`, `Historical Hit Rate: ${hist}`, `Historical Edge: +${edge}`, `Historical Sample: ${row.historical_sample || 'n/a'} signals`, '',
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
async function routeAndSend(rows) {
  const sent = [];
  for (const row of rows) {
    const targets = row.access === 'CORE_AND_VIP' ? [{ room: 'Core', chatId: coreChatId }, { room: 'VIP', chatId: vipChatId }] : [{ room: 'VIP', chatId: vipChatId }];
    for (const target of targets) {
      const message = telegramMessage(row, target.room);
      let result = { ok: false, skipped: true, reason: 'SEND_TELEGRAM=false' };
      if (sendTelegram) result = await sendTelegramMessage(target.chatId, message);
      sent.push({ ...row, telegram_room: target.room, telegram_sent: String(result.ok === true), telegram_result_json: JSON.stringify(result), telegram_message_preview: message });
    }
  }
  return sent;
}

const fields = ['scanned_at', 'signal_key', 'event_key', 'starts_at', 'event_date', 'event_time', 'minutes_to_start', 'event_status', 'player1', 'player2', 'match_name', 'tour', 'tournament_group', 'tournament_name', 'internal_bookmaker', 'market_name', 'strategy_lane', 'public_signal_name', 'access', 'score_cluster', 'public_target', 'trigger_score', 'trigger_odds', 'score_odds_json', 'grouped_odds', 'break_even_hit_rate', 'historical_hit_rate', 'historical_roi', 'historical_sample', 'model_edge_vs_breakeven', 'public_tier'];
const sentFields = [...fields, 'telegram_room', 'telegram_sent', 'telegram_result_json', 'telegram_message_preview'];

async function main() {
  ensureDir(outDir);
  const summary = { generated_at: new Date().toISOString(), date_start: dateStart, date_stop: dateStop, market_name: marketName, send_telegram: sendTelegram, bookmaker_names_hidden_in_telegram: true, min_minutes_to_start: minMinutesToStart, max_minutes_to_start: maxMinutesToStart, fixture_count: 0, odds_match_count: 0, raw_candidate_rows: 0, deduped_signals: 0, core_signals: 0, vip_only_signals: 0, telegram_messages_attempted: 0, telegram_messages_sent: 0, by_lane: {}, by_tier: {}, errors: [] };
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
  const signals = dedupeSignals(rawRows);
  const sentRows = await routeAndSend(signals);
  summary.raw_candidate_rows = rawRows.length;
  summary.deduped_signals = signals.length;
  summary.core_signals = signals.filter((r) => r.access === 'CORE_AND_VIP').length;
  summary.vip_only_signals = signals.filter((r) => r.access === 'VIP_ONLY').length;
  summary.telegram_messages_attempted = sentRows.length;
  summary.telegram_messages_sent = sentRows.filter((r) => r.telegram_sent === 'true').length;
  for (const r of signals) {
    summary.by_lane[r.strategy_lane] = (summary.by_lane[r.strategy_lane] || 0) + 1;
    summary.by_tier[r.public_tier] = (summary.by_tier[r.public_tier] || 0) + 1;
  }
  writeCsv(path.join(outDir, 'first_set_lab_live_raw_candidates.csv'), rawRows, fields);
  writeCsv(path.join(outDir, 'first_set_lab_live_signals.csv'), signals, fields);
  writeCsv(path.join(outDir, 'first_set_lab_live_telegram_log.csv'), sentRows, sentFields);
  writeJson(path.join(outDir, 'first_set_lab_live_summary.json'), summary);
  const lines = ['# SlipIQ First Set Lab Live Scanner', '', `Generated: ${summary.generated_at}`, `Date range: ${dateStart} to ${dateStop}`, `Market: ${marketName}`, `Telegram sending: ${sendTelegram ? 'ON' : 'OFF / dry-run'}`, 'Bookmaker names hidden in Telegram: yes', '', '## Counts', `Fixtures: ${summary.fixture_count}`, `Odds matches: ${summary.odds_match_count}`, `Raw candidate rows: ${summary.raw_candidate_rows}`, `Deduped public signals: ${summary.deduped_signals}`, `Core signals: ${summary.core_signals}`, `VIP-only signals: ${summary.vip_only_signals}`, `Telegram messages attempted: ${summary.telegram_messages_attempted}`, `Telegram messages sent: ${summary.telegram_messages_sent}`, '', '## Lane counts', '```json', JSON.stringify(summary.by_lane, null, 2), '```', '', '## Signals', ...(signals.length ? signals.map((r) => `- ${r.public_tier} | ${r.access} | ${r.public_signal_name} | ${r.match_name} | ${r.tournament_name} | ${r.event_date} ${r.event_time} UTC | grouped=${fmtOdds(r.grouped_odds)} | target=${r.public_target}`) : ['None']), '', '## Notes', 'Telegram messages intentionally hide bookmaker names. Internal CSV keeps bookmaker for paper tracking and grading.', 'This workflow is a probability/price-intelligence alert system, not automatic betting.', '', '## Errors', summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None'];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_live_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_live_fatal_error.json'), { generated_at: new Date().toISOString(), error: err instanceof Error ? err.stack || err.message : String(err) });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
