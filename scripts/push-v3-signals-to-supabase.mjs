#!/usr/bin/env node
/*!
 * Push SlipIQ V3 scanner candidates into Supabase and optionally Telegram.
 *
 * Read-only odds source. This does not place bets.
 */

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const inputDir = params.input || 'artifacts/output/oddsportal-upcoming-firstset';
const summaryPath = params.summary || path.join(inputDir, 'upcoming_firstset_summary.json');
const dryRun = String(params['dry-run'] || '').toLowerCase() === 'true';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

// Supabase REST exposes the public schema by default. These REST-facing tables
// are protected with RLS and service_role-only policies.
const SIGNAL_TABLE = 'private_v3_signal_log';
const PRICE_CHECK_TABLE = 'private_v3_price_checks';

function requiredEnvReady() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' UTC', 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function p2Name(row) {
  return row.away_team || row.player2 || row.player_two || '';
}

function p1Name(row) {
  return row.home_team || row.player1 || row.player_one || '';
}

function matchName(row) {
  const p1 = p1Name(row);
  const p2 = p2Name(row);
  return p1 && p2 ? `${p1} vs ${p2}` : row.match_name || row.match || 'Unknown match';
}

function classifySignal(row) {
  const grouped = asNumber(row.estimated_player2_9_12_odds ?? row.reconstructed_p2_9_12_odds ?? row.direct_p2_9_12_odds);
  if (!grouped || grouped < 3.3) return 'REJECT';

  // Final V3 operating bands:
  // 3.30-3.49 = playable, 3.50-4.50 = official target,
  // 4.50-6.99 = aggressive expansion, 7.00+ = longshot/watchlist.
  if (grouped >= 7.0) return 'WATCHLIST_LONGSHOT';
  if (grouped >= 4.5) return 'AGGRESSIVE_V3_TARGET';
  if (grouped >= 3.5) return 'OFFICIAL_V3_TARGET';
  return 'OFFICIAL_V3_PLAYABLE';
}

function playStatusFromClass(signalClass) {
  if (signalClass === 'OFFICIAL_V3_TARGET') return 'TARGET';
  if (signalClass === 'OFFICIAL_V3_PLAYABLE') return 'PLAYABLE';
  if (signalClass === 'AGGRESSIVE_V3_TARGET') return 'AGGRESSIVE';
  if (signalClass === 'WATCHLIST_LONGSHOT') return 'WATCHLIST';
  return 'REJECT';
}

function centsStake(bankroll = 5000, fraction = 0.0025) {
  return Math.round(bankroll * fraction * 100) / 100;
}

async function supabaseRequest(method, route, body) {
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${route} failed ${res.status}: ${text}`);
  }
  return data;
}

async function sendTelegram(message) {
  if (!telegramBotToken || !telegramChatId) return { skipped: true, reason: 'missing telegram env' };
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: telegramChatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telegram failed ${res.status}: ${text}`);
  return JSON.parse(text);
}

function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatSignalMessage(row, signalClass, verifiedOdds) {
  const status = playStatusFromClass(signalClass);
  const name = matchName(row);
  const p2 = p2Name(row);
  const start = row.match_date || row.starts_at || '';
  const p36 = asNumber(row.odds_3_6_decimal ?? row.odds_p2_6_3);
  const p46 = asNumber(row.odds_4_6_decimal ?? row.odds_p2_6_4);
  const p57 = asNumber(row.odds_5_7_decimal ?? row.odds_p2_7_5);
  const stake = centsStake();
  return [
    `🚨 <b>SlipIQ V3 ${escapeHtml(status)}</b>`,
    ``,
    `<b>Match:</b> ${escapeHtml(name)}`,
    `<b>Player 2:</b> ${escapeHtml(p2)}`,
    `<b>Start:</b> ${escapeHtml(start)}`,
    `<b>Sportsbook source:</b> ${escapeHtml(row.price_source || row.sportsbook || 'bet365')}`,
    ``,
    `<b>P2 6-3:</b> ${p36 ?? 'n/a'}`,
    `<b>P2 6-4:</b> ${p46 ?? 'n/a'}`,
    `<b>P2 7-5:</b> ${p57 ?? 'n/a'}`,
    `<b>Verified P2 & 9-12:</b> ${verifiedOdds?.toFixed ? verifiedOdds.toFixed(2) : verifiedOdds}`,
    ``,
    `<b>System stake:</b> $${stake.toFixed(2)} paper/live unit at 0.25% of $5k`,
    `<b>Note:</b> scanner-confirmed only; no bet placed automatically.`,
  ].join('\n');
}

function buildSignalPayload(row, summary, signalClass, scannerRunId) {
  const grouped = asNumber(row.estimated_player2_9_12_odds ?? row.reconstructed_p2_9_12_odds ?? row.direct_p2_9_12_odds);
  const source = row.price_source || summary.target_bookmaker || 'bet365';
  const external = row.match_link || `${source}:${matchName(row)}:${row.match_date || ''}`;
  return {
    source: 'github_scanner',
    sportsbook: source,
    external_match_id: external,
    match_name: matchName(row),
    tournament: row.league_name || row.tournament || null,
    starts_at: parseDate(row.match_date || row.starts_at),
    player1: p1Name(row) || null,
    player2: p2Name(row),
    player2_match_odds: asNumber(row.player2_match_odds),
    odds_p2_6_3: asNumber(row.odds_3_6_decimal ?? row.odds_p2_6_3),
    odds_p2_6_4: asNumber(row.odds_4_6_decimal ?? row.odds_p2_6_4),
    odds_p2_7_5: asNumber(row.odds_5_7_decimal ?? row.odds_p2_7_5),
    direct_p2_9_12_odds: asNumber(row.direct_p2_9_12_odds),
    reconstructed_p2_9_12_odds: grouped,
    v3_trigger_price: asNumber(row.odds_4_6_decimal ?? row.odds_p2_6_4),
    signal_class: signalClass,
    execution_status: signalClass === 'REJECT' ? 'ignored' : 'new',
    manual_confirmed: false,
    auto_price_confirmed: signalClass !== 'REJECT',
    auto_price_confirmed_at: new Date().toISOString(),
    verified_grouped_odds: grouped,
    price_verification_source: 'github_scanner',
    scanner_run_id: scannerRunId,
    raw_payload: { row, summary_meta: { generated_at: summary.generated_at, date: summary.date, leagues: summary.leagues } },
  };
}

function buildPriceCheckPayload(row, summary, signalId, signalClass, scannerRunId) {
  const grouped = asNumber(row.estimated_player2_9_12_odds ?? row.reconstructed_p2_9_12_odds ?? row.direct_p2_9_12_odds);
  return {
    signal_id: signalId,
    check_source: 'github_scanner',
    sportsbook: row.price_source || summary.target_bookmaker || 'bet365',
    external_match_id: row.match_link || `${matchName(row)}:${row.match_date || ''}`,
    match_name: matchName(row),
    player2: p2Name(row),
    odds_p2_6_3: asNumber(row.odds_3_6_decimal ?? row.odds_p2_6_3),
    odds_p2_6_4: asNumber(row.odds_4_6_decimal ?? row.odds_p2_6_4),
    odds_p2_7_5: asNumber(row.odds_5_7_decimal ?? row.odds_p2_7_5),
    direct_p2_9_12_odds: asNumber(row.direct_p2_9_12_odds),
    reconstructed_p2_9_12_odds: grouped,
    price_age_seconds: 0,
    is_fresh: true,
    is_playable: signalClass !== 'REJECT' && grouped !== null && grouped >= 3.3,
    scanner_run_id: scannerRunId,
    raw_payload: { row },
  };
}

function shouldAlert(signalClass) {
  return ['OFFICIAL_V3_TARGET', 'OFFICIAL_V3_PLAYABLE', 'AGGRESSIVE_V3_TARGET'].includes(signalClass);
}

async function main() {
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing summary JSON: ${summaryPath}`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const scannerRunId = `github_scanner:${summary.generated_at || new Date().toISOString()}`;
  const rows = [
    ...(summary.actionable_candidates || []),
  ];

  console.log(JSON.stringify({ event: 'push_start', dryRun, summaryPath, row_count: rows.length, scannerRunId }, null, 2));

  if (!requiredEnvReady()) {
    console.log(JSON.stringify({ event: 'skipped_supabase', reason: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }, null, 2));
    return;
  }

  const processed = [];
  for (const row of rows) {
    const signalClass = classifySignal(row);
    if (signalClass === 'REJECT') continue;
    const signalPayload = buildSignalPayload(row, summary, signalClass, scannerRunId);

    if (dryRun) {
      processed.push({ dry_run: true, signalPayload });
      continue;
    }

    const inserted = await supabaseRequest(
      'POST',
      `${SIGNAL_TABLE}?on_conflict=sportsbook,external_match_id,player2,starts_at`,
      [signalPayload]
    );
    const signal = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!signal?.id) throw new Error('Supabase insert did not return signal id');

    const priceCheckPayload = buildPriceCheckPayload(row, summary, signal.id, signalClass, scannerRunId);
    await supabaseRequest('POST', PRICE_CHECK_TABLE, [priceCheckPayload]);

    let telegram = { skipped: true };
    if (shouldAlert(signalClass) && !signal.telegram_alert_sent_at) {
      try {
        telegram = await sendTelegram(formatSignalMessage(row, signalClass, signalPayload.verified_grouped_odds));
        await supabaseRequest('PATCH', `${SIGNAL_TABLE}?id=eq.${signal.id}`, {
          execution_status: 'alerted',
          telegram_alert_sent_at: new Date().toISOString(),
          last_alert_error: null,
        });
      } catch (err) {
        await supabaseRequest('PATCH', `${SIGNAL_TABLE}?id=eq.${signal.id}`, {
          last_alert_error: String(err.message || err),
        });
        telegram = { error: String(err.message || err) };
      }
    }

    processed.push({ signal_id: signal.id, signal_class: signalClass, match: signalPayload.match_name, verified_grouped_odds: signalPayload.verified_grouped_odds, telegram });
  }

  console.log(JSON.stringify({ event: 'push_done', processed_count: processed.length, processed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
