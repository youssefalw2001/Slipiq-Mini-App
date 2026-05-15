#!/usr/bin/env python3
"""
SlipIQ OddsPortal decoder probe.

The endpoint probe found the important /match-event/...dat endpoints, but their
bodies are encoded. This probe captures the app JS assets and searches for the
client-side decoder / request-building logic.

Targets:
- script assets loaded by the match page
- snippets around match-event, requestPreMatch, requestBaseOddsHistory
- snippets around atob/base64/decrypt/CryptoJS/pako/fflate/TextDecoder
- endpoint URLs embedded in pageVar / data attributes

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
from urllib.parse import urljoin, urlparse

from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory

DEFAULT_MATCH_URL = "https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12"
TERMS = [
    "match-event", "match-event-history", "requestPreMatch", "requestBaseOddsHistory",
    "newOddsApiTest", "bookiehash", "oddsformat", "oddsHelper", "bettingTypes",
    "atob", "btoa", "base64", "Base64", "decrypt", "encrypt", "CryptoJS",
    "pako", "fflate", "inflate", "deflate", "TextDecoder", "Uint8Array",
    ".dat", "geo=", "lang=", "requestUrl", "requestBase",
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


def snippet(text: str, term: str, radius: int = 700) -> str:
    i = text.lower().find(term.lower())
    if i < 0:
        return ""
    return text[max(0, i - radius): i + len(term) + radius]


def find_all_snippets(text: str, terms: list[str], radius: int = 700, max_per_term: int = 5) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    lower = text.lower()
    for term in terms:
        start = 0
        count = 0
        while count < max_per_term:
            i = lower.find(term.lower(), start)
            if i < 0:
                break
            out.append({
                "term": term,
                "offset": str(i),
                "snippet": text[max(0, i - radius): i + len(term) + radius],
            })
            start = i + len(term)
            count += 1
    return out


def save_text(path: Path, text: str) -> None:
    ensure_dir(path.parent)
    path.write_text(text, encoding="utf-8", errors="replace")


def script_urls_from_page(page: Page, base_url: str) -> list[str]:
    urls = page.eval_on_selector_all("script[src]", "els => els.map(s => s.src || s.getAttribute('src') || '')")
    abs_urls = []
    seen = set()
    for url in urls:
        full = urljoin(base_url, url)
        if "oddsportal.com" not in urlparse(full).netloc:
            continue
        if full in seen:
            continue
        seen.add(full)
        abs_urls.append(full)
    return abs_urls


def fetch_asset(context: BrowserContext, url: str, timeout_ms: int = 30000) -> tuple[int, str, str]:
    try:
        resp = context.request.get(url, timeout=timeout_ms)
        content_type = resp.headers.get("content-type", "")
        text = resp.text(errors="replace")
        return resp.status, content_type, text
    except Exception as exc:
        return 0, "", f"FETCH_ERROR: {exc}"


def extract_page_vars(html: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in ["pageVar", "pageOutrightsVar"]:
        m = re.search(rf"var\s+{name}\s*=\s*'(.+?)';", html, re.S)
        if m:
            raw = m.group(1)
            out[name + "_raw_length"] = len(raw)
            for key in ["requestPreMatch", "requestBaseOddsHistory", "updateScoreRequest", "h2hEncodedEventId", "h2hEventHash"]:
                if key in raw:
                    out.setdefault("found_keys", []).append(key)
                    out[f"snippet_{key}"] = snippet(raw, key, 500)
        # data attributes may include escaped JSON too
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--match-url", default=DEFAULT_MATCH_URL)
    parser.add_argument("--out", default="artifacts/output/oddsportal-decoder-probe")
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
    }
    rows: list[dict[str, Any]] = []

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
                save_text(out_dir / "run_summary.json", json.dumps(meta, indent=2))
                return 3

            base.apply_bet365_filter(page, out_dir, args.wait_ms)
            clear_oddsportal_route_memory(context, page, args.wait_ms)
            base.log(f"Opening match page for decoder probe: {args.match_url}")
            base.goto(page, args.match_url, args.wait_ms)
            page.wait_for_timeout(args.wait_ms)
            html = page.content()
            save_text(out_dir / "match_page.html", html)
            try:
                page.screenshot(path=str(out_dir / "match_page.png"), full_page=True, timeout=20000)
            except Exception:
                pass
            page_vars = extract_page_vars(html)
            save_text(out_dir / "pagevar_probe.json", json.dumps(page_vars, indent=2))

            urls = script_urls_from_page(page, page.url)
            save_text(out_dir / "script_urls.json", json.dumps(urls, indent=2))
            base.log(f"Found {len(urls)} OddsPortal script asset(s).")

            for idx, url in enumerate(urls, start=1):
                status, content_type, text = fetch_asset(context, url)
                filename = f"{idx:03d}_{Path(urlparse(url).path).name or 'script.js'}"
                asset_path = out_dir / "js_assets" / filename
                save_text(asset_path, text)
                found = [term for term in TERMS if term.lower() in text.lower()]
                snippets = find_all_snippets(text, found, radius=900, max_per_term=3) if found else []
                snippet_path = ""
                if snippets:
                    snippet_path = f"snippets/{idx:03d}_{Path(urlparse(url).path).name or 'script'}.json"
                    save_text(out_dir / snippet_path, json.dumps(snippets, indent=2))
                rows.append({
                    "idx": idx,
                    "url": redact_url(url),
                    "status": status,
                    "content_type": content_type,
                    "asset_file": str(asset_path.relative_to(out_dir)),
                    "length": len(text),
                    "found_terms": found,
                    "snippet_file": snippet_path,
                })

            fields = ["idx", "url", "status", "content_type", "asset_file", "length", "found_terms", "snippet_file"]
            with (out_dir / "decoder_candidates.csv").open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fields)
                writer.writeheader()
                for row in rows:
                    r = dict(row)
                    r["found_terms"] = json.dumps(r.get("found_terms", []), ensure_ascii=False)
                    writer.writerow({k: r.get(k, "") for k in fields})

            useful = [r for r in rows if r.get("found_terms")]
            report = {
                "generated_at": now_iso(),
                "script_count": len(rows),
                "useful_script_count": len(useful),
                "top_useful": useful[:50],
                "pagevar_probe": page_vars,
                "recommendation": "Inspect snippets. If decoder logic is present, port it to Python/JS replay. If decoder is bundled/obfuscated, use Playwright page context to fetch/decode endpoints instead of pure Python.",
            }
            save_text(out_dir / "decoder_probe_summary.json", json.dumps(report, indent=2))
            lines = [
                "# OddsPortal Decoder Probe",
                "",
                f"Generated: {report['generated_at']}",
                f"Scripts captured: {len(rows)}",
                f"Useful scripts: {len(useful)}",
                "",
                "## PageVar request snippets",
                "",
            ]
            for k, v in page_vars.items():
                lines.append(f"- `{k}`: `{str(v)[:500]}`")
            lines += ["", "## Useful scripts", ""]
            for row in useful:
                lines.append(f"- `{row['asset_file']}` terms={', '.join(row['found_terms'])}")
                lines.append(f"  - snippets: `{row.get('snippet_file')}`")
                lines.append(f"  - url: {row['url']}")
            save_text(out_dir / "decoder_probe_report.md", "\n".join(lines))
            meta.update({
                "stop_reason": "DECODER_PROBE_COMPLETE",
                "script_count": len(rows),
                "useful_script_count": len(useful),
            })
            save_text(out_dir / "run_summary.json", json.dumps(meta, indent=2))
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
