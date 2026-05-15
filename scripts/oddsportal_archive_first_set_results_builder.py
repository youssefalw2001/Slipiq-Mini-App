#!/usr/bin/env python3
"""
SlipIQ OddsPortal archive first-set results builder.

Goal:
- Decode OddsPortal tournament archive endpoints.
- Extract real first-set result from archive row partialresult.

Key discovery:
- Decoded archive rows contain a field like:
    partialresult: "6:3, 7:6<div><sup>4</sup></div>, 6:3"
- The first comma-separated set score is the real first-set score.

This script does NOT scrape odds and does NOT backtest.
It creates a clean first_set_results.csv that can be joined with bet365 V3 odds rows by event_id/event_hash.

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse, urldefrag

from playwright.sync_api import Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import clear_oddsportal_route_memory
from oddsportal_decoded_v3_probe import decode_oddsportal_dat

VALID_SET_SCORES = {
    "6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6",
    "0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7",
}
CAPTURE_PATH_PATTERNS = [
    "/ajax-sport-country-tournament-archive",
    "/ajax-sport-country-tournament",
]
NOISY_PATH_PARTS = ["/build/assets/", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".ico"]
FINISHED_MARKERS = {"finished", "ended", "completed", "final"}
BAD_STATUS_MARKERS = {"scheduled", "walkover", "retired", "abandoned", "cancelled", "canceled", "postponed", "1st set", "2nd set", "3rd set", "live"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


def normalize_match_url(value: str, base_url: str) -> str:
    if not value:
        return ""
    absolute = urljoin(base_url, html.unescape(value))
    parsed = urlparse(absolute)
    if "oddsportal.com" not in parsed.netloc or "/tennis/" not in parsed.path.lower():
        return ""
    return strip_hash(absolute) + (absolute.split("#", 1)[1] if "#" in absolute else "") if "#" in absolute else strip_hash(absolute)


def should_capture(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "oddsportal.com" not in host:
        return False
    if any(part in path for part in NOISY_PATH_PARTS):
        return False
    return any(p in path for p in CAPTURE_PATH_PATTERNS)


def decode_response(resp: Response) -> tuple[Any | None, str]:
    try:
        raw = resp.body().decode("utf-8", errors="replace").strip()
    except Exception as exc:
        return None, f"body_error:{exc}"
    try:
        return json.loads(raw), "plain_json"
    except Exception:
        pass
    try:
        return decode_oddsportal_dat(raw), "decoded_encrypted"
    except Exception as exc:
        return None, f"decode_failed:{exc}"


def get_rows(decoded: Any) -> list[dict[str, Any]]:
    if not isinstance(decoded, dict):
        return []
    d = decoded.get("d") if isinstance(decoded.get("d"), dict) else decoded
    for key in ["rows", "events", "matches", "data"]:
        if isinstance(d.get(key), list):
            return [x for x in d.get(key) if isinstance(x, dict)]
    return []


def get_any(row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in row and row.get(key) not in (None, ""):
            return row.get(key)
    return ""


def player_name(value: Any) -> str:
    if isinstance(value, dict):
        for key in ["name", "participantName", "shortName", "slug"]:
            if value.get(key):
                return clean_text(value.get(key))
        return clean_text(" ".join(str(v) for v in value.values() if isinstance(v, (str, int, float))))
    return clean_text(value)


def status_from_row(row: dict[str, Any]) -> tuple[str, str]:
    status = clean_text(get_any(row, ["event-stage-name", "eventStageName", "status-name", "statusName", "status", "state"]))
    status_id = clean_text(get_any(row, ["event-stage-id", "eventStageId", "status-id", "statusId"]))
    if not status and status_id == "3":
        status = "Finished"
    return status, status_id


def row_is_finished(row: dict[str, Any]) -> bool:
    status, status_id = status_from_row(row)
    combined = f"{status} {status_id}".lower()
    if any(x in combined for x in BAD_STATUS_MARKERS):
        return False
    if status_id == "3":
        return True
    return any(x in combined for x in FINISHED_MARKERS)


def strip_score_html(value: Any) -> str:
    text = clean_text(value)
    text = re.sub(r"<[^>]+>", "", text)
    return clean_text(text)


def first_set_from_partialresult(value: Any) -> tuple[str, str]:
    text = strip_score_html(value)
    if not text:
        return "", ""
    # Examples:
    # "6:3, 7:6<div><sup>4</sup></div>, 6:3"
    # "3:6, 6:3, 6:4"
    first_part = text.split(",", 1)[0].strip()
    m = re.search(r"\b([0-7])\s*[:\-]\s*([0-7])\b", first_part)
    if not m:
        return "", ""
    score = f"{m.group(1)}:{m.group(2)}"
    if score not in VALID_SET_SCORES:
        return "", ""
    return score, "archive_partialresult_first_set"


def row_to_result(row: dict[str, Any], source_endpoint: str, results_url: str, landed_url: str) -> dict[str, Any]:
    event_id = clean_text(get_any(row, ["id", "eventId", "event_id", "matchId", "match_id"]))
    event_hash = clean_text(get_any(row, ["encodeEventId", "encodedEventId", "eventHash", "hash", "eid"]))
    p1 = player_name(get_any(row, ["home-name", "homeName", "home", "participant1", "homeParticipant", "homeTeam", "player1", "competitor1"]))
    p2 = player_name(get_any(row, ["away-name", "awayName", "away", "participant2", "awayParticipant", "awayTeam", "player2", "competitor2"]))
    status, status_id = status_from_row(row)
    match_date = clean_text(get_any(row, ["date-start-timestamp", "date-start-base", "date", "startTime", "time", "timestamp"]))
    tournament = clean_text(get_any(row, ["tournament-name", "tournamentName", "tournament", "league-name"]))
    raw_url = clean_text(get_any(row, ["url", "href", "link", "path", "slug"]))
    match_url = normalize_match_url(raw_url, landed_url)
    partialresult = clean_text(get_any(row, ["partialresult", "partialResult", "partial-result", "setScores", "sets", "score"] ))
    first_set_score, result_source = first_set_from_partialresult(partialresult)
    result_status = "ok" if first_set_score else "needs_result"
    p2_v3_hit = str(first_set_score in {"3:6", "4:6", "5:7"}).lower() if first_set_score else ""
    p1_v3_hit = str(first_set_score in {"6:3", "6:4", "7:5"}).lower() if first_set_score else ""
    return {
        "results_url": results_url,
        "landed_url": landed_url,
        "source_endpoint": source_endpoint,
        "event_id": event_id,
        "event_hash": event_hash,
        "player1": p1,
        "player2": p2,
        "match_name": f"{p1} - {p2}" if p1 and p2 else clean_text(get_any(row, ["name", "eventName", "matchName", "title"])),
        "match_date": match_date,
        "tournament": tournament,
        "archive_status": status,
        "status_id": status_id,
        "match_url": match_url,
        "partialresult": partialresult,
        "first_set_score": first_set_score,
        "result_status": result_status,
        "result_source": result_source,
        "p2_v3_hit": p2_v3_hit,
        "p1_v3_hit": p1_v3_hit,
    }


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def collect_results(page: Page, results_url: str, wait_ms: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    endpoint_rows: list[dict[str, Any]] = []
    result_rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    def on_response(resp: Response) -> None:
        if not should_capture(resp) or resp.url in seen:
            return
        seen.add(resp.url)
        decoded, decode_status = decode_response(resp)
        rows = get_rows(decoded)
        endpoint_rows.append({
            "results_url": results_url,
            "landed_url": page.url,
            "endpoint_url": resp.url,
            "status": resp.status,
            "decode_status": decode_status,
            "row_count": len(rows),
        })
        for row in rows:
            if not row_is_finished(row):
                continue
            result_rows.append(row_to_result(row, resp.url, results_url, page.url))

    page.on("response", on_response)
    try:
        base.log(f"First-set results builder opening: {results_url}")
        page.goto(results_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(wait_ms)
        for _ in range(4):
            try:
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            except Exception:
                pass
            page.wait_for_timeout(max(700, wait_ms // 3))
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass
    return endpoint_rows, result_rows


def dedupe_results(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        key = row.get("event_id") or row.get("event_hash") or row.get("match_url") or row.get("match_name")
        if not key or key in seen:
            continue
        seen.add(str(key))
        out.append(row)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-archive-first-set-results")
    parser.add_argument("--limit-pages", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=3000)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    urls = base.read_urls_file(args.results_urls_file)
    if args.limit_pages and args.limit_pages > 0:
        urls = urls[: args.limit_pages]

    all_endpoint_rows: list[dict[str, Any]] = []
    all_result_rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for url in urls:
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    endpoint_rows, result_rows = collect_results(page, url, args.wait_ms)
                except Exception as exc:
                    endpoint_rows, result_rows = [{"results_url": url, "error": str(exc)}], []
                all_endpoint_rows.extend(endpoint_rows)
                all_result_rows.extend(result_rows)
        finally:
            context.close()
            browser.close()

    result_rows = dedupe_results(all_result_rows)
    endpoint_fields = ["results_url", "landed_url", "endpoint_url", "status", "decode_status", "row_count", "error"]
    result_fields = [
        "results_url", "landed_url", "source_endpoint", "event_id", "event_hash", "player1", "player2", "match_name",
        "match_date", "tournament", "archive_status", "status_id", "match_url", "partialresult", "first_set_score",
        "result_status", "result_source", "p2_v3_hit", "p1_v3_hit",
    ]
    write_csv(out_dir / "archive_results_endpoint_inventory.csv", all_endpoint_rows, endpoint_fields)
    write_csv(out_dir / "first_set_results.csv", result_rows, result_fields)

    summary = {
        "generated_at": now_iso(),
        "results_url_count": len(urls),
        "captured_endpoint_count": len(all_endpoint_rows),
        "finished_result_rows": len(result_rows),
        "mapped_first_set_count": sum(1 for r in result_rows if r.get("result_status") == "ok"),
        "needs_result_count": sum(1 for r in result_rows if r.get("result_status") != "ok"),
        "p2_v3_hits": sum(1 for r in result_rows if r.get("p2_v3_hit") == "true"),
        "p1_v3_hits": sum(1 for r in result_rows if r.get("p1_v3_hit") == "true"),
    }
    (out_dir / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Archive First-Set Results",
        "",
        f"Generated: {summary['generated_at']}",
        f"URLs checked: {summary['results_url_count']}",
        f"Endpoints captured: {summary['captured_endpoint_count']}",
        f"Finished rows: {summary['finished_result_rows']}",
        f"Mapped first-set scores: {summary['mapped_first_set_count']}",
        f"Needs result: {summary['needs_result_count']}",
        f"P2 V3 hits: {summary['p2_v3_hits']}",
        f"P1 V3 hits: {summary['p1_v3_hits']}",
    ]
    (out_dir / "first_set_results_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
