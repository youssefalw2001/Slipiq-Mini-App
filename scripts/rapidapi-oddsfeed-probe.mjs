#!/usr/bin/env node
/**
 * Generic RapidAPI Odds Feed probe for SlipIQ.
 *
 * Purpose:
 * - Use a RapidAPI sports odds feed without hardcoding unknown provider schemas.
 * - Save raw responses for inspection.
 * - Recursively scan JSON for bookmaker/market/selection/odd-like objects.
 * - Try to normalize 1xBet tennis 1st Set Correct Score odds for V3:
 *   P2 3:6, 4:6, 5:7.
 *
 * Safety:
 * - API-only. No sportsbook login. No betting. No browser automation.
 * - API key must come from RAPIDAPI_KEY GitHub secret/env var.
 */

import fs from 'fs';
import path from 'path';
import { URLSearchParams } from 'url';

const TARGET_SCORES = ['3:6', '4:6', '5:7'];
const SCORE_ALIASES = {
  '3:6': ['3:6', '3-6', 'player 2 6-3', 'p2 6-3', 'away 6-3', '2 6-3'],
  '4:6': ['4:6', '4-6', 'player 2 6-4', 'p2 6-4', 'away 6-4', '2 6-4'],
  '5:7': ['5:7', '5-7', 'player 2 7-5', 'p2 7-5', 'away 7-5', '2 7-5'],
};

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    host: process.env.RAPIDAPI_HOST || '',
    endpoint: '',
    method: 'GET',
    params: '',
    paramsFile: '',
    out: 'artifacts/output/rapidapi-oddsfeed-probe',
    bookmaker: '1xBet',
    sport: 'tennis',
    mode: 'probe',
    maxRequests: 1,
    pauseMs: 800,
  };

  for (const raw of argv.slice(2)) {
    if (raw.startsWith('--host=')) args.host = raw.slice('--host='.length);
    else if (raw.startsWith('--endpoint=')) args.endpoint = raw.slice('--endpoint='.length);
    else if (raw.startsWith('--method=')) args.method = raw.slice('--method='.length).toUpperCase();
    else if (raw.startsWith('--params=')) args.params = raw.slice('--params='.length);
    else if (raw.startsWith('--params-file=')) args.paramsFile = raw.slice('--params-file='.length);
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--bookmaker=')) args.bookmaker = raw.slice('--bookmaker='.length);
    else if (raw.startsWith('--sport=')) args.sport = raw.slice('--sport='.length);
    else if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length);
    else if (raw.startsWith('--max-requests=')) args.maxRequests = Number(raw.slice('--max-requests='.length));
    else if (raw.startsWith('--pause-ms=')) args.pauseMs = Number(raw.slice('--pause-ms='.length));
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(s) {
  return String(s || 'request').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
}

function parseParamString(raw) {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const out = {};
  for (const part of trimmed.split(/[&;]/g)) {
    if (!part.trim()) continue;
    const [k, ...rest] = part.split('=');
    out[decodeURIComponent(k.trim())] = decodeURIComponent(rest.join('=').trim());
  }
  return out;
}

function loadParamSets(args) {
  const inline = parseParamString(args.params);
  if (args.paramsFile && fs.existsSync(args.paramsFile)) {
    const raw = fs.readFileSync(args.paramsFile, 'utf8');
    const json = JSON.parse(raw);
    if (Array.isArray(json)) return json.map((x) => ({ ...inline, ...x }));
    return [{ ...inline, ...json }];
  }
  return [inline];
}

function buildUrl(host, endpoint, params) {
  const cleanHost = host.replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = new URL(`https://${cleanHost}${cleanEndpoint}`);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && String(v) !== '') sp.set(k, String(v));
  }
  url.search = sp.toString();
  return url.toString();
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function numberFromAny(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1.001 && value < 1000) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(',', '.').trim();
    if (/^\d{1,4}(?:\.\d{1,5})?$/.test(cleaned)) {
      const n = Number(cleaned);
      if (Number.isFinite(n) && n > 1.001 && n < 1000) return n;
    }
  }
  return null;
}

function deepString(obj, max = 2500) {
  try {
    return JSON.stringify(obj).slice(0, max);
  } catch {
    return String(obj).slice(0, max);
  }
}

function flattenObjects(value, pointer = '$', depth = 0, out = []) {
  if (depth > 12) return out;
  if (Array.isArray(value)) {
    value.slice(0, 10000).forEach((item, idx) => flattenObjects(item, `${pointer}[${idx}]`, depth + 1, out));
  } else if (value && typeof value === 'object') {
    out.push({ pointer, value });
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') flattenObjects(v, `${pointer}.${k}`, depth + 1, out);
    }
  }
  return out;
}

function objectText(obj) {
  const values = [];
  function walk(v, depth = 0) {
    if (depth > 4) return;
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values.push(String(v));
    else if (Array.isArray(v)) v.slice(0, 40).forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v).slice(0, 80).forEach((x) => walk(x, depth + 1));
  }
  walk(obj);
  return normalizeText(values.join(' '));
}

function pickLikelyOddsFields(obj) {
  const fields = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const lk = normalizeText(k);
    if (/odd|price|decimal|coef|coefficient|value|rate|line/.test(lk)) {
      const n = numberFromAny(v);
      if (n) fields.push({ key: k, value: n, raw: v });
    }
  }
  return fields;
}

function groupedOdds(values) {
  if (values.some((v) => !(v > 1))) return null;
  return Number((1 / values.reduce((sum, v) => sum + 1 / v, 0)).toFixed(4));
}

function detectScore(text) {
  const t = normalizeText(text);
  for (const score of TARGET_SCORES) {
    for (const alias of SCORE_ALIASES[score]) {
      if (t.includes(normalizeText(alias))) return score;
    }
  }
  return '';
}

function isCorrectScoreFirstSet(text) {
  const t = normalizeText(text);
  const hasCorrectScore = /correct score|score/i.test(t);
  const hasFirstSet = /1st set|first set|set 1|1 set|period 1|inning 1/i.test(t);
  return hasCorrectScore && hasFirstSet;
}

function hasBookmaker(text, bookmaker) {
  const t = normalizeText(text);
  const b = normalizeText(bookmaker);
  if (!b) return true;
  if (t.includes(b)) return true;
  if (b.includes('1xbet') && /1x\s*bet|1xbet|1x/i.test(t)) return true;
  return false;
}

function extractNormalizedRows(json, args, requestInfo) {
  const objects = flattenObjects(json);
  const rows = [];

  for (const item of objects) {
    const obj = item.value;
    const text = objectText(obj);
    const score = detectScore(text);
    const oddsFields = pickLikelyOddsFields(obj);
    if (!score || !oddsFields.length) continue;

    const relevantMarket = isCorrectScoreFirstSet(text) || /3:6|4:6|5:7|3-6|4-6|5-7/i.test(text);
    const bookmakerOk = hasBookmaker(text, args.bookmaker);

    for (const odd of oddsFields) {
      rows.push({
        scraped_at: nowIso(),
        request_url: requestInfo.url,
        request_mode: args.mode,
        bookmaker_target: args.bookmaker,
        bookmaker_matched: bookmakerOk,
        market_matched: relevantMarket,
        score,
        decimal_odds: odd.value,
        odd_key: odd.key,
        pointer: item.pointer,
        object_text: text.slice(0, 1200),
        object_json: deepString(obj, 2000),
      });
    }
  }

  // Prefer rows that mention both target bookmaker and first-set correct-score. Keep fallbacks too.
  rows.sort((a, b) => {
    const sa = (a.bookmaker_matched ? 2 : 0) + (a.market_matched ? 2 : 0);
    const sb = (b.bookmaker_matched ? 2 : 0) + (b.market_matched ? 2 : 0);
    return sb - sa;
  });

  return rows;
}

function summarizeRows(rows) {
  const bestByScore = {};
  for (const score of TARGET_SCORES) {
    const candidates = rows.filter((r) => r.score === score && r.bookmaker_matched && r.market_matched);
    if (candidates.length) bestByScore[score] = candidates[0];
  }
  const vals = TARGET_SCORES.map((s) => bestByScore[s]?.decimal_odds || null);
  return {
    target_scores_found: Object.fromEntries(TARGET_SCORES.map((s) => [s, bestByScore[s]?.decimal_odds || null])),
    grouped_p2_3_6_4_6_5_7: vals.every(Boolean) ? groupedOdds(vals) : null,
    strict_rows_count: rows.filter((r) => r.bookmaker_matched && r.market_matched).length,
    candidate_rows_count: rows.length,
  };
}

function writeCsv(filePath, rows) {
  const headers = [
    'scraped_at',
    'request_mode',
    'bookmaker_target',
    'bookmaker_matched',
    'market_matched',
    'score',
    'decimal_odds',
    'odd_key',
    'pointer',
    'request_url',
    'object_text',
    'object_json',
  ];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(filePath, `${headers.join(',')}\n${rows.map((r) => headers.map((h) => esc(r[h])).join(',')).join('\n')}\n`, 'utf8');
}

async function fetchRapidApi(url, host, key, method = 'GET') {
  const res = await fetch(url, {
    method,
    headers: {
      'X-RapidAPI-Key': key,
      'X-RapidAPI-Host': host.replace(/^https?:\/\//i, '').replace(/\/+$/g, ''),
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _non_json_response: text.slice(0, 20000) };
  }
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), json, textLength: text.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    console.error('Missing RAPIDAPI_KEY environment variable. Add it as a GitHub secret.');
    process.exit(2);
  }
  if (!args.host || !args.endpoint) {
    console.error('Missing --host and/or --endpoint. Use RapidAPI host, for example --host=example.p.rapidapi.com --endpoint=/odds');
    process.exit(2);
  }

  ensureDir(args.out);
  const paramSets = loadParamSets(args).slice(0, Math.max(1, args.maxRequests));
  const allRows = [];
  const responses = [];

  for (let i = 0; i < paramSets.length; i += 1) {
    const params = paramSets[i];
    const url = buildUrl(args.host, args.endpoint, params);
    console.log(`[${i + 1}/${paramSets.length}] GET ${url.replace(key, '***')}`);
    const response = await fetchRapidApi(url, args.host, key, args.method);
    const tag = `${String(i + 1).padStart(3, '0')}_${safeName(args.mode)}_${safeName(args.endpoint)}`;
    fs.writeFileSync(path.join(args.out, `${tag}.raw.json`), JSON.stringify(response.json, null, 2), 'utf8');
    fs.writeFileSync(path.join(args.out, `${tag}.meta.json`), JSON.stringify({ url, status: response.status, ok: response.ok, textLength: response.textLength, params }, null, 2), 'utf8');

    const rows = extractNormalizedRows(response.json, args, { url, params });
    allRows.push(...rows);
    responses.push({ url, params, status: response.status, ok: response.ok, rowCount: rows.length, summary: summarizeRows(rows) });
    await new Promise((resolve) => setTimeout(resolve, args.pauseMs));
  }

  writeCsv(path.join(args.out, 'normalized_candidate_odds.csv'), allRows);
  const summary = {
    generated_at: nowIso(),
    mode: args.mode,
    host: args.host,
    endpoint: args.endpoint,
    bookmaker: args.bookmaker,
    requests_made: responses.length,
    responses,
    overall: summarizeRows(allRows),
    next_step: 'If target scores are null, inspect *.raw.json and adjust endpoint/params or market/bookmaker field mapping.',
  };
  fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\nFINAL RAPIDAPI ODDS FEED SUMMARY');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
