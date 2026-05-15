#!/usr/bin/env python3
"""
SlipIQ results-page-driven OddsPortal bet365 V3 scraper.

This is the full historical scraper path. It does NOT require individual match URLs.
Individual match URLs are only used for smoke tests.

Flow:
1. Load cookie/storage session or fallback login.
2. Apply/check OddsPortal bookmaker filter = bet365.
3. Run soft smoke test.
4. Load tournament results URLs from data/oddsportal_major_results_urls.txt.
5. For each results URL, discover historical match links from the page.
6. For each match link, open Correct Score -> 1st Set.
7. Read visible filtered bet365 3:6 / 4:6 / 5:7 prices.
8. Calculate grouped odds.
9. Read first-set result if visible.
10. Append every match immediately to bet365_master_odds_db.csv.
11. Continue through all results pages.

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

EXCLUDED_PATH_PARTS = [
    "/standings", "/draw", "/fixtures", "/results", "/archive", "/rankings",
    "/news", "/players", "/player/", "/teams", "/outrights", "/my-leagues",
    "/calendar", "/settings", "/bookmakers", "/bonus", "/predictions",
]

MATCH_ID_RE = re.compile(r"[A-Za-z0-9]{7,12}")
ODDSPORTAL_ROOT = "https://www.oddsportal.com"


def normalize_market_url(href: str, current_url: str) -> str | None:
    if not href:
        return None
    absolute = urljoin(current_url, href)
    parsed = urlparse(absolute)
    if "oddsportal.com" not in parsed.netloc:
        return None
    if "/tennis/" not in parsed.path:
        return None
    lower_path = parsed.path.lower()
    if any(part in lower_path for part in EXCLUDED_PATH_PARTS):
        return None

    base_url, hash_part = urldefrag(absolute)
    base_url = base_url.rstrip("/") + "/"

    # Preserve a match hash if the results page supplies one. H2H pages often need it.
    clean_hash = ""
    if "#" in absolute:
        clean_hash = absolute.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
    if clean_hash and MATCH_ID_RE.fullmatch(clean_hash):
        return f"{base_url}#{clean_hash}:cs;12"

    # Tournament match URLs often contain a match id at the end of the slug.
    # If not, #cs;12 is still the best market instruction for the page.
    return f"{base_url}#cs;12"


def looks_like_match_link(href: str, text: str, current_url: str) -> bool:
    market_url = normalize_market_url(href, current_url)
    if not market_url:
        return False
    parsed = urlparse(urljoin(current_url, href))
    path = parsed.path.strip("/")
    segments = path.split("/")
    last = segments[-1] if segments else ""
    text_clean = re.sub(r"\s+", " ", text or "").strip()

    # Strong signals.
    if "/h2h/" in parsed.path:
        return True
    if "#" in href and MATCH_ID_RE.search(href.split("#", 1)[1]):
        return True
    if re.search(r"-[A-Za-z0-9]{7,12}$", last):
        return True

    # Result table links usually have a player-vs-player looking label.
    if len(text_clean) >= 5 and re.search(r"\b(vs|v|-)\b", text_clean, re.I):
        return True
    if len(text_clean) >= 8 and len(segments) >= 4 and "-" in last:
        return True
    return False


def click_load_more(page: Page, rounds: int, wait_ms: int) -> int:
    clicked = 0
    patterns = [
        "show more matches", "show more", "load more", "more matches",
        "pokaż więcej", "pokaz wiecej", "więcej", "wiecej",
        "zobacz więcej", "zobacz wiecej",
    ]
    for _ in range(rounds):
        did_click = False
        try:
            did_click = bool(page.evaluate(
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
            did_click = False
        if not did_click:
            break
        clicked += 1
        page.wait_for_timeout(wait_ms)
    return clicked


def scroll_results_page(page: Page, rounds: int, wait_ms: int) -> None:
    for _ in range(rounds):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(600, int(wait_ms / 3)))


def discover_match_urls_from_results(page: Page, results_url: str, wait_ms: int, max_matches: int = 0) -> list[dict[str, str]]:
    base.log(f"Discovering match URLs from tournament results page: {results_url}")
    base.goto(page, results_url, wait_ms)
    scroll_results_page(page, rounds=4, wait_ms=wait_ms)
    clicked = click_load_more(page, rounds=20, wait_ms=wait_ms)
    if clicked:
        base.log(f"Clicked load-more controls {clicked} time(s) on results page.")
        scroll_results_page(page, rounds=3, wait_ms=wait_ms)

    links = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(a => ({ href: a.href || a.getAttribute('href') || '', text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') }))",
    )
    discovered: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in links:
        href = item.get("href", "")
        text = item.get("text", "")
        if not looks_like_match_link(href, text, page.url):
            continue
        market_url = normalize_market_url(href, page.url)
        if not market_url or market_url in seen:
            continue
        seen.add(market_url)
        discovered.append({
            "results_url": results_url,
            "match_url": market_url,
            "link_text": text[:240],
        })
        if max_matches and len(discovered) >= max_matches:
            break
    base.log(f"Discovered {len(discovered)} match URL(s) from {results_url}")
    return discovered


def write_discovered_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["results_url", "match_url", "link_text"])
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def run_soft_smoke(page: Page, out_dir: Path, wait_ms: int, strict: bool) -> tuple[bool, dict[str, Any]]:
    base.log("Running filtered bet365 smoke test before results-page scrape.")
    row = base.scrape_market_page(page, base.PROOF_URL, out_dir, wait_ms)
    (out_dir / "smoke_row.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
    base.save_debug(page, out_dir, "smoke_results_driven_bet365")
    strict_result = smoke_check_row(row)
    result = strict_result if strict else make_soft_smoke_result(strict_result, row)
    (out_dir / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return bool(result.get("ok")), result


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
    results_urls = base.read_urls_file(args.results_urls_file)

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

            smoke_ok, smoke_result = run_soft_smoke(page, out_dir, args.wait_ms, strict=args.strict_smoke)
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

            all_discovered: list[dict[str, str]] = []
            seen: set[str] = set()
            for idx, results_url in enumerate(results_urls, start=1):
                base.log(f"[{idx}/{len(results_urls)}] Processing results URL: {results_url}")
                try:
                    found = discover_match_urls_from_results(
                        page,
                        results_url,
                        args.wait_ms,
                        max_matches=args.max_matches_per_results,
                    )
                except Exception as exc:
                    base.log(f"[{idx}/{len(results_urls)}] Discovery error: {exc}")
                    base.save_debug(page, out_dir, f"discover_error_{idx}")
                    found = []
                for row in found:
                    url = row["match_url"]
                    if url in seen:
                        continue
                    seen.add(url)
                    all_discovered.append(row)
                    if args.limit_total and len(all_discovered) >= args.limit_total:
                        break
                write_discovered_csv(discovered_csv, all_discovered)
                if args.limit_total and len(all_discovered) >= args.limit_total:
                    break

            meta["discovered_match_count"] = len(all_discovered)
            write_discovered_csv(discovered_csv, all_discovered)
            (out_dir / "market_urls.json").write_text(json.dumps([r["match_url"] for r in all_discovered], indent=2), encoding="utf-8")
            base.log(f"Total discovered match URLs to scrape: {len(all_discovered)}")

            status_counts: dict[str, int] = {}
            for idx, item in enumerate(all_discovered, start=1):
                url = item["match_url"]
                base.log(f"[{idx}/{len(all_discovered)}] Scraping match: {url}")
                try:
                    scraped = base.scrape_market_page(page, url, out_dir, args.wait_ms)
                    scraped["source_results_url"] = item.get("results_url", "")
                    scraped["source_link_text"] = item.get("link_text", "")
                except Exception as exc:
                    base.log(f"[{idx}/{len(all_discovered)}] Scrape error: {exc}")
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
                base.append_row_csv(csv_path, scraped)
                status = scraped.get("status", "unknown")
                status_counts[status] = status_counts.get(status, 0) + 1
                meta["rows"] = idx
                meta["status_counts"] = status_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.log(f"[{idx}/{len(all_discovered)}] status={status} p2_grouped={scraped.get('p2_grouped_9_12')} match={scraped.get('match_name')}")
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
