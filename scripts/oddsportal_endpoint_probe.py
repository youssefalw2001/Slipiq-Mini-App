#!/usr/bin/env python3
"""
SlipIQ focused OddsPortal endpoint probe.

This is the next step after the broad network probe.
It ignores CSS/JS/assets/CookieLaw/ads noise and captures only OddsPortal
endpoint families that may contain useful match, result, market, or odds data.

Target families:
- /ajax-user-data/
- /match-event/
- /feed/postmatch-score/
- /ajax-sport-country-tournament-archive
- URLs containing: odds, market, bookmaker, event, h2h, match, tournament

Read-only. No betting. No sportsbook login. No captcha bypass.
Do not print cookies/secrets.
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

ENDPOINT_PATTERNS = [
    "/ajax-user-data/",
    "/match-event/",
    "/feed/postmatch-score/",
    "/ajax-sport-country-tournament-archive",
    "/ajax-next-games/",
    "/ajax-mainbookmakers/",
    "/ajax-sport-country-tournament/",
    "/ajax-match/",
    "/ajax-event/",
]
URL_KEYWORDS = ["odds", "market", "markets", "bookmaker", "event", "h2h", "match", "tournament", "score"]
BODY_TERMS = [
    "3:6", "4:6", "5:7", "3-6", "4-6", "5-7",
    "bet365", "bookmaker", "bookmakers", "odds", "market", "markets",
    "correct score", "Correct Score", "1st Set", "First Set", "cs;12",
    "Sinner", "Ofner", "Diaz", "Tabilo",
]
NOISY_HOSTS = [
    "cookielaw.org",
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "stapecdn.com",
    "widgix",
]
NOISY_PATH_PARTS = [
    "/build/assets/",
    "/country-flags/",
    "/logos/",
    "/fonts/",
    ".css",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".woff",
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


def should_capture(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    url_lower = resp.url.lower()
    content_type = (resp.headers.get("content-type") or "").lower()
    resource_type = resp.request.resource_type

    if any(noisy in host for noisy in NOISY_HOSTS):
        return False
    if any(part in path for part in NOISY_PATH_PARTS):
        return False
    if "oddsportal.com" not in host:
        return False

    if any(pattern in path for pattern in ENDPOINT_PATTERNS):
        return True
    if resource_type in {"xhr", "fetch"} and any(k in url_lower for k in URL_KEYWORDS):
        return True
    if "json" in content_type and any(k in url_lower for k in URL_KEYWORDS):
        return True
    # Capture the target document pages, but not all docs.
    if resource_type == "document" and ("/tennis/" in path and ("/h2h/" in path or "/results/" in path)):
        return True
    return False


def read_body(resp: Response, max_bytes: int) -> tuple[str, bytes | None, str]:
    try:
        body = resp.body()
    except Exception as exc:
        return "", None, f"body_read_error:{exc}"
    if body is None:
        return "", None, "empty_body"
    raw = body[:max_bytes]
    status = "ok"
    if len(body) > max_bytes:
        status = f"ok;truncated_from_{len(body)}"
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception as exc:
        text = ""
        status = f"decode_error:{exc}"
    return text, raw, status


def summarize_body(text: str) -> dict[str, Any]:
    lower = text.lower()
    found_terms = [term for term in BODY_TERMS if term.lower() in lower]
    score_terms = [s for s in ["3:6", "4:6", "5:7", "3-6", "4-6", "5-7"] if s in text]
    maybe_payload = any(t in lower for t in ["odds", "bookmaker", "market", "event", "match", "tournament", "participant"])
    return {
        "length": len(text),
        "found_terms": found_terms,
        "score_terms": score_terms,
        "has_bet365": "bet365" in lower,
        "has_v3_scores": all(s in text for s in ["3:6", "4:6", "5:7"]) or all(s in text for s in ["3-6", "4-6", "5-7"]),
        "maybe_payload": maybe_payload,
    }


def save_response(out_dir: Path, phase: str, resp: Response, idx: int, max_body_bytes: int) -> dict[str, Any] | None:
    if not should_capture(resp):
        return None
    text, raw, body_status = read_body(resp, max_body_bytes)
    summary = summarize_body(text)
    url_hash = hashlib.sha1(resp.url.encode("utf-8", errors="ignore")).hexdigest()[:12]
    content_type = resp.headers.get("content-type") or ""
    ext = "json" if "json" in content_type.lower() else "txt"
    phase_dir = out_dir / "endpoint_responses" / phase
    ensure_dir(phase_dir)
    file_path = phase_dir / f"{idx:04d}_{url_hash}.{ext}"
    if raw is not None:
        file_path.write_bytes(raw)
    return {
        "phase": phase,
        "idx": idx,
        "url": redact_url(resp.url),
        "method": resp.request.method,
        "resource_type": resp.request.resource_type,
        "status": resp.status,
        "content_type": content_type,
        "body_file": str(file_path.relative_to(out_dir)) if raw is not None else "",
        "body_status": body_status,
        **summary,
    }


def attach_endpoint_capture(page: Page, out_dir: Path, phase: str, rows: list[dict[str, Any]], max_body_bytes: int) -> None:
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
                "body_status": f"save_error:{exc}",
                "length": 0,
                "found_terms": [],
                "score_terms": [],
                "has_bet365": False,
                "has_v3_scores": False,
                "maybe_payload": False,
            })

    page.on("response", on_response)


def save_snapshot(page: Page, out_dir: Path, phase: str) -> None:
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
        (snap_dir / f"{phase}.body.txt").write_text(page.locator("body").inner_text(timeout=10000), encoding="utf-8")
    except Exception:
        pass


def scroll_and_click(page: Page, wait_ms: int) -> None:
    for _ in range(5):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(750, wait_ms // 2))
    # Try common labels for market tab, localized/nonlocalized.
    for label in ["Correct Score", "1st Set", "First Set", "Set 1", "Dokładny wynik", "1. set", "1 set"]:
        try:
            page.get_by_text(re.compile(re.escape(label), re.I)).first.click(timeout=1200)
            page.wait_for_timeout(wait_ms)
        except Exception:
            continue


def write_endpoint_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields = [
        "phase", "idx", "url", "method", "resource_type", "status", "content_type", "body_file", "body_status",
        "length", "found_terms", "score_terms", "has_bet365", "has_v3_scores", "maybe_payload",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            out = dict(row)
            out["found_terms"] = json.dumps(out.get("found_terms", []), ensure_ascii=False)
            out["score_terms"] = json.dumps(out.get("score_terms", []), ensure_ascii=False)
            writer.writerow({k: out.get(k, "") for k in fields})


def write_report(out_dir: Path, rows: list[dict[str, Any]]) -> dict[str, Any]:
    useful = [r for r in rows if r.get("has_bet365") or r.get("has_v3_scores") or r.get("score_terms")]
    payloads = [r for r in rows if r.get("maybe_payload")]
    errors = [r for r in rows if "error" in str(r.get("body_status", "")).lower()]
    summary = {
        "generated_at": now_iso(),
        "captured_endpoint_count": len(rows),
        "payload_like_count": len(payloads),
        "useful_term_count": len(useful),
        "body_error_count": len(errors),
        "top_useful": useful[:50],
        "top_payloads": payloads[:50],
        "recommendation": "If useful responses contain bet365 and V3 scores, build direct replay scraper. If only payload-like endpoints appear without odds rows, use endpoint discovery plus DOM odds extraction fallback.",
    }
    (out_dir / "endpoint_probe_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    lines = [
        "# OddsPortal Focused Endpoint Probe",
        "",
        f"Generated: {summary['generated_at']}",
        f"Captured endpoint responses: {summary['captured_endpoint_count']}",
        f"Payload-like responses: {summary['payload_like_count']}",
        f"Useful term responses: {summary['useful_term_count']}",
        f"Body errors: {summary['body_error_count']}",
        "",
        "## Useful responses",
        "",
    ]
    for row in useful[:40]:
        lines.append(f"- `{row.get('phase')}` `{row.get('status')}` `{row.get('content_type')}` `{row.get('body_file')}`")
        lines.append(f"  - terms: {', '.join(row.get('found_terms', []))}")
        lines.append(f"  - url: {row.get('url')}")
    lines.append("")
    lines.append("## Payload-like endpoint responses")
    lines.append("")
    for row in payloads[:40]:
        lines.append(f"- `{row.get('phase')}` `{row.get('status')}` `{row.get('content_type')}` `{row.get('body_file')}`")
        lines.append(f"  - terms: {', '.join(row.get('found_terms', []))}")
        lines.append(f"  - url: {row.get('url')}")
    (out_dir / "endpoint_probe_report.md").write_text("\n".join(lines), encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-url", default=DEFAULT_RESULTS_URL)
    parser.add_argument("--match-url", default=DEFAULT_MATCH_URL)
    parser.add_argument("--out", default="artifacts/output/oddsportal-endpoint-probe")
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--max-body-bytes", type=int, default=1200000)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    rows: list[dict[str, Any]] = []
    meta: dict[str, Any] = {
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

            attach_endpoint_capture(page, out_dir, "results_page", rows, args.max_body_bytes)
            base.log(f"Opening results page: {args.results_url}")
            base.goto(page, args.results_url, args.wait_ms)
            scroll_and_click(page, args.wait_ms)
            save_snapshot(page, out_dir, "results_page")

            clear_oddsportal_route_memory(context, page, args.wait_ms)
            attach_endpoint_capture(page, out_dir, "match_page", rows, args.max_body_bytes)
            base.log(f"Opening match page: {args.match_url}")
            base.goto(page, args.match_url, args.wait_ms)
            scroll_and_click(page, args.wait_ms)
            save_snapshot(page, out_dir, "match_page")

            write_endpoint_csv(out_dir / "endpoint_candidates.csv", rows)
            summary = write_report(out_dir, rows)
            meta.update({
                "stop_reason": "ENDPOINT_PROBE_COMPLETE",
                "captured_endpoint_count": summary["captured_endpoint_count"],
                "payload_like_count": summary["payload_like_count"],
                "useful_term_count": summary["useful_term_count"],
                "body_error_count": summary["body_error_count"],
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
