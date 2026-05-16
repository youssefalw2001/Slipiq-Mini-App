#!/usr/bin/env python3
"""
SlipIQ OddsPortal constructed V3 endpoint probe.

Purpose:
- Test whether we can skip opening every match page.
- Discover OddsPortal's match-event session token once.
- Construct the first-set correct-score endpoint directly:

    /match-event/1-2-{event_hash}-8-12-{session_token}.dat?geo=US&lang=en

Known pattern from direct-match-event probe:
- 1-2 = sport/market routing prefix used by OddsPortal match-event endpoint
- event_hash = encodeEventId from archive rows
- 8-12 = Correct Score / 1st Set market
- final hex token = session/build token seen in captured match-event endpoints

If this works, the odds dataset builder can become much faster:
archive events -> construct endpoint -> direct fetch -> decode provider 549 bet365 V3 odds.

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
from oddsportal_archive_events_to_v3_scraper import build_archive_events, event_is_finished
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P2,
    decode_oddsportal_dat,
    decimal_grouped,
    score_odds,
    tier_for_grouped,
)

TOKEN_RE = re.compile(r"/match-event/1-2-[A-Za-z0-9]{7,12}-\d+-\d+-([a-f0-9]{16,64})\.dat", re.I)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def endpoint_hash(endpoint_url: str) -> str:
    m = re.search(r"/match-event/[^/]*?([A-Za-z0-9]{7,12})-[0-9]+-[0-9]+-", endpoint_url)
    return m.group(1) if m else ""


def extract_session_token(endpoint_url: str) -> str:
    m = TOKEN_RE.search(endpoint_url)
    return m.group(1) if m else ""


def should_capture_match_event(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    return "oddsportal.com" in parsed.netloc and "/match-event/" in parsed.path and parsed.path.endswith(".dat")


def click_light_market_controls(page: Page, wait_ms: int) -> None:
    # Only needed to discover one session token. We do not depend on this for every match.
    for label in ["Correct Score", "1st Set", "First Set", "Set 1", "Dokladny wynik", "Dokładny wynik", "1. set", "1 set"]:
        try:
            page.get_by_text(re.compile(re.escape(label), re.I)).first.click(timeout=1000)
            page.wait_for_timeout(wait_ms)
        except Exception:
            continue
    try:
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    except Exception:
        pass
    page.wait_for_timeout(wait_ms)


def odds_summary(decoded: dict[str, Any] | None) -> dict[str, Any]:
    if decoded is None:
        return {
            "p2_3_6_decimal": "",
            "p2_4_6_decimal": "",
            "p2_5_7_decimal": "",
            "p2_grouped_9_12": "",
            "p2_tier": "",
            "bet365_confirmed_count": 0,
            "all_score_count": 0,
            "market_bt": "",
            "market_scope": "",
        }
    odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    grouped = decimal_grouped(p2_vals)
    d = decoded.get("d", {}) if isinstance(decoded, dict) else {}
    return {
        "p2_3_6_decimal": odds.get("3:6"),
        "p2_4_6_decimal": odds.get("4:6"),
        "p2_5_7_decimal": odds.get("5:7"),
        "p2_grouped_9_12": grouped,
        "p2_tier": tier_for_grouped(grouped),
        "bet365_confirmed_count": len([x for x in p2_vals if x]),
        "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]),
        "market_bt": d.get("bt") if isinstance(d, dict) else "",
        "market_scope": d.get("sc") if isinstance(d, dict) else "",
    }


def discover_session_token(context: BrowserContext, page: Page, events: list[dict[str, Any]], wait_ms: int) -> tuple[str, str]:
    for event in events[:20]:
        match_url = clean_text(event.get("match_url", ""))
        if not match_url:
            continue
        captured: list[str] = []
        seen: set[str] = set()

        def on_response(resp: Response) -> None:
            if not should_capture_match_event(resp) or resp.url in seen:
                return
            seen.add(resp.url)
            token = extract_session_token(resp.url)
            if token:
                captured.append(resp.url)

        page.on("response", on_response)
        try:
            clear_oddsportal_route_memory(context, page, wait_ms)
            base.goto(page, match_url, wait_ms)
            click_light_market_controls(page, wait_ms)
            page.wait_for_timeout(wait_ms)
        except Exception:
            pass
        finally:
            try:
                page.remove_listener("response", on_response)
            except Exception:
                pass
        for endpoint_url in captured:
            token = extract_session_token(endpoint_url)
            if token:
                return token, endpoint_url
    return "", ""


def construct_v3_endpoint(event_hash: str, token: str) -> str:
    return f"https://www.oddsportal.com/match-event/1-2-{event_hash}-8-12-{token}.dat?geo=US&lang=en"


def direct_fetch_v3(context: BrowserContext, event: dict[str, Any], token: str) -> dict[str, Any]:
    event_hash = clean_text(event.get("event_hash", ""))
    match_url = clean_text(event.get("match_url", ""))
    if not event_hash:
        return {"constructed_status": "missing_event_hash", "constructed_url": "", "note": ""}
    endpoint_url = construct_v3_endpoint(event_hash, token)
    try:
        resp = context.request.get(endpoint_url, headers={"referer": match_url or "https://www.oddsportal.com/", "accept": "*/*"}, timeout=30000)
        body = resp.text()
    except Exception as exc:
        return {
            "constructed_status": "request_error",
            "constructed_url": endpoint_url,
            "http_status": "",
            "decode_status": "",
            "body_length": "",
            "note": str(exc)[:500],
        }
    decoded = None
    decode_status = ""
    try:
        decoded = decode_oddsportal_dat(body)
        decode_status = "decoded"
    except Exception as exc:
        decode_status = f"decode_failed:{exc}"
    summary = odds_summary(decoded)
    status = "ok" if summary.get("p2_grouped_9_12") else "missing_v3_prices"
    if resp.status >= 400:
        status = f"http_{resp.status}"
    elif decoded is None:
        status = "decode_failed"
    if endpoint_hash(endpoint_url) != event_hash:
        status = "endpoint_hash_mismatch"
    return {
        "constructed_status": status,
        "constructed_url": endpoint_url,
        "http_status": resp.status,
        "decode_status": decode_status,
        "body_length": len(body),
        "note": "",
        **summary,
    }


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
    parser.add_argument("--out", default="artifacts/output/oddsportal-constructed-v3-endpoint-probe")
    parser.add_argument("--limit-pages", type=int, default=10)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=2500)
    parser.add_argument("--pause-seconds", type=float, default=0.15)
    parser.add_argument("--max-body-bytes", type=int, default=2000000)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "event_count_total": 0,
        "event_count_finished": 0,
        "chunk_count": 0,
        "rows_written": 0,
        "constructed_status_counts": {},
    }

    events, discovery_stats = build_archive_events(args.results_urls_file, out_dir, args.wait_ms, args.max_body_bytes, args.limit_pages)
    finished = [e for e in events if event_is_finished(e)]
    meta["event_count_total"] = len(events)
    meta["event_count_finished"] = len(finished)
    meta["discovery_stats"] = discovery_stats
    start = max(0, int(args.start_index or 0))
    end = None if not args.limit_total or args.limit_total <= 0 else start + int(args.limit_total)
    chunk = finished[start:end]
    meta["chunk_start_index"] = start
    meta["chunk_limit_total"] = args.limit_total
    meta["chunk_count"] = len(chunk)
    if not chunk:
        meta["stop_reason"] = "NO_EVENTS_TO_PROCESS"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for constructed endpoint probe.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 3

            token, seed_url = discover_session_token(context, page, finished, args.wait_ms)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 4

            counts: dict[str, int] = {}
            for i, event in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] Constructed direct V3 fetch: {event.get('match_name')} {event.get('event_hash')}")
                result = direct_fetch_v3(context, event, token)
                row = {
                    "scraped_at": now_iso(),
                    "event_id": event.get("event_id", ""),
                    "event_hash": event.get("event_hash", ""),
                    "player1": event.get("player1", ""),
                    "player2": event.get("player2", ""),
                    "match_name": event.get("match_name", ""),
                    "match_url": event.get("match_url", ""),
                    **result,
                }
                rows.append(row)
                status = str(row.get("constructed_status") or "unknown")
                counts[status] = counts.get(status, 0) + 1
                meta["rows_written"] = i
                meta["constructed_status_counts"] = counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    fields = [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_url",
        "constructed_status", "constructed_url", "http_status", "decode_status", "body_length",
        "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12", "p2_tier",
        "bet365_confirmed_count", "all_score_count", "market_bt", "market_scope", "note",
    ]
    write_csv(out_dir / "constructed_v3_endpoint_probe.csv", rows, fields)
    meta["constructed_ok_count"] = sum(1 for r in rows if r.get("constructed_status") == "ok")
    meta["stop_reason"] = "CONSTRUCTED_V3_ENDPOINT_PROBE_COMPLETE"
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Constructed V3 Endpoint Probe",
        "",
        f"Generated: {meta['generated_at']}",
        f"Session token discovered: {'yes' if token else 'no'}",
        f"Seed endpoint: {seed_url}",
        f"Finished events: {meta['event_count_finished']}",
        f"Chunk count: {meta['chunk_count']}",
        f"Rows written: {meta['rows_written']}",
        f"Constructed OK: {meta['constructed_ok_count']}",
        "",
        "## Constructed status counts",
        json.dumps(meta.get("constructed_status_counts", {}), indent=2),
    ]
    (out_dir / "constructed_v3_endpoint_probe_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
