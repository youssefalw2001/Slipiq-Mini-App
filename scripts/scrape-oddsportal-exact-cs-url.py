#!/usr/bin/env python3
"""
SlipIQ exact OddsPortal Correct Score URL scraper.

Use when you already have a working OddsPortal market URL like:
https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12

Read-only. No login. No betting. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

ODDS_RE = re.compile(r"(?<!\d)(?:[1-9]\d?|\d)\.\d{2}(?!\d)")
SCORE_ALIASES = {
    "3-6": ["3-6", "3:6", "3 - 6", "3 : 6"],
    "4-6": ["4-6", "4:6", "4 - 6", "4 : 6"],
    "5-7": ["5-7", "5:7", "5 - 7", "5 : 7"],
    "6-3": ["6-3", "6:3", "6 - 3", "6 : 3"],
    "6-4": ["6-4", "6:4", "6 - 4", "6 : 4"],
    "7-5": ["7-5", "7:5", "7 - 5", "7 : 5"],
}

@dataclass
class Row:
    input_url: str
    final_url: str
    title: str
    bookmaker: str
    found_bookmaker: bool
    found_correct_score_language: bool
    odds_p2_3_6: Optional[float]
    odds_p2_4_6: Optional[float]
    odds_p2_5_7: Optional[float]
    grouped_p2_9_12: Optional[float]
    odds_p1_6_3: Optional[float]
    odds_p1_6_4: Optional[float]
    odds_p1_7_5: Optional[float]
    grouped_p1_9_12: Optional[float]
    extraction_quality: str
    screenshot_file: str
    text_file: str
    debug_file: str


def grouped(vals):
    if any(v is None or v <= 1 for v in vals):
        return None
    return round(1 / sum(1 / float(v) for v in vals), 4)


def compact(s: str, max_len: int = 1400) -> str:
    return re.sub(r"\s+", " ", s or "").strip()[:max_len]


def extract_price_near_score(combined: str, score: str, bookmaker: str):
    bookmaker_low = bookmaker.lower()
    best = None
    best_ctx = ""
    best_quality = 0

    for alias in SCORE_ALIASES[score]:
        for m in re.finditer(re.escape(alias), combined, re.I):
            start = max(0, m.start() - 1200)
            end = min(len(combined), m.end() + 1200)
            ctx = combined[start:end]
            ctx_low = ctx.lower()
            odds = [float(x) for x in ODDS_RE.findall(ctx)]
            odds = [o for o in odds if 1.01 <= o <= 101]
            if not odds:
                continue

            quality = 1
            if bookmaker_low in ctx_low:
                quality += 3
            if "correct score" in ctx_low or "1st set" in ctx_low or "1st set correct score" in ctx_low:
                quality += 1

            # With OddsPortal tables, the odds closest to the score line are often the first or last decimal in the window.
            # Store a context in the debug output so we can verify manually.
            selected = odds[0]
            if bookmaker_low in ctx_low and len(odds) <= 8:
                selected = odds[-1]

            if quality > best_quality:
                best = selected
                best_ctx = compact(ctx)
                best_quality = quality
    return best, best_ctx, best_quality


def maybe_click_accept(page):
    for selector in [
        "#onetrust-accept-btn-handler",
        "#onetrust-reject-all-handler",
        "button:has-text('Accept All')",
        "button:has-text('Reject All')",
        "button:has-text('I Accept')",
    ]:
        try:
            loc = page.locator(selector).first
            if loc.count() > 0:
                loc.click(timeout=1500)
                page.wait_for_timeout(800)
                return
        except Exception:
            pass


def scrape_one(page, url: str, bookmaker: str, out_dir: Path, idx: int) -> Row:
    screenshot = f"exact_cs_{idx:03d}.png"
    text_file = f"exact_cs_{idx:03d}.txt"
    debug_file = f"exact_cs_{idx:03d}.debug.json"
    title = ""
    final_url = url
    text = ""
    html = ""
    responses = []

    def on_response(res):
        try:
            ct = res.headers.get("content-type", "")
            u = res.url
            if "oddsportal.com" not in u:
                return
            if not any(x in ct.lower() for x in ["json", "text", "html", "javascript"]):
                return
            body = res.text()
            low = body.lower()
            if bookmaker.lower() in low or "correct score" in low or "3-6" in low or "4-6" in low or "5-7" in low or "6:3" in low:
                responses.append({"url": u[:500], "status": res.status, "content_type": ct, "sample": compact(body, 4000)})
        except Exception:
            pass

    page.on("response", on_response)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3000)
        maybe_click_accept(page)
        page.wait_for_timeout(9000)
        title = page.title()
        final_url = page.url
        text = page.locator("body").inner_text(timeout=10000)
        html = page.content()
        page.screenshot(path=str(out_dir / screenshot), full_page=True)
    except Exception as exc:
        text = f"ERROR: {exc}\n{text}"

    html_text = BeautifulSoup(html, "html.parser").get_text("\n")
    combined = text + "\n" + html_text + "\n" + "\n".join(r.get("sample", "") for r in responses)
    (out_dir / text_file).write_text(combined[:500000], encoding="utf-8", errors="ignore")

    found_bookmaker = bookmaker.lower() in combined.lower()
    found_correct = any(x in combined.lower() for x in ["correct score", "correct_score", "1st set", "1st set correct score"])

    prices = {}
    contexts = {}
    qualities = {}
    for score in SCORE_ALIASES:
        price, ctx, q = extract_price_near_score(combined, score, bookmaker)
        prices[score] = price
        contexts[score] = ctx
        qualities[score] = q

    g_p2 = grouped([prices["3-6"], prices["4-6"], prices["5-7"]])
    g_p1 = grouped([prices["6-3"], prices["6-4"], prices["7-5"]])

    if g_p2 and found_bookmaker:
        quality = "p2_grouped_found"
    elif g_p1 and found_bookmaker:
        quality = "p1_grouped_found"
    elif any(prices.values()):
        quality = "partial_scores_found"
    elif found_bookmaker:
        quality = "bookmaker_only"
    else:
        quality = "none"

    debug = {
        "input_url": url,
        "final_url": final_url,
        "title": title,
        "found_bookmaker": found_bookmaker,
        "found_correct_score_language": found_correct,
        "prices": prices,
        "qualities": qualities,
        "contexts": contexts,
        "responses": responses[:30],
    }
    (out_dir / debug_file).write_text(json.dumps(debug, indent=2), encoding="utf-8")

    page.remove_listener("response", on_response)
    return Row(
        input_url=url,
        final_url=final_url,
        title=title,
        bookmaker=bookmaker,
        found_bookmaker=found_bookmaker,
        found_correct_score_language=found_correct,
        odds_p2_3_6=prices["3-6"],
        odds_p2_4_6=prices["4-6"],
        odds_p2_5_7=prices["5-7"],
        grouped_p2_9_12=g_p2,
        odds_p1_6_3=prices["6-3"],
        odds_p1_6_4=prices["6-4"],
        odds_p1_7_5=prices["7-5"],
        grouped_p1_9_12=g_p1,
        extraction_quality=quality,
        screenshot_file=screenshot,
        text_file=text_file,
        debug_file=debug_file,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", required=True, help="Comma/newline separated exact OddsPortal market URLs")
    ap.add_argument("--bookmaker", default="bet365")
    ap.add_argument("--out", default="artifacts/output/oddsportal-exact-cs")
    args = ap.parse_args()

    urls = [u.strip() for u in re.split(r"[\n,|]+", args.urls) if u.strip()]
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1400, "height": 1000},
            locale="en-US",
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        )
        page = ctx.new_page()
        for i, url in enumerate(urls, start=1):
            print(f"[*] Scraping exact CS URL {i}/{len(urls)}: {url}", flush=True)
            rows.append(scrape_one(page, url, args.bookmaker, out_dir, i))
        ctx.close()
        browser.close()

    csv_path = out_dir / "exact_cs_master_odds_db.csv"
    fields = list(asdict(rows[0]).keys()) if rows else [f.name for f in Row.__dataclass_fields__.values()]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(asdict(row))

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "urls_checked": len(rows),
        "rows_with_p2_grouped": sum(1 for r in rows if r.grouped_p2_9_12),
        "rows_with_p1_grouped": sum(1 for r in rows if r.grouped_p1_9_12),
        "rows_with_bookmaker": sum(1 for r in rows if r.found_bookmaker),
        "quality_counts": {q: sum(1 for r in rows if r.extraction_quality == q) for q in sorted({r.extraction_quality for r in rows})},
        "output_csv": str(csv_path),
        "note": "P2 grouped uses 3-6/4-6/5-7. P1 grouped uses 6-3/6-4/7-5. Verify screenshot/debug context before trusting prices.",
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
