#!/usr/bin/env python3
"""
SlipIQ OddsPortal match discovery probe.

Discovery-only diagnostic using a CLEAN PUBLIC browser context:
- no OddsPortal cookies
- no login
- no bookmaker filter
- reject bad landed pages such as /bookmakers/

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
from oddsportal_cookie_json_guarded import clear_oddsportal_route_memory

HASH_RE = re.compile(r"[A-Za-z0-9]{7,12}")
BAD_PATH_PARTS = [
    "/standings", "/draw", "/archive", "/rankings", "/news", "/players", "/player/",
    "/teams", "/outrights", "/bookmakers", "/bonus", "/predictions", "/calendar",
    "/settings", "/my-leagues",
]
BAD_LANDED_PARTS = ["/bookmakers/", "/bookmakers"]
CATEGORY_TEXT_RE = re.compile(
    r"\b(atp|wta|challenger|itf|doubles|singles|wimbledon|open|masters|rome|madrid|miami|paris|basel|rotterdam|halle|queens|washington|vienna|tokyo|beijing|dubai|acapulco|barcelona|australian|french|us open)\b",
    re.I,
)
PLAYER_VS_TEXT_RE = re.compile(r"[A-Z][A-Za-z'.-]+\s+[A-Z]\.?\s*(-|–|v|vs)\s*[A-Z][A-Za-z'.-]+\s+[A-Z]\.?")
SCORE_RE = re.compile(r"\b(6:[0-7]|7:[0-6]|[0-7]-[0-7])\b")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


def is_bad_landed_url(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower().rstrip("/") + "/"
    return any(path.startswith(p.rstrip("/") + "/") for p in BAD_LANDED_PARTS) or "/tennis/" not in path or "/results/" not in path


def extract_hash_from_url(url: str) -> str:
    if "#" in url:
        h = url.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
        if HASH_RE.fullmatch(h):
            return h
    parsed = urlparse(url)
    last = parsed.path.strip("/").split("/")[-1]
    m = re.search(r"-([A-Za-z0-9]{7,12})$", last)
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
    h = extract_hash_from_url(absolute)
    if h:
        return f"{strip_hash(absolute)}#{h}:cs;12"
    if "/h2h/" in parsed.path:
        return f"{strip_hash(absolute)}#cs;12"
    return None


def classify_link(href: str, text: str, current_url: str) -> dict[str, str]:
    absolute = urljoin(current_url, href or "")
    parsed = urlparse(absolute)
    text_clean = clean_text(text)
    path = parsed.path
    lower_path = path.lower()
    match_url = normalize_match_url(href, current_url)
    is_oddsportal = "oddsportal.com" in parsed.netloc
    is_tennis = "/tennis/" in lower_path
    has_hash = bool(extract_hash_from_url(absolute))
    has_h2h = "/h2h/" in lower_path
    has_player_text = bool(PLAYER_VS_TEXT_RE.search(text_clean)) or bool(re.search(r"\s-\s", text_clean))
    has_score_text = bool(SCORE_RE.search(text_clean))
    looks_category = bool(CATEGORY_TEXT_RE.search(text_clean)) and not has_h2h and not has_hash

    reason = ""
    is_real_match = False
    if not is_oddsportal:
        reason = "external"
    elif not is_tennis:
        reason = "not_tennis"
    elif any(part in lower_path for part in BAD_PATH_PARTS):
        reason = "bad_path"
    elif looks_category:
        reason = "category_text"
    elif match_url and (has_hash or has_h2h):
        reason = "accepted_hash_or_h2h"
        is_real_match = True
    elif match_url and has_player_text:
        reason = "accepted_player_text"
        is_real_match = True
    elif match_url:
        reason = "match_url_but_weak_text"
    else:
        reason = "no_match_signal"

    return {
        "absolute_url": absolute,
        "path": path,
        "text": text_clean[:300],
        "is_oddsportal": str(is_oddsportal).lower(),
        "is_tennis": str(is_tennis).lower(),
        "has_hash": str(has_hash).lower(),
        "has_h2h": str(has_h2h).lower(),
        "has_player_text": str(has_player_text).lower(),
        "has_score_text": str(has_score_text).lower(),
        "looks_category": str(looks_category).lower(),
        "match_url": match_url or "",
        "is_real_match": str(is_real_match).lower(),
        "reason": reason,
    }


def goto_public(page: Page, url: str, wait_ms: int) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(wait_ms)


def click_show_more(page: Page, wait_ms: int, max_clicks: int = 25) -> int:
    labels = ["show more matches", "show more", "load more", "more matches", "next", "pokaż więcej", "pokaz wiecej", "więcej", "wiecej", "zobacz więcej", "zobacz wiecej"]
    clicked = 0
    for _ in range(max_clicks):
        try:
            did = bool(page.evaluate(
                """
                (labels) => {
                  const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                  const visible = (el) => {
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                  };
                  for (const el of nodes) {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (!txt || !visible(el)) continue;
                    if (labels.some(p => txt.includes(p))) { el.click(); return true; }
                  }
                  return false;
                }
                """,
                labels,
            ))
        except Exception:
            did = False
        if not did:
            break
        clicked += 1
        page.wait_for_timeout(wait_ms)
    return clicked


def scroll_page(page: Page, wait_ms: int, rounds: int = 6) -> None:
    for _ in range(rounds):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(700, wait_ms // 3))


def collect_links(page: Page, results_url: str, wait_ms: int, out_dir: Path, page_index: int) -> tuple[list[dict[str, str]], dict[str, Any]]:
    base.log(f"Public discovery probe opening: {results_url}")
    goto_public(page, results_url, wait_ms)

    try:
        title = page.title()
    except Exception:
        title = ""
    try:
        body_text = page.locator("body").inner_text(timeout=10000)
    except Exception:
        body_text = ""

    bad_landed = is_bad_landed_url(page.url)
    if not bad_landed:
        scroll_page(page, wait_ms, rounds=4)
        clicked = click_show_more(page, wait_ms, max_clicks=25)
        scroll_page(page, wait_ms, rounds=3)
    else:
        clicked = 0
        base.log(f"BAD_LANDED_URL for {results_url}: landed on {page.url}")

    links = [] if bad_landed else page.eval_on_selector_all(
        "a[href]",
        "els => els.map(a => ({ href: a.href || a.getAttribute('href') || '', text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ') }))",
    )
    inventory: list[dict[str, str]] = []
    for item in links:
        classified = classify_link(item.get("href", ""), item.get("text", ""), page.url)
        classified["results_url"] = results_url
        classified["landed_url"] = page.url
        classified["page_title"] = title
        inventory.append(classified)

    safe_dir = out_dir / "page_samples"
    ensure_dir(safe_dir)
    (safe_dir / f"page_{page_index:03d}_body.txt").write_text(body_text[:20000], encoding="utf-8")
    (safe_dir / f"page_{page_index:03d}_links_sample.json").write_text(json.dumps(inventory[:250], indent=2), encoding="utf-8")

    stats = {
        "results_url": results_url,
        "landed_url": page.url,
        "title": title,
        "bad_landed_url": str(bad_landed).lower(),
        "show_more_clicks": clicked,
        "total_links": len(inventory),
        "oddsportal_links": sum(1 for r in inventory if r["is_oddsportal"] == "true"),
        "tennis_links": sum(1 for r in inventory if r["is_tennis"] == "true"),
        "hash_links": sum(1 for r in inventory if r["has_hash"] == "true"),
        "h2h_links": sum(1 for r in inventory if r["has_h2h"] == "true"),
        "player_text_links": sum(1 for r in inventory if r["has_player_text"] == "true"),
        "real_match_links": sum(1 for r in inventory if r["is_real_match"] == "true"),
        "category_links": sum(1 for r in inventory if r["looks_category"] == "true"),
        "body_has_finished_marker": str(any(x in body_text.lower() for x in ["finished", "ended", "after penalties", "retired", "walkover", "quarter-finals", "final"])).lower(),
        "body_sample_file": f"page_samples/page_{page_index:03d}_body.txt",
        "links_sample_file": f"page_samples/page_{page_index:03d}_links_sample.json",
    }
    return inventory, stats


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-match-discovery-probe")
    parser.add_argument("--limit-pages", type=int, default=5)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    results_urls = base.read_urls_file(args.results_urls_file)
    if args.limit_pages and args.limit_pages > 0:
        results_urls = results_urls[: args.limit_pages]

    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "results_url_count": len(results_urls),
        "public_discovery_context": True,
        "login_used": False,
        "bookmaker_filter_applied": False,
    }
    all_inventory: list[dict[str, str]] = []
    page_stats: list[dict[str, Any]] = []
    discovered: list[dict[str, str]] = []
    seen_match_urls: set[str] = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for idx, results_url in enumerate(results_urls, start=1):
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    inventory, stats = collect_links(page, results_url, args.wait_ms, out_dir, idx)
                except Exception as exc:
                    base.log(f"Discovery probe error on {results_url}: {exc}")
                    inventory = []
                    stats = {"results_url": results_url, "error": str(exc), "real_match_links": 0, "bad_landed_url": "unknown"}
                all_inventory.extend(inventory)
                page_stats.append(stats)
                for row in inventory:
                    if row.get("is_real_match") != "true":
                        continue
                    match_url = row.get("match_url", "")
                    if not match_url or match_url in seen_match_urls:
                        continue
                    seen_match_urls.add(match_url)
                    discovered.append({"results_url": row.get("results_url", ""), "landed_url": row.get("landed_url", ""), "match_url": match_url, "link_text": row.get("text", ""), "reason": row.get("reason", "")})

            link_fields = ["results_url", "landed_url", "page_title", "absolute_url", "path", "text", "is_oddsportal", "is_tennis", "has_hash", "has_h2h", "has_player_text", "has_score_text", "looks_category", "match_url", "is_real_match", "reason"]
            write_csv(out_dir / "link_inventory.csv", all_inventory, link_fields)
            write_csv(out_dir / "discovered_match_urls.csv", discovered, ["results_url", "landed_url", "match_url", "link_text", "reason"])
            write_csv(out_dir / "page_stats.csv", page_stats, ["results_url", "landed_url", "title", "bad_landed_url", "show_more_clicks", "total_links", "oddsportal_links", "tennis_links", "hash_links", "h2h_links", "player_text_links", "real_match_links", "category_links", "body_has_finished_marker", "body_sample_file", "links_sample_file", "error"])

            summary = {"generated_at": now_iso(), "public_discovery_context": True, "results_url_count": len(results_urls), "total_links": len(all_inventory), "total_real_match_links": len(discovered), "bad_landed_pages": sum(1 for s in page_stats if str(s.get("bad_landed_url")) == "true"), "page_stats": page_stats, "recommendation": "If public discovery still lands badly, the input URLs or OddsPortal public route structure are the issue. Next fallback is internal archive endpoint discovery."}
            (out_dir / "discovery_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
            lines = ["# OddsPortal Match Discovery Probe", "", f"Generated: {summary['generated_at']}", "Mode: clean public browser context", f"Pages checked: {len(results_urls)}", f"Bad landed pages: {summary['bad_landed_pages']}", f"Total links: {len(all_inventory)}", f"Real match links discovered: {len(discovered)}", "", "## Page stats", ""]
            for st in page_stats:
                lines.append(f"- `{st.get('results_url')}`")
                lines.append(f"  - landed: `{st.get('landed_url', '')}` bad_landed={st.get('bad_landed_url', '')}")
                lines.append(f"  - title: `{st.get('title', '')}`")
                lines.append(f"  - links: total={st.get('total_links', 0)} tennis={st.get('tennis_links', 0)} hash={st.get('hash_links', 0)} h2h={st.get('h2h_links', 0)} player_text={st.get('player_text_links', 0)} real={st.get('real_match_links', 0)}")
                lines.append(f"  - samples: `{st.get('body_sample_file', '')}`, `{st.get('links_sample_file', '')}`")
            (out_dir / "discovery_report.md").write_text("\n".join(lines), encoding="utf-8")
            meta.update({"stop_reason": "MATCH_DISCOVERY_PROBE_COMPLETE", "total_links": len(all_inventory), "total_real_match_links": len(discovered), "bad_landed_pages": summary["bad_landed_pages"]})
            (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            return 0
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
