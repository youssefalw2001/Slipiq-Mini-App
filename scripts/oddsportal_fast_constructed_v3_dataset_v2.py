#!/usr/bin/env python3
"""
SlipIQ fast constructed V3 dataset builder V2.

This wraps the original fast constructed V3 builder, but replaces token discovery
with a more robust token grabber.

Why V2 exists:
- The first combined fast workflow successfully built first_set_results.csv.
- It then stopped with exit code 4 because no match-event session token was captured.
- The result rows had clean match URLs, but not always the market anchor that forces
  OddsPortal to load Correct Score -> 1st Set.

V2 token grabber tries multiple URL variants:
- match_url
- match_url/
- match_url#EVENTHASH:cs;12
- match_url/#EVENTHASH:cs;12

It also scans response URLs and page HTML for the token pattern.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urldefrag

from playwright.sync_api import BrowserContext, Page, Response

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import clear_oddsportal_route_memory
import oddsportal_fast_constructed_v3_dataset as fast
from oddsportal_constructed_v3_endpoint_probe import (
    TOKEN_RE,
    click_light_market_controls,
    extract_session_token,
    should_capture_match_event,
)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def token_seed_url_variants(match_url: str, event_hash: str) -> list[str]:
    raw = clean_text(match_url)
    if not raw:
        return []
    base = urldefrag(raw)[0].rstrip("/")
    variants: list[str] = []
    for candidate in [raw, base + "/"]:
        if candidate and candidate not in variants:
            variants.append(candidate)
    if event_hash:
        anchored = [
            base + f"#{event_hash}:cs;12",
            base + f"/#{event_hash}:cs;12",
            base + f"#cs;12",
            base + f"/#cs;12",
        ]
        for candidate in anchored:
            if candidate not in variants:
                variants.append(candidate)
    return variants


def robust_discover_session_token(context: BrowserContext, page: Page, events: list[dict[str, Any]], wait_ms: int) -> tuple[str, str]:
    """Discover OddsPortal match-event token with stronger URL variants.

    Returns (token, seed_endpoint_or_seed_url).
    """
    max_events = min(len(events), 60)
    for event in events[:max_events]:
        event_hash = clean_text(event.get("event_hash", ""))
        match_url = clean_text(event.get("match_url", ""))
        variants = token_seed_url_variants(match_url, event_hash)
        if not variants:
            continue

        for url in variants:
            captured: list[str] = []
            seen: set[str] = set()

            def on_response(resp: Response) -> None:
                if resp.url in seen:
                    return
                seen.add(resp.url)
                if should_capture_match_event(resp):
                    token = extract_session_token(resp.url)
                    if token:
                        captured.append(resp.url)
                else:
                    m = TOKEN_RE.search(resp.url)
                    if m:
                        captured.append(resp.url)

            page.on("response", on_response)
            try:
                clear_oddsportal_route_memory(context, page, wait_ms)
                base.log(f"Token discovery trying: {url}")
                base.goto(page, url, wait_ms)
                click_light_market_controls(page, wait_ms)
                page.wait_for_timeout(wait_ms)
                try:
                    html = page.content()
                    m = TOKEN_RE.search(html)
                    if m:
                        token = m.group(1)
                        return token, url
                except Exception:
                    pass
            except Exception as exc:
                base.log(f"Token discovery variant failed: {exc}")
            finally:
                try:
                    page.remove_listener("response", on_response)
                except Exception:
                    pass

            for endpoint_url in captured:
                token = extract_session_token(endpoint_url)
                if token:
                    base.log(f"Discovered match-event token from {endpoint_url}")
                    return token, endpoint_url
    return "", ""


fast.discover_session_token = robust_discover_session_token

if __name__ == "__main__":
    raise SystemExit(fast.main())
