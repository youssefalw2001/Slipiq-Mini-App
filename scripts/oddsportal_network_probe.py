#!/usr/bin/env python3
"""
SlipIQ OddsPortal network probe.

Purpose:
- Use the existing OddsPortal cookie/session secrets.
- Open one tournament results page and one Correct Score 1st Set match page.
- Capture XHR/fetch/API responses and page snapshots.
- Search saved payloads for V3 terms: 3:6, 4:6, 5:7, bet365, odds, event/match names.

This is a probe, not a scraper:
- read-only
- no betting
- no sportsbook login
- no captcha bypass
- secrets/cookies are not printed
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import (
    clear_oddsportal_route_memory,
    create_cookie_context,
    has_cookie_secret,
)

DEFAULT_RESULTS_URL = "https://www.oddsportal.com/tennis/italy/atp-rome-2025/results/"
DEFAULT_MATCH_URL = "https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12"
SEARCH_TERMS = [
    "3:6", "4:6", "5:7", "3-6", "4-6", "5-7",
    "bet365", "Correct Score", "correct score", "1st Set", "First Set", "cs;12",
    "odds", "bookmaker", "markets", "market", "Sinner", "Ofner",
]
SENSITIVE_QUERY_KEYS = ["token", "apiKey", "apikey", "api_key", "key", "session", "auth", "password"]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def redact_url(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.query:
        return url
    parts = []
    for kv in parsed.query.split("&"):
        if "=" not in kv:
            parts.append(kv)
            continue
        k, _ = kv.split("=", 1)
        if any(s in k.lower() for s in SENSITIVE_QUERY_KEYS):
            parts.append(f"{k}=***REDACTED***")
        else:
            parts.append(kv)
    return parsed._replace(query="&".join(parts)).geturl()


def is_interesting_response(resp: Response) -> bool:
    req = resp.request
    resource_type = req.resource_type
    url = resp.url.lower()
    content_type = (resp.headers.get("content-type") or "").lower()
    if resource_type in {"xhr", "fetch", "document"}:
        return True
    if "json" in content_type or "javascript" in content_type or "text" in content_type:
        return True
    if any(word in url for word in ["api", "ajax", "feed", "event", "match", "odds", "market", "bookmaker"]):
        return True
    return False


def summarize_text(text: str) -> dict[str, Any]:
    lower = text.lower()
    found_terms = [term for term in SEARCH_TERMS if term.lower() in lower]
    scores_found = [score for score in ["3:6", "4:6", "5:7", "3-6", "4-6", "5-7"] if score in text]
    return {
        "length": len(text),
        "found_terms": found_terms,
        "scores_found": scores_found,
        "has_bet365": "bet365" in lower,
        "has_jsonish_odds": any(term in lower for term in ["odds", "bookmaker", "market", "markets", "event", "fixture"]),
    }


def try_decode_body(resp: Response, max_bytes: int) -> tuple[str, bytes | None, str]:
    try:
        body = resp.body()
    except Exception as exc:
        return "", None, f"body_read_error:{exc}"
    if body is None:
        return "", None, "empty_body"
    truncated = body[:max_bytes]
    decode_status = "ok"
    try:
        text = truncated.decode("utf-8", errors="replace")
    except Exception as exc:
        text = ""
        decode_status = f"decode_error:{exc}"
    if len(body) > max_bytes:
        decode_status += f";truncated_from_{len(body)}"
    return text, truncated, decode_status


def save_response(out_dir: Path, phase: str, resp: Response, idx: int, max_body_bytes: int) -> dict[str, Any] | None:
    if not is_interesting_response(resp):
        return None
    url = resp.url
    content_type = resp.headers.get("content-type") or ""
    status = resp.status
    text, raw, decode_status = try_decode_body(resp, max_body_bytes)
    summary = summarize_text(text)
    url_hash = hashlib.sha1(url.encode("utf-8", errors="ignore")).hexdigest()[:12]
    ext = "json" if "json" in content_type.lower() else "txt"
    phase_dir = out_dir / "responses" / phase
    ensure_dir(phase_dir)
    body_filename = f"{idx:04d}_{url_hash}.{ext}"
    body_path = phase_dir / body_filename
    if raw is not None:
        body_path.write_bytes(raw)
    return {
        "phase": phase,
        "idx": idx,
        "url": redact_url(url),
        "method": resp.request.method,
        "resource_type": resp.request.resource_type,
        "status": status,
        "content_type": content_type,
        "body_file": str(body_path.relative_to(out_dir)) if raw is not None else "",
        "decode_status": decode_status,
        **summary,
    }


def attach_capture(page: Page, out_dir: Path, phase: str, rows: list[dict[str, Any]], max_body_bytes: int) -> None:
    counter = {"n": 0}

    def on_response(resp: Response) -> None:
        counter["n"] += 1
        try:
            row = save_response(out_dir, phase, resp, counter["n"], max_body_bytes)
            if row is not None:
                rows.append(row)
        except Exception as exc:
            rows.append({
                "phase": phase,
                "idx": counter["n"],
                "url": redact_url(resp.url),
                "method": resp.request.method,
                "resource_type": resp.request.resource_type,
                "status": resp.status,
                "content_type": resp.headers.get("content-type") or "",
                "body_file": "",
                "decode_status": f"save_error:{exc}",
                "length": 0,
                "found_terms": [],
                "scores_found": [],
                "has_bet365": False,
                "has_jsonish_odds": False,
            })

    page.on("response", on_response)


def save_page_snapshot(page: Page, out_dir: Path, phase: str) -> None:
    snap_dir = out_dir / "snapshots"
    ensure_dir(snap_dir)
    try:
        page.screenshot(path=str(snap_dir / f"{phase}.png"), full_page=True, timeout=20000)
    except Exception:
        pass
    try:
        (snap_dir / f"{phase}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass
    try:
        text = page.locator("body").inner_text(timeout=10000)
        (snap_dir / f"{phase}.body.txt").write_text(text, encoding="utf-8")
    except Exception:
        pass


def scroll_and_wait(page: Page, wait_ms: int, rounds: int = 4) -> None:
    for _ in range(rounds):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(750, wait_ms // 2))


def click_possible_market_controls(page: Page, wait_ms: int) -> None:
    patterns = ["Correct Score", "1st Set", "First Set", "Set 1", "Dokładny wynik", "1. set", "1 set"]
    for pat in patterns:
        try:
            loc = page.get_by_text(re.compile(re.escape(pat), re.I)).first
            loc.click(timeout=1500)
            page.wait_for_timeout(wait_ms)
        except Exception:
            continue


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields = [
        "phase", "idx", "url", "method", "resource_type", "status", "content_type", "body_file",
        "decode_status", "length", "found_terms", "scores_found", "has_bet365", "has_jsonish_odds",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            out = dict(row)
            out["found_terms"] = json.dumps(out.get("found_terms", []), ensure_ascii=False)
            out["scores_found"] = json.dumps(out.get("scores_found", []), ensure_ascii=False)
            writer.writerow({k: out.get(k, "") for k in fields})


def write_interest_report(out_dir: Path, rows: list[dict[str, Any]]) -> dict[str, Any]:
    interesting = [r for r in rows if r.get("found_terms") or r.get("has_bet365") or r.get("scores_found")]
    jsonish = [r for r in rows if "json" in str(r.get("content_type", "")).lower()]
    body_errors = [r for r in rows if "error" in str(r.get("decode_status", "")).lower()]
    report = {
        "generated_at": now_iso(),
        "total_captured": len(rows),
        "jsonish_count": len(jsonish),
        "interesting_count": len(interesting),
        "body_error_count": len(body_errors),
        "top_interesting": interesting[:50],
        "recommendation": "Inspect network_requests.csv and responses/* files. If score odds/bookmaker data appears in JSON, build JSON scraper next. If only HTML has it, keep DOM scraper fallback.",
    }
    (out_dir / "network_probe_summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = [
        "# OddsPortal Network Probe Report",
        "",
        f"Generated: {report['generated_at']}",
        f"Total captured responses: {len(rows)}",
        f"JSON-ish responses: {len(jsonish)}",
        f"Interesting responses: {len(interesting)}",
        f"Body read/save errors: {len(body_errors)}",
        "",
        "## Top interesting responses",
        "",
    ]
    for row in interesting[:30]:
        terms = ", ".join(row.get("found_terms", []))
        lines.append(f"- `{row.get('phase')}` `{row.get('status')}` `{row.get('content_type')}` `{row.get('body_file')}`")
        lines.append(f"  - terms: {terms}")
        lines.append(f"  - url: {row.get('url')}")
    (out_dir / "network_probe_report.md").write_text("\n".join(lines), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-url", default=DEFAULT_RESULTS_URL)
    parser.add_argument("--match-url", default=DEFAULT_MATCH_URL)
    parser.add_argument("--out", default="artifacts/output/oddsportal-network-probe")
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--max-body-bytes", type=int, default=750000)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    rows: list[dict[str, Any]] = []
    meta = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context: BrowserContext = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret; skipping username/password login.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                login_ok = True
            else:
                login_ok = base.login_if_needed(page, out_dir, args.wait_ms)
            meta["login_ok"] = bool(login_ok)
            if not login_ok:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 3

            base.apply_bet365_filter(page, out_dir, args.wait_ms)
            clear_oddsportal_route_memory(context, page, args.wait_ms)

            attach_capture(page, out_dir, "results_page", rows, args.max_body_bytes)
            base.log(f"Opening results page for network probe: {args.results_url}")
            base.goto(page, args.results_url, args.wait_ms)
            scroll_and_wait(page, args.wait_ms, rounds=5)
            save_page_snapshot(page, out_dir, "results_page")

            clear_oddsportal_route_memory(context, page, args.wait_ms)
            attach_capture(page, out_dir, "match_page", rows, args.max_body_bytes)
            base.log(f"Opening match page for network probe: {args.match_url}")
            base.goto(page, args.match_url, args.wait_ms)
            click_possible_market_controls(page, args.wait_ms)
            scroll_and_wait(page, args.wait_ms, rounds=3)
            save_page_snapshot(page, out_dir, "match_page")

            write_csv(out_dir / "network_requests.csv", rows)
            report = write_interest_report(out_dir, rows)
            meta.update({
                "stop_reason": "NETWORK_PROBE_COMPLETE",
                "captured_responses": len(rows),
                "interesting_count": report.get("interesting_count"),
                "jsonish_count": report.get("jsonish_count"),
                "body_error_count": report.get("body_error_count"),
            })
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
