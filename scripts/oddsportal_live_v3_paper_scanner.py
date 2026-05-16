#!/usr/bin/env python3
"""
SlipIQ OddsPortal live V3 / P2 grouped 9-12 paper scanner.

Purpose:
- Discover current/upcoming OddsPortal tennis match links.
- Direct-fetch Correct Score / 1st Set market endpoints.
- Extract provider 549 bet365 prices for 3:6, 4:6, 5:7.
- Reconstruct Player 2 & 9-12 grouped odds.
- Classify into CEO buckets.
- Optionally write raw price checks and promoted signals to Supabase.

Read-only odds research. No auto-betting. No captcha bypass. No sportsbook actions.
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
from urllib.parse import quote, urlencode, urlparse, urldefrag
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from playwright.sync_api import BrowserContext, Page, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret, clear_oddsportal_route_memory
from oddsportal_constructed_v3_endpoint_probe import construct_v3_endpoint
from oddsportal_decoded_v3_probe import (
    PROVIDER_BET365,
    TARGET_P2,
    decode_oddsportal_dat,
    decimal_grouped,
    score_odds,
)
from oddsportal_v3_odds_from_master_csv import discover_token_fast

DEFAULT_DISCOVERY_URLS = [
    "https://www.oddsportal.com/tennis/",
    "https://www.oddsportal.com/matches/tennis/",
    "https://www.oddsportal.com/matches/tennis/today/",
    "https://www.oddsportal.com/matches/tennis/tomorrow/",
]

BAD_LINK_PARTS = [
    "/results/",
    "/draw/",
    "/standings/",
    "/rankings/",
    "/news/",
    "/outrights/",
    "/archive/",
    "/fixtures/",
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def safe_float(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except Exception:
        return None


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def event_hash_from_url(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    if not path:
        return ""
    last = path.split("/")[-1]
    if re.fullmatch(r"[A-Za-z0-9]{8,}", last or ""):
        return last
    # Some archive links carry the event hash after a fragment.
    frag = urlparse(url).fragment
    if frag:
        first = frag.split(":", 1)[0].strip("/")
        if re.fullmatch(r"[A-Za-z0-9]{8,}", first or ""):
            return first
    return ""


def normalize_match_url(url: str) -> str:
    no_hash = urldefrag(clean_text(url))[0].rstrip("/")
    return no_hash + "/" if no_hash else ""


def is_probable_match_url(url: str) -> bool:
    parsed = urlparse(url)
    if "oddsportal.com" not in parsed.netloc.lower():
        return False
    path = parsed.path.lower()
    if "/tennis/" not in path:
        return False
    if any(part in path for part in BAD_LINK_PARTS):
        return False
    return bool(event_hash_from_url(url))


def names_from_link(text: str, url: str) -> tuple[str, str, str]:
    text = clean_text(text)
    # OddsPortal links often render as "Player A - Player B".
    for sep in [" - ", " vs ", " v "]:
        if sep in text:
            left, right = text.split(sep, 1)
            p1 = clean_text(left)
            p2 = clean_text(right)
            if p1 and p2:
                return p1, p2, f"{p1} vs {p2}"
    parts = [p for p in urlparse(url).path.strip("/").split("/") if p]
    # h2h/player-one/player-two/eventhash format.
    if "h2h" in parts:
        idx = parts.index("h2h")
        if len(parts) > idx + 3:
            p1 = parts[idx + 1].replace("-", " ").title()
            p2 = parts[idx + 2].replace("-", " ").title()
            return p1, p2, f"{p1} vs {p2}"
    if text:
        return "", "", text
    return "", "", event_hash_from_url(url)


def extract_match_links(page: Page, source_url: str) -> list[dict[str, str]]:
    try:
        raw_links = page.evaluate(
            """
            () => Array.from(document.querySelectorAll('a[href]')).map(a => ({
              href: a.href || '',
              text: (a.innerText || a.textContent || '').trim()
            }))
            """
        )
    except Exception:
        raw_links = []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw_links:
        href = normalize_match_url(str(item.get("href") or ""))
        if not href or href in seen or not is_probable_match_url(href):
            continue
        seen.add(href)
        event_hash = event_hash_from_url(href)
        player1, player2, match_name = names_from_link(str(item.get("text") or ""), href)
        out.append({
            "discovered_at": now_iso(),
            "source_url": source_url,
            "match_url": href,
            "event_hash": event_hash,
            "player1": player1,
            "player2": player2,
            "match_name": match_name,
        })
    return out


def discover_matches(context: BrowserContext, page: Page, urls: list[str], wait_ms: int, limit: int) -> list[dict[str, str]]:
    all_matches: list[dict[str, str]] = []
    seen: set[str] = set()
    for url in urls:
        if limit and len(all_matches) >= limit:
            break
        try:
            clear_oddsportal_route_memory(context, page, wait_ms)
            base.log(f"Live scanner discovery opening: {url}")
            base.goto(page, url, wait_ms)
            page.wait_for_timeout(wait_ms)
            for _ in range(3):
                try:
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                except Exception:
                    pass
                page.wait_for_timeout(max(700, wait_ms // 3))
            links = extract_match_links(page, url)
        except Exception as exc:
            base.log(f"Discovery failed for {url}: {exc}")
            links = []
        for row in links:
            key = row.get("event_hash") or row.get("match_url")
            if not key or key in seen:
                continue
            seen.add(key)
            all_matches.append(row)
            if limit and len(all_matches) >= limit:
                break
    return all_matches


def fetch_v3_price_row(context: BrowserContext, row: dict[str, str], token: str) -> dict[str, Any]:
    event_hash = clean_text(row.get("event_hash"))
    match_url = clean_text(row.get("match_url"))
    endpoint_url = construct_v3_endpoint(event_hash, token) if event_hash else ""
    out: dict[str, Any] = {
        **row,
        "scraped_at": now_iso(),
        "constructed_url": endpoint_url,
        "provider_id": PROVIDER_BET365,
        "http_status": "",
        "decode_status": "",
        "body_length": "",
        "market_bt": "",
        "market_scope": "",
        "p2_3_6_decimal": "",
        "p2_4_6_decimal": "",
        "p2_5_7_decimal": "",
        "p2_grouped_9_12": "",
        "v3_exact_4_6_trigger": "false",
        "v4_compression_ratio": "",
        "v4_compression_trigger": "false",
        "ceo_bucket": "NO_PRICE",
        "odds_status": "missing_event_hash" if not event_hash else "unknown",
        "note": "",
    }
    if not endpoint_url:
        return out
    try:
        resp = context.request.get(
            endpoint_url,
            headers={"referer": match_url or "https://www.oddsportal.com/", "accept": "*/*"},
            timeout=30000,
        )
        body = resp.text()
        out["http_status"] = resp.status
        out["body_length"] = len(body)
    except Exception as exc:
        out["odds_status"] = "request_error"
        out["note"] = str(exc)[:500]
        return out

    try:
        decoded = decode_oddsportal_dat(body)
        out["decode_status"] = "decoded"
    except Exception as exc:
        out["decode_status"] = f"decode_failed:{exc}"
        out["odds_status"] = "decode_failed"
        return out

    odds = score_odds(decoded, PROVIDER_BET365)
    p2_vals = [odds.get(s) for s in TARGET_P2]
    grouped = decimal_grouped(p2_vals)
    p36 = safe_float(odds.get("3:6"))
    p46 = safe_float(odds.get("4:6"))
    p57 = safe_float(odds.get("5:7"))
    d = decoded.get("d", {}) if isinstance(decoded, dict) else {}
    out.update({
        "market_bt": d.get("bt") if isinstance(d, dict) else "",
        "market_scope": d.get("sc") if isinstance(d, dict) else "",
        "p2_3_6_decimal": p36 or "",
        "p2_4_6_decimal": p46 or "",
        "p2_5_7_decimal": p57 or "",
        "p2_grouped_9_12": grouped or "",
    })
    v3 = bool(p46 and 6.25 <= p46 < 7.0)
    ratio = None
    if p36 and p46 and min(p36, p46) > 0:
        ratio = round(max(p36, p46) / min(p36, p46), 6)
    v4 = bool(grouped and grouped >= 2.80 and ratio is not None and ratio <= 1.40)
    out["v3_exact_4_6_trigger"] = bool_text(v3)
    out["v4_compression_ratio"] = ratio or ""
    out["v4_compression_trigger"] = bool_text(v4)
    out["ceo_bucket"] = classify_bucket(grouped, None)
    if resp.status >= 400:
        out["odds_status"] = f"http_{resp.status}"
    elif grouped:
        out["odds_status"] = "ok"
    else:
        out["odds_status"] = "missing_v3_prices"
    return out


def classify_bucket(grouped: float | None, p2_match_odds: float | None) -> str:
    if grouped is None:
        return "NO_PRICE"
    if p2_match_odds is None:
        if grouped >= 3.30:
            return "PRICE_ONLY_REVIEW"
        if grouped >= 2.80:
            return "PRICE_ONLY_RESEARCH"
        return "REJECT_OR_WATCH"
    if grouped >= 3.50 and p2_match_odds < 1.50:
        return "A_PLUS"
    if grouped >= 3.30 and p2_match_odds < 1.60:
        return "A"
    if grouped >= 3.00 and p2_match_odds < 1.60:
        return "MAIN"
    if grouped >= 2.80 and p2_match_odds < 1.70:
        return "RESEARCH"
    return "REJECT_OR_WATCH"


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fields = [
        "discovered_at", "scraped_at", "source_url", "match_url", "event_hash", "player1", "player2", "match_name",
        "constructed_url", "provider_id", "http_status", "decode_status", "body_length", "market_bt", "market_scope",
        "p2_3_6_decimal", "p2_4_6_decimal", "p2_5_7_decimal", "p2_grouped_9_12",
        "v3_exact_4_6_trigger", "v4_compression_ratio", "v4_compression_trigger", "ceo_bucket", "odds_status", "note",
    ]
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
        "Prefer": "return=representation",
    }


def supabase_url_for(table: str) -> str:
    base_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    return f"{base_url}/rest/v1/{table}"


def supabase_ready() -> bool:
    return bool((os.getenv("SUPABASE_URL") or "").strip() and (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip())


def supabase_get_existing(table: str, external_match_id: str) -> list[dict[str, Any]]:
    url = supabase_url_for(table) + "?" + urlencode({"external_match_id": f"eq.{external_match_id}", "select": "id", "limit": "1"})
    req = Request(url, headers=supabase_headers(), method="GET")
    try:
        with urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []


def supabase_insert(table: str, payload: dict[str, Any]) -> tuple[bool, str]:
    data = json.dumps(payload).encode("utf-8")
    req = Request(supabase_url_for(table), data=data, headers=supabase_headers(), method="POST")
    try:
        with urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8")
            return 200 <= resp.status < 300, body[:500]
    except HTTPError as exc:
        try:
            body = exc.read().decode("utf-8")
        except Exception:
            body = str(exc)
        return False, body[:500]
    except URLError as exc:
        return False, str(exc)[:500]


def to_supabase_price_check(row: dict[str, Any], scanner_run_id: str) -> dict[str, Any]:
    grouped = safe_float(row.get("p2_grouped_9_12"))
    return {
        "check_source": "github_actions_oddsportal_live",
        "sportsbook": "bet365",
        "external_match_id": row.get("match_url") or row.get("event_hash"),
        "match_name": row.get("match_name") or row.get("event_hash"),
        "player2": row.get("player2") or None,
        "odds_p2_6_3": safe_float(row.get("p2_3_6_decimal")),
        "odds_p2_6_4": safe_float(row.get("p2_4_6_decimal")),
        "odds_p2_7_5": safe_float(row.get("p2_5_7_decimal")),
        "reconstructed_p2_9_12_odds": grouped,
        "is_playable": bool(grouped and grouped >= 3.00),
        "raw_payload": row,
        "scanner_run_id": scanner_run_id,
        "strategy_family": "P2_GROUPED_9_12",
        "candidate_bucket": row.get("ceo_bucket") or None,
        "v3_exact_4_6_trigger": row.get("v3_exact_4_6_trigger") == "true",
        "v4_compression_trigger": row.get("v4_compression_trigger") == "true",
        "v4_compression_ratio": safe_float(row.get("v4_compression_ratio")),
        "grouped_price_floor": grouped,
        "paper_trade_ready": row.get("ceo_bucket") in {"MAIN", "A", "A_PLUS", "PRICE_ONLY_REVIEW"},
        "paper_trade_notes": "Live scanner price check. P2 match odds may be missing in first scanner version.",
    }


def to_supabase_signal(row: dict[str, Any], scanner_run_id: str) -> dict[str, Any]:
    grouped = safe_float(row.get("p2_grouped_9_12"))
    p46 = safe_float(row.get("p2_4_6_decimal"))
    bucket = row.get("ceo_bucket") or "UNCLASSIFIED"
    signal_class = "WATCHLIST_LONGSHOT"
    if bucket == "PRICE_ONLY_REVIEW":
        signal_class = "OFFICIAL_V3_PLAYABLE" if p46 and 6.25 <= p46 < 7.0 else "AGGRESSIVE_V3_TARGET"
    return {
        "source": "github_actions_oddsportal_live",
        "sportsbook": "bet365",
        "external_match_id": row.get("match_url") or row.get("event_hash"),
        "match_name": row.get("match_name") or row.get("event_hash"),
        "player1": row.get("player1") or None,
        "player2": row.get("player2") or None,
        "odds_p2_6_3": safe_float(row.get("p2_3_6_decimal")),
        "odds_p2_6_4": p46,
        "odds_p2_7_5": safe_float(row.get("p2_5_7_decimal")),
        "reconstructed_p2_9_12_odds": grouped,
        "verified_grouped_odds": grouped,
        "v3_trigger_price": p46,
        "signal_class": signal_class,
        "execution_status": "new",
        "result_status": "pending",
        "raw_payload": row,
        "scanner_run_id": scanner_run_id,
        "strategy_family": "P2_GROUPED_9_12",
        "candidate_bucket": bucket,
        "v3_exact_4_6_trigger": row.get("v3_exact_4_6_trigger") == "true",
        "v4_compression_trigger": row.get("v4_compression_trigger") == "true",
        "v4_compression_ratio": safe_float(row.get("v4_compression_ratio")),
        "grouped_price_floor": grouped,
        "paper_trade_ready": bucket in {"MAIN", "A", "A_PLUS", "PRICE_ONLY_REVIEW"},
        "paper_trade_notes": "Promoted by live scanner. Paper bet not automatically created in v1.",
    }


def write_supabase_rows(rows: list[dict[str, Any]], scanner_run_id: str, promote_buckets: set[str]) -> dict[str, Any]:
    summary = {
        "supabase_ready": supabase_ready(),
        "price_checks_attempted": 0,
        "price_checks_inserted": 0,
        "signals_attempted": 0,
        "signals_inserted": 0,
        "errors": [],
    }
    if not supabase_ready():
        summary["errors"].append("SUPABASE_URL and service role key are required for writes.")
        return summary
    for row in rows:
        if row.get("odds_status") != "ok":
            continue
        external_id = row.get("match_url") or row.get("event_hash") or ""
        if not external_id:
            continue
        if not supabase_get_existing("private_v3_price_checks", external_id):
            summary["price_checks_attempted"] += 1
            ok, msg = supabase_insert("private_v3_price_checks", to_supabase_price_check(row, scanner_run_id))
            if ok:
                summary["price_checks_inserted"] += 1
            else:
                summary["errors"].append({"table": "private_v3_price_checks", "match": external_id, "error": msg})
        bucket = str(row.get("ceo_bucket") or "")
        if bucket in promote_buckets and not supabase_get_existing("private_v3_signal_log", external_id):
            summary["signals_attempted"] += 1
            ok, msg = supabase_insert("private_v3_signal_log", to_supabase_signal(row, scanner_run_id))
            if ok:
                summary["signals_inserted"] += 1
            else:
                summary["errors"].append({"table": "private_v3_signal_log", "match": external_id, "error": msg})
    return summary


def parse_csv_list(value: str) -> list[str]:
    return [x.strip() for x in str(value or "").split(",") if x.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/output/oddsportal-live-v3-paper-scanner")
    parser.add_argument("--limit-matches", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=3000)
    parser.add_argument("--pause-seconds", type=float, default=0.25)
    parser.add_argument("--dry-run", default="true", choices=["true", "false"])
    parser.add_argument("--write-supabase", default="false", choices=["true", "false"])
    parser.add_argument("--promote-buckets", default="PRICE_ONLY_REVIEW,A_PLUS,A,MAIN")
    parser.add_argument("--discovery-urls", default=",".join(DEFAULT_DISCOVERY_URLS))
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    scanner_run_id = f"live-v3-{int(time.time())}"
    discovery_urls = parse_csv_list(args.discovery_urls) or DEFAULT_DISCOVERY_URLS
    dry_run = args.dry_run == "true"
    write_supabase = args.write_supabase == "true" and not dry_run
    promote_buckets = set(parse_csv_list(args.promote_buckets))
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "scanner_run_id": scanner_run_id,
        "args": vars(args),
        "dry_run": dry_run,
        "write_supabase": write_supabase,
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "discovered_match_count": 0,
        "rows_written": 0,
        "odds_status_counts": {},
        "ceo_bucket_counts": {},
        "supabase_write_summary": {},
    }

    rows: list[dict[str, Any]] = []
    discovered: list[dict[str, str]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for live V3 scanner.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2

            token, seed_url = discover_token_fast(context, page, [], args.wait_ms, 0)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed_url
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2

            discovered = discover_matches(context, page, discovery_urls, args.wait_ms, args.limit_matches)
            meta["discovered_match_count"] = len(discovered)
            for i, match in enumerate(discovered, start=1):
                base.log(f"[{i}/{len(discovered)}] Live V3 price check: {match.get('match_name')} {match.get('event_hash')}")
                row = fetch_v3_price_row(context, match, token)
                rows.append(row)
                status = str(row.get("odds_status") or "unknown")
                bucket = str(row.get("ceo_bucket") or "unknown")
                meta["odds_status_counts"][status] = meta["odds_status_counts"].get(status, 0) + 1
                meta["ceo_bucket_counts"][bucket] = meta["ceo_bucket_counts"].get(bucket, 0) + 1
                meta["rows_written"] = len(rows)
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    write_csv(out_dir / "live_v3_price_checks.csv", rows)
    write_csv(out_dir / "live_v3_discovered_matches.csv", discovered)
    if write_supabase:
        meta["supabase_write_summary"] = write_supabase_rows(rows, scanner_run_id, promote_buckets)
    else:
        meta["supabase_write_summary"] = {"skipped": True, "reason": "dry_run_or_write_supabase_false"}
    meta["stop_reason"] = "LIVE_V3_SCANNER_COMPLETE"
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Live V3 Paper Scanner",
        "",
        f"Generated: {meta['generated_at']}",
        f"Scanner run id: {scanner_run_id}",
        f"Dry run: {dry_run}",
        f"Write Supabase: {write_supabase}",
        f"Discovered matches: {meta['discovered_match_count']}",
        f"Rows written: {meta['rows_written']}",
        "",
        "## Odds status counts",
        json.dumps(meta["odds_status_counts"], indent=2),
        "",
        "## CEO bucket counts",
        json.dumps(meta["ceo_bucket_counts"], indent=2),
    ]
    (out_dir / "live_v3_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
