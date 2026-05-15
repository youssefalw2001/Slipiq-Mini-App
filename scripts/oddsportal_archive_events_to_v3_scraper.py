#!/usr/bin/env python3
"""
SlipIQ OddsPortal archive events -> decoded bet365 V3 scraper.

Input path:
- Either an existing high_confidence_events.csv, OR
- a results URL file. If results URLs are provided, this script first runs public
  decoded archive discovery, then uses those rows.

Output:
- bet365_master_decoded_v3.csv

Flow:
1. Build/read real match rows from decrypted OddsPortal archive endpoints.
2. Keep finished/completed rows only unless --include-unfinished is set.
3. Chunk by --start-index and --limit-total.
4. Use authenticated OddsPortal cookie context for odds phase.
5. Optionally apply/check bet365 filter.
6. Open each match_url.
7. Capture matching /match-event/...dat endpoint.
8. Decrypt endpoint and extract provider 549 bet365 3:6 / 4:6 / 5:7.
9. Calculate grouped V3 odds and save immediately.

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
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_archive_event_parser_probe import probe_page, dedupe_events
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P1,
    TARGET_P2,
    decode_oddsportal_dat,
    decimal_grouped,
    score_odds,
    tier_for_grouped,
)

VALID_SET_SCORES = {
    "6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6",
    "0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7",
}
P2_HIT_SCORES = {"3:6", "4:6", "5:7"}
P1_HIT_SCORES = {"6:3", "6:4", "7:5"}
FINISHED_MARKERS = {"finished", "ended", "completed", "final", "after penalties"}
BAD_RESULT_MARKERS = {"retired", "walkover", "abandoned", "cancelled", "canceled", "postponed", "scheduled", "1st set", "2nd set", "3rd set", "live"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def infer_event_status_from_raw(raw_text: Any) -> str:
    """Recover archive event status from raw decoded row text.

    Earlier parser versions saved status as empty, but raw_text still contains
    fields like:
      "event-stage-name": "Finished"
      "status-id": 3
      "event-stage-id": 3
    This lets the bridge filter finished historical rows without rerunning a
    separate parser first.
    """
    raw = clean_text(raw_text)
    if not raw:
        return ""
    name_match = re.search(
        r'"(?:event-stage-name|eventStageName|status-name|statusName|status|state)"\s*:\s*"([^"\\]+)"',
        raw,
        re.I,
    )
    if name_match:
        return clean_text(name_match.group(1))
    id_match = re.search(
        r'"(?:event-stage-id|eventStageId|status-id|statusId)"\s*:\s*"?(\d+)"?',
        raw,
        re.I,
    )
    if id_match:
        status_id = id_match.group(1)
        if status_id == "3":
            return "Finished"
        if status_id == "1":
            return "Scheduled"
        return f"status-id:{status_id}"
    # Last-ditch text markers inside compact raw row.
    lower = raw.lower()
    if '"event-stage-name":"finished"' in lower or 'event-stage-name finished' in lower:
        return "Finished"
    if '"event-stage-name":"scheduled"' in lower:
        return "Scheduled"
    if "walkover" in lower:
        return "Walkover"
    if "retired" in lower:
        return "Retired"
    return ""


def extract_url_hash(url: str) -> str:
    if "#" in url:
        h = url.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
        if re.fullmatch(r"[A-Za-z0-9]{7,12}", h):
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


def should_capture_match_event(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    return "oddsportal.com" in parsed.netloc and "/match-event/" in parsed.path and parsed.path.endswith(".dat")


def event_fields() -> list[str]:
    return [
        "source_type", "source_endpoint", "results_url", "landed_url", "event_id", "event_hash",
        "player1", "player2", "match_name", "match_date", "status", "match_url", "confidence", "raw_text",
    ]


def output_fields() -> list[str]:
    return [
        "scraped_at", "results_url", "event_id", "event_hash", "player1", "player2", "match_name", "match_date",
        "archive_status", "match_url", "market_url", "endpoint_url", "endpoint_hash", "provider_id", "market_bt", "market_scope",
        "first_set_score", "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12",
        "p2_tier", "p2_v3_hit", "p1_6_3_decimal", "p1_6_4_decimal", "p1_7_5_decimal", "p1_grouped_9_12",
        "p1_tier", "p1_v3_hit", "bet365_confirmed_count", "all_score_count", "status", "note",
    ]


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def append_csv(path: Path, row: dict[str, Any], fields: list[str]) -> None:
    ensure_dir(path.parent)
    exists = path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerow({k: row.get(k, "") for k in fields})


def event_is_finished(row: dict[str, Any]) -> bool:
    status = clean_text(row.get("status") or row.get("archive_status") or infer_event_status_from_raw(row.get("raw_text"))).lower()
    raw = clean_text(row.get("raw_text", "")).lower()
    combined = f"{status} {raw}"
    if any(bad in combined for bad in BAD_RESULT_MARKERS):
        return False
    if any(marker in combined for marker in FINISHED_MARKERS):
        return True
    if re.search(r'"(?:event-stage-id|eventStageId|status-id|statusId)"\s*:\s*"?3"?', raw, re.I):
        return True
    return False


def normalize_event_row(row: dict[str, Any]) -> dict[str, Any]:
    raw_text = clean_text(row.get("raw_text", ""))[:1000]
    status = clean_text(row.get("status", "")) or infer_event_status_from_raw(raw_text)
    return {
        "source_type": row.get("source_type", ""),
        "source_endpoint": row.get("source_endpoint", ""),
        "results_url": row.get("results_url", ""),
        "landed_url": row.get("landed_url", ""),
        "event_id": clean_text(row.get("event_id", "")),
        "event_hash": clean_text(row.get("event_hash", "")),
        "player1": clean_text(row.get("player1", "")),
        "player2": clean_text(row.get("player2", "")),
        "match_name": clean_text(row.get("match_name", "")) or f"{clean_text(row.get('player1'))} - {clean_text(row.get('player2'))}",
        "match_date": clean_text(row.get("match_date", "")),
        "status": status,
        "match_url": clean_text(row.get("match_url", "")),
        "confidence": clean_text(row.get("confidence", "")),
        "raw_text": raw_text,
    }


def build_archive_events(results_urls_file: str, out_dir: Path, wait_ms: int, max_body_bytes: int, limit_pages: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    results_urls = base.read_urls_file(results_urls_file)
    if limit_pages and limit_pages > 0:
        results_urls = results_urls[:limit_pages]
    events: list[dict[str, Any]] = []
    page_stats: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for idx, results_url in enumerate(results_urls, start=1):
                clear_oddsportal_route_memory(context, page, wait_ms)
                try:
                    _, page_events, stats = probe_page(page, results_url, out_dir / "archive_discovery", wait_ms, max_body_bytes, idx)
                except Exception as exc:
                    page_events, stats = [], {"results_url": results_url, "error": str(exc), "raw_event_count": 0}
                events.extend(page_events)
                page_stats.append(stats)
        finally:
            context.close()
            browser.close()
    normalized = [normalize_event_row(r) for r in dedupe_events(events)]
    write_csv(out_dir / "archive_events_all.csv", normalized, event_fields())
    return normalized, page_stats


def page_first_set_score(page: Page) -> str:
    try:
        text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        return ""
    candidates = re.findall(r"\b(7:6|6:7|7:5|5:7|6:[0-4]|[0-4]:6)\b", text)
    return candidates[0] if candidates else ""


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


def build_output_row(event: dict[str, Any], decoded: dict[str, Any] | None, endpoint_url: str, first_set_score: str, page_url: str, status: str, note: str) -> dict[str, Any]:
    odds: dict[str, float | None] = {}
    if decoded is not None:
        odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    p1_vals = [odds.get(s) for s in TARGET_P1]
    p2_grouped = decimal_grouped(p2_vals)
    p1_grouped = decimal_grouped(p1_vals)
    score = clean_text(first_set_score).replace("-", ":")
    if score and score not in VALID_SET_SCORES:
        score = ""
    endpoint_id = endpoint_hash(endpoint_url) if endpoint_url else ""
    event_hash = clean_text(event.get("event_hash", "")) or extract_url_hash(event.get("match_url", ""))
    final_status = status
    if endpoint_id and event_hash and endpoint_id != event_hash:
        final_status = "endpoint_hash_mismatch"
        note = f"expected event_hash={event_hash}, got endpoint_hash={endpoint_id}"
    elif status == "ok" and not p2_grouped:
        final_status = "missing_v3_prices"
    return {
        "scraped_at": now_iso(),
        "results_url": event.get("results_url", ""),
        "event_id": event.get("event_id", ""),
        "event_hash": event_hash,
        "player1": event.get("player1", ""),
        "player2": event.get("player2", ""),
        "match_name": event.get("match_name", ""),
        "match_date": event.get("match_date", ""),
        "archive_status": event.get("status", ""),
        "match_url": event.get("match_url", ""),
        "market_url": page_url,
        "endpoint_url": endpoint_url,
        "endpoint_hash": endpoint_id,
        "provider_id": PROVIDER_BET365,
        "market_bt": decoded.get("d", {}).get("bt") if decoded else "",
        "market_scope": decoded.get("d", {}).get("sc") if decoded else "",
        "first_set_score": score,
        "p2_3_6_decimal": odds.get("3:6"),
        "p2_4_6_decimal": odds.get("4:6"),
        "p2_5_7_decimal": odds.get("5:7"),
        "p2_grouped_9_12": p2_grouped,
        "p2_tier": tier_for_grouped(p2_grouped),
        "p2_v3_hit": str(score in P2_HIT_SCORES).lower() if score else "",
        "p1_6_3_decimal": odds.get("6:3"),
        "p1_6_4_decimal": odds.get("6:4"),
        "p1_7_5_decimal": odds.get("7:5"),
        "p1_grouped_9_12": p1_grouped,
        "p1_tier": tier_for_grouped(p1_grouped),
        "p1_v3_hit": str(score in P1_HIT_SCORES).lower() if score else "",
        "bet365_confirmed_count": len([x for x in p2_vals if x]),
        "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]),
        "status": final_status,
        "note": note,
    }


def scrape_event(context: BrowserContext, page: Page, event: dict[str, Any], wait_ms: int) -> dict[str, Any]:
    match_url = clean_text(event.get("match_url", ""))
    if not match_url:
        return build_output_row(event, None, "", "", "", "missing_match_url", "Archive event row has no match_url yet.")
    expected_hash = clean_text(event.get("event_hash", "")) or extract_url_hash(match_url)
    decoded_rows: list[tuple[dict[str, Any], str]] = []
    seen_endpoints: set[str] = set()
    first_set = ""

    def on_response(resp: Response) -> None:
        if not should_capture_match_event(resp) or resp.url in seen_endpoints:
            return
        seen_endpoints.add(resp.url)
        eh = endpoint_hash(resp.url)
        if expected_hash and eh and eh != expected_hash:
            base.log(f"Skipping endpoint hash mismatch expected={expected_hash} got={eh}")
            return
        try:
            decoded = decode_oddsportal_dat(resp.body().decode("utf-8", errors="replace"))
            decoded_rows.append((decoded, resp.url))
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
    if not decoded_rows:
        return build_output_row(event, None, "", first_set, page.url, "no_decoded_match_event", "No matching decoded /match-event/.dat response captured.")
    candidate_rows = [build_output_row(event, decoded, endpoint_url, first_set, page.url, "ok", "") for decoded, endpoint_url in decoded_rows]
    candidate_rows.sort(key=lambda r: 0 if r.get("p2_grouped_9_12") else 1)
    return candidate_rows[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events-csv", default="")
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-archive-events-to-v3")
    parser.add_argument("--limit-pages", type=int, default=5)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=20)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--pause-seconds", type=float, default=1.5)
    parser.add_argument("--max-body-bytes", type=int, default=2000000)
    parser.add_argument("--include-unfinished", action="store_true")
    parser.add_argument("--skip-bet365-filter", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    csv_path = out_dir / "bet365_master_decoded_v3.csv"
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "event_count_total": 0,
        "event_count_finished": 0,
        "chunk_count": 0,
        "rows_written": 0,
        "status_counts": {},
    }

    if args.events_csv:
        events = [normalize_event_row(r) for r in read_csv_rows(Path(args.events_csv))]
        discovery_stats = []
    else:
        events, discovery_stats = build_archive_events(args.results_urls_file, out_dir, args.wait_ms, args.max_body_bytes, args.limit_pages)
    meta["event_count_total"] = len(events)
    meta["discovery_stats"] = discovery_stats

    if args.include_unfinished:
        filtered = events
    else:
        filtered = [e for e in events if event_is_finished(e)]
    meta["event_count_finished"] = len(filtered)
    write_csv(out_dir / "archive_events_filtered.csv", filtered, event_fields())

    start = max(0, int(args.start_index or 0))
    end = None if not args.limit_total or args.limit_total <= 0 else start + int(args.limit_total)
    chunk = filtered[start:end]
    meta["chunk_start_index"] = start
    meta["chunk_limit_total"] = args.limit_total
    meta["chunk_count"] = len(chunk)

    if not chunk:
        meta["stop_reason"] = "NO_EVENTS_TO_PROCESS"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for authenticated odds decode.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 3
            if not args.skip_bet365_filter:
                base.apply_bet365_filter(page, out_dir, args.wait_ms)

            status_counts: dict[str, int] = {}
            for i, event in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] V3 decode: {event.get('match_name')} {event.get('match_url')}")
                row = scrape_event(context, page, event, args.wait_ms)
                append_csv(csv_path, row, output_fields())
                status = str(row.get("status") or "unknown")
                status_counts[status] = status_counts.get(status, 0) + 1
                meta["rows_written"] = i
                meta["status_counts"] = status_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
            meta["stop_reason"] = "ARCHIVE_EVENTS_TO_V3_COMPLETE"
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
