#!/usr/bin/env python3
"""
SlipIQ fast constructed V3 dataset builder.

This is the combined fast workflow:
1. Decode OddsPortal archive endpoints.
2. Extract real first-set results from partialresult.
3. Discover match-event session token once.
4. Construct first-set correct-score endpoint directly:
   https://www.oddsportal.com/match-event/1-2-{event_hash}-8-12-{session_token}.dat?geo=US&lang=en
5. Direct-fetch/decode provider 549 bet365 V3 odds.
6. Join result + odds into one backtest-ready CSV.

V3 = Player 2 wins first set by 3:6 / 4:6 / 5:7.

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_archive_first_set_results_builder import collect_results, dedupe_results
from oddsportal_constructed_v3_endpoint_probe import discover_session_token, construct_v3_endpoint
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P1,
    TARGET_P2,
    decode_oddsportal_dat,
    decimal_grouped,
    score_odds,
    tier_for_grouped,
)

P2_V3_HIT_SCORES = {"3:6", "4:6", "5:7"}
P1_V3_HIT_SCORES = {"6:3", "6:4", "7:5"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def to_float(value: Any) -> float | None:
    try:
        if value in (None, "", "None", "nan"):
            return None
        v = float(value)
        if math.isnan(v):
            return None
        return v
    except Exception:
        return None


def profit_for_stake(hit: bool | None, odds: float | None, stake: float) -> float | str:
    if hit is None or odds is None:
        return ""
    return round(stake * (odds - 1), 2) if hit else round(-stake, 2)


def implied_break_even(odds: float | None) -> float | str:
    if odds is None or odds <= 0:
        return ""
    return round(1 / odds, 6)


def output_fields() -> list[str]:
    return [
        "scraped_at",
        "event_id",
        "event_hash",
        "player1",
        "player2",
        "match_name",
        "match_date",
        "tournament",
        "match_url",
        "partialresult",
        "first_set_score",
        "result_status",
        "result_source",
        "constructed_url",
        "provider_id",
        "market_bt",
        "market_scope",
        "p2_3_6_decimal",
        "p2_4_6_decimal",
        "p2_5_7_decimal",
        "p2_grouped_9_12",
        "p2_break_even",
        "p2_tier",
        "p2_v3_hit",
        "p2_profit_100",
        "p1_6_3_decimal",
        "p1_6_4_decimal",
        "p1_7_5_decimal",
        "p1_grouped_9_12",
        "p1_break_even",
        "p1_tier",
        "p1_v3_hit",
        "p1_profit_100",
        "bet365_confirmed_count",
        "all_score_count",
        "http_status",
        "decode_status",
        "body_length",
        "odds_status",
        "status",
        "note",
    ]


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

    all_endpoint_rows: list[dict[str, Any]] = []
    all_result_rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for url in urls:
                clear_oddsportal_route_memory(context, page, wait_ms)
                try:
                    endpoint_rows, result_rows = collect_results(page, url, wait_ms)
                except Exception as exc:
                    endpoint_rows, result_rows = [{"results_url": url, "error": str(exc)}], []
                all_endpoint_rows.extend(endpoint_rows)
                all_result_rows.extend(result_rows)
        finally:
            context.close()
            browser.close()
    result_rows = dedupe_results(all_result_rows)
    endpoint_fields = ["results_url", "landed_url", "endpoint_url", "status", "decode_status", "row_count", "error"]
    result_fields = [
        "results_url", "landed_url", "source_endpoint", "event_id", "event_hash", "player1", "player2", "match_name",
        "match_date", "tournament", "archive_status", "status_id", "match_url", "partialresult", "first_set_score",
        "result_status", "result_source", "p2_v3_hit", "p1_v3_hit",
    ]
    write_csv(out_dir / "archive_results_endpoint_inventory.csv", all_endpoint_rows, endpoint_fields)
    write_csv(out_dir / "first_set_results.csv", result_rows, result_fields)
    return result_rows, all_endpoint_rows


def result_row_to_event(row: dict[str, Any]) -> dict[str, Any]:
    # discover_session_token expects event-like keys.
    return {
        "event_id": row.get("event_id", ""),
        "event_hash": row.get("event_hash", ""),
        "player1": row.get("player1", ""),
        "player2": row.get("player2", ""),
        "match_name": row.get("match_name", ""),
        "match_url": row.get("match_url", ""),
    }


def direct_fetch_joined_row(context: Any, result_row: dict[str, Any], session_token: str, stake: float) -> dict[str, Any]:
    event_hash = clean_text(result_row.get("event_hash", ""))
    match_url = clean_text(result_row.get("match_url", ""))
    first_set_score = clean_text(result_row.get("first_set_score", ""))
    result_status = clean_text(result_row.get("result_status", "")) or ("ok" if first_set_score else "needs_result")

    base_row: dict[str, Any] = {
        "scraped_at": now_iso(),
        "event_id": result_row.get("event_id", ""),
        "event_hash": event_hash,
        "player1": result_row.get("player1", ""),
        "player2": result_row.get("player2", ""),
        "match_name": result_row.get("match_name", ""),
        "match_date": result_row.get("match_date", ""),
        "tournament": result_row.get("tournament", ""),
        "match_url": match_url,
        "partialresult": result_row.get("partialresult", ""),
        "first_set_score": first_set_score,
        "result_status": result_status,
        "result_source": result_row.get("result_source", ""),
        "provider_id": PROVIDER_BET365,
    }

    if not event_hash:
        return {**base_row, "odds_status": "missing_event_hash", "status": "skip_missing_event_hash", "note": "No event_hash/encodeEventId."}

    constructed_url = construct_v3_endpoint(event_hash, session_token)
    try:
        resp = context.request.get(constructed_url, headers={"referer": match_url or "https://www.oddsportal.com/", "accept": "*/*"}, timeout=30000)
        body = resp.text()
    except Exception as exc:
        return {
            **base_row,
            "constructed_url": constructed_url,
            "http_status": "",
            "decode_status": "",
            "body_length": "",
            "odds_status": "request_error",
            "status": "skip_request_error",
            "note": str(exc)[:500],
        }

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
    p2_hit = first_set_score in P2_V3_HIT_SCORES if first_set_score else None
    p1_hit = first_set_score in P1_V3_HIT_SCORES if first_set_score else None
    d = decoded.get("d", {}) if isinstance(decoded, dict) else {}

    if resp.status >= 400:
        odds_status = f"http_{resp.status}"
    elif decoded is None:
        odds_status = "decode_failed"
    elif not p2_grouped:
        odds_status = "missing_v3_prices"
    else:
        odds_status = "ok"

    final_status = "ok" if odds_status == "ok" and result_status == "ok" else "skip"
    all_score_count = len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v])
    return {
        **base_row,
        "constructed_url": constructed_url,
        "http_status": resp.status,
        "decode_status": decode_status,
        "body_length": len(body),
        "market_bt": d.get("bt") if isinstance(d, dict) else "",
        "market_scope": d.get("sc") if isinstance(d, dict) else "",
        "p2_3_6_decimal": odds.get("3:6"),
        "p2_4_6_decimal": odds.get("4:6"),
        "p2_5_7_decimal": odds.get("5:7"),
        "p2_grouped_9_12": p2_grouped,
        "p2_break_even": implied_break_even(p2_grouped),
        "p2_tier": tier_for_grouped(p2_grouped),
        "p2_v3_hit": str(p2_hit).lower() if p2_hit is not None else "",
        "p2_profit_100": profit_for_stake(p2_hit, p2_grouped, stake),
        "p1_6_3_decimal": odds.get("6:3"),
        "p1_6_4_decimal": odds.get("6:4"),
        "p1_7_5_decimal": odds.get("7:5"),
        "p1_grouped_9_12": p1_grouped,
        "p1_break_even": implied_break_even(p1_grouped),
        "p1_tier": tier_for_grouped(p1_grouped),
        "p1_v3_hit": str(p1_hit).lower() if p1_hit is not None else "",
        "p1_profit_100": profit_for_stake(p1_hit, p1_grouped, stake),
        "bet365_confirmed_count": len([x for x in p2_vals if x]),
        "all_score_count": all_score_count,
        "odds_status": odds_status,
        "status": final_status,
        "note": "",
    }


def summarize_backtest(rows: list[dict[str, Any]], stake: float, prefix: str) -> dict[str, Any]:
    odds_key = f"{prefix}_grouped_9_12"
    hit_key = f"{prefix}_v3_hit"
    profit_key = f"{prefix}_profit_100"
    eligible = [r for r in rows if r.get("status") == "ok" and r.get("odds_status") == "ok" and r.get("result_status") == "ok" and to_float(r.get(odds_key))]
    if not eligible:
        return {
            "bets": 0,
            "wins": 0,
            "losses": 0,
            "hit_rate": None,
            "avg_odds": None,
            "break_even_hit_rate": None,
            "profit": 0,
            "roi": None,
            "tier_counts": {},
        }
    wins = sum(1 for r in eligible if str(r.get(hit_key)).lower() == "true")
    profit = round(sum(float(r.get(profit_key) or 0) for r in eligible), 2)
    total_staked = round(len(eligible) * stake, 2)
    odds_values = [float(r.get(odds_key)) for r in eligible if to_float(r.get(odds_key))]
    tier_counts: dict[str, int] = {}
    for r in eligible:
        tier = str(r.get(f"{prefix}_tier") or "")
        tier_counts[tier] = tier_counts.get(tier, 0) + 1
    avg_odds = statistics.mean(odds_values) if odds_values else None
    return {
        "bets": len(eligible),
        "wins": wins,
        "losses": len(eligible) - wins,
        "hit_rate": round(wins / len(eligible), 6),
        "avg_odds": round(avg_odds, 6) if avg_odds else None,
        "break_even_hit_rate": round(1 / avg_odds, 6) if avg_odds else None,
        "total_staked": total_staked,
        "profit": profit,
        "roi": round(profit / total_staked, 6) if total_staked else None,
        "tier_counts": tier_counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-fast-constructed-v3-dataset")
    parser.add_argument("--limit-pages", type=int, default=25)
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=200)
    parser.add_argument("--wait-ms", type=int, default=2500)
    parser.add_argument("--pause-seconds", type=float, default=0.15)
    parser.add_argument("--stake", type=float, default=100.0)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    csv_path = out_dir / "fast_v3_backtest_ready.csv"
    fields = output_fields()
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
        "status_counts": {},
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
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for fast constructed V3 dataset.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 3

            event_seed_rows = [result_row_to_event(r) for r in result_rows if r.get("match_url") and r.get("event_hash")]
            token, seed_url = discover_session_token(context, page, event_seed_rows, args.wait_ms)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 4

            odds_counts: dict[str, int] = {}
            status_counts: dict[str, int] = {}
            for i, result_row in enumerate(chunk, start=1):
                base.log(f"[{i}/{len(chunk)}] Fast V3 direct fetch: {result_row.get('match_name')} {result_row.get('event_hash')}")
                row = direct_fetch_joined_row(context, result_row, token, args.stake)
                append_csv(csv_path, row, fields)
                rows.append(row)
                odds_status = str(row.get("odds_status") or "unknown")
                status = str(row.get("status") or "unknown")
                odds_counts[odds_status] = odds_counts.get(odds_status, 0) + 1
                status_counts[status] = status_counts.get(status, 0) + 1
                meta["rows_written"] = i
                meta["odds_status_counts"] = odds_counts
                meta["status_counts"] = status_counts
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    summary = {
        "generated_at": now_iso(),
        "rows_written": len(rows),
        "result_rows_total": len(result_rows),
        "odds_status_counts": meta.get("odds_status_counts", {}),
        "status_counts": meta.get("status_counts", {}),
        "p2": summarize_backtest(rows, args.stake, "p2"),
        "p1": summarize_backtest(rows, args.stake, "p1"),
        "notes": [
            "P2 V3 = first-set score in 3:6, 4:6, 5:7.",
            "Rows are backtest eligible only when status=ok, odds_status=ok, and result_status=ok.",
            "This is historical analysis only, not betting advice.",
        ],
    }
    meta["dataset_summary"] = summary
    meta["stop_reason"] = "FAST_CONSTRUCTED_V3_DATASET_COMPLETE"
    (out_dir / "dataset_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    report = [
        "# Fast Constructed V3 Dataset",
        "",
        f"Generated: {summary['generated_at']}",
        f"Result rows total: {summary['result_rows_total']}",
        f"Rows written: {summary['rows_written']}",
        "",
        "## Odds status counts",
        json.dumps(summary["odds_status_counts"], indent=2),
        "",
        "## P2 V3 summary",
        json.dumps(summary["p2"], indent=2),
        "",
        "## P1 mirror summary",
        json.dumps(summary["p1"], indent=2),
    ]
    (out_dir / "fast_v3_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
