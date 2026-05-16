#!/usr/bin/env python3
"""
SlipIQ OddsPortal live V3 paper scanner v2.

v2 improvements:
- Discover a broad pool from OddsPortal ajax-nextgames dates/pages.
- Keep tournament/country/start metadata when present.
- Exclude doubles before pricing.
- Rank likely higher-coverage matches first.
- Price-check only the top N ranked singles.
- Add diagnostics for missing bet365 V3 prices.
- Emit filtered signal files separately from raw price checks.

Read-only research. No betting. No captcha bypass. No sportsbook actions.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_archive_first_set_results_builder import (
    decode_response as decode_archive_response,
    get_any,
    get_rows,
    normalize_match_url as archive_normalize_match_url,
    player_name,
)
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_live_v3_paper_scanner import (
    DEFAULT_DISCOVERY_URLS,
    clean_text,
    dedupe_urls,
    fetch_v3_price_row,
    is_doubles_candidate,
    safe_float,
    write_supabase_rows,
)
from oddsportal_v3_odds_from_master_csv import discover_token_fast

NOISY_RESPONSE_PARTS = [
    "/build/assets/", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".ico", ".map"
]
HIGH_QUALITY_TERMS = [
    "atp", "wta", "australian open", "french open", "roland garros", "wimbledon", "us open",
    "indian wells", "miami", "monte carlo", "madrid", "rome", "cincinnati", "canada",
    "shanghai", "paris", "finals", "masters", "500", "250", "125"
]
LOW_QUALITY_TERMS = ["itf", "juniors", "junior", "doubles", "exhibition", "utr"]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def build_ajax_nextgames_urls(days: int, pages: int) -> list[str]:
    urls: list[str] = []
    today = datetime.now(timezone.utc).date()
    stamp = int(time.time() * 1000)
    for offset in range(max(1, days)):
        ymd = (today + timedelta(days=offset)).strftime("%Y%m%d")
        for page_no in range(1, max(1, pages) + 1):
            urls.append(
                f"https://www.oddsportal.com/ajax-nextgames/2/3/1/{ymd}/yj142.dat"
                f"?page={page_no}&_={stamp + offset * 100 + page_no}&hideFinished=1"
            )
    return urls


def should_decode_discovery_response(resp: Response) -> bool:
    url = resp.url.lower()
    if "oddsportal.com" not in url:
        return False
    if "/match-event/" in url:
        return False
    if any(part in url for part in NOISY_RESPONSE_PARTS):
        return False
    return "/ajax-nextgames/" in url or "/ajax" in url or url.endswith(".dat")


def first_nonempty(row: dict[str, Any], keys: list[str]) -> str:
    return clean_text(get_any(row, keys))


def event_hash_from_row(row: dict[str, Any]) -> str:
    return first_nonempty(row, ["encodeEventId", "encodedEventId", "eventHash", "hash", "eid"])


def candidate_from_row(row: dict[str, Any], response_url: str, source_url: str, landed_url: str, exclude_doubles: bool) -> dict[str, Any] | None:
    event_hash = event_hash_from_row(row)
    event_id = first_nonempty(row, ["id", "eventId", "event_id", "matchId", "match_id"])
    player1 = player_name(get_any(row, ["home-name", "homeName", "home", "participant1", "homeParticipant", "homeTeam", "player1", "competitor1"]))
    player2 = player_name(get_any(row, ["away-name", "awayName", "away", "participant2", "awayParticipant", "awayTeam", "player2", "competitor2"]))
    raw_url = first_nonempty(row, ["url", "href", "link", "path", "slug"])
    match_url = archive_normalize_match_url(raw_url, landed_url) if raw_url else ""
    tournament = first_nonempty(row, ["tournament-name", "tournamentName", "tournament", "league-name", "leagueName", "event-name"])
    country = first_nonempty(row, ["country-name", "countryName", "country", "area-name", "areaName"])
    start_time = first_nonempty(row, ["date-start-timestamp", "date-start-base", "date", "startTime", "time", "timestamp"])
    status = first_nonempty(row, ["event-stage-name", "eventStageName", "status-name", "statusName", "status", "state"])
    match_name = f"{player1} vs {player2}" if player1 and player2 else first_nonempty(row, ["name", "eventName", "matchName", "title"])
    if not event_hash:
        return None
    if not match_url:
        match_url = f"https://www.oddsportal.com/tennis/#{event_hash}"
    if not match_name:
        match_name = event_hash
    if exclude_doubles and is_doubles_candidate(player1, player2, match_name):
        return None
    return {
        "discovered_at": now_iso(),
        "source_url": source_url,
        "source_endpoint": response_url,
        "match_url": match_url,
        "event_hash": event_hash,
        "event_id": event_id,
        "player1": player1,
        "player2": player2,
        "match_name": match_name,
        "tournament": tournament,
        "country": country,
        "start_time": start_time,
        "status_text": status,
    }


def quality_score(candidate: dict[str, Any]) -> int:
    haystack = " ".join(str(candidate.get(k, "")) for k in ["tournament", "country", "match_name", "source_url", "source_endpoint"]).lower()
    score = 0
    if any(term in haystack for term in HIGH_QUALITY_TERMS):
        score += 100
    if "atp" in haystack:
        score += 40
    if "wta" in haystack:
        score += 40
    if "challenger" in haystack:
        score += 20
    if any(term in haystack for term in LOW_QUALITY_TERMS):
        score -= 100
    if candidate.get("player1") and candidate.get("player2"):
        score += 10
    if candidate.get("match_url") and "oddsportal.com/tennis" in str(candidate.get("match_url")):
        score += 5
    return score


def discover_pool(context: BrowserContext, page: Page, urls: list[str], wait_ms: int, discover_limit: int, exclude_doubles: bool) -> list[dict[str, Any]]:
    pool: list[dict[str, Any]] = []
    seen: set[str] = set()
    for url in urls:
        if discover_limit and len(pool) >= discover_limit:
            break
        response_candidates: list[dict[str, Any]] = []
        seen_responses: set[str] = set()

        def on_response(resp: Response) -> None:
            if resp.url in seen_responses or not should_decode_discovery_response(resp):
                return
            seen_responses.add(resp.url)
            try:
                decoded, decode_status = decode_archive_response(resp)
                rows = get_rows(decoded) if decoded is not None else []
                for raw in rows:
                    c = candidate_from_row(raw, resp.url, url, page.url, exclude_doubles)
                    if c:
                        c["discovery_decode_status"] = decode_status
                        response_candidates.append(c)
            except Exception as exc:
                base.log(f"Discovery decode skipped for {resp.url}: {exc}")

        page.on("response", on_response)
        try:
            clear_oddsportal_route_memory(context, page, wait_ms)
            base.log(f"Ranked scanner discovery opening: {url}")
            base.goto(page, url, wait_ms)
            page.wait_for_timeout(wait_ms)
        except Exception as exc:
            base.log(f"Discovery page failed: {url}: {exc}")
        finally:
            try:
                page.remove_listener("response", on_response)
            except Exception:
                pass
        for c in response_candidates:
            key = c.get("event_hash") or c.get("match_url")
            if not key or key in seen:
                continue
            seen.add(str(key))
            c["quality_score"] = quality_score(c)
            pool.append(c)
            if discover_limit and len(pool) >= discover_limit:
                break
    pool.sort(key=lambda r: (int(r.get("quality_score") or 0), str(r.get("tournament") or "")), reverse=True)
    return pool


def diagnose_price_row(row: dict[str, Any]) -> dict[str, Any]:
    p36 = safe_float(row.get("p2_3_6_decimal"))
    p46 = safe_float(row.get("p2_4_6_decimal"))
    p57 = safe_float(row.get("p2_5_7_decimal"))
    row["has_p2_3_6"] = bool(p36)
    row["has_p2_4_6"] = bool(p46)
    row["has_p2_5_7"] = bool(p57)
    row["has_all_p2_scores"] = bool(p36 and p46 and p57)
    status = str(row.get("odds_status") or "")
    http_status = str(row.get("http_status") or "")
    body_len = int(safe_float(row.get("body_length")) or 0)
    if status == "ok":
        reason = "ok"
    elif http_status and http_status not in {"200", ""}:
        reason = f"http_{http_status}"
    elif body_len and body_len < 700:
        reason = "decoded_empty_or_tiny_market_payload"
    elif not row["has_all_p2_scores"]:
        missing = [score for score, present in [("3:6", p36), ("4:6", p46), ("5:7", p57)] if not present]
        reason = "missing_scores_" + "_".join(missing)
    else:
        reason = status or "unknown"
    row["missing_reason"] = reason
    return row


def should_filter_signal(row: dict[str, Any]) -> bool:
    grouped = safe_float(row.get("p2_grouped_9_12"))
    p46 = safe_float(row.get("p2_4_6_decimal"))
    ratio = safe_float(row.get("v4_compression_ratio"))
    if not grouped:
        return False
    return bool(
        grouped >= 2.80
        or (p46 and 6.00 <= p46 <= 8.50)
        or (ratio and ratio <= 1.40)
    )


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields = [
        "discovered_at", "scraped_at", "source_url", "source_endpoint", "match_url", "event_hash", "event_id",
        "player1", "player2", "match_name", "tournament", "country", "start_time", "status_text", "quality_score",
        "constructed_url", "provider_id", "http_status", "decode_status", "body_length", "market_bt", "market_scope",
        "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12",
        "has_p2_3_6", "has_p2_4_6", "has_p2_5_7", "has_all_p2_scores", "missing_reason",
        "v3_exact_4_6_trigger", "v4_compression_ratio", "v4_compression_trigger", "ceo_bucket", "odds_status", "note",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def parse_csv_list(value: str) -> list[str]:
    return [x.strip() for x in str(value or "").split(",") if x.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/output/oddsportal-live-v3-paper-scanner")
    parser.add_argument("--limit-matches", type=int, default=50, help="Number of ranked matches to price-check")
    parser.add_argument("--discover-limit", type=int, default=200, help="Maximum discovered singles before ranking")
    parser.add_argument("--wait-ms", type=int, default=4000)
    parser.add_argument("--pause-seconds", type=float, default=0.25)
    parser.add_argument("--dry-run", default="true", choices=["true", "false"])
    parser.add_argument("--write-supabase", default="false", choices=["true", "false"])
    parser.add_argument("--promote-buckets", default="PRICE_ONLY_REVIEW,A_PLUS,A,MAIN")
    parser.add_argument("--discovery-urls", default="")
    parser.add_argument("--discovery-days", type=int, default=3)
    parser.add_argument("--discovery-pages", type=int, default=5)
    parser.add_argument("--exclude-doubles", default="true", choices=["true", "false"])
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    scanner_run_id = f"live-v3-ranked-{int(time.time())}"
    extra_urls = parse_csv_list(args.discovery_urls)
    discovery_urls = dedupe_urls(build_ajax_nextgames_urls(args.discovery_days, args.discovery_pages) + DEFAULT_DISCOVERY_URLS + extra_urls)
    dry_run = args.dry_run == "true"
    write_supabase = args.write_supabase == "true" and not dry_run
    exclude_doubles = args.exclude_doubles == "true"
    promote_buckets = set(parse_csv_list(args.promote_buckets))
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "scanner_run_id": scanner_run_id,
        "version": "v2_ranked_discovery",
        "args": vars(args),
        "dry_run": dry_run,
        "write_supabase": write_supabase,
        "exclude_doubles": exclude_doubles,
        "discovery_url_count": len(discovery_urls),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "discovered_pool_count": 0,
        "priced_match_count": 0,
        "rows_written": 0,
        "odds_status_counts": {},
        "ceo_bucket_counts": {},
        "missing_reason_counts": {},
        "supabase_write_summary": {},
    }

    rows: list[dict[str, Any]] = []
    pool: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for ranked live V3 scanner.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            token, seed_url = discover_token_fast(context, page, [], args.wait_ms, 0)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            pool = discover_pool(context, page, discovery_urls, args.wait_ms, args.discover_limit, exclude_doubles)
            meta["discovered_pool_count"] = len(pool)
            priced = pool[: max(0, args.limit_matches)]
            meta["priced_match_count"] = len(priced)
            for i, match in enumerate(priced, start=1):
                base.log(f"[{i}/{len(priced)}] Ranked live V3 price check: {match.get('match_name')} {match.get('event_hash')} score={match.get('quality_score')}")
                row = diagnose_price_row(fetch_v3_price_row(context, match, token))
                rows.append(row)
                for key_name, field in [("odds_status_counts", "odds_status"), ("ceo_bucket_counts", "ceo_bucket"), ("missing_reason_counts", "missing_reason")]:
                    val = str(row.get(field) or "unknown")
                    meta[key_name][val] = meta[key_name].get(val, 0) + 1
                meta["rows_written"] = len(rows)
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    filtered = [r for r in rows if should_filter_signal(r)]
    write_csv(out_dir / "live_v3_discovered_ranked_pool.csv", pool)
    write_csv(out_dir / "live_v3_price_checks.csv", rows)
    write_csv(out_dir / "live_v3_filtered_signals.csv", filtered)
    if write_supabase:
        meta["supabase_write_summary"] = write_supabase_rows(rows, scanner_run_id, promote_buckets)
    else:
        meta["supabase_write_summary"] = {"skipped": True, "reason": "dry_run_or_write_supabase_false"}
    meta["filtered_signal_count"] = len(filtered)
    meta["stop_reason"] = "LIVE_V3_RANKED_SCANNER_COMPLETE"
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Live V3 Paper Scanner v2",
        "",
        f"Generated: {meta['generated_at']}",
        f"Scanner run id: {scanner_run_id}",
        f"Dry run: {dry_run}",
        f"Write Supabase: {write_supabase}",
        f"Discovery URLs: {meta['discovery_url_count']}",
        f"Discovered pool: {meta['discovered_pool_count']}",
        f"Priced matches: {meta['priced_match_count']}",
        f"Rows written: {meta['rows_written']}",
        f"Filtered signals: {len(filtered)}",
        "",
        "## Odds status counts",
        json.dumps(meta["odds_status_counts"], indent=2),
        "",
        "## Missing reason counts",
        json.dumps(meta["missing_reason_counts"], indent=2),
        "",
        "## CEO bucket counts",
        json.dumps(meta["ceo_bucket_counts"], indent=2),
    ]
    (out_dir / "live_v3_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
