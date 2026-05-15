#!/usr/bin/env python3
"""
Guarded runner for the fast filtered OddsPortal bet365 scraper.

Adds two safety checks on top of oddsportal_login_filtered_bet365_scraper.py:
1. If OddsPortal login/session is not confirmed, stop before filter/smoke.
2. If the proof URL redirects to the wrong match, stop before comparing prices.

Read-only. No betting. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

import oddsportal_login_filtered_bet365_scraper as base


def proof_match_ok(row: dict[str, str]) -> bool:
    haystack = " ".join([
        row.get("market_url", ""),
        row.get("match_name", ""),
        row.get("title", ""),
    ]).lower()
    return "sinner" in haystack and "ofner" in haystack


def odds_to_decimal(value: str | None) -> float | None:
    return base.odds_to_decimal(value or "")


def smoke_check_row(row: dict[str, str]) -> dict[str, Any]:
    if not proof_match_ok(row):
        return {
            "ok": False,
            "reason": "WRONG_PROOF_MATCH",
            "message": "Proof URL did not remain on Sinner/Ofner. Do not compare prices from another match.",
            "row": row,
            "checks": [],
        }

    checks = []
    for score, expected in base.TARGET_P2.items():
        key = {"3:6": "p2_3_6", "4:6": "p2_4_6", "5:7": "p2_5_7"}[score]
        raw_key = key + "_raw"
        actual = odds_to_decimal(row.get(key, ""))
        raw = row.get(raw_key, "")
        ok = base.decimal_close(actual, expected["decimal"]) or str(raw).strip() == expected["american"]
        checks.append({
            "score": score,
            "expected_decimal": expected["decimal"],
            "expected_american": expected["american"],
            "actual_decimal": actual,
            "actual_raw": raw,
            "ok": ok,
        })
    return {
        "ok": all(c["ok"] for c in checks),
        "reason": "OK" if all(c["ok"] for c in checks) else "FILTERED_BET365_PRICES_NOT_CONFIRMED",
        "checks": checks,
        "row": row,
    }


def append_row_csv(path: Path, row: dict[str, str]) -> None:
    # Delegate to original helper to keep the backtest CSV schema consistent.
    base.append_row_csv(path, row)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exact-urls-file", default="")
    parser.add_argument("--results-urls-file", default="")
    parser.add_argument("--out", default="artifacts/output/oddsportal-login-filtered-bet365")
    parser.add_argument("--limit-total", type=int, default=40)
    parser.add_argument("--max-matches-per-results", type=int, default=10)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--pause-seconds", type=float, default=1.5)
    parser.add_argument("--smoke-only", action="store_true")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    base.ensure_dir(out_dir)
    csv_path = out_dir / "bet365_master_odds_db.csv"
    meta: dict[str, Any] = {
        "generated_at": base.now_iso(),
        "args": vars(args),
        "rows": 0,
        "login_ok": False,
        "proof_match_ok": False,
        "smoke_ok": False,
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = base.create_context(browser, out_dir)
        page = context.new_page()
        try:
            login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.log("Login/session not confirmed. Stopping before filter/smoke.")
                return 3

            base.apply_bet365_filter(page, out_dir, args.wait_ms)

            base.log("Running guarded filtered bet365 smoke test on Sinner/Ofner proof URL.")
            row = base.scrape_market_page(page, base.PROOF_URL, out_dir, args.wait_ms)
            (out_dir / "smoke_row.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
            base.save_debug(page, out_dir, "smoke_filtered_bet365_guarded")

            result = smoke_check_row(row)
            meta["proof_match_ok"] = proof_match_ok(row)
            meta["smoke_ok"] = bool(result["ok"])
            meta["smoke_reason"] = result.get("reason")
            (out_dir / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            base.log(json.dumps({"smoke_ok": result["ok"], "reason": result.get("reason"), "proof_match_ok": meta["proof_match_ok"]}, indent=2))

            if not result["ok"]:
                meta["stop_reason"] = result.get("reason")
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2

            if args.smoke_only:
                meta["stop_reason"] = "SMOKE_ONLY_COMPLETE"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.log("Smoke-only mode complete.")
                return 0

            exact_urls = base.read_urls_file(args.exact_urls_file)
            results_urls = base.read_urls_file(args.results_urls_file)
            market_urls: list[str] = []
            market_urls.extend(exact_urls)
            for results_url in results_urls:
                if len(market_urls) >= args.limit_total:
                    break
                market_urls.extend(base.discover_match_urls(page, results_url, args.max_matches_per_results, args.wait_ms))

            deduped = []
            seen = set()
            for url in market_urls:
                if url not in seen:
                    seen.add(url)
                    deduped.append(url)
            market_urls = deduped[: args.limit_total]
            (out_dir / "market_urls.json").write_text(json.dumps(market_urls, indent=2), encoding="utf-8")
            base.log(f"Total market URLs to scrape: {len(market_urls)}")

            rows: list[dict[str, str]] = []
            for idx, url in enumerate(market_urls, start=1):
                base.log(f"[{idx}/{len(market_urls)}] Scraping {url}")
                try:
                    scraped = base.scrape_market_page(page, url, out_dir, args.wait_ms)
                except Exception as exc:
                    base.log(f"[{idx}/{len(market_urls)}] ERROR {exc}")
                    base.save_debug(page, out_dir, f"error_{idx}")
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
                rows.append(scraped)
                append_row_csv(csv_path, scraped)
                base.log(f"[{idx}/{len(market_urls)}] status={scraped.get('status')} p2_grouped={scraped.get('p2_grouped_9_12')} match={scraped.get('match_name')}")
                time.sleep(args.pause_seconds)

            meta["rows"] = len(rows)
            meta["status_counts"] = {s: sum(1 for r in rows if r.get("status") == s) for s in sorted({r.get("status") for r in rows})}
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
