#!/usr/bin/env python3
"""
Fast SlipIQ Stake vs bet365 OddsPortal probe.

Purpose:
- Take a small set of recent SlipIQ signals, usually the latest 6 from Supabase.
- Re-fetch OddsPortal Correct Score / 1st Set endpoints with multiple geo variants.
- Inventory all providers exposed in each decoded payload.
- Find provider names containing "stake" or an explicitly supplied provider id.
- Compare Stake grouped P2 9-12 odds against bet365/provider 549.

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
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

from playwright.sync_api import BrowserContext, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_all_providers_v3_from_master_csv import all_score_provider_odds, grouped_for_provider
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret
from oddsportal_decoded_v3_probe import decimal_grouped, safe_float, decode_oddsportal_dat
from oddsportal_v3_odds_from_master_csv import discover_token_fast

BASELINE_PROVIDER_ID = "549"
TARGET_SCORES = ["3:6", "4:6", "5:7"]


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


def supabase_headers() -> dict[str, str]:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or ""
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def supabase_ready() -> bool:
    return bool((os.getenv("SUPABASE_URL") or "").strip() and (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip())


def fetch_latest_supabase_signals(limit: int, scanner_run_id: str = "") -> list[dict[str, Any]]:
    if not supabase_ready():
        return []
    base_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    select_cols = "id,created_at,scanner_run_id,match_name,player1,player2,external_match_id,reconstructed_p2_9_12_odds,verified_grouped_odds,raw_payload,candidate_bucket,signal_class"
    params = {
        "select": select_cols,
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if scanner_run_id:
        params["scanner_run_id"] = f"eq.{scanner_run_id}"
    url = f"{base_url}/rest/v1/private_v3_signal_log?{urlencode(params)}"
    req = Request(url, headers=supabase_headers(), method="GET")
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def event_hash_from_url(value: str) -> str:
    path = urlparse(value or "").path.rstrip("/")
    if path:
        last = path.split("/")[-1]
        if re.fullmatch(r"[A-Za-z0-9]{8,}", last or ""):
            return last
    fragment = urlparse(value or "").fragment
    if fragment:
        first = fragment.split(":", 1)[0]
        if re.fullmatch(r"[A-Za-z0-9]{8,}", first or ""):
            return first
    return ""


def event_hash_from_signal(row: dict[str, Any]) -> str:
    raw = row.get("raw_payload") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    for value in [raw.get("event_hash") if isinstance(raw, dict) else "", row.get("event_hash"), row.get("external_match_id")]:
        text = clean_text(value)
        if re.fullmatch(r"[A-Za-z0-9]{8,}", text or ""):
            return text
        found = event_hash_from_url(text)
        if found:
            return found
    return ""


def normalize_signal(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("raw_payload") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    event_hash = event_hash_from_signal(row)
    match_url = clean_text(raw.get("match_url") or row.get("external_match_id") or "")
    return {
        "source_signal_id": row.get("id", ""),
        "created_at": row.get("created_at", ""),
        "scanner_run_id": row.get("scanner_run_id", ""),
        "event_hash": event_hash,
        "match_url": match_url,
        "match_name": clean_text(row.get("match_name") or raw.get("match_name") or event_hash),
        "player1": clean_text(row.get("player1") or raw.get("player1")),
        "player2": clean_text(row.get("player2") or raw.get("player2")),
        "bet365_existing_grouped": safe_float(row.get("verified_grouped_odds") or row.get("reconstructed_p2_9_12_odds") or raw.get("p2_grouped_9_12")) or "",
        "candidate_bucket": row.get("candidate_bucket", ""),
        "signal_class": row.get("signal_class", ""),
    }


def read_input_csv(path: Path, limit: int) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out: list[dict[str, Any]] = []
    for row in rows[:limit]:
        event_hash = clean_text(row.get("event_hash") or event_hash_from_url(row.get("match_url", "")))
        out.append({
            "source_signal_id": row.get("source_signal_id", ""),
            "created_at": row.get("created_at", ""),
            "scanner_run_id": row.get("scanner_run_id", ""),
            "event_hash": event_hash,
            "match_url": row.get("match_url", ""),
            "match_name": row.get("match_name", event_hash),
            "player1": row.get("player1", ""),
            "player2": row.get("player2", ""),
            "bet365_existing_grouped": safe_float(row.get("bet365_existing_grouped") or row.get("p2_grouped_9_12") or row.get("verified_grouped_odds")) or "",
            "candidate_bucket": row.get("candidate_bucket", ""),
            "signal_class": row.get("signal_class", ""),
        })
    return out


def construct_endpoint(event_hash: str, token: str, geo: str) -> str:
    base = f"https://www.oddsportal.com/match-event/1-2-{event_hash}-8-12-{token}.dat"
    geo_clean = clean_text(geo).upper()
    if geo_clean in {"", "NONE", "NO_GEO"}:
        return f"{base}?lang=en"
    return f"{base}?geo={geo_clean}&lang=en"


def fetch_decoded(context: BrowserContext, event_hash: str, token: str, geo: str, referer: str) -> tuple[str, int | str, str, int, dict[str, Any] | None]:
    endpoint = construct_endpoint(event_hash, token, geo)
    try:
        resp = context.request.get(endpoint, headers={"referer": referer or "https://www.oddsportal.com/", "accept": "*/*"}, timeout=30000)
        body = resp.text()
        try:
            decoded = decode_oddsportal_dat(body)
            return endpoint, resp.status, "decoded", len(body), decoded
        except Exception as exc:
            return endpoint, resp.status, f"decode_failed:{exc}", len(body), None
    except Exception as exc:
        return endpoint, "request_error", str(exc)[:300], 0, None


def provider_inventory_rows(signal: dict[str, Any], geo: str, endpoint: str, http_status: Any, decode_status: str, body_length: int, score_map: dict[str, dict[str, float]], provider_names: dict[str, str]) -> list[dict[str, Any]]:
    provider_ids = sorted(set().union(*(set(score_map.get(score, {}).keys()) for score in TARGET_SCORES))) if score_map else []
    rows: list[dict[str, Any]] = []
    for provider_id in provider_ids:
        grouped, odds = grouped_for_provider(score_map, provider_id)
        rows.append({
            **signal,
            "geo_variant": geo,
            "constructed_url": endpoint,
            "http_status": http_status,
            "decode_status": decode_status,
            "body_length": body_length,
            "provider_id": provider_id,
            "provider_name": provider_names.get(provider_id, ""),
            "p2_3_6_decimal": odds.get("3:6"),
            "p2_4_6_decimal": odds.get("4:6"),
            "p2_5_7_decimal": odds.get("5:7"),
            "provider_grouped_9_12": grouped or "",
            "has_all_scores": bool_text(bool(grouped)),
        })
    if not rows:
        rows.append({
            **signal,
            "geo_variant": geo,
            "constructed_url": endpoint,
            "http_status": http_status,
            "decode_status": decode_status,
            "body_length": body_length,
            "provider_id": "",
            "provider_name": "",
            "p2_3_6_decimal": "",
            "p2_4_6_decimal": "",
            "p2_5_7_decimal": "",
            "provider_grouped_9_12": "",
            "has_all_scores": "false",
        })
    return rows


def find_target_provider(inventory: list[dict[str, Any]], target_name: str, target_id: str) -> dict[str, Any] | None:
    full_rows = [r for r in inventory if str(r.get("has_all_scores")).lower() == "true"]
    if target_id:
        matches = [r for r in full_rows if str(r.get("provider_id")) == str(target_id)]
        if matches:
            return max(matches, key=lambda r: safe_float(r.get("provider_grouped_9_12")) or 0)
    target = target_name.lower().strip()
    matches = [r for r in full_rows if target and target in str(r.get("provider_name", "")).lower()]
    if matches:
        return max(matches, key=lambda r: safe_float(r.get("provider_grouped_9_12")) or 0)
    return None


def find_baseline_provider(inventory: list[dict[str, Any]], baseline_id: str) -> dict[str, Any] | None:
    matches = [r for r in inventory if str(r.get("has_all_scores")).lower() == "true" and str(r.get("provider_id")) == str(baseline_id)]
    if matches:
        return max(matches, key=lambda r: safe_float(r.get("provider_grouped_9_12")) or 0)
    return None


def comparison_fields() -> list[str]:
    return [
        "source_signal_id", "created_at", "scanner_run_id", "event_hash", "match_url", "match_name", "player1", "player2",
        "candidate_bucket", "signal_class", "stake_found", "stake_provider_id", "stake_provider_name", "stake_geo_variant",
        "stake_3_6_decimal", "stake_4_6_decimal", "stake_5_7_decimal", "stake_grouped_9_12",
        "bet365_found", "bet365_geo_variant", "bet365_3_6_decimal", "bet365_4_6_decimal", "bet365_5_7_decimal", "bet365_grouped_9_12",
        "stake_vs_bet365_diff", "stake_vs_bet365_pct", "stake_better", "provider_count_with_all_scores", "geos_checked", "note",
    ]


def inventory_fields() -> list[str]:
    return [
        "source_signal_id", "created_at", "scanner_run_id", "event_hash", "match_url", "match_name", "player1", "player2",
        "geo_variant", "constructed_url", "http_status", "decode_status", "body_length", "provider_id", "provider_name",
        "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "provider_grouped_9_12", "has_all_scores",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/output/oddsportal-stake-vs-bet365")
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--scanner-run-id", default="")
    parser.add_argument("--input-csv", default="")
    parser.add_argument("--geo-variants", default="US,GB,CA,AU,EU,NONE")
    parser.add_argument("--target-provider-name", default="stake")
    parser.add_argument("--target-provider-id", default="")
    parser.add_argument("--baseline-provider-id", default=BASELINE_PROVIDER_ID)
    parser.add_argument("--wait-ms", type=int, default=3500)
    parser.add_argument("--token-max-events", type=int, default=8)
    parser.add_argument("--pause-seconds", type=float, default=0.20)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    geo_variants = [g.strip() for g in args.geo_variants.split(",") if g.strip()]
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "supabase_ready": supabase_ready(),
        "cookie_secret_present": has_cookie_secret(),
        "signals_loaded": 0,
        "signals_with_event_hash": 0,
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "inventory_rows": 0,
        "comparison_rows": 0,
        "stake_found_rows": 0,
        "bet365_found_rows": 0,
        "stake_better_rows": 0,
        "stop_reason": "NOT_STARTED",
    }

    if args.input_csv:
        signals = read_input_csv(Path(args.input_csv), args.limit)
    else:
        try:
            signals = [normalize_signal(r) for r in fetch_latest_supabase_signals(args.limit, args.scanner_run_id)]
        except Exception as exc:
            meta["stop_reason"] = f"SUPABASE_SIGNAL_LOAD_FAILED:{exc}"
            (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            return 2
    signals = [s for s in signals if s.get("event_hash")]
    meta["signals_loaded"] = len(signals)
    meta["signals_with_event_hash"] = len(signals)
    if not signals:
        meta["stop_reason"] = "NO_SIGNALS_WITH_EVENT_HASH"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    inventory: list[dict[str, Any]] = []
    comparisons: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for Stake vs bet365 probe.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            token, seed = discover_token_fast(context, page, [], args.wait_ms, args.token_max_events)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2

            for sig in signals:
                per_signal_inventory: list[dict[str, Any]] = []
                for geo in geo_variants:
                    endpoint, http_status, decode_status, body_length, decoded = fetch_decoded(context, sig["event_hash"], token, geo, sig.get("match_url", ""))
                    if decoded is not None:
                        score_map, provider_names = all_score_provider_odds(decoded)
                    else:
                        score_map, provider_names = {}, {}
                    rows = provider_inventory_rows(sig, geo, endpoint, http_status, decode_status, body_length, score_map, provider_names)
                    inventory.extend(rows)
                    per_signal_inventory.extend(rows)
                    time.sleep(args.pause_seconds)

                target = find_target_provider(per_signal_inventory, args.target_provider_name, args.target_provider_id)
                baseline = find_baseline_provider(per_signal_inventory, args.baseline_provider_id)
                target_grouped = safe_float(target.get("provider_grouped_9_12")) if target else None
                baseline_grouped = safe_float(baseline.get("provider_grouped_9_12")) if baseline else None
                diff = target_grouped - baseline_grouped if target_grouped and baseline_grouped else None
                pct = diff / baseline_grouped * 100.0 if diff is not None and baseline_grouped else None
                provider_count = len({r.get("provider_id") for r in per_signal_inventory if str(r.get("has_all_scores")).lower() == "true" and r.get("provider_id")})
                comparisons.append({
                    **sig,
                    "stake_found": bool_text(bool(target)),
                    "stake_provider_id": target.get("provider_id") if target else "",
                    "stake_provider_name": target.get("provider_name") if target else "",
                    "stake_geo_variant": target.get("geo_variant") if target else "",
                    "stake_3_6_decimal": target.get("p2_3_6_decimal") if target else "",
                    "stake_4_6_decimal": target.get("p2_4_6_decimal") if target else "",
                    "stake_5_7_decimal": target.get("p2_5_7_decimal") if target else "",
                    "stake_grouped_9_12": round(target_grouped, 6) if target_grouped else "",
                    "bet365_found": bool_text(bool(baseline)),
                    "bet365_geo_variant": baseline.get("geo_variant") if baseline else "",
                    "bet365_3_6_decimal": baseline.get("p2_3_6_decimal") if baseline else "",
                    "bet365_4_6_decimal": baseline.get("p2_4_6_decimal") if baseline else "",
                    "bet365_5_7_decimal": baseline.get("p2_5_7_decimal") if baseline else "",
                    "bet365_grouped_9_12": round(baseline_grouped, 6) if baseline_grouped else "",
                    "stake_vs_bet365_diff": round(diff, 6) if diff is not None else "",
                    "stake_vs_bet365_pct": round(pct, 2) if pct is not None else "",
                    "stake_better": bool_text(bool(diff is not None and diff > 0)),
                    "provider_count_with_all_scores": provider_count,
                    "geos_checked": ",".join(geo_variants),
                    "note": "" if target else "target provider not found in decoded provider inventory",
                })
                meta["inventory_rows"] = len(inventory)
                meta["comparison_rows"] = len(comparisons)
                meta["stake_found_rows"] = sum(1 for r in comparisons if r.get("stake_found") == "true")
                meta["bet365_found_rows"] = sum(1 for r in comparisons if r.get("bet365_found") == "true")
                meta["stake_better_rows"] = sum(1 for r in comparisons if r.get("stake_better") == "true")
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        finally:
            context.close()
            browser.close()

    write_csv(out_dir / "stake_vs_bet365_comparison.csv", comparisons, comparison_fields())
    write_csv(out_dir / "stake_provider_inventory.csv", inventory, inventory_fields())
    meta["stop_reason"] = "STAKE_VS_BET365_PROBE_COMPLETE"
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    report = [
        "# Stake vs bet365 OddsPortal Probe",
        "",
        f"Generated: {meta['generated_at']}",
        f"Signals checked: {meta['comparison_rows']}",
        f"Stake found rows: {meta['stake_found_rows']}",
        f"bet365 found rows: {meta['bet365_found_rows']}",
        f"Stake better rows: {meta['stake_better_rows']}",
        "",
        "## Comparisons",
    ]
    for row in comparisons:
        report.append(
            f"- {row.get('match_name')}: Stake={row.get('stake_grouped_9_12') or 'not found'} "
            f"vs bet365={row.get('bet365_grouped_9_12') or 'not found'}; "
            f"Stake better={row.get('stake_better')}; providers={row.get('provider_count_with_all_scores')}"
        )
    (out_dir / "stake_vs_bet365_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
