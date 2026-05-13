#!/usr/bin/env python3
"""
SlipIQ OddsPortal 1st Set Correct Score scraper.

Read-only. No login. No betting. It tests the Manus #cs;2 idea:
- Open tournament results pages.
- Discover match links.
- Open each match with #cs;2.
- Search visible page text/HTML for bet365 and target first-set scores.
- Save CSV + debug screenshots/text so failures are diagnosable from mobile.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

TARGET_SCORES = ["3-6", "4-6", "5-7"]
TARGET_SCORE_ALIASES = {
    "3-6": ["3-6", "3:6", "3 - 6", "3 : 6"],
    "4-6": ["4-6", "4:6", "4 - 6", "4 : 6"],
    "5-7": ["5-7", "5:7", "5 - 7", "5 : 7"],
}
ODDS_RE = re.compile(r"(?<!\d)(?:[1-9]\d?|\d)\.\d{2}(?!\d)")


@dataclass
class ScrapeRow:
    results_url: str
    match_url: str
    cs_url: str
    title: str
    player1: str | None
    player2: str | None
    first_set_score: str | None
    found_bet365: bool
    odds_p2_3_6: float | None
    odds_p2_4_6: float | None
    odds_p2_5_7: float | None
    grouped_p2_9_12: float | None
    v3_hit: bool | None
    extraction_quality: str
    debug_text_file: str
    screenshot_file: str


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + "/", "", "", ""))


def looks_like_match_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = parsed.netloc.replace("www.", "")
        path = parsed.path.lower()
        if host != "oddsportal.com":
            return False
        if "/tennis/" not in path:
            return False
        bad = ["/results", "/fixtures", "/standings", "/draw", "/outrights", "/rankings", "/news", "/h2h/", "/bookmakers"]
        if any(b in path for b in bad):
            return False
        parts = [p for p in path.split("/") if p]
        if len(parts) < 4:
            return False
        last = parts[-1]
        return "-" in last and not last.isdigit()
    except Exception:
        return False


def discover_match_links(page, results_url: str, max_links: int) -> list[str]:
    page.goto(results_url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(5000)
    # Load more when present, but do not get stuck.
    for _ in range(3):
        clicked = False
        for label in ["Show more matches", "Show more", "More"]:
            try:
                loc = page.get_by_text(label, exact=False).first
                if loc.count() > 0:
                    loc.click(timeout=1500)
                    page.wait_for_timeout(1500)
                    clicked = True
                    break
            except Exception:
                pass
        if not clicked:
            break
    hrefs = page.eval_on_selector_all("a[href]", "els => els.map(a => a.href)")
    out: list[str] = []
    seen: set[str] = set()
    for href in hrefs:
        full = normalize_url(urljoin(results_url, href))
        if looks_like_match_url(full) and full not in seen:
            seen.add(full)
            out.append(full)
            if len(out) >= max_links:
                break
    return out


def parse_players_from_title(title: str) -> tuple[str | None, str | None]:
    # OddsPortal titles often look like "Player A v Player B..."
    clean = re.sub(r"\s+", " ", title).strip()
    m = re.search(r"(.+?)\s+(?:v|vs|-)\s+(.+?)(?:\s+odds|\s+betting|\s+\||$)", clean, re.I)
    if not m:
        return None, None
    return m.group(1).strip(" -|"), m.group(2).strip(" -|")


def grouped_odds(values: list[float | None]) -> float | None:
    if any(v is None or v <= 1 for v in values):
        return None
    implied = sum(1 / float(v) for v in values if v)
    return round(1 / implied, 4) if implied > 0 else None


def find_first_set_score(text: str) -> str | None:
    # Best effort. If not parsed, backtest can still join to external result data later.
    candidates = re.findall(r"\b([0-7])\s*[:\-]\s*([0-7])\b", text)
    for a, b in candidates[:20]:
        ai, bi = int(a), int(b)
        if max(ai, bi) >= 6 and abs(ai - bi) >= 2 or {ai, bi} == {6, 7}:
            return f"{ai}-{bi}"
    return None


def extract_score_price(text: str, html: str, score: str, bookmaker: str) -> tuple[float | None, str]:
    combined = f"{text}\n{BeautifulSoup(html, 'html.parser').get_text('\n')}"
    low = combined.lower()
    bookmaker_low = bookmaker.lower()
    best: float | None = None
    best_context = ""

    # Prefer windows containing both score and bookmaker.
    for alias in TARGET_SCORE_ALIASES[score]:
        for m in re.finditer(re.escape(alias), combined, re.I):
            start = max(0, m.start() - 900)
            end = min(len(combined), m.end() + 900)
            ctx = combined[start:end]
            if bookmaker_low not in ctx.lower():
                # still keep as fallback, but lower confidence
                pass
            odds = [float(x) for x in ODDS_RE.findall(ctx)]
            plausible = [o for o in odds if 1.01 <= o <= 101]
            if plausible:
                # Usually the closest odds after score is the price. Prefer prices not tiny.
                selected = plausible[0]
                if bookmaker_low in ctx.lower():
                    selected = plausible[-1] if len(plausible) <= 4 else plausible[0]
                if best is None or bookmaker_low in ctx.lower():
                    best = selected
                    best_context = re.sub(r"\s+", " ", ctx).strip()[:1200]
                    if bookmaker_low in ctx.lower():
                        return best, best_context
    return best, best_context


def scrape_match(page, results_url: str, match_url: str, bookmaker: str, out_dir: Path, index: int) -> ScrapeRow:
    cs_url = match_url.rstrip("/") + "/#cs;2"
    title = ""
    text = ""
    html = ""
    screenshot_name = f"match_{index:04d}.png"
    text_name = f"match_{index:04d}.txt"
    try:
        page.goto(cs_url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(6500)
        title = page.title()
        text = page.locator("body").inner_text(timeout=7000)
        html = page.content()
        page.screenshot(path=str(out_dir / screenshot_name), full_page=True)
    except PlaywrightTimeoutError as exc:
        text = f"TIMEOUT: {exc}\n{text}"
    except Exception as exc:
        text = f"ERROR: {exc}\n{text}"

    (out_dir / text_name).write_text(text[:250000], encoding="utf-8", errors="ignore")
    p1, p2 = parse_players_from_title(title)
    first_set = find_first_set_score(text)
    found_b365 = bookmaker.lower() in f"{text}\n{html}".lower()

    prices = {}
    contexts = {}
    for score in TARGET_SCORES:
        price, ctx = extract_score_price(text, html, score, bookmaker)
        prices[score] = price
        contexts[score] = ctx

    grouped = grouped_odds([prices["3-6"], prices["4-6"], prices["5-7"]])
    hit = first_set in TARGET_SCORES if first_set else None
    quality = "none"
    if grouped and found_b365:
        quality = "bet365_grouped_found"
    elif any(prices.values()):
        quality = "partial_scores_found"
    elif found_b365:
        quality = "bookmaker_only"

    debug = {
        "match_url": match_url,
        "cs_url": cs_url,
        "title": title,
        "found_bet365": found_b365,
        "first_set_score_best_effort": first_set,
        "prices": prices,
        "contexts": contexts,
    }
    (out_dir / f"match_{index:04d}.debug.json").write_text(json.dumps(debug, indent=2), encoding="utf-8")

    return ScrapeRow(
        results_url=results_url,
        match_url=match_url,
        cs_url=cs_url,
        title=title,
        player1=p1,
        player2=p2,
        first_set_score=first_set,
        found_bet365=found_b365,
        odds_p2_3_6=prices["3-6"],
        odds_p2_4_6=prices["4-6"],
        odds_p2_5_7=prices["5-7"],
        grouped_p2_9_12=grouped,
        v3_hit=hit,
        extraction_quality=quality,
        debug_text_file=text_name,
        screenshot_file=screenshot_name,
    )


def write_csv(path: Path, rows: list[ScrapeRow]) -> None:
    fieldnames = list(asdict(rows[0]).keys()) if rows else [
        "results_url", "match_url", "cs_url", "title", "player1", "player2", "first_set_score",
        "found_bet365", "odds_p2_3_6", "odds_p2_4_6", "odds_p2_5_7", "grouped_p2_9_12",
        "v3_hit", "extraction_quality", "debug_text_file", "screenshot_file"
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls", required=True, help="Comma/newline separated OddsPortal results URLs")
    parser.add_argument("--max-matches", type=int, default=10)
    parser.add_argument("--bookmaker", default="bet365")
    parser.add_argument("--out", default="artifacts/output/oddsportal-cs-scrape")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    results_urls = [u.strip() for u in re.split(r"[\n,|]+", args.results_urls) if u.strip()]

    rows: list[ScrapeRow] = []
    discovered: dict[str, list[str]] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1365, "height": 900},
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            locale="en-US",
        )
        page = context.new_page()
        for results_url in results_urls:
            links = discover_match_links(page, results_url, args.max_matches)
            discovered[results_url] = links
            for link in links[: args.max_matches]:
                print(f"[*] Scraping {len(rows)+1}: {link}#cs;2", flush=True)
                rows.append(scrape_match(page, results_url, link, args.bookmaker, out_dir, len(rows) + 1))
                time.sleep(0.7)
        context.close()
        browser.close()

    write_csv(out_dir / "master_odds_db.csv", rows)
    useful = [r for r in rows if r.grouped_p2_9_12]
    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results_urls": results_urls,
        "discovered_count": sum(len(v) for v in discovered.values()),
        "scraped_matches": len(rows),
        "rows_with_grouped_odds": len(useful),
        "rows_with_bet365": sum(1 for r in rows if r.found_bet365),
        "quality_counts": {q: sum(1 for r in rows if r.extraction_quality == q) for q in sorted({r.extraction_quality for r in rows})},
        "discovered": discovered,
        "next_step": "If rows_with_grouped_odds > 0, upload master_odds_db.csv for V3 reality backtest. If 0, inspect screenshots/debug JSON to adjust selectors.",
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
