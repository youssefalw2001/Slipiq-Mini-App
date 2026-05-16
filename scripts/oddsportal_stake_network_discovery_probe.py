#!/usr/bin/env python3
"""
OddsPortal Stake network discovery probe.

The constructed match-event endpoint currently exposes only provider 549/bet365.
This probe opens the actual OddsPortal match pages, listens to every relevant
OddsPortal network response, decodes what it can, and inventories provider names
and IDs while searching for Stake.

Read-only research. No betting. No sportsbook actions. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urlparse

from playwright.sync_api import Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_archive_first_set_results_builder import decode_response as decode_archive_response
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_constructed_v3_endpoint_probe import click_light_market_controls
from oddsportal_decoded_v3_probe import decode_oddsportal_dat
from oddsportal_stake_vs_bet365_probe import fetch_latest_supabase_signals, normalize_signal, read_input_csv, supabase_ready

NOISY_RESPONSE_PARTS = [
    "/build/assets/", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".ico", ".map",
    "google", "facebook", "doubleclick", "analytics", "sentry", "hotjar",
]
PROVIDER_KEYS = {"id", "bookmakerId", "providerId", "bid", "bookmaker_id", "provider_id"}
NAME_KEYS = {"name", "bookmakerName", "providerName", "title", "label", "bookmaker_name", "provider_name"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def should_capture_response(resp: Response) -> bool:
    url = resp.url.lower()
    if "oddsportal.com" not in url:
        return False
    if any(part in url for part in NOISY_RESPONSE_PARTS):
        return False
    return any(part in url for part in ["/ajax", ".dat", "/match-event/", "/event/", "/tennis/"])


def page_variants(match_url: str, event_hash: str) -> list[str]:
    raw = clean_text(match_url)
    if not raw or "oddsportal.com" not in raw:
        raw = f"https://www.oddsportal.com/tennis/#{event_hash}"
    base_url = urldefrag(raw)[0].rstrip("/")
    variants = [raw, base_url + "/"]
    if event_hash:
        variants.extend([
            base_url + f"/#{event_hash}:cs;12",
            base_url + f"#{event_hash}:cs;12",
            base_url + "/#cs;12",
            base_url + "#cs;12",
        ])
    out: list[str] = []
    for v in variants:
        if v and v not in out:
            out.append(v)
    return out


def short_url(url: str, max_len: int = 180) -> str:
    return url if len(url) <= max_len else url[: max_len - 3] + "..."


def detect_response_kind(url: str, text: str, decoded: Any) -> str:
    low_url = url.lower()
    if "/match-event/" in low_url:
        return "match_event_dat"
    if "/ajax-nextgames/" in low_url:
        return "ajax_nextgames"
    if "/ajax" in low_url:
        return "ajax"
    if decoded is not None:
        return "decoded_payload"
    if "stake" in text.lower():
        return "raw_text_contains_stake"
    return "other"


def try_decode_text(url: str, text: str) -> tuple[str, Any | None]:
    # Try OddsPortal match-event decoder first for .dat payloads.
    try:
        decoded = decode_oddsportal_dat(text)
        return "decode_oddsportal_dat", decoded
    except Exception:
        pass
    # Try JSON for plain JSON payloads.
    try:
        return "json", json.loads(text)
    except Exception:
        pass
    return "raw", None


def walk_provider_records(obj: Any) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []

    def visit(node: Any, path: str = "") -> None:
        if isinstance(node, dict):
            # shape: {"549": {"name": "bet365"}}
            for k, v in node.items():
                if str(k).isdigit():
                    if isinstance(v, dict):
                        name = ""
                        for nk in NAME_KEYS:
                            if clean_text(v.get(nk)):
                                name = clean_text(v.get(nk))
                                break
                        if name:
                            records.append({"provider_id": str(k), "provider_name": name, "path": f"{path}.{k}".strip(".")})
                    elif isinstance(v, str) and clean_text(v):
                        val = clean_text(v)
                        if not re.fullmatch(r"\d+(\.\d+)?", val):
                            records.append({"provider_id": str(k), "provider_name": val, "path": f"{path}.{k}".strip(".")})
                if isinstance(v, (dict, list)):
                    visit(v, f"{path}.{k}".strip("."))
            # shape: {id/bookmakerId/providerId, name/bookmakerName/providerName}
            pid = ""
            name = ""
            for pk in PROVIDER_KEYS:
                if clean_text(node.get(pk)):
                    pid = clean_text(node.get(pk))
                    break
            for nk in NAME_KEYS:
                if clean_text(node.get(nk)):
                    name = clean_text(node.get(nk))
                    break
            if pid and name:
                records.append({"provider_id": pid, "provider_name": name, "path": path})
        elif isinstance(node, list):
            for i, item in enumerate(node):
                visit(item, f"{path}[{i}]")

    visit(obj)
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for r in records:
        key = (r.get("provider_id", ""), r.get("provider_name", ""), r.get("path", ""))
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    return deduped


def extract_text_provider_mentions(text: str) -> list[str]:
    mentions: list[str] = []
    low = text.lower()
    if "stake" in low:
        # Return short snippets around stake occurrences.
        for m in re.finditer("stake", low):
            start = max(0, m.start() - 80)
            end = min(len(text), m.end() + 120)
            snippet = clean_text(text[start:end])
            if snippet not in mentions:
                mentions.append(snippet)
            if len(mentions) >= 10:
                break
    return mentions


def response_summary_fields() -> list[str]:
    return [
        "captured_at", "source_signal_id", "event_hash", "match_name", "page_url", "response_url", "http_status",
        "body_length", "decode_method", "response_kind", "contains_stake_text", "provider_record_count",
        "provider_ids", "provider_names", "stake_provider_candidates", "stake_snippets",
    ]


def provider_record_fields() -> list[str]:
    return [
        "captured_at", "source_signal_id", "event_hash", "match_name", "page_url", "response_url", "decode_method",
        "provider_id", "provider_name", "provider_path", "is_stake_candidate",
    ]


def load_signals(limit: int, scanner_run_id: str, input_csv: str) -> list[dict[str, Any]]:
    if input_csv:
        return read_input_csv(Path(input_csv), limit)
    rows = fetch_latest_supabase_signals(limit, scanner_run_id)
    return [normalize_signal(r) for r in rows]


def process_response(signal: dict[str, Any], page_url: str, resp: Response, max_body_chars: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    captured_at = now_iso()
    url = resp.url
    body_text = ""
    status: int | str = ""
    try:
        status = resp.status
        body_text = resp.text()
    except Exception as exc:
        body_text = f"RESPONSE_TEXT_ERROR:{exc}"
    if max_body_chars > 0 and len(body_text) > max_body_chars:
        body_for_decode = body_text[:max_body_chars]
    else:
        body_for_decode = body_text
    decode_method, decoded = try_decode_text(url, body_for_decode)
    provider_records = walk_provider_records(decoded) if decoded is not None else []
    contains_stake = "stake" in body_text.lower()
    snippets = extract_text_provider_mentions(body_text)
    provider_ids = sorted({r.get("provider_id", "") for r in provider_records if r.get("provider_id")})
    provider_names = sorted({r.get("provider_name", "") for r in provider_records if r.get("provider_name")})
    stake_candidates = [r for r in provider_records if "stake" in r.get("provider_name", "").lower() or r.get("provider_id", "").lower() == "stake"]
    summary = {
        "captured_at": captured_at,
        "source_signal_id": signal.get("source_signal_id", ""),
        "event_hash": signal.get("event_hash", ""),
        "match_name": signal.get("match_name", ""),
        "page_url": page_url,
        "response_url": short_url(url),
        "http_status": status,
        "body_length": len(body_text),
        "decode_method": decode_method,
        "response_kind": detect_response_kind(url, body_text, decoded),
        "contains_stake_text": bool_text(contains_stake),
        "provider_record_count": len(provider_records),
        "provider_ids": "|".join(provider_ids[:50]),
        "provider_names": "|".join(provider_names[:50]),
        "stake_provider_candidates": "|".join(f"{r.get('provider_id')}:{r.get('provider_name')}" for r in stake_candidates),
        "stake_snippets": " || ".join(snippets[:5]),
    }
    provider_rows = [
        {
            "captured_at": captured_at,
            "source_signal_id": signal.get("source_signal_id", ""),
            "event_hash": signal.get("event_hash", ""),
            "match_name": signal.get("match_name", ""),
            "page_url": page_url,
            "response_url": short_url(url),
            "decode_method": decode_method,
            "provider_id": r.get("provider_id", ""),
            "provider_name": r.get("provider_name", ""),
            "provider_path": r.get("path", ""),
            "is_stake_candidate": bool_text("stake" in r.get("provider_name", "").lower()),
        }
        for r in provider_records
    ]
    return summary, provider_rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/output/oddsportal-stake-network-discovery")
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--scanner-run-id", default="")
    parser.add_argument("--input-csv", default="")
    parser.add_argument("--wait-ms", type=int, default=4000)
    parser.add_argument("--per-page-ms", type=int, default=9000)
    parser.add_argument("--max-responses-per-signal", type=int, default=80)
    parser.add_argument("--max-body-chars", type=int, default=2000000)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "supabase_ready": supabase_ready(),
        "cookie_secret_present": has_cookie_secret(),
        "signals_loaded": 0,
        "signals_with_event_hash": 0,
        "login_ok": False,
        "response_summary_rows": 0,
        "provider_record_rows": 0,
        "stake_text_responses": 0,
        "stake_provider_rows": 0,
        "stop_reason": "NOT_STARTED",
    }

    try:
        signals = load_signals(args.limit, args.scanner_run_id, args.input_csv)
    except Exception as exc:
        meta["stop_reason"] = f"SIGNAL_LOAD_FAILED:{exc}"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2
    signals = [s for s in signals if clean_text(s.get("event_hash"))]
    meta["signals_loaded"] = len(signals)
    meta["signals_with_event_hash"] = len(signals)
    if not signals:
        meta["stop_reason"] = "NO_SIGNALS_WITH_EVENT_HASH"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    response_summaries: list[dict[str, Any]] = []
    provider_records: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for Stake network discovery.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2

            for sig in signals:
                captured_count = 0
                seen_response_urls: set[str] = set()

                def on_response(resp: Response) -> None:
                    nonlocal captured_count
                    if captured_count >= args.max_responses_per_signal:
                        return
                    if resp.url in seen_response_urls or not should_capture_response(resp):
                        return
                    seen_response_urls.add(resp.url)
                    try:
                        summary, rows = process_response(sig, page.url, resp, args.max_body_chars)
                        response_summaries.append(summary)
                        provider_records.extend(rows)
                        captured_count += 1
                    except Exception as exc:
                        response_summaries.append({
                            "captured_at": now_iso(),
                            "source_signal_id": sig.get("source_signal_id", ""),
                            "event_hash": sig.get("event_hash", ""),
                            "match_name": sig.get("match_name", ""),
                            "page_url": page.url,
                            "response_url": short_url(resp.url),
                            "http_status": "",
                            "body_length": "",
                            "decode_method": "error",
                            "response_kind": f"response_process_error:{exc}",
                            "contains_stake_text": "false",
                            "provider_record_count": 0,
                            "provider_ids": "",
                            "provider_names": "",
                            "stake_provider_candidates": "",
                            "stake_snippets": "",
                        })

                page.on("response", on_response)
                try:
                    for url in page_variants(clean_text(sig.get("match_url")), clean_text(sig.get("event_hash"))):
                        clear_oddsportal_route_memory(context, page, args.wait_ms)
                        base.log(f"Stake network discovery opening: {sig.get('match_name')} -> {url}")
                        base.goto(page, url, args.wait_ms)
                        click_light_market_controls(page, max(800, args.wait_ms // 2))
                        for _ in range(4):
                            try:
                                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                            except Exception:
                                pass
                            page.wait_for_timeout(max(1000, args.per_page_ms // 4))
                except Exception as exc:
                    base.log(f"Page discovery failed for {sig.get('match_name')}: {exc}")
                finally:
                    try:
                        page.remove_listener("response", on_response)
                    except Exception:
                        pass
                meta["response_summary_rows"] = len(response_summaries)
                meta["provider_record_rows"] = len(provider_records)
                meta["stake_text_responses"] = sum(1 for r in response_summaries if r.get("contains_stake_text") == "true")
                meta["stake_provider_rows"] = sum(1 for r in provider_records if r.get("is_stake_candidate") == "true")
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        finally:
            context.close()
            browser.close()

    write_csv(out_dir / "stake_network_response_summary.csv", response_summaries, response_summary_fields())
    write_csv(out_dir / "stake_network_provider_records.csv", provider_records, provider_record_fields())
    meta["response_summary_rows"] = len(response_summaries)
    meta["provider_record_rows"] = len(provider_records)
    meta["stake_text_responses"] = sum(1 for r in response_summaries if r.get("contains_stake_text") == "true")
    meta["stake_provider_rows"] = sum(1 for r in provider_records if r.get("is_stake_candidate") == "true")
    meta["stop_reason"] = "STAKE_NETWORK_DISCOVERY_COMPLETE"
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    provider_names = sorted({r.get("provider_name", "") for r in provider_records if r.get("provider_name")})
    report = [
        "# OddsPortal Stake Network Discovery Probe",
        "",
        f"Generated: {meta['generated_at']}",
        f"Signals checked: {meta['signals_with_event_hash']}",
        f"Network responses summarized: {len(response_summaries)}",
        f"Provider records found: {len(provider_records)}",
        f"Responses containing Stake text: {meta['stake_text_responses']}",
        f"Provider rows with Stake name: {meta['stake_provider_rows']}",
        "",
        "## Provider names seen",
        ", ".join(provider_names[:100]) if provider_names else "None",
        "",
        "## Stake-bearing responses",
    ]
    for row in response_summaries:
        if row.get("contains_stake_text") == "true" or row.get("stake_provider_candidates"):
            report.append(f"- {row.get('match_name')} | {row.get('response_kind')} | {row.get('response_url')} | {row.get('stake_provider_candidates')} | {row.get('stake_snippets')}")
    (out_dir / "stake_network_discovery_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
