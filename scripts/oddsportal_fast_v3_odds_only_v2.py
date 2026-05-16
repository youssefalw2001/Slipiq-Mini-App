#!/usr/bin/env python3
"""
SlipIQ fast V3 odds-only builder V2.

Uses the proven first-set-results archive parser as the master event list,
then fetches V3 odds via the constructed endpoint:

  /match-event/1-2-{event_hash}-8-12-{session_token}.dat?geo=US&lang=en

Important reliability behavior:
- This script does NOT hard-fail when no rows/token are found.
- It writes run_summary.json and exits 0 so GitHub uploads diagnostics.

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

from playwright.sync_api import sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_archive_first_set_results_builder import collect_results, dedupe_results
from oddsportal_constructed_v3_endpoint_probe import construct_v3_endpoint
from oddsportal_fast_constructed_v3_dataset_v2 import robust_discover_session_token
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P1,
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


def build_result_rows(results_urls_file: str, out_dir: Path, limit_pages: int, wait_ms: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    urls = base.read_urls_file(results_urls_file)
    if limit_pages and limit_pages > 0:
        urls = urls[:limit_pages]
    endpoint_rows: list[dict[str, Any]] = []
    result_rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for url in urls:
                clear_oddsportal_route_memory(context, page, wait_ms)
                try:
                    eps, rows = collect_results(page, url, wait_ms)
                except Exception as exc:
                    eps, rows = [{"results_url": url, "error": str(exc)}], []
                endpoint_rows.extend(eps)
                result_rows.extend(rows)
        finally:
            context.close()
            browser.close()
    deduped = dedupe_results(result_rows)
    write_csv(out_dir / "first_set_results.csv", deduped, [
        "results_url", "landed_url", "source_endpoint", "event_id", "event_hash", "player1", "player2", "match_name",
        "match_date", "tournament", "archive_status", "status_id", "match_url", "partialresult", "first_set_score",
        "result_status", "result_source", "p2_v3_hit", "p1_v3_hit",
    ])
    write_csv(out_dir / "archive_results_endpoint_inventory.csv", endpoint_rows, ["results_url", "landed_url", "endpoint_url", "status", "decode_status", "row_count", "error"])
    return deduped, endpoint_rows


def result_row_to_event(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": row.get("event_id", ""),
        "event_hash": row.get("event_hash", ""),
        "player1": row.get("player1", ""),
        "player2": row.get("player2", ""),
        "match_name": row.get("match_name", ""),
        "match_url": row.get("match_url", ""),
    }


def output_fields() -> list[str]:
    return [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "tournament", "match_url",
        "partialresult", "first_set_score", "result_status", "constructed_url", "provider_id", "http_status", "decode_status", "body_length",
        "market_bt", "market_scope", "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12", "p2_tier",
        "p1_6_3_decimal", "p1_6_4_decimal", "p1_7_5_decimal", "p1_grouped_9_12", "p1_tier",
        "bet365_confirmed_count", "all_score_count", "odds_status", "note",
    ]


def fetch_odds_row(context: Any, row: dict[str, Any], token: str) -> dict[str, Any]:
    event_hash = clean_text(row.get("event_hash", ""))
    match_url = clean_text(row.get("match_url", ""))
    base_row = {
        "scraped_at": now_iso(),
        "event_id": row.get("event_id", ""),
        "event_hash": event_hash,
        "player1": row.get("player1", ""),
        "player2": row.get("player2", ""),
        "match_name": row.get("match_name", ""),
        "match_date": row.get("match_date", ""),
        "tournament": row.get("tournament", ""),
        "match_url": match_url,
        "partialresult": row.get("partialresult", ""),
        "first_set_score": row.get("first_set_score", ""),
        "result_status": row.get("result_status", ""),
        "provider_id": PROVIDER_BET365,
    }
    if not event_hash:
        return {**base_row, "odds_status": "missing_event_hash", "note": "No event_hash."}
    endpoint_url = construct_v3_endpoint(event_hash, token)
    try:
        resp = context.request.get(endpoint_url, headers={"referer": match_url or "https://www.oddsportal.com/", "accept": "*/*"}, timeout=30000)
        body = resp.text()
    except Exception as exc:
        return {**base_row, "constructed_url": endpoint_url, "odds_status": "request_error", "note": str(exc)[:500]}

    decoded = None
    decode_status = ""
    try:
        decoded = decode_oddsportal_dat(body)
        decode_status = "decoded"
    except Exception as exc:
        decode_status = f"decode_failed:{exc}"

    odds: dict[str, float | None] = {}
    if decoded is not None:
        odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    p1_vals = [odds.get(s) for s in TARGET_P1]
    p2_grouped = decimal_grouped(p2_vals)
    p1_grouped = decimal_grouped(p1_vals)
    d = decoded.get("d", {}) if isinstance(decoded, dict) else {}

    if resp.status >= 400:
        odds_status = f"http_{resp.status}"
    elif decoded is None:
        odds_status = "decode_failed"
    elif not p2_grouped:
        odds_status = "missing_v3_prices"
    else:
        odds_status = "ok"

    return {
        **base_row,
        "constructed_url": endpoint_url,
        "http_status": resp.status,
        "decode_status": decode_status,
        "body_length": len(body),
        "market_bt": d.get("bt") if isinstance(d, dict) else "",
        "market_scope": d.get("sc") if isinstance(d, dict) else "",
        "p2_3_6_decimal": odds.get("3:6"),
        "p2_4_6_decimal": odds.get("4:6"),
        "p2_5_7_decimal": odds.get("5:7"),
        "p2_grouped_9_12": p2_grouped,
        "p2_tier": tier_for_grouped(p2_grouped),
        "p1_6_3_decimal": odds.get("6:3"),
        "p1_6_4_decimal": odds.get("6:4"),
        "p1_7_5_decimal": odds.get("7:5"),
        "p1_grouped_9_12": p1_grouped,
        "p1_tier": tier_for_grouped(p1_grouped),
        "bet365_confirmed_count": len([x for x in p2_vals if x]),
        "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]),
        "odds_status": odds_status,
        "note": "",
    }


def write_summary(out_dir: Path, meta: dict[str, Any]) -> None:
    ensure_dir(out_dir)
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-fast-v3-odds-only")
    parser.add_argument("--limit-pages", type=int, default=10)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=2500)
    parser.add_argument("--pause-seconds", type=float, default=0.15)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    fields = output_fields()
    out_csv = out_dir / "fast_v3_odds_only.csv"
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "result_rows_total": 0,
        "chunk_count": 0,
        "rows_written": 0,
        "session_token": "",
        "seed_endpoint_url": "",
        "odds_status_counts": {},
        "fatal": False,
    }

    result_rows, endpoint_rows = build_result_rows(args.results_urls_file, out_dir, args.limit_pages, args.wait_ms)
    meta["result_rows_total"] = len(result_rows)
    meta["endpoint_count"] = len(endpoint_rows)
    start = max(0, int(args.start_index or 0))
    end = None if not args.limit_total or args.limit_total <= 0 else start + int(args.limit_total)
    chunk = result_rows[start:end]
    meta["chunk_start_index"] = start
    meta["chunk_limit_total"] = args.limit_total
    meta["chunk_count"] = len(chunk)
    if not chunk:
        meta["stop_reason"] = "NO_RESULT_ROWS_TO_PROCESS"
        meta["note"] = "No rows in the selected slice. Try start_index 0 or increase limit_pages."
        write_summary(out_dir, meta)
        return 0

    rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for fast V3 odds-only V2.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                meta["fatal"] = True
                write_summary(out_dir, meta)
                return 0

            seed_events = [result_row_to_event(r) for r in result_rows if r.get("event_hash") and r.get("match_url")]
            token, seed_url = robust_discover_session_token(context, page, seed_events, args.wait_ms)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                meta["note"] = "Result rows were found, but no /match-event/ token was captured. The artifact still includes first_set_results.csv for joining later."
                write_summary(out_dir, meta)
                return 0

            counts: dict[str, int] = {}
            for i, result_row in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] Fast V3 odds-only direct fetch: {result_row.get('match_name')} {result_row.get('event_hash')}")
                out_row = fetch_odds_row(context, result_row, token)
                append_csv(out_csv, out_row, fields)
                rows.append(out_row)
                status = str(out_row.get("odds_status") or "unknown")
                counts[status] = counts.get(status, 0) + 1
                meta["rows_written"] = i
                meta["odds_status_counts"] = counts
                write_summary(out_dir, meta)
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    summary = {
        "generated_at": now_iso(),
        "result_rows_total": len(result_rows),
        "rows_written": len(rows),
        "odds_status_counts": meta.get("odds_status_counts", {}),
        "ok_rows": sum(1 for r in rows if r.get("odds_status") == "ok"),
    }
    meta["dataset_summary"] = summary
    meta["stop_reason"] = "FAST_V3_ODDS_ONLY_COMPLETE"
    (out_dir / "dataset_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    write_summary(out_dir, meta)
    report = [
        "# Fast V3 Odds Only V2",
        "",
        f"Generated: {summary['generated_at']}",
        f"Result rows total: {summary['result_rows_total']}",
        f"Rows written: {summary['rows_written']}",
        f"OK rows: {summary['ok_rows']}",
        "",
        "## Odds status counts",
        json.dumps(summary["odds_status_counts"], indent=2),
    ]
    (out_dir / "fast_v3_odds_only_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
