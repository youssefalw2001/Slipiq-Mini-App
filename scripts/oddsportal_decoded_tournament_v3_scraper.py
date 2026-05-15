#!/usr/bin/env python3
"""
SlipIQ decoded OddsPortal tournament V3 scraper.

Discovery phase does NOT apply the bet365 filter. Decode phase applies/checks it only
when opening actual match pages. This prevents tournament results pages from being
redirected to /bookmakers/ during match discovery.

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

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_decoded_v3_probe import PROVIDER_BET365, TARGET_P1, TARGET_P2, decode_oddsportal_dat, decimal_grouped, score_odds, tier_for_grouped

BAD_PATH_PARTS = ["/results", "/fixtures", "/standings", "/draw", "/archive", "/rankings", "/news", "/players", "/player/", "/teams", "/outrights", "/bookmakers", "/bonus", "/predictions", "/calendar", "/settings", "/my-leagues"]
BAD_LANDED_PARTS = ["/bookmakers/", "/bookmakers"]
CATEGORY_TEXT_RE = re.compile(r"\b(atp|wta|challenger|itf|doubles|singles|wimbledon|open|masters|rome|madrid|miami|paris|basel|rotterdam|halle|queens|washington|vienna|tokyo|beijing|dubai|acapulco|barcelona)\b", re.I)
HASH_RE = re.compile(r"[A-Za-z0-9]{7,12}")
VALID_SET_SCORES = {"6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6", "0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7"}
P2_HIT_SCORES = {"3:6", "4:6", "5:7"}
P1_HIT_SCORES = {"6:3", "6:4", "7:5"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


def is_bad_landed_results_url(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower().rstrip("/") + "/"
    return any(path.startswith(p.rstrip("/") + "/") for p in BAD_LANDED_PARTS) or "/tennis/" not in path or "/results/" not in path


def extract_url_hash(url: str) -> str:
    if "#" in url:
        h = url.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
        if HASH_RE.fullmatch(h):
            return h
    parsed = urlparse(url)
    last = parsed.path.strip("/").split("/")[-1]
    m = re.search(r"-([A-Za-z0-9]{7,12})$", last)
    return m.group(1) if m else ""


def endpoint_hash(endpoint_url: str) -> str:
    m = re.search(r"/match-event/[^/]*?([A-Za-z0-9]{7,12})-[0-9]+-[0-9]+-", endpoint_url)
    if m:
        return m.group(1)
    m = re.search(r"/match-event/[^/]+-([A-Za-z0-9]{7,12})-", endpoint_url)
    return m.group(1) if m else ""


def normalize_match_url(href: str, current_url: str) -> str | None:
    if not href:
        return None
    absolute = urljoin(current_url, href)
    parsed = urlparse(absolute)
    if "oddsportal.com" not in parsed.netloc or "/tennis/" not in parsed.path:
        return None
    lower_path = parsed.path.lower()
    if any(part in lower_path for part in BAD_PATH_PARTS):
        return None
    hash_id = extract_url_hash(absolute)
    if hash_id:
        return f"{strip_hash(absolute)}#{hash_id}:cs;12"
    if "/h2h/" in parsed.path:
        return f"{strip_hash(absolute)}#cs;12"
    return None


def looks_like_match_link(href: str, text: str, current_url: str) -> bool:
    match_url = normalize_match_url(href, current_url)
    if not match_url:
        return False
    parsed = urlparse(urljoin(current_url, href))
    text_clean = clean_text(text)
    if CATEGORY_TEXT_RE.search(text_clean) and "/h2h/" not in parsed.path and "#" not in href:
        return False
    if re.search(r"\(\d+\)\s*$", text_clean):
        return False
    if "/h2h/" in parsed.path:
        return True
    if "#" in href and HASH_RE.search(href.split("#", 1)[1]):
        return True
    last = parsed.path.strip("/").split("/")[-1]
    return bool(re.search(r"-[A-Za-z0-9]{7,12}$", last))


def scroll_and_expand(page: Page, wait_ms: int) -> int:
    clicked = 0
    labels = ["show more matches", "show more", "load more", "more matches", "pokaż więcej", "pokaz wiecej", "więcej", "wiecej", "zobacz więcej", "zobacz wiecej"]
    for _ in range(5):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(700, wait_ms // 3))
    for _ in range(20):
        try:
            did = bool(page.evaluate("""
                (labels) => {
                  const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                  const visible = (el) => { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
                  for (const el of nodes) { const txt = (el.innerText || el.textContent || '').trim().toLowerCase(); if (!txt || !visible(el)) continue; if (labels.some(p => txt.includes(p))) { el.click(); return true; } }
                  return false;
                }
                """, labels))
        except Exception:
            did = False
        if not did:
            break
        clicked += 1
        page.wait_for_timeout(wait_ms)
    return clicked


def discover_matches(page: Page, results_url: str, wait_ms: int, max_matches: int = 0) -> tuple[list[dict[str, str]], dict[str, Any]]:
    base.log(f"Discovering decoded match URLs without bookmaker filter from: {results_url}")
    base.goto(page, results_url, wait_ms)
    page.wait_for_timeout(wait_ms)
    landed = page.url
    bad_landed = is_bad_landed_results_url(landed)
    if bad_landed:
        base.log(f"BAD_LANDED_URL for discovery: {results_url} -> {landed}")
        return [], {"results_url": results_url, "landed_url": landed, "bad_landed_url": True, "real_match_links": 0}
    scroll_and_expand(page, wait_ms)
    links = page.eval_on_selector_all("a[href]", "els => els.map(a => ({ href: a.href || a.getAttribute('href') || '', text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') }))")
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in links:
        href = item.get("href", "")
        text = item.get("text", "")
        if not looks_like_match_link(href, text, page.url):
            continue
        match_url = normalize_match_url(href, page.url)
        if not match_url or match_url in seen:
            continue
        seen.add(match_url)
        rows.append({"results_url": results_url, "landed_url": landed, "match_url": match_url, "link_text": clean_text(text)[:240]})
        if max_matches and len(rows) >= max_matches:
            break
    stats = {"results_url": results_url, "landed_url": landed, "bad_landed_url": False, "total_links": len(links), "real_match_links": len(rows)}
    base.log(f"Discovered {len(rows)} match URL(s) from {results_url}")
    return rows, stats


def page_first_set_score(page: Page) -> str:
    try:
        text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        return ""
    candidates = re.findall(r"\b(7:6|6:7|7:5|5:7|6:[0-4]|[0-4]:6)\b", text)
    return candidates[0] if candidates else ""


def should_capture_match_event(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    return "oddsportal.com" in parsed.netloc and "/match-event/" in parsed.path and parsed.path.endswith(".dat")


def click_market_controls(page: Page, wait_ms: int) -> None:
    for label in ["Correct Score", "1st Set", "First Set", "Set 1", "Dokładny wynik", "1. set", "1 set"]:
        try:
            page.get_by_text(re.compile(re.escape(label), re.I)).first.click(timeout=1200)
            page.wait_for_timeout(wait_ms)
        except Exception:
            continue
    for _ in range(3):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(750, wait_ms // 2))


def build_row(decoded: dict[str, Any], endpoint_url: str, match_url: str, first_set_score: str, source: dict[str, str]) -> dict[str, Any]:
    odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    p1_vals = [odds.get(s) for s in TARGET_P1]
    p2_grouped = decimal_grouped(p2_vals)
    p1_grouped = decimal_grouped(p1_vals)
    score = clean_text(first_set_score).replace("-", ":")
    endpoint_id = endpoint_hash(endpoint_url)
    expected_id = extract_url_hash(match_url)
    status = "ok" if p2_grouped else "missing_v3_prices"
    if expected_id and endpoint_id and expected_id != endpoint_id:
        status = "endpoint_hash_mismatch"
    if score and score not in VALID_SET_SCORES:
        score = ""
    return {
        "scraped_at": now_iso(), "results_url": source.get("results_url", ""), "source_link_text": source.get("link_text", ""), "input_url": match_url, "match_url": match_url, "market_url": match_url, "endpoint_url": endpoint_url, "expected_hash": expected_id, "endpoint_hash": endpoint_id, "provider_id": PROVIDER_BET365, "market_bt": decoded.get("d", {}).get("bt"), "market_scope": decoded.get("d", {}).get("sc"), "first_set_score": score,
        "p2_3_6_decimal": odds.get("3:6"), "p2_4_6_decimal": odds.get("4:6"), "p2_5_7_decimal": odds.get("5:7"), "p2_grouped_9_12": p2_grouped, "p2_tier": tier_for_grouped(p2_grouped), "p2_v3_hit": str(score in P2_HIT_SCORES).lower() if score else "",
        "p1_6_3_decimal": odds.get("6:3"), "p1_6_4_decimal": odds.get("6:4"), "p1_7_5_decimal": odds.get("7:5"), "p1_grouped_9_12": p1_grouped, "p1_tier": tier_for_grouped(p1_grouped), "p1_v3_hit": str(score in P1_HIT_SCORES).lower() if score else "",
        "bet365_confirmed_count": len([x for x in [odds.get(s) for s in TARGET_P2] if x]), "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]), "status": status, "note": "",
    }


def fieldnames() -> list[str]:
    return ["scraped_at", "results_url", "source_link_text", "input_url", "match_url", "market_url", "endpoint_url", "expected_hash", "endpoint_hash", "provider_id", "market_bt", "market_scope", "first_set_score", "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12", "p2_tier", "p2_v3_hit", "p1_6_3_decimal", "p1_6_4_decimal", "p1_7_5_decimal", "p1_grouped_9_12", "p1_tier", "p1_v3_hit", "bet365_confirmed_count", "all_score_count", "status", "note"]


def append_csv(path: Path, row: dict[str, Any]) -> None:
    ensure_dir(path.parent)
    exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames())
        if not exists:
            writer.writeheader()
        writer.writerow({k: row.get(k, "") for k in fieldnames()})


def write_discovered(path: Path, rows: list[dict[str, str]]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["results_url", "landed_url", "match_url", "link_text"])
        writer.writeheader()
        writer.writerows(rows)


def scrape_match(context: BrowserContext, page: Page, match: dict[str, str], wait_ms: int) -> list[dict[str, Any]]:
    match_url = match["match_url"]
    expected = extract_url_hash(match_url)
    rows: list[dict[str, Any]] = []
    seen_endpoints: set[str] = set()
    first_set = ""

    def on_response(resp: Response) -> None:
        nonlocal first_set
        if not should_capture_match_event(resp) or resp.url in seen_endpoints:
            return
        seen_endpoints.add(resp.url)
        endpoint_id = endpoint_hash(resp.url)
        if expected and endpoint_id and endpoint_id != expected:
            base.log(f"Skipping endpoint hash mismatch expected={expected} got={endpoint_id}")
            return
        try:
            decoded = decode_oddsportal_dat(resp.body().decode("utf-8", errors="replace"))
            if not first_set:
                first_set = page_first_set_score(page)
            rows.append(build_row(decoded, resp.url, match_url, first_set, match))
        except Exception as exc:
            base.log(f"Decode failed for {resp.url}: {exc}")

    page.on("response", on_response)
    try:
        clear_oddsportal_route_memory(context, page, wait_ms)
        base.goto(page, match_url, wait_ms)
        first_set = page_first_set_score(page)
        click_market_controls(page, wait_ms)
        page.wait_for_timeout(wait_ms)
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass
    if not rows:
        rows.append({"scraped_at": now_iso(), "results_url": match.get("results_url", ""), "source_link_text": match.get("link_text", ""), "input_url": match_url, "match_url": match_url, "market_url": page.url, "expected_hash": expected, "first_set_score": first_set, "bet365_confirmed_count": 0, "all_score_count": 0, "status": "no_decoded_match_event", "note": "No matching decoded /match-event/.dat response captured."})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-decoded-tournament-v3")
    parser.add_argument("--limit-total", type=int, default=20)
    parser.add_argument("--max-matches-per-results", type=int, default=20)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--pause-seconds", type=float, default=1.5)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    csv_path = out_dir / "bet365_master_decoded_v3.csv"
    discovered_path = out_dir / "discovered_match_urls.csv"
    urls = base.read_urls_file(args.results_urls_file)
    meta: dict[str, Any] = {"generated_at": now_iso(), "args": vars(args), "results_url_count": len(urls), "discovered_match_count": 0, "rows": 0, "status_counts": {}, "discovery_bad_landed_pages": 0, "cookie_secret_present": has_cookie_secret(), "login_ok": False, "bookmaker_filter_applied_during_discovery": False}

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

            # Discovery WITHOUT bet365 filter.
            discovered: list[dict[str, str]] = []
            seen: set[str] = set()
            discovery_stats: list[dict[str, Any]] = []
            for results_url in urls:
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    found, stats = discover_matches(page, results_url, args.wait_ms, args.max_matches_per_results)
                except Exception as exc:
                    base.log(f"Discovery error on {results_url}: {exc}")
                    found, stats = [], {"results_url": results_url, "error": str(exc), "bad_landed_url": True}
                discovery_stats.append(stats)
                for m in found:
                    if m["match_url"] in seen:
                        continue
                    seen.add(m["match_url"])
                    discovered.append(m)
                    if args.limit_total and len(discovered) >= args.limit_total:
                        break
                write_discovered(discovered_path, discovered)
                if args.limit_total and len(discovered) >= args.limit_total:
                    break

            meta["discovered_match_count"] = len(discovered)
            meta["discovery_bad_landed_pages"] = sum(1 for s in discovery_stats if s.get("bad_landed_url"))
            meta["discovery_stats"] = discovery_stats
            write_discovered(discovered_path, discovered)
            (out_dir / "market_urls.json").write_text(json.dumps([m["match_url"] for m in discovered], indent=2), encoding="utf-8")

            # Apply/check bet365 only before decoding actual match pages.
            if discovered:
                base.apply_bet365_filter(page, out_dir, args.wait_ms)

            status_counts: dict[str, int] = {}
            for idx, match in enumerate(discovered, start=1):
                rows = scrape_match(context, page, match, args.wait_ms)
                row = sorted(rows, key=lambda r: 0 if r.get("status") == "ok" else 1)[0]
                append_csv(csv_path, row)
                status = str(row.get("status") or "unknown")
                status_counts[status] = status_counts.get(status, 0) + 1
                meta["rows"] = idx
                meta["status_counts"] = status_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)

            meta["stop_reason"] = "DECODED_TOURNAMENT_SCRAPE_COMPLETE"
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
