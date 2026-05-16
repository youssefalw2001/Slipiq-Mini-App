#!/usr/bin/env python3
"""
SlipIQ OddsPortal direct match-event endpoint probe.

Goal:
- Test whether a known /match-event/.dat endpoint can be fetched directly after
  it has been discovered once.
- If direct fetch works, future odds collection can be sped up by reusing or
  constructing endpoint URLs instead of full page navigation for every check.

This probe:
1. Builds a finished event list from decoded archive endpoints.
2. Opens a small number of match pages normally to capture working .dat endpoints.
3. Direct-fetches the captured endpoint URL with Playwright's authenticated request context.
4. Decodes the direct response.
5. Confirms provider 549 bet365 V3 prices exist.
6. Saves a pattern inventory for endpoint URL analysis.

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
from oddsportal_archive_events_to_v3_scraper import build_archive_events, event_is_finished, normalize_event_row
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P2,
    decode_oddsportal_dat,
    decimal_grouped,
    score_odds,
    tier_for_grouped,
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


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


def endpoint_pattern(endpoint_url: str) -> dict[str, str]:
    parsed = urlparse(endpoint_url)
    filename = parsed.path.strip("/").split("/")[-1]
    stem = filename[:-4] if filename.endswith(".dat") else filename
    parts = stem.split("-")
    return {
        "endpoint_host": parsed.netloc,
        "endpoint_path": parsed.path,
        "endpoint_filename": filename,
        "endpoint_stem": stem,
        "endpoint_parts_json": json.dumps(parts),
        "endpoint_part_count": str(len(parts)),
    }


def should_capture_match_event(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    return "oddsportal.com" in parsed.netloc and "/match-event/" in parsed.path and parsed.path.endswith(".dat")


def click_market_controls(page: Page, wait_ms: int) -> None:
    for label in ["Correct Score", "1st Set", "First Set", "Set 1", "Dokladny wynik", "Dokładny wynik", "1. set", "1 set"]:
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
    return {
        "p2_3_6_decimal": odds.get("3:6"),
        "p2_4_6_decimal": odds.get("4:6"),
        "p2_5_7_decimal": odds.get("5:7"),
        "p2_grouped_9_12": grouped,
        "p2_tier": tier_for_grouped(grouped),
        "bet365_confirmed_count": len([x for x in p2_vals if x]),
        "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]),
        "market_bt": decoded.get("d", {}).get("bt") if isinstance(decoded.get("d"), dict) else "",
        "market_scope": decoded.get("d", {}).get("sc") if isinstance(decoded.get("d"), dict) else "",
    }


def capture_baseline_endpoint(context: BrowserContext, page: Page, event: dict[str, Any], wait_ms: int) -> dict[str, Any]:
    match_url = clean_text(event.get("match_url", ""))
    event_hash = clean_text(event.get("event_hash", "")) or extract_url_hash(match_url)
    if not match_url:
        return {"baseline_status": "missing_match_url", "endpoint_url": "", "note": "Archive event row had no match_url."}

    captured: list[tuple[str, dict[str, Any] | None, str]] = []
    seen: set[str] = set()

    def on_response(resp: Response) -> None:
        if not should_capture_match_event(resp) or resp.url in seen:
            return
        seen.add(resp.url)
        eh = endpoint_hash(resp.url)
        if event_hash and eh and eh != event_hash:
            return
        try:
            decoded = decode_oddsportal_dat(resp.body().decode("utf-8", errors="replace"))
            captured.append((resp.url, decoded, "decoded"))
        except Exception as exc:
            captured.append((resp.url, None, f"decode_failed:{exc}"))

    page.on("response", on_response)
    try:
        clear_oddsportal_route_memory(context, page, wait_ms)
        base.goto(page, match_url, wait_ms)
        click_market_controls(page, wait_ms)
        page.wait_for_timeout(wait_ms)
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass

    if not captured:
        return {"baseline_status": "no_match_event_endpoint", "endpoint_url": "", "note": "No matching /match-event/.dat captured."}

    rows: list[dict[str, Any]] = []
    for endpoint_url, decoded, decode_status in captured:
        summary = odds_summary(decoded)
        rows.append({
            "baseline_status": "ok" if summary.get("p2_grouped_9_12") else "missing_v3_prices",
            "endpoint_url": endpoint_url,
            "baseline_decode_status": decode_status,
            "endpoint_hash": endpoint_hash(endpoint_url),
            **summary,
            "note": "",
        })
    rows.sort(key=lambda r: 0 if r.get("p2_grouped_9_12") else 1)
    return rows[0]


def direct_fetch_endpoint(context: BrowserContext, endpoint_url: str, referer: str) -> dict[str, Any]:
    if not endpoint_url:
        return {"direct_status": "no_endpoint_url", "direct_http_status": "", "direct_decode_status": "", "direct_note": ""}
    try:
        resp = context.request.get(endpoint_url, headers={"referer": referer, "accept": "*/*"}, timeout=30000)
    except Exception as exc:
        return {"direct_status": "request_error", "direct_http_status": "", "direct_decode_status": "", "direct_note": str(exc)[:500]}

    body = ""
    try:
        body = resp.text()
    except Exception as exc:
        return {"direct_status": "body_error", "direct_http_status": resp.status, "direct_decode_status": "", "direct_note": str(exc)[:500]}

    decoded = None
    decode_status = ""
    try:
        decoded = decode_oddsportal_dat(body)
        decode_status = "decoded"
    except Exception as exc:
        decode_status = f"decode_failed:{exc}"

    summary = odds_summary(decoded)
    direct_status = "ok" if summary.get("p2_grouped_9_12") else "missing_v3_prices"
    if resp.status >= 400:
        direct_status = f"http_{resp.status}"
    elif decoded is None:
        direct_status = "decode_failed"
    return {
        "direct_status": direct_status,
        "direct_http_status": resp.status,
        "direct_decode_status": decode_status,
        "direct_body_length": len(body),
        "direct_note": "",
        "direct_p2_3_6_decimal": summary.get("p2_3_6_decimal"),
        "direct_p2_4_6_decimal": summary.get("p2_4_6_decimal"),
        "direct_p2_5_7_decimal": summary.get("p2_5_7_decimal"),
        "direct_p2_grouped_9_12": summary.get("p2_grouped_9_12"),
        "direct_bet365_confirmed_count": summary.get("bet365_confirmed_count"),
        "direct_all_score_count": summary.get("all_score_count"),
        "direct_market_bt": summary.get("market_bt"),
        "direct_market_scope": summary.get("market_scope"),
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
    parser.add_argument("--out", default="artifacts/output/oddsportal-direct-match-event-probe")
    parser.add_argument("--limit-pages", type=int, default=10)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=10)
    parser.add_argument("--wait-ms", type=int, default=3000)
    parser.add_argument("--pause-seconds", type=float, default=0.5)
    parser.add_argument("--max-body-bytes", type=int, default=2000000)
    parser.add_argument("--skip-bet365-filter", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)

    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "event_count_total": 0,
        "event_count_finished": 0,
        "chunk_count": 0,
        "rows_written": 0,
        "baseline_status_counts": {},
        "direct_status_counts": {},
    }

    events, discovery_stats = build_archive_events(args.results_urls_file, out_dir, args.wait_ms, args.max_body_bytes, args.limit_pages)
    meta["event_count_total"] = len(events)
    meta["discovery_stats"] = discovery_stats
    finished = [e for e in events if event_is_finished(e)]
    meta["event_count_finished"] = len(finished)
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
                base.log("Using cookie/storage secret for direct endpoint probe.")
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

            baseline_counts: dict[str, int] = {}
            direct_counts: dict[str, int] = {}
            for i, event in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] Direct probe baseline capture: {event.get('match_name')} {event.get('match_url')}")
                baseline = capture_baseline_endpoint(context, page, event, args.wait_ms)
                direct = direct_fetch_endpoint(context, baseline.get("endpoint_url", ""), clean_text(event.get("match_url", "")))
                pattern = endpoint_pattern(baseline.get("endpoint_url", "")) if baseline.get("endpoint_url") else {}
                row = {
                    "scraped_at": now_iso(),
                    "event_id": event.get("event_id", ""),
                    "event_hash": event.get("event_hash", ""),
                    "player1": event.get("player1", ""),
                    "player2": event.get("player2", ""),
                    "match_name": event.get("match_name", ""),
                    "match_url": event.get("match_url", ""),
                    **baseline,
                    **direct,
                    **pattern,
                }
                rows.append(row)
                bs = str(row.get("baseline_status") or "unknown")
                ds = str(row.get("direct_status") or "unknown")
                baseline_counts[bs] = baseline_counts.get(bs, 0) + 1
                direct_counts[ds] = direct_counts.get(ds, 0) + 1
                meta["rows_written"] = i
                meta["baseline_status_counts"] = baseline_counts
                meta["direct_status_counts"] = direct_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    fields = [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_url",
        "baseline_status", "endpoint_url", "baseline_decode_status", "endpoint_hash", "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal",
        "p2_grouped_9_12", "p2_tier", "bet365_confirmed_count", "all_score_count", "market_bt", "market_scope", "note",
        "direct_status", "direct_http_status", "direct_decode_status", "direct_body_length", "direct_note", "direct_p2_3_6_decimal",
        "direct_p2_4_6_decimal", "direct_p2_5_7_decimal", "direct_p2_grouped_9_12", "direct_bet365_confirmed_count",
        "direct_all_score_count", "direct_market_bt", "direct_market_scope",
        "endpoint_host", "endpoint_path", "endpoint_filename", "endpoint_stem", "endpoint_parts_json", "endpoint_part_count",
    ]
    write_csv(out_dir / "direct_match_event_probe.csv", rows, fields)
    meta["stop_reason"] = "DIRECT_MATCH_EVENT_PROBE_COMPLETE"
    meta["direct_fetch_ok_count"] = sum(1 for r in rows if r.get("direct_status") == "ok")
    meta["baseline_ok_count"] = sum(1 for r in rows if r.get("baseline_status") == "ok")
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Direct Match-Event Probe",
        "",
        f"Generated: {meta['generated_at']}",
        f"Events total: {meta['event_count_total']}",
        f"Finished events: {meta['event_count_finished']}",
        f"Chunk count: {meta['chunk_count']}",
        f"Rows written: {meta['rows_written']}",
        f"Baseline OK: {meta['baseline_ok_count']}",
        f"Direct fetch OK: {meta['direct_fetch_ok_count']}",
        "",
        "## Baseline status counts",
        json.dumps(meta.get("baseline_status_counts", {}), indent=2),
        "",
        "## Direct status counts",
        json.dumps(meta.get("direct_status_counts", {}), indent=2),
    ]
    (out_dir / "direct_match_event_probe_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
