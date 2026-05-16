#!/usr/bin/env python3
"""
SlipIQ V3 odds fetcher from a saved master first-set-results CSV.

Two-stage stable architecture:
1) Build data/first_set_results_master.csv once from archive partialresult data.
2) This script reads that CSV directly, discovers one OddsPortal match-event token,
   then direct-fetches V3 odds for each event_hash.

V3 = Player 2 wins first set by 3:6 / 4:6 / 5:7.
Endpoint pattern:
  https://www.oddsportal.com/match-event/1-2-{event_hash}-8-12-{token}.dat?geo=US&lang=en

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
from urllib.parse import urldefrag

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_constructed_v3_endpoint_probe import (
    TOKEN_RE,
    click_light_market_controls,
    construct_v3_endpoint,
    extract_session_token,
    should_capture_match_event,
)
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


def read_csv_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists() or path.stat().st_size == 0:
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


def token_seed_url_variants(match_url: str, event_hash: str) -> list[str]:
    raw = clean_text(match_url)
    if not raw:
        return []
    base_url = urldefrag(raw)[0].rstrip("/")
    variants = [raw, base_url + "/"]
    if event_hash:
        variants.extend([
            base_url + f"#{event_hash}:cs;12",
            base_url + f"/#{event_hash}:cs;12",
            base_url + "#cs;12",
            base_url + "/#cs;12",
        ])
    out: list[str] = []
    for item in variants:
        if item and item not in out:
            out.append(item)
    return out


def discover_token_fast(
    context: BrowserContext,
    page: Page,
    rows: list[dict[str, Any]],
    wait_ms: int,
    max_events: int,
) -> tuple[str, str]:
    seed_rows = [r for r in rows if clean_text(r.get("match_url")) and clean_text(r.get("event_hash"))]
    for row in seed_rows[:max_events]:
        event_hash = clean_text(row.get("event_hash"))
        for url in token_seed_url_variants(clean_text(row.get("match_url")), event_hash):
            captured: list[str] = []
            seen: set[str] = set()

            def on_response(resp: Response) -> None:
                if resp.url in seen:
                    return
                seen.add(resp.url)
                if should_capture_match_event(resp) or TOKEN_RE.search(resp.url):
                    token = extract_session_token(resp.url)
                    if token:
                        captured.append(resp.url)

            page.on("response", on_response)
            try:
                clear_oddsportal_route_memory(context, page, wait_ms)
                base.log(f"Token seed trying: {url}")
                base.goto(page, url, wait_ms)
                click_light_market_controls(page, max(800, wait_ms // 2))
                page.wait_for_timeout(max(800, wait_ms // 2))
                try:
                    html = page.content()
                    m = TOKEN_RE.search(html)
                    if m:
                        return m.group(1), url
                except Exception:
                    pass
            except Exception as exc:
                base.log(f"Token seed failed: {exc}")
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


def output_fields() -> list[str]:
    return [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "tournament", "match_url",
        "partialresult", "first_set_score", "result_status", "constructed_url", "provider_id", "http_status", "decode_status", "body_length",
        "market_bt", "market_scope", "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12", "p2_tier",
        "p1_6_3_decimal", "p1_6_4_decimal", "p1_7_5_decimal", "p1_grouped_9_12", "p1_tier",
        "bet365_confirmed_count", "all_score_count", "odds_status", "note",
    ]


def fetch_odds_row(context: BrowserContext, row: dict[str, Any], token: str) -> dict[str, Any]:
    event_hash = clean_text(row.get("event_hash"))
    match_url = clean_text(row.get("match_url"))
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
    parser.add_argument("--master-results-csv", default="data/first_set_results_master.csv")
    parser.add_argument("--out", default="artifacts/output/oddsportal-v3-odds-from-master")
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=2500)
    parser.add_argument("--pause-seconds", type=float, default=0.15)
    parser.add_argument("--token-max-events", type=int, default=8)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    out_csv = out_dir / "v3_odds_from_master.csv"
    fields = output_fields()
    master_path = Path(args.master_results_csv)
    all_rows = read_csv_rows(master_path)
    start = max(0, int(args.start_index or 0))
    end = None if not args.limit_total or args.limit_total <= 0 else start + int(args.limit_total)
    chunk = all_rows[start:end]

    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "master_results_csv_exists": master_path.exists(),
        "master_results_csv_size": master_path.stat().st_size if master_path.exists() else 0,
        "master_rows_total": len(all_rows),
        "chunk_start_index": start,
        "chunk_limit_total": args.limit_total,
        "chunk_count": len(chunk),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "rows_written": 0,
        "odds_status_counts": {},
    }
    if not chunk:
        meta["stop_reason"] = "NO_MASTER_ROWS_TO_PROCESS"
        meta["note"] = "Build data/first_set_results_master.csv first, or change start_index/limit_total."
        write_summary(out_dir, meta)
        return 0

    rows_written: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for V3 odds from master CSV.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                write_summary(out_dir, meta)
                return 0

            token, seed_url = discover_token_fast(context, page, all_rows, args.wait_ms, args.token_max_events)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                write_summary(out_dir, meta)
                return 0

            counts: dict[str, int] = {}
            for i, row in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] Direct V3 odds from master: {row.get('match_name')} {row.get('event_hash')}")
                out_row = fetch_odds_row(context, row, token)
                append_csv(out_csv, out_row, fields)
                rows_written.append(out_row)
                status = str(out_row.get("odds_status") or "unknown")
                counts[status] = counts.get(status, 0) + 1
                meta["rows_written"] = i
                meta["odds_status_counts"] = counts
                write_summary(out_dir, meta)
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    dataset_summary = {
        "generated_at": now_iso(),
        "master_rows_total": len(all_rows),
        "rows_written": len(rows_written),
        "ok_rows": sum(1 for r in rows_written if r.get("odds_status") == "ok"),
        "odds_status_counts": meta.get("odds_status_counts", {}),
    }
    meta["dataset_summary"] = dataset_summary
    meta["stop_reason"] = "V3_ODDS_FROM_MASTER_COMPLETE"
    (out_dir / "dataset_summary.json").write_text(json.dumps(dataset_summary, indent=2), encoding="utf-8")
    write_summary(out_dir, meta)
    report = [
        "# V3 Odds From Master CSV",
        "",
        f"Generated: {dataset_summary['generated_at']}",
        f"Master rows total: {dataset_summary['master_rows_total']}",
        f"Rows written: {dataset_summary['rows_written']}",
        f"OK rows: {dataset_summary['ok_rows']}",
        "",
        "## Odds status counts",
        json.dumps(dataset_summary["odds_status_counts"], indent=2),
    ]
    (out_dir / "v3_odds_from_master_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
