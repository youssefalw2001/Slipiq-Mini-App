#!/usr/bin/env python3
"""
SlipIQ OddsPortal Cookie Editor JSON guarded runner.

Use this when the user can export cookies from iPhone Cookie Editor Next.

Supported secrets:
  ODDSPORTAL_COOKIES_JSON       raw Cookie Editor JSON export
  ODDSPORTAL_COOKIES_JSON_B64   base64 Cookie Editor JSON export
  ODDSPORTAL_STORAGE_STATE_B64  normal Playwright storage_state JSON base64
  ODDSPORTAL_USERNAME/PASSWORD  fallback only

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_login_filtered_bet365_guarded import proof_match_ok, smoke_check_row


def normalize_samesite(value: Any) -> str:
    s = str(value or "Lax").strip().lower()
    if s in {"no_restriction", "none", "samesite=none"}:
        return "None"
    if s in {"strict", "samesite=strict"}:
        return "Strict"
    return "Lax"


def to_float_or_minus_one(value: Any) -> float:
    if value in (None, "", False):
        return -1
    try:
        v = float(value)
        if v > 999999999999:  # ms timestamp
            v = v / 1000.0
        if v <= 0:
            return -1
        return v
    except Exception:
        return -1


def extract_cookie_list(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [c for c in raw if isinstance(c, dict)]
    if isinstance(raw, dict):
        for key in ["cookies", "data", "items", "cookieList"]:
            if isinstance(raw.get(key), list):
                return [c for c in raw[key] if isinstance(c, dict)]
        # Some exporters use domain -> list mapping.
        out: list[dict[str, Any]] = []
        for v in raw.values():
            if isinstance(v, list):
                out.extend([c for c in v if isinstance(c, dict)])
        if out:
            return out
    return []


def cookie_editor_to_storage_state(cookie_export: Any) -> dict[str, Any]:
    cookies = []
    for c in extract_cookie_list(cookie_export):
        name = c.get("name") or c.get("Name") or c.get("key")
        value = c.get("value") or c.get("Value")
        domain = c.get("domain") or c.get("Domain") or ".oddsportal.com"
        path = c.get("path") or c.get("Path") or "/"
        if not name or value is None:
            continue
        domain = str(domain).strip()
        if "oddsportal.com" not in domain:
            continue
        expires = c.get("expires", c.get("expirationDate", c.get("expiration", c.get("expiry", -1))))
        cookies.append({
            "name": str(name),
            "value": str(value),
            "domain": domain,
            "path": str(path),
            "expires": to_float_or_minus_one(expires),
            "httpOnly": bool(c.get("httpOnly", c.get("hostOnly", False)) and False),
            "secure": bool(c.get("secure", c.get("Secure", True))),
            "sameSite": normalize_samesite(c.get("sameSite", c.get("SameSite", "Lax"))),
        })
    return {"cookies": cookies, "origins": []}


def load_cookie_editor_secret(out_dir: Path) -> Path | None:
    raw = os.getenv("ODDSPORTAL_COOKIES_JSON", "").strip()
    raw_b64 = os.getenv("ODDSPORTAL_COOKIES_JSON_B64", "").strip()
    if raw_b64 and not raw:
        try:
            raw = base64.b64decode(raw_b64).decode("utf-8")
        except Exception as exc:
            base.log(f"Could not decode ODDSPORTAL_COOKIES_JSON_B64: {exc}")
            return None
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        state = cookie_editor_to_storage_state(parsed)
        state_path = out_dir / "cookie_editor_storage_state.json"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        base.log(f"Converted Cookie Editor JSON to Playwright storage state with {len(state['cookies'])} oddsportal cookies.")
        return state_path
    except Exception as exc:
        base.log(f"Could not parse ODDSPORTAL_COOKIES_JSON: {exc}")
        return None


def create_cookie_context(browser: Browser, out_dir: Path) -> BrowserContext:
    # Priority 1: normal Playwright state secret.
    storage_path = base.decode_storage_state(out_dir)
    # Priority 2: iPhone Cookie Editor export.
    if storage_path is None:
        storage_path = load_cookie_editor_secret(out_dir)
    kwargs: dict[str, Any] = {
        "viewport": {"width": 1440, "height": 1200},
        "locale": "en-US",
        "timezone_id": "UTC",
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    }
    if storage_path:
        kwargs["storage_state"] = str(storage_path)
    return browser.new_context(**kwargs)


def has_cookie_secret() -> bool:
    return bool(os.getenv("ODDSPORTAL_COOKIES_JSON", "").strip() or os.getenv("ODDSPORTAL_COOKIES_JSON_B64", "").strip() or os.getenv("ODDSPORTAL_STORAGE_STATE_B64", "").strip())


def append_row_csv(path: Path, row: dict[str, str]) -> None:
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
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "proof_match_ok": False,
        "smoke_ok": False,
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret; skipping username/password login.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = base.logged_in_hint(page)
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "COOKIE_OR_LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                base.save_debug(page, out_dir, "cookie_or_login_not_confirmed")
                base.log("Cookie/login session not confirmed. Stopping before filter/smoke.")
                return 3

            base.apply_bet365_filter(page, out_dir, args.wait_ms)
            base.log("Running cookie guarded filtered bet365 smoke test on Sinner/Ofner proof URL.")
            row = base.scrape_market_page(page, base.PROOF_URL, out_dir, args.wait_ms)
            (out_dir / "smoke_row.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
            base.save_debug(page, out_dir, "smoke_filtered_bet365_cookie_guarded")

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
