#!/usr/bin/env node
/*
SlipIQ / First Set Lab Supabase delivery guard.

Reads first_set_lab_live_signals.csv from the scanner artifact, upserts each signal
into Supabase, checks telegram_signal_deliveries for successful prior sends,
sends Telegram only for room deliveries that were not successfully sent before,
then writes delivery rows back to Supabase and artifact logs.

Important: dry-run rows have sent_ok=false. Those must not block a later real
send_telegram=true run. Successful sent_ok=true rows must not be overwritten by
later duplicate skips.

Supports both:
- exact_score_cluster signals
- first_set_winner comfort signals
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(process.argv.slice(2).map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const inputCsv = params.input || 'artifacts/output/api-tennis-live-first-set-lab-scanner/first_set_lab_live_signals.csv';
const outDir = params.out || 'artifacts/output/api-tennis-live-first-set-lab-scanner';
const sendTelegram = String(params['send-telegram'] ?? process.env.SEND_TELEGRAM ?? 'false').toLowerCase() === 'true';
const requireSupabaseForSend = String(params['require-supabase-for-send'] ?? process.env.REQUIRE_SUPABASE_FOR_SEND ?? 'true').toLowerCase() === 'true';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const coreChatId = process.env.TELEGRAM_CORE_CHAT_ID || '';
const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID || '';

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const clean = (v) => String(v ?? '').trim();
const nval = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const nullable = (v) => clean(v) === '' ? null : clean(v);
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch === '\r') {}
      else cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => clean(h));
  return rows.slice(1).filter((r) => r.some((c) => clean(c) !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function parseJsonField(v) {
  try {
    const s = clean(v);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function signalPayload(row) {
  return {
    signal_key: clean(row.signal_key),
    signal_type: nullable(row.signal_type) || 'exact_score_cluster',
    selected_side: nullable(row.selected_side),
    selected_side_odds: nval(row.selected_side_odds),
    market_source: nullable(row.market_source),
    scanned_at: nullable(row.scanned_at) || new Date().toISOString(),
    event_key: clean(row.event_key),
    event_date: nullable(row.event_date),
    event_time: nullable(row.event_time),
    starts_at: nullable(row.starts_at),
    minutes_to_start: nval(row.minutes_to_start),
    event_status: nullable(row.event_status),
    match_name: nullable(row.match_name),
    player1: nullable(row.player1),
    player2: nullable(row.player2),
    tour: nullable(row.tour),
    tournament_group: nullable(row.tournament_group),
    tournament_name: nullable(row.tournament_name),
    market_name: nullable(row.market_name) || 'Correct Score 1st Half',
    strategy_lane: clean(row.strategy_lane),
    public_signal_name: nullable(row.public_signal_name),
    access: clean(row.access),
    score_cluster: nullable(row.score_cluster),
    public_target: nullable(row.public_target),
    internal_bookmaker: nullable(row.internal_bookmaker),
    trigger_score: nullable(row.trigger_score),
    trigger_odds: nval(row.trigger_odds),
    score_odds_json: parseJsonField(row.score_odds_json),
    grouped_odds: nval(row.grouped_odds),
    break_even_hit_rate: nval(row.break_even_hit_rate),
    historical_hit_rate: nval(row.historical_hit_rate),
    historical_roi: nval(row.historical_roi),
    historical_sample: nval(row.historical_sample),
    model_edge_vs_breakeven: nval(row.model_edge_vs_breakeven),
    public_tier: nullable(row.public_tier),
    signal_quality: nval(row.signal_quality),
    updated_at: new Date().toISOString(),
  };
}

function formatStartWindow(minutesValue) {
  const minutes = Number(minutesValue);
  if (!Number.isFinite(minutes)) return 'n/a';
  if (minutes <= 0) return 'starting soon';
  if (minutes < 90) return `~${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins ? `~${hours}h ${mins}m` : `~${hours}h`;
}

function scoreClusterText(row) {
  const cluster = clean(row.score_cluster);
  if (cluster) return cluster.replaceAll(',', ' / ');
  const target = clean(row.public_target);
  const scores = target.match(/\b\d:\d\b/g);
  return scores && scores.length ? scores.join(' / ') : target || 'n/a';
}

function scoreBandSide(scoreText) {
  const first = (scoreText.match(/\b(\d):(\d)\b/) || []).slice(1).map(Number);
  if (first.length !== 2 || first.some((v) => !Number.isFinite(v))) return 'First-set score band';
  return first[0] > first[1] ? 'Player 1 first-set score band' : 'Player 2 first-set score band';
}

function telegramMessage(row) {
  const pct = (v) => v === null || v === undefined || v === '' ? 'n/a' : `${(Number(v) * 100).toFixed(1)}%`;
  const odds = (v) => v === null || v === undefined || v === '' ? 'n/a' : Number(v).toFixed(2);
  const edge = row.model_edge_vs_breakeven ? `${(Number(row.model_edge_vs_breakeven) * 100).toFixed(1)} pts` : 'n/a';
  const dateTime = `${row.event_date || ''} ${row.event_time || ''} UTC`.trim();
  const windowText = formatStartWindow(row.minutes_to_start);
  const tournament = row.tournament_name || row.tournament_group || 'n/a';

  if (row.signal_type === 'first_set_winner') {
    return [
      '🎾 First Set Lab — Comfort',
      '',
      `${row.match_name}`,
      `Tournament: ${tournament}`,
      `Starts: ${dateTime}`,
      `Window: ${windowText}`,
      '',
      'Signal:',
      row.public_target,
      '',
      `Price: ${odds(row.selected_side_odds || row.grouped_odds)}`,
      '',
      'Model context:',
      `Break-even: ${pct(row.break_even_hit_rate)}`,
      `Historical hit rate: ${pct(row.historical_hit_rate)}`,
      `Historical edge: +${edge}`,
      `Sample: ${row.historical_sample || 'n/a'} signals`,
      '',
      'Paper-tracked. No guarantees.',
    ].join('\n');
  }

  const scores = scoreClusterText(row);
  const signalText = scoreBandSide(scores);
  const tier = row.public_tier ? `${row.public_tier}-Tier` : 'Signal';

  return [
    `🎾 First Set Lab — ${tier}`,
    '',
    `${row.match_name}`,
    `Tournament: ${tournament}`,
    `Starts: ${dateTime}`,
    `Window: ${windowText}`,
    '',
    'Signal:',
    signalText,
    '',
    'Covered scores:',
    scores,
    '',
    `Grouped price: ${odds(row.grouped_odds)}`,
    '',
    'Model context:',
    `Break-even: ${pct(row.break_even_hit_rate)}`,
    `Historical hit rate: ${pct(row.historical_hit_rate)}`,
    `Historical edge: +${edge}`,
    `Sample: ${row.historical_sample || 'n/a'} signals`,
    '',
    'Paper-tracked. No guarantees.',
  ].join('\n');
}

async function sbFetch(tablePath, options = {}) {
  if (!supabaseUrl || !supabaseKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
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

async function upsertSignal(row) {
  const payload = signalPayload(row);
  const data = await sbFetch('live_signals?on_conflict=signal_key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  return Array.isArray(data) ? data[0] : data;
}

async function existingSuccessfulDelivery(signalId, roomKey) {
  const room = encodeURIComponent(roomKey);
  const data = await sbFetch(`telegram_signal_deliveries?select=id,telegram_message_id,sent_ok,skipped_duplicate&signal_id=eq.${signalId}&room_key=eq.${room}&sent_ok=eq.true&limit=1`, { method: 'GET' });
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function insertDelivery(signal, row, result, message) {
  const payload = {
    signal_id: signal.id,
    signal_key: signal.signal_key,
    room_key: row.telegram_room === 'Core' ? 'core' : 'vip',
    telegram_chat_id: row.telegram_room === 'Core' ? coreChatId : vipChatId,
    telegram_message_id: result?.message_id ? String(result.message_id) : null,
    sent_ok: result?.ok === true,
    skipped_duplicate: result?.skipped_duplicate === true,
    error_json: result?.ok === true ? null : result,
    message_preview: message,
  };
  const data = await sbFetch('telegram_signal_deliveries?on_conflict=signal_id,room_key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  return Array.isArray(data) ? data[0] : data;
}

async function sendTelegramMessage(chatId, text) {
  if (!telegramBotToken || !chatId) return { ok: false, skipped: true, reason: 'missing bot token or chat id' };
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok !== true) return { ok: false, status: res.status, payload };
  return { ok: true, message_id: payload.result?.message_id };
}

async function main() {
  ensureDir(outDir);
  const summary = {
    generated_at: new Date().toISOString(), input_csv: inputCsv, send_telegram: sendTelegram,
    supabase_enabled: Boolean(supabaseUrl && supabaseKey), require_supabase_for_send: requireSupabaseForSend,
    rows_read: 0, signals_upserted: 0, duplicate_deliveries_skipped: 0,
    telegram_attempted: 0, telegram_sent: 0, delivery_rows_written: 0, errors: [],
  };
  if (!fs.existsSync(inputCsv)) throw new Error(`Missing input CSV: ${inputCsv}`);
  const rows = parseCsv(fs.readFileSync(inputCsv, 'utf8'));
  summary.rows_read = rows.length;
  if (sendTelegram && requireSupabaseForSend && (!supabaseUrl || !supabaseKey)) {
    throw new Error('Refusing to send Telegram without Supabase duplicate guard. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or set REQUIRE_SUPABASE_FOR_SEND=false for testing only.');
  }
  const outRows = [];
  for (const row of rows) {
    const message = telegramMessage(row);
    const roomKey = row.telegram_room === 'Core' ? 'core' : 'vip';
    const chatId = row.telegram_room === 'Core' ? coreChatId : vipChatId;
    let signal = null;
    let delivery = null;
    let result = { ok: false, skipped: true, reason: 'SEND_TELEGRAM=false' };
    let duplicate = false;
    try {
      if (supabaseUrl && supabaseKey) {
        signal = await upsertSignal(row);
        summary.signals_upserted += 1;
        const existing = await existingSuccessfulDelivery(signal.id, roomKey);
        if (existing) {
          duplicate = true;
          result = { ok: false, skipped_duplicate: true, existing_delivery_id: existing.id, existing_message_id: existing.telegram_message_id || null };
          summary.duplicate_deliveries_skipped += 1;
          delivery = existing;
        } else if (sendTelegram) {
          summary.telegram_attempted += 1;
          result = await sendTelegramMessage(chatId, message);
          if (result.ok) summary.telegram_sent += 1;
          delivery = await insertDelivery(signal, row, result, message);
          summary.delivery_rows_written += 1;
        } else {
          delivery = await insertDelivery(signal, row, result, message);
          summary.delivery_rows_written += 1;
        }
      } else if (sendTelegram) {
        summary.telegram_attempted += 1;
        result = await sendTelegramMessage(chatId, message);
        if (result.ok) summary.telegram_sent += 1;
      }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      summary.errors.push({ signal_key: row.signal_key, room: row.telegram_room, error: result.error });
    }
    outRows.push({ ...row, room_key: roomKey, supabase_signal_id: signal?.id || '', supabase_delivery_id: delivery?.id || '', duplicate_skipped: String(duplicate), telegram_sent: String(result.ok === true), telegram_result_json: JSON.stringify(result), telegram_message_preview: message });
  }
  const fields = Object.keys(outRows[0] || { signal_key: '', telegram_room: '', telegram_sent: '' });
  writeCsv(path.join(outDir, 'first_set_lab_supabase_delivery_log.csv'), outRows, fields);
  writeJson(path.join(outDir, 'first_set_lab_supabase_delivery_summary.json'), summary);
  const lines = ['# First Set Lab Supabase Delivery Guard', '', `Generated: ${summary.generated_at}`, `Rows read: ${summary.rows_read}`, `Supabase enabled: ${summary.supabase_enabled}`, `Telegram sending: ${summary.send_telegram}`, `Signals upserted: ${summary.signals_upserted}`, `Duplicate deliveries skipped: ${summary.duplicate_deliveries_skipped}`, `Telegram attempted: ${summary.telegram_attempted}`, `Telegram sent: ${summary.telegram_sent}`, `Delivery rows written: ${summary.delivery_rows_written}`, '', '## Errors', summary.errors.length ? '```json\n' + JSON.stringify(summary.errors, null, 2) + '\n```' : 'None'];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_supabase_delivery_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_supabase_delivery_fatal_error.json'), { generated_at: new Date().toISOString(), error: err instanceof Error ? err.stack || err.message : String(err) });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
