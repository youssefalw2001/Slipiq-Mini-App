#!/usr/bin/env python3
"""
SlipIQ OddsPortal decoded V3 probe.

This script uses the decoded /match-event/...dat response discovered by the endpoint
and decoder probes. It captures match-event responses, decrypts the encrypted .dat
payload, extracts bet365/provider 549 Correct Score 1st Set prices, and writes V3
odds to CSV.

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import base64
import csv
import gzip
import json
import math
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from playwright.sync_api import BrowserContext, Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory

DEFAULT_MATCH_URL = "https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12"
PROVIDER_BET365 = "549"
TARGET_P2 = ["3:6", "4:6", "5:7"]
TARGET_P1 = ["6:3", "6:4", "7:5"]

# Extracted from OddsPortal frontend bundle. The JS uses these when pageVar.encriptedResponse is falsy/missing.
DEFAULT_PASSWORD = "J*8sQ!p$7aD_fR2yW@gHn*3bVp#sAdLd_k"
DEFAULT_SALT = "5b9a8f2c3e6d1a4b7c8e9d0f1a2b3c4d"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def decimal_grouped(odds: list[float | None]) -> float | None:
    vals = [o for o in odds if o and o > 1]
    if len(vals) != len(odds):
        return None
    denom = sum(1.0 / float(o) for o in vals)
    if denom <= 0:
        return None
    return round(1.0 / denom, 6)


def safe_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def decode_oddsportal_dat(payload: str, password: str = DEFAULT_PASSWORD, salt: str = DEFAULT_SALT) -> dict[str, Any]:
    """Decode OddsPortal encrypted .dat payload.

    Frontend logic:
      atob(payload) => "<base64_ciphertext>:<hex_iv>"
      PBKDF2(password, salt, SHA-256, 1000, 256-bit)
      AES-CBC decrypt
      gzip decompress if plaintext starts with 1f 8b
      JSON.parse
    """
    outer = base64.b64decode(payload.strip())
    outer_text = outer.decode("utf-8")
    if ":" not in outer_text:
        raise ValueError("Decoded outer payload does not contain ':' separator")
    ciphertext_b64, iv_hex = outer_text.split(":", 1)
    iv = bytes.fromhex(iv_hex)
    ciphertext = base64.b64decode(ciphertext_b64)

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt.encode("utf-8"),
        iterations=1000,
    )
    key = kdf.derive(password.encode("utf-8"))
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    decrypted = decryptor.update(ciphertext) + decryptor.finalize()

    try:
        unpadder = padding.PKCS7(128).unpadder()
        plaintext = unpadder.update(decrypted) + unpadder.finalize()
    except Exception:
        plaintext = decrypted

    if plaintext[:2] == b"\x1f\x8b":
        plaintext = gzip.decompress(plaintext)
    return json.loads(plaintext.decode("utf-8", errors="replace"))


def should_capture_match_event(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    if "oddsportal.com" not in parsed.netloc:
        return False
    return "/match-event/" in parsed.path and parsed.path.endswith(".dat")


def score_odds(decoded: dict[str, Any], provider_id: str = PROVIDER_BET365) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    back = decoded.get("d", {}).get("oddsdata", {}).get("back", {})
    if not isinstance(back, dict):
        return out
    for row in back.values():
        if not isinstance(row, dict):
            continue
        name = str(row.get("mixedParameterName") or "").strip()
        odds_map = row.get("odds") or {}
        provider_odds = odds_map.get(provider_id) if isinstance(odds_map, dict) else None
        if isinstance(provider_odds, list) and provider_odds:
            out[name] = safe_float(provider_odds[0])
    return out


def tier_for_grouped(grouped: float | None) -> str:
    if grouped is None:
        return "NO_PRICE"
    if grouped >= 4.0:
        return "S"
    if grouped >= 3.5:
        return "A"
    if grouped >= 3.3:
        return "B_WATCH"
    return "C_SKIP"


def extract_row(decoded: dict[str, Any], endpoint_url: str, match_url: str) -> dict[str, Any]:
    odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    p1_vals = [odds.get(s) for s in TARGET_P1]
    p2_grouped = decimal_grouped(p2_vals)
    p1_grouped = decimal_grouped(p1_vals)
    return {
        "scraped_at": now_iso(),
        "match_url": match_url,
        "endpoint_url": endpoint_url,
        "provider_id": PROVIDER_BET365,
        "market_bt": decoded.get("d", {}).get("bt"),
        "market_scope": decoded.get("d", {}).get("sc"),
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
        "all_score_count": len([k for k, v in odds.items() if re.match(r"^\d+:\d+$", str(k)) and v]),
        "status": "ok" if p2_grouped else "missing_v3_prices",
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields = [
        "scraped_at", "match_url", "endpoint_url", "provider_id", "market_bt", "market_scope",
        "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12", "p2_tier",
        "p1_6_3_decimal", "p1_6_4_decimal", "p1_7_5_decimal", "p1_grouped_9_12", "p1_tier",
        "all_score_count", "status",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--match-url", default=DEFAULT_MATCH_URL)
    parser.add_argument("--out", default="artifacts/output/oddsportal-decoded-v3-probe")
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
        "decoded_count": 0,
        "extracted_rows": 0,
    }
    decoded_payloads: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    seen_endpoint_urls: set[str] = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context: BrowserContext = create_cookie_context(browser, out_dir)
        page: Page = context.new_page()

        def on_response(resp: Response) -> None:
            if not should_capture_match_event(resp):
                return
            if resp.url in seen_endpoint_urls:
                return
            seen_endpoint_urls.add(resp.url)
            try:
                payload = resp.body().decode("utf-8", errors="replace")
                decoded = decode_oddsportal_dat(payload)
                decoded_payloads.append({"url": resp.url, "decoded": decoded})
                response_dir = out_dir / "decoded_responses"
                ensure_dir(response_dir)
                (response_dir / f"decoded_{len(decoded_payloads):03d}.json").write_text(json.dumps(decoded, indent=2), encoding="utf-8")
                rows.append(extract_row(decoded, resp.url, args.match_url))
                base.log(f"Decoded match-event endpoint: {resp.url}")
            except Exception as exc:
                base.log(f"Could not decode endpoint {resp.url}: {exc}")

        page.on("response", on_response)
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
            base.log(f"Opening match page for decoded V3 probe: {args.match_url}")
            base.goto(page, args.match_url, args.wait_ms)
            page.wait_for_timeout(args.wait_ms)
            # Click/scroll to trigger market endpoint loads.
            for label in ["Correct Score", "1st Set", "First Set", "Set 1", "Dokładny wynik", "1. set", "1 set"]:
                try:
                    page.get_by_text(re.compile(re.escape(label), re.I)).first.click(timeout=1200)
                    page.wait_for_timeout(args.wait_ms)
                except Exception:
                    continue
            for _ in range(4):
                try:
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                except Exception:
                    pass
                page.wait_for_timeout(max(750, args.wait_ms // 2))

            write_csv(out_dir / "decoded_v3_prices.csv", rows)
            summary = {
                "generated_at": now_iso(),
                "match_url": args.match_url,
                "decoded_count": len(decoded_payloads),
                "extracted_rows": len(rows),
                "rows": rows,
                "recommendation": "If p2_3_6/p2_4_6/p2_5_7 match the expected bet365 prices, build the full decoded endpoint scraper next.",
            }
            (out_dir / "decoded_v3_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
            meta.update({
                "stop_reason": "DECODED_V3_PROBE_COMPLETE",
                "decoded_count": len(decoded_payloads),
                "extracted_rows": len(rows),
                "first_row": rows[0] if rows else None,
            })
            (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            return 0 if rows else 2
        finally:
            try:
                context.storage_state(path=str(out_dir / "last_storage_state.json"))
            except Exception:
                pass
            context.close()
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
