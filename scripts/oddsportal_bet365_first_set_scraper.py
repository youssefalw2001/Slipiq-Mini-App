#!/usr/bin/env python3
"""
SlipIQ OddsPortal bet365 1st Set Correct Score scraper.

Read-only browser automation. No login. No betting. No captcha bypass.

Known proven method:
1. Open an OddsPortal tennis 1st Set Correct Score market URL.
2. Find an exact score row by BOTH score and visible odds, for example: "4:6 3 +3000".
3. Click the far-left side / arrow of that exact row.
4. Search only near the expanded row for a compact element containing bet365.
5. Extract bet365 odds, convert American odds to decimal, and calculate grouped odds.

Smoke-test URL:
https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

TARGETS = [
    {"score": "3:6", "side": "p2", "field": "p2_3_6"},
    {"score": "4:6", "side": "p2", "field": "p2_4_6"},
    {"score": "5:7", "side": "p2", "field": "p2_5_7"},
    {"score": "6:3", "side": "p1", "field": "p1_6_3"},
    {"score": "6:4", "side": "p1", "field": "p1_6_4"},
    {"score": "7:5", "side": "p1", "field": "p1_7_5"},
]

CSV_FIELDS = [
    "scraped_at",
    "source_results_url",
    "input_url",
    "market_url",
    "final_url",
    "title",
    "match_name",
    "first_set_score",
    "bet365_confirmed_count",
    "p2_3_6_raw",
    "p2_3_6_decimal",
    "p2_4_6_raw",
    "p2_4_6_decimal",
    "p2_5_7_raw",
    "p2_5_7_decimal",
    "p2_grouped_9_12",
    "p2_v3_hit",
    "p1_6_3_raw",
    "p1_6_3_decimal",
    "p1_6_4_raw",
    "p1_6_4_decimal",
    "p1_7_5_raw",
    "p1_7_5_decimal",
    "p1_grouped_9_12",
    "p1_hit",
    "status",
    "note",
]

DECIMAL_RE = re.compile(r"(?<!\d)(?:[1-9]\d?|\d)\.\d{2}(?!\d)")
AMERICAN_RE = re.compile(r"(?<![\w.])([+-](?:[1-9]\d{2,5}))(?![\w.])")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def read_lines_file(path: str | None) -> list[str]:
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        return []
    out: list[str] = []
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def read_split(value: str | None) -> list[str]:
    if not value:
        return []
    out = []
    for chunk in re.split(r"[\n,|]+", value):
        chunk = chunk.strip()
        if chunk:
            out.append(chunk)
    return out


def american_to_decimal(raw: str) -> float | None:
    try:
        n = int(str(raw).replace("+", ""))
    except Exception:
        return None
    if n > 0:
        return round(1 + n / 100, 4)
    if n < 0:
        return round(1 + 100 / abs(n), 4)
    return None


def odds_tokens(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in DECIMAL_RE.finditer(text or ""):
        dec = float(m.group(0))
        if 1.01 <= dec <= 1000:
            out.append({"raw": m.group(0), "decimal": dec, "kind": "decimal", "pos": m.start()})
    for m in AMERICAN_RE.finditer(text or ""):
        dec = american_to_decimal(m.group(1))
        if dec and 1.01 <= dec <= 1000:
            out.append({"raw": m.group(1), "decimal": dec, "kind": "american", "pos": m.start()})
    return sorted(out, key=lambda x: x["pos"])


def grouped(values: list[float | None]) -> float | None:
    if any(v is None or v <= 1 for v in values):
        return None
    return round(1 / sum(1 / float(v) for v in values if v), 4)


def normalize_url(url: str) -> str:
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, p.path.rstrip("/") + "/", "", "", p.fragment))


def looks_like_tennis_match(url: str) -> bool:
    try:
        p = urlparse(url)
        host = p.netloc.replace("www.", "")
        path = p.path.lower()
        if host != "oddsportal.com" or "/tennis/" not in path:
            return False
        blocked = [
            "/results",
            "/fixtures",
            "/standings",
            "/draw",
            "/outrights",
            "/rankings",
            "/news",
            "/bookmakers",
            "/odds/",
        ]
        if any(x in path for x in blocked):
            return False
        parts = [x for x in path.split("/") if x]
        return len(parts) >= 4 and "-" in parts[-1]
    except Exception:
        return False


def extract_first_set_score(text: str) -> str:
    m = re.search(r"Final result.*?\(([0-7]\s*[:\-]\s*[0-7])", text or "", re.I | re.S)
    if m:
        return re.sub(r"\s+", "", m.group(1)).replace("-", ":")
    m = re.search(r"\(([0-7]\s*[:\-]\s*[0-7])\s*,", text or "")
    if m:
        return re.sub(r"\s+", "", m.group(1)).replace("-", ":")
    return ""


def extract_match_name(title: str, text: str) -> str:
    m = re.search(r"Home\s*>\s*Tennis\s*>.*?>\s*([^\n]+?\s*-\s*[^\n]+?)\s+Home/Away", text or "", re.I | re.S)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()
    if " Odds" in title:
        return title.split(" Odds", 1)[0].strip()
    return title.strip()


def ensure_csv(csv_path: Path) -> None:
    if csv_path.exists():
        return
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()


def append_csv(csv_path: Path, row: dict[str, Any]) -> None:
    ensure_csv(csv_path)
    safe = {field: row.get(field, "") for field in CSV_FIELDS}
    with csv_path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writerow(safe)


def read_scraped_urls(csv_path: Path) -> set[str]:
    if not csv_path.exists():
        return set()
    out = set()
    try:
        with csv_path.open("r", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                for key in ("market_url", "input_url"):
                    if row.get(key):
                        out.add(row[key])
    except Exception:
        return set()
    return out


async def accept_cookies(page) -> None:
    for selector in [
        "#onetrust-accept-btn-handler",
        "#onetrust-reject-all-handler",
        "button:has-text('Accept All')",
        "button:has-text('Reject All')",
        "button:has-text('Accept')",
    ]:
        try:
            loc = page.locator(selector).first
            if await loc.count() > 0:
                await loc.click(timeout=2000)
                await page.wait_for_timeout(1000)
                return
        except Exception:
            pass


async def click_market_tabs(page) -> None:
    # Click top-level Correct Score and sub-market 1st Set if visible.
    for label in ["Correct Score", "1st Set"]:
        try:
            loc = page.get_by_text(label, exact=True)
            count = await loc.count()
            for i in range(min(count, 4)):
                try:
                    item = loc.nth(i)
                    if await item.is_visible(timeout=1000):
                        await item.click(timeout=2500)
                        await page.wait_for_timeout(1400)
                        break
                except Exception:
                    pass
        except Exception:
            pass


async def goto_market(page, url: str, wait_ms: int) -> tuple[str, str, str]:
    await page.goto(url, wait_until="networkidle", timeout=90000)
    await page.wait_for_timeout(wait_ms)
    await accept_cookies(page)
    await click_market_tabs(page)
    await page.wait_for_timeout(2500)
    title = await page.title()
    text = await page.locator("body").inner_text(timeout=15000)
    return title, text, page.url


async def discover_match_links(page, results_url: str, max_matches: int, wait_ms: int, out_dir: Path, index: int) -> list[str]:
    print(f"[*] Discovering match links from {results_url}", flush=True)
    try:
        await page.goto(results_url, wait_until="networkidle", timeout=90000)
        await page.wait_for_timeout(wait_ms)
        await accept_cookies(page)
        for _ in range(4):
            clicked = False
            for label in ["Show more matches", "Show more", "More"]:
                try:
                    loc = page.get_by_text(label, exact=False).first
                    if await loc.count() > 0 and await loc.is_visible(timeout=1000):
                        await loc.click(timeout=2500)
                        await page.wait_for_timeout(1500)
                        clicked = True
                        break
                except Exception:
                    pass
            if not clicked:
                break
        if index % 3 == 0:
            await page.screenshot(path=str(out_dir / f"discover_{index:03d}.png"), full_page=True)
        hrefs = await page.eval_on_selector_all("a[href]", "els => els.map(a => a.href)")
        seen: set[str] = set()
        links: list[str] = []
        for href in hrefs:
            u = normalize_url(urljoin(results_url, href))
            if looks_like_tennis_match(u) and u not in seen:
                seen.add(u)
                links.append(u)
                if len(links) >= max_matches:
                    break
        print(f"    found {len(links)} links", flush=True)
        return links
    except Exception as e:
        print(f"    discovery failed: {str(e)[:250]}", flush=True)
        return []


async def resolve_market_url(page, match_url: str, wait_ms: int) -> str:
    if ":cs;" in match_url:
        return match_url
    try:
        title, text, final_url = await goto_market(page, match_url, wait_ms)
        if all(s in text for s in ["3:6", "4:6", "5:7"]):
            return final_url
        html = await page.content()
        combined = text + "\n" + html
        base = match_url.split("#", 1)[0].rstrip("/") + "/"
        m = re.search(r"#([A-Za-z0-9]+:cs;12)", combined)
        if m:
            return base + "#" + m.group(1)
        m = re.search(r"#([A-Za-z0-9]+:cs;\d+)", combined)
        if m:
            return base + "#" + m.group(1)
        # If tabs were selected but hash did not show in HTML, keep final URL only if score rows are visible.
        return ""
    except Exception:
        return ""


async def visible_score_prices(page) -> tuple[dict[str, dict[str, Any]], str]:
    text = await page.locator("body").inner_text(timeout=15000)
    prices: dict[str, dict[str, Any]] = {}
    for target in TARGETS:
        score = target["score"]
        m = re.search(rf"\b{re.escape(score)}\s+\d+\s+([+-]\d+|\d+\.\d{{2}})\b", text)
        if m:
            raw = m.group(1)
            dec = american_to_decimal(raw) if raw.startswith(("+", "-")) else float(raw)
            prices[score] = {"raw": raw, "decimal": dec}
    return prices, text


async def find_and_click_exact_score_row(page, score: str, visible_raw: str) -> dict[str, Any] | None:
    candidates = await page.evaluate(
        """
        ({score, visibleRaw}) => {
          const out = [];
          const els = [...document.querySelectorAll('*')];
          function visible(el) {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
          }
          for (const el of els) {
            if (!visible(el)) continue;
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (text.includes(score) && text.includes(visibleRaw)) {
              const r = el.getBoundingClientRect();
              out.push({ tag: el.tagName, text, x: r.x, y: r.y, w: r.width, h: r.height, len: text.length });
            }
          }
          return out
            .filter(x => x.w > 300 && x.h >= 20 && x.h < 130 && x.len < 350)
            .sort((a,b) => a.len - b.len || a.y - b.y)
            .slice(0, 20);
        }
        """,
        {"score": score, "visibleRaw": visible_raw},
    )
    if not candidates:
        return None
    row = candidates[0]
    click_x = max(8, row["x"] + 20)
    click_y = row["y"] + row["h"] / 2
    await page.mouse.click(click_x, click_y)
    await page.wait_for_timeout(3000)
    return row


async def extract_bet365_near_y(page, row_y: float, bookmaker: str) -> dict[str, Any] | None:
    result = await page.evaluate(
        """
        ({rowY, bookmaker}) => {
          const out = [];
          const bookieRe = new RegExp(bookmaker, 'i');
          function meta(el) {
            const imgs = [...el.querySelectorAll('img')].map(img => [img.alt || '', img.title || '', img.src || ''].join(' ')).join(' ');
            return [el.innerText || '', imgs, el.getAttribute('alt') || '', el.getAttribute('title') || '', el.getAttribute('src') || '', el.outerHTML || ''].join(' ');
          }
          function visible(el) {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
          }
          const els = [...document.querySelectorAll('*')];
          for (const el of els) {
            if (!visible(el)) continue;
            const raw = meta(el);
            if (!bookieRe.test(raw)) continue;
            const r = el.getBoundingClientRect();
            if (r.y < rowY - 30 || r.y > rowY + 700) continue;
            let cur = el;
            for (let depth = 0; depth < 8 && cur; depth++, cur = cur.parentElement) {
              if (!visible(cur)) continue;
              const cr = cur.getBoundingClientRect();
              const text = (cur.innerText || '').replace(/\s+/g, ' ').trim();
              const html = (cur.outerHTML || '').slice(0, 9000);
              const all = (text + ' ' + html).replace(/\s+/g, ' ').trim();
              if (cr.y < rowY - 30 || cr.y > rowY + 700) continue;
              if (cr.width < 100 || cr.height < 10 || cr.height > 180) continue;
              if (!bookieRe.test(all)) continue;
              out.push({ depth, tag: cur.tagName, x: cr.x, y: cr.y, w: cr.width, h: cr.height, text, html, all: all.slice(0, 3500), size: all.length });
            }
          }
          return out.sort((a,b) => a.size - b.size || Math.abs(a.y - rowY) - Math.abs(b.y - rowY)).slice(0, 50);
        }
        """,
        {"rowY": row_y, "bookmaker": bookmaker},
    )
    best = None
    for c in result:
        html_text = BeautifulSoup(c.get("html", ""), "html.parser").get_text(" ")
        merged = (c.get("text", "") + " " + html_text).replace("\n", " ")
        tokens = odds_tokens(merged)
        decimal_tokens = [t for t in tokens if t["kind"] == "decimal"]
        selected = decimal_tokens[0] if decimal_tokens else (tokens[0] if tokens else None)
        if selected:
            candidate = {
                "raw": selected["raw"],
                "decimal": selected["decimal"],
                "kind": selected["kind"],
                "candidate_text": re.sub(r"\s+", " ", merged).strip()[:1200],
                "candidate_size": c.get("size", 999999),
            }
            if best is None or candidate["candidate_size"] < best["candidate_size"]:
                best = candidate
    return best


def empty_row(source: str, url: str, status: str, note: str) -> dict[str, Any]:
    row = {field: "" for field in CSV_FIELDS}
    row.update(
        {
            "scraped_at": now_iso(),
            "source_results_url": source,
            "input_url": url,
            "market_url": url,
            "bet365_confirmed_count": 0,
            "status": status,
            "note": note[:500],
        }
    )
    return row


async def scrape_one_market(browser, market_url: str, source_results_url: str, idx: int, args) -> dict[str, Any]:
    context = await browser.new_context(
        viewport={"width": 1500, "height": 1200},
        locale="en-US",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    )
    page = await context.new_page()
    try:
        title, text, final_url = await goto_market(page, market_url, args.wait_ms)
        visible_prices, page_text = await visible_score_prices(page)
        text = page_text
        html = await page.content()
        match_name = extract_match_name(title, text)
        first_set_score = extract_first_set_score(text)

        if args.debug_every > 0 and idx % args.debug_every == 0:
            await page.screenshot(path=str(Path(args.out) / f"market_{idx:05d}.png"), full_page=True)

        if not visible_prices:
            debug = {"market_url": market_url, "title": title, "final_url": final_url, "text_sample": text[:5000], "html_sample": html[:5000]}
            (Path(args.out) / f"failed_no_visible_prices_{idx:05d}.json").write_text(json.dumps(debug, indent=2), encoding="utf-8")
            await context.close()
            return empty_row(source_results_url, market_url, "no_visible_prices", "Could not find 1st Set Correct Score visible score rows")

        score_results: dict[str, dict[str, Any]] = {}
        for target in TARGETS:
            score = target["score"]
            field = target["field"]
            visible = visible_prices.get(score)
            if not visible:
                score_results[field] = {"raw": "", "decimal": None, "confirmed": False}
                continue

            # Reload for a clean expanded state per score.
            await goto_market(page, market_url, args.wait_ms)
            await page.wait_for_timeout(1200)
            row = await find_and_click_exact_score_row(page, score, visible["raw"])
            if not row:
                score_results[field] = {"raw": "", "decimal": None, "confirmed": False}
                continue

            bet365 = await extract_bet365_near_y(page, row["y"], args.bookmaker)
            if bet365:
                score_results[field] = {"raw": bet365["raw"], "decimal": bet365["decimal"], "confirmed": True}
            else:
                score_results[field] = {"raw": "", "decimal": None, "confirmed": False}

        p2_group = grouped(
            [
                score_results.get("p2_3_6", {}).get("decimal"),
                score_results.get("p2_4_6", {}).get("decimal"),
                score_results.get("p2_5_7", {}).get("decimal"),
            ]
        )
        p1_group = grouped(
            [
                score_results.get("p1_6_3", {}).get("decimal"),
                score_results.get("p1_6_4", {}).get("decimal"),
                score_results.get("p1_7_5", {}).get("decimal"),
            ]
        )
        confirmed_count = sum(1 for v in score_results.values() if v.get("confirmed"))
        status = "ok" if confirmed_count == 6 else ("p2_ok" if all(score_results.get(f, {}).get("confirmed") for f in ["p2_3_6", "p2_4_6", "p2_5_7"]) else "partial")

        row = {
            "scraped_at": now_iso(),
            "source_results_url": source_results_url,
            "input_url": market_url,
            "market_url": market_url,
            "final_url": final_url,
            "title": title,
            "match_name": match_name,
            "first_set_score": first_set_score,
            "bet365_confirmed_count": confirmed_count,
            "p2_3_6_raw": score_results.get("p2_3_6", {}).get("raw", ""),
            "p2_3_6_decimal": score_results.get("p2_3_6", {}).get("decimal"),
            "p2_4_6_raw": score_results.get("p2_4_6", {}).get("raw", ""),
            "p2_4_6_decimal": score_results.get("p2_4_6", {}).get("decimal"),
            "p2_5_7_raw": score_results.get("p2_5_7", {}).get("raw", ""),
            "p2_5_7_decimal": score_results.get("p2_5_7", {}).get("decimal"),
            "p2_grouped_9_12": p2_group,
            "p2_v3_hit": first_set_score in ["3:6", "4:6", "5:7"] if first_set_score else "",
            "p1_6_3_raw": score_results.get("p1_6_3", {}).get("raw", ""),
            "p1_6_3_decimal": score_results.get("p1_6_3", {}).get("decimal"),
            "p1_6_4_raw": score_results.get("p1_6_4", {}).get("raw", ""),
            "p1_6_4_decimal": score_results.get("p1_6_4", {}).get("decimal"),
            "p1_7_5_raw": score_results.get("p1_7_5", {}).get("raw", ""),
            "p1_7_5_decimal": score_results.get("p1_7_5", {}).get("decimal"),
            "p1_grouped_9_12": p1_group,
            "p1_hit": first_set_score in ["6:3", "6:4", "7:5"] if first_set_score else "",
            "status": status,
            "note": "",
        }
        await context.close()
        return row
    except PlaywrightTimeoutError as e:
        await context.close()
        return empty_row(source_results_url, market_url, "timeout", str(e))
    except Exception as e:
        await context.close()
        return empty_row(source_results_url, market_url, "error", str(e))


async def run(args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "bet365_master_odds_db.csv"
    progress_path = out_dir / "progress.json"
    summary_path = out_dir / "summary.json"
    ensure_csv(csv_path)

    exact_urls = read_lines_file(args.exact_urls_file) + read_split(args.exact_urls)
    results_urls = read_lines_file(args.results_urls_file) + read_split(args.results_urls)
    work: list[dict[str, str]] = [{"source": "exact_input", "url": u} for u in exact_urls]

    scraped_urls = read_scraped_urls(csv_path)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])

        if results_urls:
            discovery_context = await browser.new_context(
                viewport={"width": 1500, "height": 1200},
                locale="en-US",
                user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            )
            discovery_page = await discovery_context.new_page()
            for r_idx, results_url in enumerate(results_urls, start=1):
                if len(work) >= args.limit_total:
                    break
                match_links = await discover_match_links(discovery_page, results_url, args.max_matches_per_results, args.wait_ms, out_dir, r_idx)
                for match_url in match_links:
                    if len(work) >= args.limit_total:
                        break
                    market_url = await resolve_market_url(discovery_page, match_url, args.wait_ms)
                    if market_url:
                        print(f"    resolved market: {market_url}", flush=True)
                        work.append({"source": results_url, "url": market_url})
            await discovery_context.close()

        # Deduplicate and cap.
        deduped: list[dict[str, str]] = []
        seen = set()
        for item in work:
            if item["url"] not in seen:
                seen.add(item["url"])
                deduped.append(item)
        deduped = deduped[: args.limit_total]

        print(f"[*] Total market URLs to scrape: {len(deduped)}", flush=True)
        completed_this_run = 0
        for idx, item in enumerate(deduped, start=1):
            url = item["url"]
            if url in scraped_urls:
                print(f"[{idx}/{len(deduped)}] skip already scraped", flush=True)
                continue
            print(f"[{idx}/{len(deduped)}] scraping {url}", flush=True)
            row = await scrape_one_market(browser, url, item["source"], idx, args)
            append_csv(csv_path, row)
            completed_this_run += 1
            progress_path.write_text(
                json.dumps(
                    {
                        "updated_at": now_iso(),
                        "total_market_urls": len(deduped),
                        "completed_this_run": completed_this_run,
                        "last_url": url,
                        "last_status": row.get("status"),
                        "last_confirmed_count": row.get("bet365_confirmed_count"),
                        "csv_path": str(csv_path),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            print(
                "   status:",
                row.get("status"),
                "confirmed:",
                row.get("bet365_confirmed_count"),
                "p2_group:",
                row.get("p2_grouped_9_12"),
                "first_set:",
                row.get("first_set_score"),
                flush=True,
            )
            await asyncio.sleep(args.pause_seconds)

        await browser.close()

    rows: list[dict[str, str]] = []
    if csv_path.exists():
        with csv_path.open("r", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))

    def to_float(x: Any) -> float | None:
        try:
            if x in (None, "", "None"):
                return None
            v = float(x)
            if math.isnan(v):
                return None
            return v
        except Exception:
            return None

    p2_rows = [r for r in rows if to_float(r.get("p2_grouped_9_12"))]
    p2_hits = [r for r in p2_rows if str(r.get("p2_v3_hit")).lower() == "true"]
    ok_rows = [r for r in rows if r.get("status") in ("ok", "p2_ok")]
    summary = {
        "generated_at": now_iso(),
        "csv_path": str(csv_path),
        "total_rows": len(rows),
        "ok_or_p2_ok_rows": len(ok_rows),
        "full_6_score_rows": sum(1 for r in rows if str(r.get("bet365_confirmed_count")) == "6"),
        "p2_grouped_rows": len(p2_rows),
        "p2_hits": len(p2_hits),
        "p2_hit_rate": round(len(p2_hits) / len(p2_rows), 4) if p2_rows else None,
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("\nFINAL SCRAPE SUMMARY")
    print(json.dumps(summary, indent=2), flush=True)

    if args.smoke_test:
        if not rows:
            print("Smoke test failed: no rows", file=sys.stderr)
            return 2
        last = rows[-1]
        p2_group = to_float(last.get("p2_grouped_9_12"))
        p1_group = to_float(last.get("p1_grouped_9_12"))
        confirmed = int(float(last.get("bet365_confirmed_count") or 0))
        checks = [
            confirmed == 6,
            p2_group is not None and 10.5 <= p2_group <= 12.5,
            p1_group is not None and 1.5 <= p1_group <= 2.0,
            last.get("p2_3_6_raw") in ("+6600", "67.00", "67"),
            last.get("p2_4_6_raw") in ("+1800", "19.00", "19"),
            last.get("p2_5_7_raw") in ("+5000", "51.00", "51"),
        ]
        if not all(checks):
            print("Smoke test failed", file=sys.stderr)
            print(json.dumps(last, indent=2), file=sys.stderr)
            return 2
        print("Smoke test passed", flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exact-urls-file", default="")
    ap.add_argument("--exact-urls", default="")
    ap.add_argument("--results-urls-file", default="")
    ap.add_argument("--results-urls", default="")
    ap.add_argument("--limit-total", type=int, default=25)
    ap.add_argument("--max-matches-per-results", type=int, default=25)
    ap.add_argument("--out", default="artifacts/output/oddsportal-bet365-first-set")
    ap.add_argument("--bookmaker", default="bet365")
    ap.add_argument("--wait-ms", type=int, default=4500)
    ap.add_argument("--pause-seconds", type=float, default=1.2)
    ap.add_argument("--debug-every", type=int, default=10)
    ap.add_argument("--smoke-test", action="store_true")
    return ap.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(parse_args())))
