#!/usr/bin/env node
/*!
 * SlipIQ OddsPortal Historical V3 Probe
 *
 * Goal:
 * - Open historical OddsPortal tennis match pages.
 * - Check whether the page exposes the exact market we need:
 *   Tennis -> 1st Set Correct Score -> Bet365 -> 3-6 / 4-6 / 5-7.
 * - Save proof artifacts so we can decide if a full historical V3 ROI backtest
 *   is possible from OddsPortal.
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
  if (matchLinksFile && fs.existsSync(matchLinksFile)) {
    values.push(fs.readFileSync(matchLinksFile, 'utf8'));
  }
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
  const low = text.toLowerCase();
  const idx = low.indexOf(String(needle).toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + String(needle).length + radius);
  return compactText(text.slice(start, end), radius * 2);
}

function countMatches(text, patterns) {
  const out = {};
  for (const p of patterns) {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out[p] = [...String(text).matchAll(re)].length;
  }
  return out;
}

function hasAny(text, terms) {
  const low = String(text || '').toLowerCase();
  return terms.some((t) => low.includes(t.toLowerCase()));
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
      const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join(' | ');
      const odds = [...context.matchAll(/\b(?:[1-9]\d?|\d)\.\d{2}\b/g)].map((m) => Number(m[0]));
      matches.push({ line, context: compactText(context, 600), odds });
    }
    result[score] = matches.slice(0, 10);
  }
  return result;
}

async function safeClickByText(page, patterns) {
  const clicked = [];
  for (const label of patterns) {
    try {
      const loc = page.getByText(label, { exact: false }).first();
      if (await loc.count()) {
        await loc.click({ timeout: 2500 });
        clicked.push(label);
        await page.waitForTimeout(1200);
      }
    } catch (_) {
      // Ignore: page layouts differ and many labels will not exist.
    }
  }
  return clicked;
}

async function probeOne(browser, url, index) {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const networkHits = [];
  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      const u = res.url();
      if (!/json|text|javascript/i.test(ct) && !/odds|event|coupon|match|bookmaker/i.test(u)) return;
      const body = await res.text().catch(() => '');
      const low = body.toLowerCase();
      if (low.includes('3-6') || low.includes('4-6') || low.includes('5-7') || low.includes(bookmaker) || low.includes('correct score')) {
        networkHits.push({
          url: u.slice(0, 500),
          status: res.status(),
          content_type: ct,
          has_bookmaker: low.includes(bookmaker),
          has_3_6: low.includes('3-6'),
          has_4_6: low.includes('4-6'),
          has_5_7: low.includes('5-7'),
          has_correct_score: low.includes('correct score'),
          sample: compactText(body, 1500),
        });
      }
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

  const clicked = await safeClickByText(page, [
    'Odds',
    '1st Set',
    '1st set',
    'First Set',
    'Set 1',
    'Correct Score',
    'Correct score',
    'Set Correct Score',
    'Bookmakers',
    'Show more',
    'More',
  ]);

  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const html = await page.content().catch(() => '');
  const combined = `${text}\n${html}`;
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
    'Correct Score',
    'correct_score',
  ]);

  const scoreWindows = {
    '3-6': textWindow(combined, '3-6'),
    '4-6': textWindow(combined, '4-6'),
    '5-7': textWindow(combined, '5-7'),
    bookmaker: textWindow(combined, bookmaker),
    correct_score: textWindow(combined, 'Correct Score') || textWindow(combined, 'correct_score'),
  };

  const foundTargetScores = Boolean(keywordCounts['3-6'] && keywordCounts['4-6'] && keywordCounts['5-7']);
  const foundMarketLanguage = hasAny(combined, ['Correct Score', 'correct_score']) && hasAny(combined, ['1st Set', 'First Set', 'Set 1', '1st_set']);
  const foundBookmaker = Boolean(keywordCounts[bookmaker]);
  const oddsCandidates = oddsNearScores(text);

  return {
    input_url: url,
    final_url: finalUrl,
    status,
    load_error: loadError,
    title,
    clicked_labels: clicked,
    screenshot_file: path.basename(screenshotPath),
    text_length: text.length,
    html_length: html.length,
    keyword_counts: keywordCounts,
    found_target_scores: foundTargetScores,
    found_market_language: foundMarketLanguage,
    found_bookmaker: foundBookmaker,
    potentially_useful_for_v3: foundTargetScores && (foundMarketLanguage || networkHits.some((h) => h.has_correct_score)) && (foundBookmaker || networkHits.some((h) => h.has_bookmaker)),
    odds_candidates_near_scores: oddsCandidates,
    score_windows: scoreWindows,
    network_hits: networkHits.slice(0, 50),
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
  const details = [];
  for (let i = 0; i < links.length; i += 1) {
    console.error(`[*] Probing ${i + 1}/${links.length}: ${links[i]}`);
    details.push(await probeOne(browser, links[i], i));
  }
  await browser.close();

  const useful = details.filter((d) => d.potentially_useful_for_v3);
  const summary = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    mode: 'oddsportal_historical_v3_probe',
    bookmaker,
    links_checked: links.length,
    potentially_useful_count: useful.length,
    potentially_useful_urls: useful.map((d) => d.input_url),
    target_scores_found_count: details.filter((d) => d.found_target_scores).length,
    market_language_found_count: details.filter((d) => d.found_market_language).length,
    bookmaker_found_count: details.filter((d) => d.found_bookmaker).length,
    verdict: useful.length > 0
      ? 'OddsPortal historical pages appear to expose enough V3 market evidence for at least one tested match. Next step is a structured extractor/backtest.'
      : 'No tested page proved the full V3 market yet. Try more historical match URLs or screenshots/manual page URLs where 1st Set Correct Score is visible.',
    warning: 'Read-only probe. Confirm OddsPortal terms and manually verify extracted prices before using results.',
  };

  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_details.json'), `${JSON.stringify(details, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'oddsportal_historical_v3_probe_samples.txt'), details.map((d, i) => [
    `# ${i + 1} ${d.input_url}`,
    `potentially_useful_for_v3=${d.potentially_useful_for_v3}`,
    `title=${d.title}`,
    `3-6=${d.score_windows['3-6'] || ''}`,
    `4-6=${d.score_windows['4-6'] || ''}`,
    `5-7=${d.score_windows['5-7'] || ''}`,
    `bookmaker=${d.score_windows.bookmaker || ''}`,
    `correct_score=${d.score_windows.correct_score || ''}`,
  ].join('\n')).join('\n\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
