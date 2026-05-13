#!/usr/bin/env node
/*!
 * SlipIQ read-only Bet365 API discovery scanner.
 *
 * Purpose:
 * - Test whether a user-provided Bet365 mobile/API endpoint contains tennis
 *   first-set correct-score data needed for V3.
 * - Detect tennis events, market labels, score labels, and possible odds tokens.
 * - Write sanitized artifacts for inspection.
 *
 * Safety:
 * - Read-only GET requests only.
 * - Does not log in, place bets, click anything, or bypass controls.
 * - Never print cookies or authorization headers.
 * - Keep BET365_COOKIE only in local .env or GitHub Secrets.
 */

import fs from 'node:fs';
import path from 'node:path';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const endpoint = params.url || process.env.BET365_API_URL || 'https://mobile.bet365.com/inplaydiaryapi/schedule?timezone=16&lid=33&zid=0';
const outDir = params.out || 'artifacts/output/bet365-api-discovery';
const timeoutMs = Number.parseInt(params.timeout_ms || process.env.BET365_TIMEOUT_MS || '60000', 10);
const keywordString = params.keywords || 'tennis,set,1st set,first set,correct score,3-6,4-6,5-7,6-3,6-4,7-5';
const keywords = keywordString.split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(outDir, { recursive: true });

function buildHeaders() {
  const h = {
    'Accept': process.env.BET365_ACCEPT || '*/*',
    'Accept-Language': process.env.BET365_ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'User-Agent': process.env.BET365_USER_AGENT || process.env.USER_AGENT || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    'Referer': process.env.BET365_REFERER || 'https://www.bet365.com/',
    'Origin': process.env.BET365_ORIGIN || 'https://www.bet365.com',
  };

  if (process.env.BET365_COOKIE) h.Cookie = process.env.BET365_COOKIE;
  if (process.env.BET365_HOST) h.Host = process.env.BET365_HOST;
  if (process.env.BET365_EXTRA_HEADERS_JSON) {
    try {
      const extra = JSON.parse(process.env.BET365_EXTRA_HEADERS_JSON);
      for (const [k, v] of Object.entries(extra)) {
        if (/cookie|authorization/i.test(k)) continue;
        h[k] = String(v);
      }
    } catch (err) {
      console.error('[!] BET365_EXTRA_HEADERS_JSON was not valid JSON; ignoring it.');
    }
  }
  return h;
}

function safeHeaders(headers) {
  const safe = {};
  for (const [k, v] of Object.entries(headers)) {
    safe[k] = /cookie|authorization/i.test(k) ? '[redacted]' : v;
  }
  return safe;
}

function normalizeText(text) {
  return String(text || '')
    .replaceAll('\u00ac', '¬')
    .replaceAll('\u0001', '|')
    .replaceAll('\u001d', '|');
}

function parseKeyValues(segment) {
  const out = {};
  const text = normalizeText(segment);
  const parts = text.split(/[¬|]/g);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) continue;
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

function textHasKeyword(text, terms = keywords) {
  const low = String(text || '').toLowerCase();
  return terms.some((term) => low.includes(term.toLowerCase()));
}

function oddsToDecimal(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1 ? n : null;
  }
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (b > 0) return 1 + a / b;
  }
  const american = s.match(/^([+-]\d{3,5})$/);
  if (american) {
    const n = Number(american[1]);
    return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  }
  return null;
}

function candidateOddsFromKv(kv) {
  const possibleKeys = ['OD', 'O', 'OO', 'SP', 'FD', 'AD'];
  const odds = [];
  for (const key of possibleKeys) {
    const value = kv[key];
    const values = Array.isArray(value) ? value : value ? [value] : [];
    for (const v of values) {
      const decimal = oddsToDecimal(v);
      if (decimal) odds.push({ key, raw: v, decimal });
    }
  }
  return odds;
}

function scoreLabelFromText(text) {
  const s = String(text || '');
  const m = s.match(/\b([0-7])\s*[-:]\s*([0-7])\b/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function groupedOdds(a, b, c) {
  if (!a || !b || !c) return null;
  return 1 / (1 / a + 1 / b + 1 / c);
}

function splitSegments(text) {
  const normalized = normalizeText(text);
  const byRecord = normalized.split(/(?=\b(?:EV|MG|MA|PA|FI|NA)=)/g);
  const fallback = normalized.split(/EV/g).map((s) => `EV${s}`);
  const segments = byRecord.length > fallback.length ? byRecord : fallback;
  return segments.map((s) => s.trim()).filter((s) => s.length > 10);
}

function compactSegment(segment, max = 800) {
  return normalizeText(segment).slice(0, max).replace(/[\r\n\t]+/g, ' ');
}

async function main() {
  const startedAt = new Date().toISOString();
  const headers = buildHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  console.error('[*] SlipIQ Bet365 API discovery scan');
  console.error(`[*] Endpoint host/path: ${new URL(endpoint).host}${new URL(endpoint).pathname}`);
  console.error(`[*] Keywords: ${keywords.join(', ')}`);
  console.error(`[*] Cookie present: ${process.env.BET365_COOKIE ? 'yes' : 'no'}`);

  let response;
  let text = '';
  let fetchError = null;
  try {
    response = await fetch(endpoint, { headers, signal: controller.signal });
    text = await response.text();
  } catch (err) {
    fetchError = String(err.message || err);
  } finally {
    clearTimeout(timer);
  }

  const normalized = normalizeText(text);
  const segments = splitSegments(normalized);
  const matchingSegments = [];
  const scoreCandidates = [];
  const scoreMap = new Map();
  const targetScores = new Set(['3-6', '4-6', '5-7']);

  for (const segment of segments) {
    const kv = parseKeyValues(segment);
    const haystack = [segment, kv.NA, kv.N2, kv.MA, kv.MG, kv.CL, kv.CT, kv.IT].filter(Boolean).join(' ');
    const hasKeyword = textHasKeyword(haystack);
    const score = scoreLabelFromText(haystack);
    const odds = candidateOddsFromKv(kv);

    if (hasKeyword || score || odds.length) {
      const item = {
        score,
        has_target_score: targetScores.has(score || ''),
        label: kv.NA || kv.N2 || kv.MA || kv.MG || null,
        event_id: kv.FI || kv.ID || kv.CI || null,
        market_id: kv.MA || kv.MG || kv.IT || null,
        odds,
        keys: Object.keys(kv).sort(),
        sample: compactSegment(segment),
      };
      matchingSegments.push(item);
      if (score || odds.length) scoreCandidates.push(item);
      if (score && odds[0]?.decimal) scoreMap.set(score, odds[0].decimal);
    }
  }

  const p2_3_6 = scoreMap.get('3-6') || null;
  const p2_4_6 = scoreMap.get('4-6') || null;
  const p2_5_7 = scoreMap.get('5-7') || null;
  const reconstructed_p2_9_12 = groupedOdds(p2_3_6, p2_4_6, p2_5_7);

  const summary = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: 'read_only_discovery',
    endpoint_host: (() => { try { return new URL(endpoint).host; } catch { return null; } })(),
    endpoint_path: (() => { try { return new URL(endpoint).pathname; } catch { return null; } })(),
    status: response?.status || null,
    ok: response?.ok || false,
    fetch_error: fetchError,
    content_type: response?.headers?.get('content-type') || null,
    raw_text_length: normalized.length,
    segments_scanned: segments.length,
    matching_segments_count: matchingSegments.length,
    score_candidates_count: scoreCandidates.length,
    target_scores_found: {
      p2_3_6,
      p2_4_6,
      p2_5_7,
      reconstructed_p2_9_12,
    },
    useful_for_v3: Boolean(reconstructed_p2_9_12),
    safe_request_headers: safeHeaders(headers),
    warning: 'Discovery only. This does not log in, place bets, or guarantee that Bet365 permits this use. Keep cookies private and confirm all prices manually.',
  };

  fs.writeFileSync(path.join(outDir, 'bet365_api_discovery_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'bet365_api_matching_segments.json'), `${JSON.stringify(matchingSegments.slice(0, 500), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'bet365_api_score_candidates.json'), `${JSON.stringify(scoreCandidates.slice(0, 500), null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'bet365_api_raw_sample.txt'), normalized.slice(0, 50000));

  console.log(JSON.stringify(summary, null, 2));

  if (!response?.ok || fetchError) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
