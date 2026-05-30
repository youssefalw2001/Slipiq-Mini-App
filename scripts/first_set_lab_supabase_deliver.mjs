#!/usr/bin/env node
/*
SlipIQ / First Set Lab Supabase delivery guard.

Purpose:
- Upsert live scanner signals into Supabase.
- Send only allowed customer-facing Telegram alerts.
- Keep RESEARCH_ONLY and paused books in Supabase for shadow tracking.
- Suppress duplicate executable Telegram messages inside the same room.

Current customer-facing rules:
- RESEARCH_ONLY: Supabase only, no Telegram.
- Paused books: Supabase only, no Telegram. Default paused book is 1xBet.
- Same room + event + market type + book + target = one Telegram alert.
- Raw VIP Booster v1 staking guidance is display-only: 1u grouped base, plus 0.5u pocket booster only when a pocket flag fires.
- 0.75u booster is tracker-only and is not promoted in live signal copy.
*/

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const inputCsv = params.input || 'artifacts/output/api-tennis-live-first-set-lab-scanner/first_set_lab_live_signals.csv';
const outDir = params.out || 'artifacts/output/api-tennis-live-first-set-lab-scanner';
const sendTelegram = String(params['send-telegram'] ?? process.env.SEND_TELEGRAM ?? 'false').toLowerCase() === 'true';
const requireSupabaseForSend = String(params['require-supabase-for-send'] ?? process.env.REQUIRE_SUPABASE_FOR_SEND ?? 'true').toLowerCase() === 'true';
const pausedTelegramBooks = new Set(
  String(process.env.PAUSE_TELEGRAM_BOOKS || '1xBet')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const coreChatId = process.env.TELEGRAM_CORE_CHAT_ID || '';
const vipChatId = process.env.TELEGRAM_VIP_CHAT_ID || '';

const clean = (v) => String(v ?? '').trim();
const nullable = (v) => (clean(v) === '' ? null : clean(v));
const nval = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const csvEscape = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const writeJson = (filePath, data) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};
const writeCsv = (filePath, rows, fields) => {
  ensureDir(path.dirname(filePath));
  const lines = [fields.join(',')];
  for (const row of rows) lines.push(fields.map((field) => csvEscape(row[field])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => clean(h));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => clean(c) !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function parseJsonField(value) {
  try {
    if (value && typeof value === 'object') return value;
    const s = clean(value);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function roomKeyForRow(row) {
  if (row.telegram_room === 'Core') return 'core';
  if (row.telegram_room === 'VIP') return 'vip';
  return 'research';
}

function isResearchOnly(row) {
  return clean(row.access) === 'RESEARCH_ONLY' || clean(row.telegram_room) === 'Research';
}

function isPausedBookForTelegram(row) {
  return pausedTelegramBooks.has(clean(row.internal_bookmaker).toLowerCase());
}

function executionTarget(row) {
  return clean(row.score_cluster) || clean(row.selected_side) || clean(row.public_target) || 'target';
}

function executionKey(row) {
  return [
    roomKeyForRow(row),
    clean(row.event_key),
    clean(row.signal_type) || 'exact_score_cluster',
    clean(row.market_name) || clean(row.market_source) || 'market',
    clean(row.internal_bookmaker) || 'book',
    executionTarget(row),
  ].join(':');
}

function signalPayload(row) {
  const proofKey = clean(row.customer_proof_key) || clean(row.signal_key);
  return {
    signal_key: clean(row.signal_key),
    customer_proof_key: proofKey || null,
    scanner_signal_version: nullable(row.scanner_signal_version),
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

function scoreOddsMap(row) {
  return parseJsonField(row.score_odds_json) || {};
}

function exactScoreOdds(row, score) {
  const scoreMap = scoreOddsMap(row);
  const fromJson = Number(scoreMap[score]);
  if (Number.isFinite(fromJson) && fromJson > 1) return fromJson;
  const direct = Number(row[`odds_${score.replace(':', '_')}`]);
  return Number.isFinite(direct) && direct > 1 ? direct : 0;
}

function marketSkewBucket(row) {
  const scoreMap = scoreOddsMap(row);
  return clean(scoreMap.market_skew_bucket || row.market_skew_bucket || 'UNKNOWN_OR_NONE') || 'UNKNOWN_OR_NONE';
}

function boosterBucket(row) {
  const lane = clean(row.strategy_lane);
  if (lane === 'RESEARCH_P2_GS_26_46_BET365') return 'RESEARCH_P2_SNIPER';
  if (lane === 'VIP_P2_V3_SHAPE') return 'OTHER';
  return 'MAIN';
}

function vipPocketHits(row) {
  const bucket = boosterBucket(row);
  const skew = marketSkewBucket(row);
  const lane = clean(row.strategy_lane);
  const o63 = exactScoreOdds(row, '6:3');
  const o64 = exactScoreOdds(row, '6:4');
  const o26 = exactScoreOdds(row, '2:6');
  const o62 = exactScoreOdds(row, '6:2');
  const pockets = [];

  if (bucket === 'MAIN' && skew === 'MID' && o63 >= 4.0 && o63 <= 5.5) {
    pockets.push({ key: 'A_63_MAIN_MID', score: '6:3', odds: o63 });
  }
  if (bucket === 'MAIN' && skew === 'UNKNOWN_OR_NONE' && o64 > 5.5 && o64 <= 7.5) {
    pockets.push({ key: 'B_64_MAIN_NONE', score: '6:4', odds: o64 });
  }
  if (lane === 'RESEARCH_P2_GS_26_46_BET365' && skew === 'EXTREME' && o26 > 10.0) {
    pockets.push({ key: 'C_26_P2_SNIPER', score: '2:6', odds: o26 });
  }
  if (bucket === 'MAIN' && skew === 'HIGH' && o64 >= 4.0 && o64 <= 5.5) {
    pockets.push({ key: 'D_64_MAIN_HIGH', score: '6:4', odds: o64 });
  }
  if (bucket === 'MAIN' && skew === 'HIGH' && o62 > 7.5 && o62 <= 10.0) {
    pockets.push({ key: 'E_62_MAIN_HIGH', score: '6:2', odds: o62 });
  }
  return pockets.filter((p) => p.odds && p.odds > 1);
}

function stakingPlanLines(row, oddsFormatter) {
  const pockets = vipPocketHits(row);
  const lines = [
    'Execution plan:',
    'Base grouped stake: 1.0u',
  ];
  if (!pockets.length) {
    lines.push('Pocket booster: none fired');
    lines.push('Aggressive tracker: n/a');
    return lines;
  }
  const pocketText = pockets.map((p) => `${p.score} @ ${oddsFormatter(p.odds)}`).join(' / ');
  lines.push(`Active pocket booster: +0.5u on ${pocketText}`);
  lines.push('Aggressive tracker only: +0.75u on same pocket, not active yet');
  return lines;
}

function telegramMessage(row) {
  const pct = (v) => (v === null || v === undefined || v === '' ? 'n/a' : `${(Number(v) * 100).toFixed(1)}%`);
  const odds = (v) => (v === null || v === undefined || v === '' ? 'n/a' : Number(v).toFixed(2));
  const rawEdge = nval(row.model_edge_vs_breakeven);
  const edge = rawEdge === null ? 'n/a' : `${rawEdge >= 0 ? '+' : ''}${(rawEdge * 100).toFixed(1)} pts`;
  const dateTime = `${row.event_date || ''} ${row.event_time || ''} UTC`.trim();
  const tournament = row.tournament_name || row.tournament_group || 'n/a';
  const windowText = formatStartWindow(row.minutes_to_start);

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
      `Historical edge: ${edge}`,
      `Sample: ${row.historical_sample || 'n/a'} signals`,
      '',
      'Paper-tracked. No guarantees.',
    ].join('\n');
  }

  const scores = scoreClusterText(row);
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
    scoreBandSide(scores),
    '',
    'Covered scores:',
    scores,
    '',
    `Grouped price: ${odds(row.grouped_odds)}`,
    '',
    ...stakingPlanLines(row, odds),
    '',
    'Model context:',
    `Break-even: ${pct(row.break_even_hit_rate)}`,
    `Historical hit rate: ${pct(row.historical_hit_rate)}`,
    `Historical edge: ${edge}`,
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
  const data = await sbFetch('live_signals?on_conflict=signal_key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(signalPayload(row)),
  });
  return Array.isArray(data) ? data[0] : data;
}

async function existingSuccessfulDelivery(signalId, roomKey) {
  const room = encodeURIComponent(roomKey);
  const data = await sbFetch(
    `telegram_signal_deliveries?select=id,telegram_message_id,sent_ok,skipped_duplicate&signal_id=eq.${signalId}&room_key=eq.${room}&sent_ok=eq.true&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function insertDelivery(signal, row, result, message) {
  const payload = {
    signal_id: signal.id,
    signal_key: signal.signal_key,
    room_key: roomKeyForRow(row),
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
  const res = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
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
    generated_at: new Date().toISOString(),
    input_csv: inputCsv,
    send_telegram: sendTelegram,
    paused_telegram_books: [...pausedTelegramBooks],
    supabase_enabled: Boolean(supabaseUrl && supabaseKey),
    require_supabase_for_send: requireSupabaseForSend,
    rows_read: 0,
    signals_upserted: 0,
    research_signals_upserted: 0,
    research_delivery_skipped: 0,
    paused_book_delivery_skipped: 0,
    duplicate_deliveries_skipped: 0,
    duplicate_executions_suppressed: 0,
    telegram_attempted: 0,
    telegram_sent: 0,
    delivery_rows_written: 0,
    errors: [],
  };

  if (!fs.existsSync(inputCsv)) throw new Error(`Missing input CSV: ${inputCsv}`);
  const rows = parseCsv(fs.readFileSync(inputCsv, 'utf8'));
  summary.rows_read = rows.length;

  if (sendTelegram && requireSupabaseForSend && (!supabaseUrl || !supabaseKey)) {
    throw new Error('Refusing to send Telegram without Supabase duplicate guard. Configure Supabase secrets or disable REQUIRE_SUPABASE_FOR_SEND for testing only.');
  }

  const outRows = [];
  const seenExecutionKeys = new Set();

  for (const row of rows) {
    const researchOnly = isResearchOnly(row);
    const pausedBook = isPausedBookForTelegram(row);
    const roomKey = roomKeyForRow(row);
    const execKey = executionKey(row);
    const message = researchOnly || pausedBook ? '' : telegramMessage(row);
    const chatId = row.telegram_room === 'Core' ? coreChatId : row.telegram_room === 'VIP' ? vipChatId : '';

    let signal = null;
    let delivery = null;
    let duplicate = false;
    let executionDuplicate = false;
    let result = { ok: false, skipped: true, reason: 'SEND_TELEGRAM=false' };

    try {
      if (supabaseUrl && supabaseKey) {
        signal = await upsertSignal(row);
        summary.signals_upserted += 1;

        if (researchOnly) {
          summary.research_signals_upserted += 1;
          summary.research_delivery_skipped += 1;
          result = { ok: false, skipped: true, reason: 'RESEARCH_ONLY_SUPABASE_ONLY' };
        } else if (pausedBook) {
          summary.paused_book_delivery_skipped += 1;
          result = { ok: false, skipped: true, reason: 'PAUSED_BOOK_SUPABASE_ONLY', book: clean(row.internal_bookmaker) };
        } else if (seenExecutionKeys.has(execKey)) {
          executionDuplicate = true;
          summary.duplicate_executions_suppressed += 1;
          result = { ok: false, skipped_duplicate: true, reason: 'DUPLICATE_EXECUTABLE_SIGNAL_IN_ROOM', execution_key: execKey };
        } else {
          seenExecutionKeys.add(execKey);
          const existing = await existingSuccessfulDelivery(signal.id, roomKey);
          if (existing) {
            duplicate = true;
            summary.duplicate_deliveries_skipped += 1;
            delivery = existing;
            result = { ok: false, skipped_duplicate: true, existing_delivery_id: existing.id, existing_message_id: existing.telegram_message_id || null };
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
        }
      } else if (sendTelegram && !researchOnly && !pausedBook) {
        if (seenExecutionKeys.has(execKey)) {
          executionDuplicate = true;
          summary.duplicate_executions_suppressed += 1;
          result = { ok: false, skipped_duplicate: true, reason: 'DUPLICATE_EXECUTABLE_SIGNAL_IN_ROOM', execution_key: execKey };
        } else {
          seenExecutionKeys.add(execKey);
          summary.telegram_attempted += 1;
          result = await sendTelegramMessage(chatId, message);
          if (result.ok) summary.telegram_sent += 1;
        }
      }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      summary.errors.push({ signal_key: row.signal_key, room: row.telegram_room, error: result.error });
    }

    outRows.push({
      ...row,
      execution_key: execKey,
      room_key: roomKey,
      supabase_signal_id: signal?.id || '',
      supabase_delivery_id: delivery?.id || '',
      duplicate_skipped: String(duplicate),
      execution_duplicate_suppressed: String(executionDuplicate),
      paused_book_delivery_skipped: String(pausedBook && !researchOnly),
      telegram_sent: String(result.ok === true),
      telegram_result_json: JSON.stringify(result),
      telegram_message_preview: message,
    });
  }

  const fields = Object.keys(outRows[0] || { signal_key: '', telegram_room: '', telegram_sent: '' });
  writeCsv(path.join(outDir, 'first_set_lab_supabase_delivery_log.csv'), outRows, fields);
  writeJson(path.join(outDir, 'first_set_lab_supabase_delivery_summary.json'), summary);

  const lines = [
    '# First Set Lab Supabase Delivery Guard',
    '',
    `Generated: ${summary.generated_at}`,
    `Rows read: ${summary.rows_read}`,
    `Supabase enabled: ${summary.supabase_enabled}`,
    `Telegram sending: ${summary.send_telegram}`,
    `Paused Telegram books: ${summary.paused_telegram_books.join(', ') || 'none'}`,
    `Signals upserted: ${summary.signals_upserted}`,
    `Research signals upserted: ${summary.research_signals_upserted}`,
    `Research deliveries skipped: ${summary.research_delivery_skipped}`,
    `Paused book deliveries skipped: ${summary.paused_book_delivery_skipped}`,
    `Duplicate delivery rows skipped: ${summary.duplicate_deliveries_skipped}`,
    `Duplicate executable signals suppressed: ${summary.duplicate_executions_suppressed}`,
    `Telegram attempted: ${summary.telegram_attempted}`,
    `Telegram sent: ${summary.telegram_sent}`,
    `Delivery rows written: ${summary.delivery_rows_written}`,
    '',
    '## Errors',
    summary.errors.length ? `\`\`\`json\n${JSON.stringify(summary.errors, null, 2)}\n\`\`\`` : 'None',
  ];
  fs.writeFileSync(path.join(outDir, 'first_set_lab_supabase_delivery_report.md'), lines.join('\n'), 'utf8');
}

main().catch((err) => {
  ensureDir(outDir);
  writeJson(path.join(outDir, 'first_set_lab_supabase_delivery_fatal_error.json'), {
    generated_at: new Date().toISOString(),
    error: err instanceof Error ? err.stack || err.message : String(err),
  });
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(2);
});
