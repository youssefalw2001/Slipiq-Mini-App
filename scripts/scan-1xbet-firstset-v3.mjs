#!/usr/bin/env node
/**
 * SlipIQ read-only 1xBet first-set V3 scanner.
 *
 * Safety:
 * - No login.
 * - No betting.
 * - No captcha bypass.
 * - No credential storage.
 * - Only reads public page text/DOM and writes local artifacts.
 *
 * Goal:
 * Extract 1xBet tennis 1st Set Correct Score odds for P2 V3:
 *   3:6, 4:6, 5:7
 * plus optional support market:
 *   Total 2 Over 5.5 first set
 *
 * This is intentionally narrow. It is an odds-confirmation layer, not a sportsbook bot.
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const TARGET_SCORES = ['3:6', '4:6', '5:7'];
const SUPPORT_MARKETS = ['Total 2 Over 5.5 1st set'];

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    urls: '',
    urlsFile: '',
    out: 'artifacts/output/1xbet-firstset-v3',
    threshold: 3.3,
    waitMs: 5000,
    pauseSeconds: 1.25,
    debugEvery: 1,
    headed: false,
    telegram: false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--headed') args.headed = true;
    else if (raw === '--telegram') args.telegram = true;
    else if (raw.startsWith('--urls=')) args.urls = raw.slice('--urls='.length);
    else if (raw.startsWith('--urls-file=')) args.urlsFile = raw.slice('--urls-file='.length);
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--threshold=')) args.threshold = Number(raw.slice('--threshold='.length));
    else if (raw.startsWith('--wait-ms=')) args.waitMs = Number(raw.slice('--wait-ms='.length));
    else if (raw.startsWith('--pause-seconds=')) args.pauseSeconds = Number(raw.slice('--pause-seconds='.length));
    else if (raw.startsWith('--debug-every=')) args.debugEvery = Number(raw.slice('--debug-every='.length));
  }
  return args;
}

function splitUrls(raw) {
  return String(raw || '')
    .split(/[\n,|]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'));
}

function readUrls(args) {
  const out = [];
  out.push(...splitUrls(args.urls));
  if (args.urlsFile && fs.existsSync(args.urlsFile)) {
    out.push(...splitUrls(fs.readFileSync(args.urlsFile, 'utf8')));
  }
  return [...new Set(out)].filter((url) => /^https?:\/\//i.test(url));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, rows) {
  const headers = [
    'scraped_at',
    'input_url',
    'final_url',
    'title',
    'match_name',
    'price_source',
    'odds_3_6_decimal',
    'odds_4_6_decimal',
    'odds_5_7_decimal',
    'estimated_player2_9_12_odds',
    'total2_over_5_5_first_set_decimal',
    'playable',
    'status',
    'note',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function linesFromText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[−–—]/g, '-')
    .split(/\n+/g)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decimalFromToken(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(',', '.').trim();
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    const n = Number(cleaned);
    if (n > 1.01 && n < 1000) return Number(n.toFixed(4));
  }
  return null;
}

function groupedOdds(values) {
  if (values.some((v) => !(v > 1))) return null;
  const denom = values.reduce((sum, v) => sum + 1 / v, 0);
  return Number((1 / denom).toFixed(4));
}

function scoreAliases(score) {
  const [a, b] = score.split(':');
  return [score, `${a}-${b}`, `${a} : ${b}`, `${a} - ${b}`];
}

function extractMatchName(title, bodyText) {
  const cleanTitle = normalizeText(title || '');
  if (cleanTitle && !/^1xbet/i.test(cleanTitle)) return cleanTitle;

  const text = normalizeText(bodyText);
  const vs = text.match(/([A-Z][A-Za-z.' -]{2,40})\s+(?:-|vs|v)\s+([A-Z][A-Za-z.' -]{2,40})/i);
  if (vs) return `${vs[1].trim()} - ${vs[2].trim()}`;
  return cleanTitle || 'unknown_match';
}

function extractScoreOddsFromLines(lines, score) {
  const aliases = scoreAliases(score);
  const oddsToken = '(\\d{1,3}(?:[.,]\\d{1,3})?)';

  for (const line of lines) {
    const compact = normalizeText(line);
    if (!aliases.some((alias) => compact.includes(alias))) continue;

    // Good rows usually look like: 3:6 12.00 or 3:6 12
    // Take the first plausible decimal after the score alias.
    for (const alias of aliases) {
      const idx = compact.indexOf(alias);
      if (idx === -1) continue;
      const after = compact.slice(idx + alias.length, idx + alias.length + 80);
      const m = after.match(new RegExp(`(?:^|\\s)${oddsToken}(?=\\s|$)`));
      const dec = decimalFromToken(m?.[1]);
      if (dec) {
        return { raw: m[1], decimal: dec, line: compact };
      }
    }
  }

  // Fallback: scan whole text-ish line for score and later odds.
  for (const line of lines) {
    const compact = normalizeText(line);
    for (const alias of aliases) {
      const re = new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${oddsToken}`);
      const m = compact.match(re);
      const dec = decimalFromToken(m?.[1]);
      if (dec) return { raw: m[1], decimal: dec, line: compact };
    }
  }

  return { raw: '', decimal: null, line: '' };
}

function extractTotal2Over55(lines, fullText) {
  const candidates = [];
  const normalizedLines = lines.map(normalizeText);

  for (let i = 0; i < normalizedLines.length; i += 1) {
    const line = normalizedLines[i];
    const lower = line.toLowerCase();
    const near = normalizedLines.slice(Math.max(0, i - 2), Math.min(normalizedLines.length, i + 4)).join(' | ');
    const nearLower = near.toLowerCase();

    const mentionsTotal2 = /total\s*2|player\s*2\s*total|team\s*2\s*total|individual\s*total\s*2/i.test(near);
    const mentionsFirstSet = /1st\s*set|first\s*set|set\s*1/i.test(near);
    const mentionsOver55 = /over\s*5[.,]5|o\s*5[.,]5|5[.,]5\s*over/i.test(near);

    if (mentionsTotal2 && mentionsFirstSet && mentionsOver55) {
      const m = near.match(/(?:over\s*5[.,]5|o\s*5[.,]5|5[.,]5\s*over)\D{0,30}(\d{1,3}(?:[.,]\d{1,3})?)/i);
      const dec = decimalFromToken(m?.[1]);
      if (dec) candidates.push({ raw: m[1], decimal: dec, line: near });
    }

    if (lower.includes('total') && lower.includes('5.5')) {
      const m = line.match(/(?:over|o)\s*5[.,]5\s+(\d{1,3}(?:[.,]\d{1,3})?)/i);
      const dec = decimalFromToken(m?.[1]);
      if (dec) candidates.push({ raw: m[1], decimal: dec, line });
    }
  }

  if (candidates.length) return candidates[0];

  const text = normalizeText(fullText);
  const m = text.match(/(?:Total\s*2|Player\s*2\s*Total|Individual\s*Total\s*2).{0,180}(?:1st\s*Set|First\s*Set|Set\s*1).{0,180}(?:Over|O)\s*5[.,]5\D{0,30}(\d{1,3}(?:[.,]\d{1,3})?)/i);
  const dec = decimalFromToken(m?.[1]);
  if (dec) return { raw: m[1], decimal: dec, line: m[0] };

  return { raw: '', decimal: null, line: '' };
}

async function acceptCookies(page) {
  const labels = [
    'Accept',
    'Accept all',
    'I agree',
    'Agree',
    'OK',
    'Got it',
    'Allow all',
  ];
  for (const label of labels) {
    try {
      const loc = page.getByText(label, { exact: false }).first();
      if ((await loc.count()) > 0 && (await loc.isVisible({ timeout: 750 }).catch(() => false))) {
        await loc.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(800);
        return;
      }
    } catch {}
  }
}

async function clickTextIfVisible(page, label, exact = false) {
  try {
    const loc = page.getByText(label, { exact }).first();
    if ((await loc.count()) > 0 && (await loc.isVisible({ timeout: 750 }).catch(() => false))) {
      await loc.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  } catch {}
  return false;
}

async function tryOpenRelevantMarkets(page) {
  // These are best-effort because 1xBet labels vary by locale/layout.
  const marketLabels = [
    'Correct Score 1st set',
    'Correct score 1st set',
    'Correct Score',
    'Correct score',
    'Set 1 Correct Score',
    '1st set',
    'First set',
    '1st Set',
    'Set 1',
    'Total 2',
  ];

  for (const label of marketLabels) {
    await clickTextIfVisible(page, label, false);
  }

  // Expand collapsed sections if present, but avoid clicking login/bet buttons.
  const expanders = ['Show more', 'More', 'All markets', '+', 'Markets'];
  for (const label of expanders) {
    await clickTextIfVisible(page, label, false);
  }
}

async function scrapeUrl(browser, url, index, args) {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1200 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  const debugDir = path.join(args.out, 'debug');
  ensureDir(debugDir);

  const row = {
    scraped_at: nowIso(),
    input_url: url,
    final_url: '',
    title: '',
    match_name: '',
    price_source: '1xbet_public_read_only',
    odds_3_6_decimal: '',
    odds_4_6_decimal: '',
    odds_5_7_decimal: '',
    estimated_player2_9_12_odds: '',
    total2_over_5_5_first_set_decimal: '',
    playable: false,
    status: 'error',
    note: '',
    debug: {},
  };

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(args.waitMs);
    await acceptCookies(page);
    await tryOpenRelevantMarkets(page);
    await page.waitForTimeout(1500);

    row.final_url = page.url();
    row.title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
    row.match_name = extractMatchName(row.title, bodyText);
    const lines = linesFromText(bodyText);

    const extracted = {};
    for (const score of TARGET_SCORES) {
      extracted[score] = extractScoreOddsFromLines(lines, score);
      row[`odds_${score.replace(':', '_')}_decimal`] = extracted[score].decimal || '';
    }

    const total2 = extractTotal2Over55(lines, bodyText);
    row.total2_over_5_5_first_set_decimal = total2.decimal || '';

    const vals = TARGET_SCORES.map((s) => extracted[s].decimal);
    const group = groupedOdds(vals);
    row.estimated_player2_9_12_odds = group || '';
    row.playable = Boolean(group && group >= args.threshold);
    row.status = group ? 'ok' : 'missing_scores';
    row.note = group ? '' : 'Could not find all P2 3:6/4:6/5:7 1st-set correct-score odds on the public page.';
    row.debug = {
      extracted,
      total2,
      target_scores_found: Object.fromEntries(TARGET_SCORES.map((s) => [s, extracted[s].decimal])),
      line_count: lines.length,
      sample_lines: lines.filter((x) => /3:6|4:6|5:7|Correct|Score|Total|1st|First/i.test(x)).slice(0, 80),
    };

    if (args.debugEvery > 0 && index % args.debugEvery === 0) {
      await page.screenshot({ path: path.join(debugDir, `1xbet_${String(index).padStart(4, '0')}.png`), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(debugDir, `1xbet_${String(index).padStart(4, '0')}.txt`), bodyText.slice(0, 500000), 'utf8');
      fs.writeFileSync(path.join(debugDir, `1xbet_${String(index).padStart(4, '0')}.debug.json`), JSON.stringify(row.debug, null, 2), 'utf8');
    }
  } catch (error) {
    row.status = 'error';
    row.note = String(error?.message || error).slice(0, 500);
  }

  await context.close().catch(() => {});
  return row;
}

function signalText(row, threshold) {
  if (!row.playable) return '';
  return [
    '🚨 SlipIQ 1xBet V3 candidate',
    '',
    `Match: ${row.match_name}`,
    `Book: 1xBet public read-only`,
    '',
    `P2 3:6: ${row.odds_3_6_decimal}`,
    `P2 4:6: ${row.odds_4_6_decimal}`,
    `P2 5:7: ${row.odds_5_7_decimal}`,
    `Grouped: ${row.estimated_player2_9_12_odds}`,
    `Minimum: ${threshold}`,
    row.total2_over_5_5_first_set_decimal ? `Total 2 O5.5 1st set: ${row.total2_over_5_5_first_set_decimal}` : '',
    '',
    'Action: manually verify inside 1xBet before using Auto Bet. No bet was placed by SlipIQ.',
    row.final_url,
  ].filter(Boolean).join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !text) return { ok: false, skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.json().catch(() => ({ ok: res.ok }));
}

async function main() {
  const args = parseArgs(process.argv);
  ensureDir(args.out);
  const urls = readUrls(args);

  if (!urls.length) {
    const summary = {
      generated_at: nowIso(),
      status: 'no_urls',
      message: 'Provide --urls="https://..." or --urls-file=data/1xbet_firstset_urls.txt with public 1xBet match URLs.',
    };
    fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  console.log(`[*] 1xBet read-only V3 scanner starting. URLs: ${urls.length}`);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const rows = [];

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    console.log(`[${i + 1}/${urls.length}] ${url}`);
    const row = await scrapeUrl(browser, url, i + 1, args);
    rows.push(row);
    console.log(`   status=${row.status} grouped=${row.estimated_player2_9_12_odds || 'NA'} playable=${row.playable}`);
    if (args.telegram && row.playable) {
      await sendTelegram(signalText(row, args.threshold)).catch((err) => console.warn('[telegram]', err.message));
    }
    await new Promise((resolve) => setTimeout(resolve, args.pauseSeconds * 1000));
  }

  await browser.close();

  const playable = rows.filter((r) => r.playable);
  const summary = {
    generated_at: nowIso(),
    mode: '1xbet_public_read_only_firstset_v3',
    safety: 'No login, no betting, no captcha bypass, no credential storage.',
    urls_scanned: rows.length,
    ok_rows: rows.filter((r) => r.status === 'ok').length,
    playable_count: playable.length,
    threshold: args.threshold,
    output_csv: path.join(args.out, '1xbet_firstset_v3_rows.csv'),
    playable_rows_top_25: playable.slice(0, 25),
    warning: 'Manual verification inside 1xBet is required before using Auto Bet. SlipIQ did not place any bet.',
  };

  writeCsv(path.join(args.out, '1xbet_firstset_v3_rows.csv'), rows);
  fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(args.out, 'rows.json'), JSON.stringify(rows, null, 2), 'utf8');

  console.log('\nFINAL 1XBET V3 SUMMARY');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
