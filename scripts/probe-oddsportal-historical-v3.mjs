#!/usr/bin/env node
/*!
 * SlipIQ OddsPortal Historical V3 Probe
 *
 * Goal:
 * - Open historical OddsPortal tennis match/H2H pages.
 * - Check whether the page or its first-party network responses expose:
 *   Tennis -> 1st Set Correct Score -> Bet365 -> 3-6 / 4-6 / 5-7.
 *
 * Safety:
 * - Read-only browser automation.
 * - No login, no betting, no account access.
 * - No bypass/captcha solving.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const params = Object.fromEntries(
  process.argv.slice(2)
    .map((arg) => arg.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);

const outDir = params.out || 'artifacts/output/oddsportal-historical-v3-probe';
const bookmaker = (params.bookmaker || process.env.BOOKMAKER || 'bet365').toLowerCase();
const timeoutMs = Number.parseInt(params.timeout_ms || process.env.TIMEOUT_MS || '45000', 10);
const waitMs = Number.parseInt(params.wait_ms || process.env.WAIT_MS || '6000', 10);
const headless = String(params.headless ?? process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
const matchLinksInput = params['match-links'] || process.env.MATCH_LINKS || '';
const matchLinksFile = params['match-links-file'] || process.env.MATCH_LINKS_FILE || '';

fs.mkdirSync(outDir, { recursive: true });

function parseLinks() {
  const values = [];
  if (matchLinksFile && fs.existsSync(matchLinksFile)) values.push(fs.readFileSync(matchLinksFile, 'utf8'));
  if (matchLinksInput) values.push(matchLinksInput);
  return values
    .join('\n')
    .split(/[\n,|]+/g)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function compactText(s, max = 1200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function textWindow(text, needle, radius = 700) {
  const low = String(text || '').toLowerCase();
  const target = String(needle || '').toLowerCase();
  const idx = low.indexOf(target);
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + target.length + radius);
  return compactText(text.slice(start, end), radius * 2);
}

function countMatches(text, patterns) {
  const out = {};
  for (const p of patterns) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out[p] = [...String(text || '').matchAll(new RegExp(escaped, 'gi'))].length;
  }
  return out;
}

function hasAny(text, terms) {
  const low = String(text || '').toLowerCase();
  return terms.some((t) => low.includes(t.toLowerCase()));
}

function isFirstPartyUsefulResponse(url, contentType) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'oddsportal.com') return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff2?)$/i.test(u.pathname)) return false;
    if (!/json|text|javascript|html/i.test(contentType || '')) return false;
    return true;
  } catch {
    return false;
  }
}

function scoreCounts(text) {
  return countMatches(text, ['3-6', '4-6', '5-7', '6-3', '6-4', '7-5']);
}

function oddsNearScores(text) {
  const lines = String(text || '')
    .split(/\n|\r|\t| {2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const targets = ['3-6', '4-6', '5-7'];
  const result = {};
  for (const score of targets) {
    const matches = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.includes(score)) continue;
      const context = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join(' | ');
      const odds = [...context.matchAll(/\b(?:[1-9]\d?|\d)\.\d{2}\b/g)].map((m) => Number(m[0]));
      matches.push({ line, context: compactText(context, 700), odds });
    }
    result[score] = matches.slice(0, 10);
  }
  return result;
}

async function dismissCookieBanner(page) {
  const clicked = [];
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#onetrust-reject-all-handler',
    'button:has-text("Continue without Accepting")',
    'button:has-text("Accept All")',
    'button:has-text("Reject All")',
    'button:has-text("Allow All")',
  ];
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if (await loc.count()) {
        await loc.click({ timeout: 1500 });
        clicked.push(selector);
        await page.waitForTimeout(800);
        break;
      }
    } catch (_) {}
  }
  return clicked;
}

async function probeOne(context, url, index) {
  const page = await context.newPage();
  const networkHits = [];

  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      const u = res.url();
      if (!isFirstPartyUsefulResponse(u, ct)) return;
      const body = await res.text().catch(() => '');
      const low = body.toLowerCase();
      const interesting = low.includes(bookmaker)
        || low.includes('correct score')
        || low.includes('correct_score')
        || low.includes('1st set')
        || low.includes('first set')
        || low.includes('set 1')
        || low.includes('3-6')
        || low.includes('4-6')
        || low.includes('5-7');
      if (!interesting) return;
      networkHits.push({
        url: u.slice(0, 500),
        status: res.status(),
        content_type: ct,
        has_bookmaker: low.includes(bookmaker),
        has_3_6: low.includes('3-6'),
        has_4_6: low.includes('4-6'),
        has_5_7: low.includes('5-7'),
        has_correct_score: low.includes('correct score') || low.includes('correct_score'),
        has_first_set: low.includes('1st set') || low.includes('first set') || low.includes('set 1') || low.includes('1st_set'),
        score_counts: scoreCounts(body),
        sample: compactText(body, 1800),
      });
    } catch (_) {}
  });

  let status = null;
  let loadError = null;
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    status = res?.status() || null;
    await page.waitForTimeout(waitMs);
  } catch (err) {
    loadError = String(err.message || err);
  }

  const cookie_clicks = await dismissCookieBanner(page);
  await page.waitForTimeout(1200);

  // IMPORTANT: do not click generic text like "Bookmakers", "Odds", or "More".
  // Those labels can navigate away from the match page and pollute the artifact.
  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const html = await page.content().catch(() => '');
  const combined = `${text}\n${html}\n${networkHits.map((h) => h.sample).join('\n')}`;

  const screenshotPath = path.join(outDir, `probe_${String(index + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  await page.close().catch(() => null);

  const keywordCounts = countMatches(combined, [
    bookmaker,
    '3-6',
    '4-6',
    '5-7',
    '1st Set',
    'First Set',
    'Set 1',
    '1st_set',
    'Correct Score',
    'correct_score',
  ]);

  const scoreWindows = {
    '3-6': textWindow(combined, '3-6'),
    '4-6': textWindow(combined, '4-6'),
    '5-7': textWindow(combined, '5-7'),
    bookmaker: textWindow(combined, bookmaker),
    correct_score: textWindow(combined, 'Correct Score') || textWindow(combined, 'correct_score'),
    first_set: textWindow(combined, '1st Set') || textWindow(combined, 'First Set') || textWindow(combined, 'Set 1') || textWindow(combined, '1st_set'),
  };

  const foundTargetScores = Boolean(keywordCounts['3-6'] && keywordCounts['4-6'] && keywordCounts['5-7']);
  const foundMarketLanguage = hasAny(combined, ['Correct Score', 'correct_score']) && hasAny(combined, ['1st Set', 'First Set', 'Set 1', '1st_set']);
  const foundBookmaker = Boolean(keywordCounts[bookmaker]);
  const pageStayedOnMatch = !finalUrl.includes('/bookmakers/');

  return {
    input_url: url,
    final_url: finalUrl,
    page_stayed_on_match: pageStayedOnMatch,
    status,
    load_error: loadError,
    title,
    cookie_clicks,
    clicked_labels: [],
    screenshot_file: path.basename(screenshotPath),
    text_length: text.length,
    html_length: html.length,
    keyword_counts: keywordCounts,
    found_target_scores: foundTargetScores,
    found_market_language: foundMarketLanguage,
    found_bookmaker: foundBookmaker,
    potentially_useful_for_v3: pageStayedOnMatch && foundTargetScores && foundMarketLanguage && foundBookmaker,
    odds_candidates_near_scores: oddsNearScores(combined),
    score_windows: scoreWindows,
    network_hits: networkHits.slice(0, 80),
  };
}

async function main() {
  const links = parseLinks();
  const startedAt = new Date().toISOString();
  if (!links.length) {
    const summary = {
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      ok: false,
      reason: 'No match links provided. Add OddsPortal historical tennis match URLs to the workflow input.',
      example_input: 'https://www.oddsportal.com/tennis/.../player-a-player-b-xxxxxxxx/',
    };
    fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  const details = [];
  for (let i = 0; i < links.length; i += 1) {
    console.error(`[*] Probing ${i + 1}/${links.length}: ${links[i]}`);
    details.push(await probeOne(context, links[i], i));
  }
  await context.close().catch(() => null);
  await browser.close().catch(() => null);

  const useful = details.filter((d) => d.potentially_useful_for_v3);
  const summary = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: 'oddsportal_historical_v3_probe',
    bookmaker,
    links_checked: links.length,
    pages_stayed_on_match_count: details.filter((d) => d.page_stayed_on_match).length,
    redirected_to_bookmakers_count: details.filter((d) => String(d.final_url || '').includes('/bookmakers/')).length,
    potentially_useful_count: useful.length,
    potentially_useful_urls: useful.map((d) => d.input_url),
    target_scores_found_count: details.filter((d) => d.found_target_scores).length,
    market_language_found_count: details.filter((d) => d.found_market_language).length,
    bookmaker_found_count: details.filter((d) => d.found_bookmaker).length,
    verdict: useful.length > 0
      ? 'OddsPortal historical pages appear to expose enough V3 market evidence for at least one tested match. Next step is a structured extractor/backtest.'
      : 'No tested page proved the full V3 market yet. If pages stay on match URLs but market data is absent, OddsPortal public H2H pages likely do not expose historical 1st-set correct-score odds directly.',
    warning: 'Read-only probe. Confirm OddsPortal terms and manually verify extracted prices before using results.',
  };

  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_details.json'), `${JSON.stringify(details, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_samples.txt'), details.map((d, i) => [
    `# ${i + 1} ${d.input_url}`,
    `final_url=${d.final_url}`,
    `page_stayed_on_match=${d.page_stayed_on_match}`,
    `potentially_useful_for_v3=${d.potentially_useful_for_v3}`,
    `title=${d.title}`,
    `3-6=${d.score_windows['3-6'] || ''}`,
    `4-6=${d.score_windows['4-6'] || ''}`,
    `5-7=${d.score_windows['5-7'] || ''}`,
    `bookmaker=${d.score_windows.bookmaker || ''}`,
    `first_set=${d.score_windows.first_set || ''}`,
    `correct_score=${d.score_windows.correct_score || ''}`,
  ].join('\n')).join('\n\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
