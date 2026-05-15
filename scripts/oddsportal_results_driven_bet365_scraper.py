#!/usr/bin/env python3
"""
SlipIQ results-page-driven OddsPortal bet365 V3 scraper.

Tournament results URLs are the input. Individual match URLs are smoke/debug only.
This version is intentionally strict about discovery: it only accepts real match-like
links and rejects tournament/category links so route-memory redirects cannot create
fake duplicate backtest rows.

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin, urlparse

from playwright.sync_api import Page, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import (
    clear_oddsportal_route_memory,
    create_cookie_context,
    has_cookie_secret,
    make_soft_smoke_result,
)
from oddsportal_login_filtered_bet365_guarded import proof_match_ok, smoke_check_row

MATCH_ID_RE = re.compile(r"[A-Za-z0-9]{7,12}")
BAD_PATH_PARTS = [
    "/results", "/fixtures", "/standings", "/draw", "/archive", "/rankings",
    "/news", "/players", "/player/", "/teams", "/outrights", "/bookmakers",
    "/bonus", "/predictions", "/calendar", "/settings", "/my-leagues",
]
CATEGORY_TEXT_RE = re.compile(
    r"\b(atp|wta|challenger|itf|doubles|singles|wimbledon|open|masters|rome|madrid|miami|paris|basel|rotterdam|halle|queens|washington|vienna|tokyo|beijing|dubai|acapulco|barcelona)\b",
    re.I,
)


def read_urls(path: str) -> list[str]:
    return base.read_urls_file(path)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


def is_same_h2h_page(requested: str, landed: str) -> bool:
    req = urlparse(requested)
    got = urlparse(landed)
    if "/h2h/" not in req.path:
        return True
    return req.path.rstrip("/") == got.path.rstrip("/")


def normalize_match_url(href: str, current_url: str) -> str | None:
    """Return a first-set correct-score URL only for real match-like links.

    The previous version accepted category links such as /atp-wimbledon/#cs;12.
    Those are unsafe because OddsPortal can route them to the last match page. This
    version only accepts /h2h/... links or links with a real match hash/id.
    """
    if not href:
        return None
    absolute = urljoin(current_url, href)
    parsed = urlparse(absolute)
    if "oddsportal.com" not in parsed.netloc or "/tennis/" not in parsed.path:
        return None
    lower_path = parsed.path.lower()
    if any(part in lower_path for part in BAD_PATH_PARTS):
        return None

    if "#" in absolute:
        raw_hash = absolute.split("#", 1)[1]
        hash_id = raw_hash.split(":", 1)[0].split("?", 1)[0].strip("/")
        if MATCH_ID_RE.fullmatch(hash_id):
            return f"{strip_hash(absolute)}#{hash_id}:cs;12"

    if "/h2h/" in parsed.path:
        return f"{strip_hash(absolute)}#cs;12"

    # Some OddsPortal match links end with a slug id like player-a-player-b-AbC123xY.
    last = parsed.path.strip("/").split("/")[-1]
    if re.search(r"-[A-Za-z0-9]{7,12}$", last) and len(parsed.path.strip("/").split("/")) >= 4:
        return f"{strip_hash(absolute)}#cs;12"

    return None


def looks_like_real_match_link(href: str, text: str, current_url: str) -> bool:
    url = normalize_match_url(href, current_url)
    if not url:
        return False
    parsed = urlparse(urljoin(current_url, href))
    text_clean = clean_text(text)

    # Reject obvious category links even if they slipped through path checks.
    if CATEGORY_TEXT_RE.search(text_clean) and "/h2h/" not in parsed.path and "#" not in href:
        return False
    if re.search(r"\(\d+\)\s*$", text_clean):
        return False

    # Accept strongest match signals only.
    if "/h2h/" in parsed.path:
        return True
    if "#" in href and MATCH_ID_RE.search(href.split("#", 1)[1]):
        return True
    last = parsed.path.strip("/").split("/")[-1]
    if re.search(r"-[A-Za-z0-9]{7,12}$", last):
        return True
    return False


def scroll_and_expand(page: Page, wait_ms: int) -> int:
    clicked = 0
    patterns = [
        "show more matches", "show more", "load more", "more matches",
        "pokaż więcej", "pokaz wiecej", "więcej", "wiecej",
        "zobacz więcej", "zobacz wiecej",
    ]
    for _ in range(4):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(700, wait_ms // 3))
    for _ in range(20):
        try:
            did = bool(page.evaluate(
                """
                (patterns) => {
                  const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                  };
                  for (const el of nodes) {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (!txt || !visible(el)) continue;
                    if (patterns.some(p => txt.includes(p))) {
                      el.click();
                      return true;
                    }
                  }
                  return false;
                }
                """,
                patterns,
            ))
        except Exception:
            did = False
        if not did:
            break
        clicked += 1
        page.wait_for_timeout(wait_ms)
    return clicked


def discover_match_urls_from_results(page: Page, results_url: str, wait_ms: int, max_matches: int = 0) -> list[dict[str, str]]:
    base.log(f"Discovering match URLs from tournament results page: {results_url}")
    base.goto(page, results_url, wait_ms)
    clicked = scroll_and_expand(page, wait_ms)
    if clicked:
        base.log(f"Clicked load-more controls {clicked} time(s).")

    links = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(a => ({ href: a.href || a.getAttribute('href') || '', text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') }))",
    )
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    rejected_matchish = 0
    for item in links:
        href = item.get("href", "")
        text = item.get("text", "")
        if not looks_like_real_match_link(href, text, page.url):
            if normalize_match_url(href, page.url):
                rejected_matchish += 1
            continue
        match_url = normalize_match_url(href, page.url)
        if not match_url or match_url in seen:
            continue
        seen.add(match_url)
        rows.append({"results_url": results_url, "match_url": match_url, "link_text": clean_text(text)[:240]})
        if max_matches and len(rows) >= max_matches:
            break
    base.log(f"Discovered {len(rows)} real match URL(s); rejected {rejected_matchish} unsafe tennis link(s).")
    return rows


def write_discovered_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["results_url", "match_url", "link_text"])
        writer.writeheader()
        writer.writerows(rows)


def run_smoke(page: Page, out_dir: Path, wait_ms: int, strict: bool) -> tuple[bool, dict[str, Any]]:
    base.log("Running filtered bet365 smoke test.")
    row = base.scrape_market_page(page, base.PROOF_URL, out_dir, wait_ms)
    (out_dir / "smoke_row.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
    base.save_debug(page, out_dir, "smoke_results_driven_bet365")
    strict_result = smoke_check_row(row)
    result = strict_result if strict else make_soft_smoke_result(strict_result, row)
    (out_dir / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return bool(result.get("ok")), result


def append_scrape_row(csv_path: Path, row: dict[str, str]) -> None:
    base.append_row_csv(csv_path, row)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-login-filtered-bet365")
    parser.add_argument("--limit-total", type=int, default=0, help="0 means no total cap")
    parser.add_argument("--max-matches-per-results", type=int, default=0, help="0 means all discovered per results page")
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--pause-seconds", type=float, default=1.5)
    parser.add_argument("--smoke-only", action="store_true")
    parser.add_argument("--strict-smoke", action="store_true")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    base.ensure_dir(out_dir)
    csv_path = out_dir / "bet365_master_odds_db.csv"
    discovered_csv = out_dir / "discovered_match_urls.csv"
    results_urls = read_urls(args.results_urls_file)

    meta: dict[str, Any] = {
        "generated_at": base.now_iso(),
        "args": vars(args),
        "results_url_count": len(results_urls),
        "discovered_match_count": 0,
        "rows": 0,
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "smoke_ok": False,
        "smoke_policy": "strict" if args.strict_smoke else "soft_any_match",
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret; skipping username/password login.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 3

            base.apply_bet365_filter(page, out_dir, args.wait_ms)
            clear_oddsportal_route_memory(context, page, args.wait_ms)
            smoke_ok, smoke_result = run_smoke(page, out_dir, args.wait_ms, strict=args.strict_smoke)
            meta["smoke_ok"] = smoke_ok
            meta["smoke_reason"] = smoke_result.get("reason")
            meta["proof_match_ok"] = proof_match_ok(smoke_result.get("row", {}))
            if not smoke_ok:
                meta["stop_reason"] = smoke_result.get("reason", "SMOKE_FAILED")
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            if args.smoke_only:
                meta["stop_reason"] = "SMOKE_ONLY_COMPLETE"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 0

            all_found: list[dict[str, str]] = []
            seen: set[str] = set()
            for i, results_url in enumerate(results_urls, start=1):
                base.log(f"[{i}/{len(results_urls)}] Results page: {results_url}")
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    found = discover_match_urls_from_results(page, results_url, args.wait_ms, args.max_matches_per_results)
                except Exception as exc:
                    base.log(f"Discovery error on {results_url}: {exc}")
                    base.save_debug(page, out_dir, f"discover_error_{i}")
                    found = []
                for row in found:
                    if row["match_url"] in seen:
                        continue
                    seen.add(row["match_url"])
                    all_found.append(row)
                    if args.limit_total and len(all_found) >= args.limit_total:
                        break
                write_discovered_csv(discovered_csv, all_found)
                if args.limit_total and len(all_found) >= args.limit_total:
                    break

            meta["discovered_match_count"] = len(all_found)
            write_discovered_csv(discovered_csv, all_found)
            (out_dir / "market_urls.json").write_text(json.dumps([r["match_url"] for r in all_found], indent=2), encoding="utf-8")
            base.log(f"Total real match URLs to scrape: {len(all_found)}")

            status_counts: dict[str, int] = {}
            landed_seen: set[str] = set()
            for idx, item in enumerate(all_found, start=1):
                url = item["match_url"]
                base.log(f"[{idx}/{len(all_found)}] Scraping match: {url}")
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    scraped = base.scrape_market_page(page, url, out_dir, args.wait_ms)
                    if not is_same_h2h_page(url, scraped.get("market_url", "")):
                        scraped["status"] = "redirect_mismatch"
                    if scraped.get("market_url") in landed_seen:
                        scraped["status"] = "duplicate_market_url"
                    landed_seen.add(scraped.get("market_url", ""))
                except Exception as exc:
                    base.log(f"Scrape error on {url}: {exc}")
                    base.save_debug(page, out_dir, f"scrape_error_{idx}")
                    scraped = {
                        "scraped_at": base.now_iso(),
                        "input_url": url,
                        "market_url": page.url if page else url,
                        "match_name": "",
                        "title": "",
                        "first_set_score": "",
                        "bet365_confirmed_count": "0",
                        "bet365_all_score_count": "0",
                        "status": "error",
                    }
                append_scrape_row(csv_path, scraped)
                status = scraped.get("status", "unknown")
                status_counts[status] = status_counts.get(status, 0) + 1
                meta["rows"] = idx
                meta["status_counts"] = status_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.log(f"[{idx}/{len(all_found)}] status={status} grouped={scraped.get('p2_grouped_9_12')} match={scraped.get('match_name')}")
                time.sleep(args.pause_seconds)

            meta["stop_reason"] = "SCRAPE_COMPLETE"
            (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            return 0
        finally:
            try:
                context.storage_state(path=str(out_dir / "last_storage_state.json"))
            except Exception:
                pass
            context.close()
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
