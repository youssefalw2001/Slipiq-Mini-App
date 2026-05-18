#!/usr/bin/env node
/*
SlipIQ / First Set Lab Proof Vault Daily Recap

Sends a premium recap instead of an ugly win/loss scoreboard.

Principles:
- Paid rooms get the full honest recap.
- Free proof channel is curated marketing/proof, not the full raw scoreboard.
- No hiding or lying: public wording says paid rooms receive full live detail.
- Show today in context with rolling 7D / 30D windows.
- Use flat unit math from real stored prices.
- Use calibration notes so red days become useful information.

Room logic:
- core recap includes CORE_AND_VIP / CORE / core access signals.
- vip recap includes CORE_AND_VIP / VIP_ONLY / VIP / vip access signals.
- free proof recap is optional and only sends if TELEGRAM_FREE_CHAT_ID exists.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const outDir = params.out || 'artifacts/output/first-set-lab-daily-recap';
const lookbackHours = Number(params['lookback-hours'] || process.env.RECAP_LOOKBACK_HOURS || '24');
const rolling7Days = Number(params['rolling-7-days'] || process.env.RECAP_ROLLING_7_DAYS || '7');
const rolling30Days = Number(params['rolling-30-days'] || process.env.RECAP_ROLLING_30_DAYS || '30');
const minDetailedSettled = Number(params['min-detailed-settled'] || process.env.RECAP_MIN_DETAILED_SETTLED || '3');
const minFreeHighlightUnits = Number(params['min-free-highlight-units'] || process.env.RECAP_MIN_FREE_HIGHLIGHT_UNITS || '0');
const sendTelegram = String(params['send-telegram'] ?? process.env.SEND_TELEGRAM ?? process.env.ENABLE_LIVE_TELEGRAM_SEND ?? 'false').toLowerCase() === 'true';
const sendFreeProof = String(params['send-free-proof'] ?? process.env.SEND_FREE_PROOF_RECAP ?? 'false').toLowerCase() === 'true';

const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const coreChatId = process.env.TELEGRAM_CORE_CHAT_ID || '';
const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID || '';
const freeChatId = process.env.TELEGRAM_FREE_CHAT_ID || '';

const now = new Date();
const since24 = new Date(now.getTime() - lookbackHours * 3600 * 1000);
const since7 = new Date(now.getTime() - rolling7Days * 24 * 3600 * 1000);
const since30 = new Date(now.getTime() - rolling30Days * 24 * 3600 * 1000);

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const nval = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
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

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

async function sbFetch(tablePath, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${tablePath}`, {
    ...options,
    headers: {
      apikey: supabaseKey,
      authorization: `Bearer ${supabaseKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) throw new Error(`Supabase ${tablePath} failed ${res.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  return payload;
}

async function fetchSettledSince(since) {
  const selected = [
    'id','signal_key','signal_type','strategy_lane','public_signal_name','access','match_name','tour','tournament_group','tournament_name',
    'score_cluster','selected_side','selected_side_odds','grouped_odds','first_set_score','settled_win','settled_at','starts_at','public_target'
  ].join(',');
  const restPath = `live_signals?select=${selected}&status=eq.settled&settled_at=gte.${encodeURIComponent(since.toISOString())}&order=settled_at.asc&limit=5000`;
  return await sbFetch(restPath, { method: 'GET' });
}

async function fetchOpenSignals() {
  const selected = 'id,signal_key,signal_type,strategy_lane,access,match_name,starts_at,event_date,event_time';
  const restPath = `live_signals?select=${selected}&status=eq.open&order=starts_at.asc&limit=5000`;
  return await sbFetch(restPath, { method: 'GET' });
}

function roomIncludes(row, roomKey) {
  const access = clean(row.access).toUpperCase();
  if (roomKey === 'core') return ['CORE', 'CORE_AND_VIP'].includes(access);
  if (roomKey === 'vip') return ['VIP', 'VIP_ONLY', 'CORE_AND_VIP'].includes(access);
  if (roomKey === 'free') return false;
  return false;
}

function oddsFor(row) {
  return nval(row.selected_side_odds) || nval(row.grouped_odds);
}

function unitProfit(row) {
  const odds = oddsFor(row);
  if (!odds || odds <= 1) return 0;
  return row.settled_win === true ? odds - 1 : -1;
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [clean(row.match_name), clean(row.strategy_lane), clean(row.signal_type), clean(row.score_cluster), clean(row.selected_side)].join('|');
    const existing = map.get(key);
    if (!existing || new Date(row.settled_at || 0) < new Date(existing.settled_at || 0)) map.set(key, row);
  }
  return [...map.values()];
}

function stats(rows) {
  const settled = rows.length;
  const wins = rows.filter((r) => r.settled_win === true).length;
  const losses = rows.filter((r) => r.settled_win === false).length;
  const profit = rows.reduce((sum, r) => sum + unitProfit(r), 0);
  const avgOdds = rows.length ? rows.reduce((sum, r) => sum + (oddsFor(r) || 0), 0) / rows.length : 0;
  return { settled, wins, losses, hit_rate: settled ? wins / settled : 0, profit_units: profit, flat_roi: settled ? profit / settled : 0, avg_odds: avgOdds };
}

function fmtPct(v) { return `${(Number(v || 0) * 100).toFixed(1)}%`; }
function fmtUnits(v) { const n = Number(v || 0); const sign = n > 0 ? '+' : ''; return `${sign}${n.toFixed(2)}u`; }
function fmtOdds(v) { const n = Number(v || 0); return n ? n.toFixed(2) : 'n/a'; }
function resultWord(profitUnits, settled) {
  if (!settled) return 'Archive update';
  if (profitUnits > 0) return 'Green day archived';
  if (profitUnits < 0) return 'Red day archived';
  return 'Flat day archived';
}

function directionalMissNote(rows) {
  const exactLosses = rows.filter((r) => r.signal_type !== 'first_set_winner' && r.settled_win === false);
  let p1WinsWrongBand = 0;
  let p2WinsWrongBand = 0;
  for (const row of exactLosses) {
    const cluster = clean(row.score_cluster);
    const first = cluster.split('/').map((s) => clean(s)).find(Boolean) || '';
    const targetP1 = /^([67]):/.test(first);
    const targetP2 = /:([67])$/.test(first);
    const score = clean(row.first_set_score);
    const actualP1 = /^([67]):/.test(score);
    const actualP2 = /:([67])$/.test(score);
    if (targetP1 && actualP1) p1WinsWrongBand += 1;
    if (targetP2 && actualP2) p2WinsWrongBand += 1;
  }
  const total = p1WinsWrongBand + p2WinsWrongBand;
  if (total > 0) return `${total} exact-score losses were directionally close: set winner matched the lane, but the final score landed outside the covered band.`;
  if (exactLosses.length > 0) return 'Exact-score variance logged. No filter change is triggered from one recap window alone.';
  return 'No major exact-score variance note in this window.';
}

function compactLines(label, s) {
  return [`${label}: ${fmtUnits(s.profit_units)}`, `${s.wins}W / ${s.losses}L | Hit: ${fmtPct(s.hit_rate)} | Avg price: ${fmtOdds(s.avg_odds)}`];
}

function paidMessage(roomName, todayRows, rows7, rows30, openCount) {
  const today = stats(todayRows);
  const seven = stats(rows7);
  const thirty = stats(rows30);
  const header = resultWord(today.profit_units, today.settled);
  const enough = today.settled >= minDetailedSettled;
  const note = enough ? directionalMissNote(todayRows) : 'Small settlement sample today. Results archived; rolling context matters more than one low-volume window.';

  return [
    '🎾 First Set Lab — Proof Vault Update', '', header, '',
    'Settled window:', `${today.settled} signals archived`, `${today.wins} wins / ${today.losses} losses`, `Flat result: ${fmtUnits(today.profit_units)}`, today.settled ? `Avg price: ${fmtOdds(today.avg_odds)}` : 'Avg price: n/a', '',
    'Rolling context:', ...compactLines('7D', seven), ...compactLines('30D', thirty), '',
    `Open signals still tracking: ${openCount}`, '',
    'Calibration note:', note, '',
    'No deleted signals. No guarantees. Calibration continues.',
  ].join('\n');
}

function bestPublicProofRows(rows) {
  return [...rows]
    .filter((r) => r.settled_win === true)
    .sort((a, b) => unitProfit(b) - unitProfit(a))
    .slice(0, 2);
}

function freeMessage(todayRows, rows7, openCount) {
  const today = stats(todayRows);
  const seven = stats(rows7);
  const highlights = bestPublicProofRows(todayRows.length ? todayRows : rows7);
  const greenToday = today.settled > 0 && today.profit_units >= minFreeHighlightUnits;
  const greenSeven = seven.settled > 0 && seven.profit_units > 0;

  if (greenToday || greenSeven || highlights.length) {
    const proofLines = highlights.length
      ? highlights.flatMap((r, i) => [
          `${i + 1}. ${clean(r.match_name) || 'Archived signal'}`,
          `   Market: ${r.signal_type === 'first_set_winner' ? 'First-set winner' : 'First-set score band'}`,
          `   Result: WIN | Price: ${fmtOdds(oddsFor(r))}`,
        ])
      : ['Historical archive updated. Highlight examples will post as stronger settled samples build.'];

    return [
      '🎾 First Set Lab — Public Proof Vault', '',
      'Proof highlight archived.', '',
      ...proofLines, '',
      'Public vault context:',
      `Signals archived in the last ${lookbackHours}h: ${today.settled}`,
      `Rolling 7D flat result: ${fmtUnits(seven.profit_units)}`,
      `Open signals still tracking: ${openCount}`, '',
      'Free channel shows curated proof, education, and delayed examples. Core / Quant receive live private signals and full recap detail.', '',
      'No deleted signals. No guarantees. 18+ decision-support only.',
    ].join('\n');
  }

  return [
    '🎾 First Set Lab — Research Vault Update', '',
    'No public highlight posted from this recap window.', '',
    'Why:',
    'The free channel is curated for education, delayed proof, and strong public examples — not every raw live result.', '',
    `Signals archived in the last ${lookbackHours}h: ${today.settled}`,
    `Open signals still tracking: ${openCount}`, '',
    'Core / Quant receive the full live signal feed and complete Proof Vault recap.', '',
    'No deleted signals. No guarantees. Calibration continues.',
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

async function main() {
  ensureDir(outDir);
  const all24 = dedupeRows(await fetchSettledSince(since24));
  const all7 = dedupeRows(await fetchSettledSince(since7));
  const all30 = dedupeRows(await fetchSettledSince(since30));
  const open = await fetchOpenSignals();

  const rooms = [{ key: 'core', name: 'Core Terminal', chatId: coreChatId }, { key: 'vip', name: 'Quant Terminal', chatId: vipChatId }];
  if (sendFreeProof && freeChatId) rooms.push({ key: 'free', name: 'Free Proof', chatId: freeChatId });

  const outputs = [];
  const summary = { generated_at: now.toISOString(), send_telegram: sendTelegram, send_free_proof: sendFreeProof, lookback_hours: lookbackHours, all_settled_24h: all24.length, all_settled_7d: all7.length, all_settled_30d: all30.length, all_open: open.length, rooms: {}, telegram_sent: 0, errors: [] };

  for (const room of rooms) {
    const todayRows = room.key === 'free' ? all24 : all24.filter((r) => roomIncludes(r, room.key));
    const rows7 = room.key === 'free' ? all7 : all7.filter((r) => roomIncludes(r, room.key));
    const rows30 = room.key === 'free' ? all30 : all30.filter((r) => roomIncludes(r, room.key));
    const openCount = room.key === 'free' ? open.length : open.filter((r) => roomIncludes(r, room.key)).length;
    const message = room.key === 'free' ? freeMessage(todayRows, rows7, openCount) : paidMessage(room.name, todayRows, rows7, rows30, openCount);
    let result = { ok: false, skipped: true, reason: 'SEND_TELEGRAM=false' };
    if (sendTelegram) {
      result = await sendTelegramMessage(room.chatId, message);
      if (result.ok) summary.telegram_sent += 1;
      if (!result.ok) summary.errors.push({ room: room.key, result });
    }
    summary.rooms[room.key] = { name: room.name, chat_configured: Boolean(room.chatId), settled_24h: todayRows.length, stats_24h: stats(todayRows), stats_7d: stats(rows7), stats_30d: stats(rows30), open_count: openCount, telegram_result: result };
    outputs.push({ room_key: room.key, room_name: room.name, message, telegram_sent: String(result.ok === true), telegram_result_json: JSON.stringify(result) });
  }

  writeJson(path.join(outDir, 'first_set_lab_daily_recap_summary.json'), summary);
  writeCsv(path.join(outDir, 'first_set_lab_daily_recap_messages.csv'), outputs, ['room_key','room_name','message','telegram_sent','telegram_result_json']);
  const lines = ['# First Set Lab Daily Proof Vault Recap', '', `Generated: ${summary.generated_at}`, `Telegram sending: ${summary.send_telegram}`, `Settled 24h: ${summary.all_settled_24h}`, `Settled 7D: ${summary.all_settled_7d}`, `Settled 30D: ${summary.all_settled_30d}`, `Open signals: ${summary.all_open}`, `Telegram sent: ${summary.telegram_sent}`, '', '## Messages', ...outputs.flatMap((o) => [`### ${o.room_name}`, '```text', o.message, '```', '']), '## Errors', summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None'];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_daily_recap_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_daily_recap_fatal_error.json'), { generated_at: new Date().toISOString(), error: err instanceof Error ? err.stack || err.message : String(err) });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
