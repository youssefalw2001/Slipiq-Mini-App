#!/usr/bin/env node
/*!
 * Discover likely historical OddsPortal tennis match URLs from tournament result pages.
 * Read-only. No login. No betting.
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

const seedLinksInput = params['seed-links'] || process.env.MATCH_LINKS || '';
const outDir = params.out || 'artifacts/output/oddsportal-historical-v3-probe';
const outputFile = params.output || path.join(outDir, 'discovered_match_links.txt');
const maxLinks = Number.parseInt(params.max || process.env.MAX_DISCOVERED_LINKS || '30', 10);
const timeoutMs = Number.parseInt(params.timeout_ms || process.env.TIMEOUT_MS || '45000', 10);
const waitMs = Number.parseInt(params.wait_ms || process.env.WAIT_MS || '4000', 10);
const headless = String(params.headless ?? process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';

fs.mkdirSync(outDir, { recursive: true });

function parseLinks(text) {
  return String(text || '')
    .split(/[\n,|]+/g)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

function looksLikeMatchUrl(url) {
  try {
    const u = new URL(url);
    if (!/oddsportal\.com$/i.test(u.hostname.replace(/^www\./, ''))) return false;
    const pathName = u.pathname.toLowerCase();
    if (!pathName.includes('/tennis/')) return false;
    if (/(\/results\/?$|\/fixtures\/?$|\/standings|\/draw|\/outrights|\/rankings|\/news|\/archive)/i.test(pathName)) return false;
    const parts = pathName.split('/').filter(Boolean);
    if (parts.length < 4) return false;
    const last = parts.at(-1) || '';
    if (!last.includes('-')) return false;
    const hyphenCount = (last.match(/-/g) || []).length;
    const hasLikelyId = /-[a-z0-9]{6,}$/i.test(last);
    return hasLikelyId || hyphenCount >= 3;
  } catch {
    return false;
  }
}

async function discoverFromPage(browser, url, pageIndex) {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const result = { seed_url: url, status: null, title: '', discovered: [], error: null, screenshot_file: null };
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    result.status = res?.status() || null;
    await page.waitForTimeout(waitMs);

    for (const label of ['Show more', 'Yesterday', 'Previous', '2025', '2024', '2023']) {
      try {
        const loc = page.getByText(label, { exact: false }).first();
        if (await loc.count()) {
          await loc.click({ timeout: 1500 });
          await page.waitForTimeout(1000);
        }
      } catch (_) {}
    }

    result.title = await page.title().catch(() => '');
    const links = await page.$$eval('a[href]', (anchors) => anchors.map((a) => ({ href: a.href, text: a.textContent || '' })));
    const found = [];
    for (const item of links) {
      const normalized = normalizeUrl(item.href, url);
      if (!normalized || !looksLikeMatchUrl(normalized)) continue;
      found.push({ url: normalized, text: String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
    }
    const seen = new Set();
    result.discovered = found.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
    const screenshotPath = path.join(outDir, `discover_${String(pageIndex + 1).padStart(2, '0')}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
    result.screenshot_file = path.basename(screenshotPath);
  } catch (err) {
    result.error = String(err.message || err);
  } finally {
    await page.close().catch(() => null);
  }
  return result;
}

async function main() {
  const seeds = parseLinks(seedLinksInput);
  const browser = await chromium.launch({ headless });
  const pages = [];
  const all = [];
  const seen = new Set();

  for (let i = 0; i < seeds.length; i += 1) {
    console.error(`[*] Discovering match links from ${i + 1}/${seeds.length}: ${seeds[i]}`);
    const pageResult = await discoverFromPage(browser, seeds[i], i);
    pages.push(pageResult);
    for (const item of pageResult.discovered) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      all.push(item);
      if (all.length >= maxLinks) break;
    }
    if (all.length >= maxLinks) break;
  }
  await browser.close();

  fs.writeFileSync(outputFile, `${all.map((x) => x.url).join('\n')}\n`);
  const summary = {
    generated_at: new Date().toISOString(),
    seed_links_checked: seeds.length,
    discovered_match_links_count: all.length,
    max_links: maxLinks,
    output_file: path.relative(process.cwd(), outputFile),
    discovered_match_links: all,
    page_details: pages,
    note: 'These are likely match URLs discovered from seed tournament/results pages. The V3 probe must still verify whether each page exposes 1st Set Correct Score, Bet365, and 3-6/4-6/5-7.',
  };
  fs.writeFileSync(path.join(outDir, 'discovered_match_links_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
