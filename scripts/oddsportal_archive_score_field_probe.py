#!/usr/bin/env python3
"""
SlipIQ OddsPortal archive score field probe.

Goal:
- Decode OddsPortal tournament archive endpoints.
- Inspect d.rows[] for real score/result/set fields.
- Try to extract first_set_score WITHOUT using visible page text.

This does NOT scrape odds, does NOT backtest, and does NOT place bets.
Read-only public archive endpoint inspection.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

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
SCORE_KEY_HINTS = [
    "score", "result", "period", "partial", "set", "home", "away", "stage", "status", "winner",
]
FIRST_SET_KEY_PATTERNS = [
    r"home.*score.*period.*1",
    r"away.*score.*period.*1",
    r"home.*partial.*1",
    r"away.*partial.*1",
    r"home.*set.*1",
    r"away.*set.*1",
    r"period.*1.*home",
    r"period.*1.*away",
    r"set.*1.*home",
    r"set.*1.*away",
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def norm_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def flatten(obj: Any, prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            out.extend(flatten(v, key))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            key = f"{prefix}[{i}]" if prefix else f"[{i}]"
            out.extend(flatten(v, key))
    else:
        out.append((prefix, obj))
    return out


def should_capture(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    if "oddsportal.com" not in host:
        return False
    if any(part in path for part in NOISY_PATH_PARTS):
        return False
    return any(p in path for p in CAPTURE_PATH_PATTERNS)


def decode_response(resp: Response) -> tuple[Any | None, str, str]:
    try:
        raw = resp.body().decode("utf-8", errors="replace")
    except Exception as exc:
        return None, "", f"body_error:{exc}"
    stripped = raw.strip()
    try:
        return json.loads(stripped), raw, "plain_json"
    except Exception:
        pass
    try:
        return decode_oddsportal_dat(stripped), raw, "decoded_encrypted"
    except Exception as exc:
        return None, raw, f"decode_failed:{exc}"


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


def normalize_score(home: Any, away: Any) -> str:
    h = clean_text(home)
    a = clean_text(away)
    if not re.fullmatch(r"\d+", h) or not re.fullmatch(r"\d+", a):
        return ""
    score = f"{h}:{a}"
    return score if score in VALID_SET_SCORES else ""


def extract_explicit_period1_score(row: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    flat = dict(flatten(row))
    candidates: dict[str, Any] = {}
    for k, v in flat.items():
        kl = k.lower()
        if any(re.search(p, kl) for p in FIRST_SET_KEY_PATTERNS):
            candidates[k] = v

    home_keys = [k for k in candidates if re.search(r"home", k, re.I)]
    away_keys = [k for k in candidates if re.search(r"away", k, re.I)]
    for hk in home_keys:
        for ak in away_keys:
            score = normalize_score(candidates.get(hk), candidates.get(ak))
            if score:
                return score, f"explicit_period1_fields:{hk}|{ak}", candidates
    return "", "", candidates


def extract_score_like_fields(row: dict[str, Any]) -> dict[str, Any]:
    flat = dict(flatten(row))
    out: dict[str, Any] = {}
    for k, v in flat.items():
        kl = k.lower()
        val = clean_text(v)
        if any(hint in kl for hint in SCORE_KEY_HINTS):
            out[k] = v
        elif re.fullmatch(r"[0-7]\s*[:\-]\s*[0-7]", val):
            out[k] = v
    return out


def extract_score_tokens_from_score_fields(score_fields: dict[str, Any]) -> list[str]:
    tokens: list[str] = []
    text = json.dumps(score_fields, ensure_ascii=False)
    for m in re.finditer(r"\b([0-7])\s*[:\-]\s*([0-7])\b", text):
        score = f"{m.group(1)}:{m.group(2)}"
        if score in VALID_SET_SCORES and score not in tokens:
            tokens.append(score)
    return tokens


def row_to_output(row: dict[str, Any], source_endpoint: str, results_url: str, landed_url: str) -> dict[str, Any]:
    event_id = clean_text(get_any(row, ["id", "eventId", "event_id", "matchId", "match_id"]))
    event_hash = clean_text(get_any(row, ["encodeEventId", "encodedEventId", "eventHash", "hash", "eid"]))
    p1 = player_name(get_any(row, ["home-name", "homeName", "home", "participant1", "homeParticipant", "homeTeam", "player1", "competitor1"]))
    p2 = player_name(get_any(row, ["away-name", "awayName", "away", "participant2", "awayParticipant", "awayTeam", "player2", "competitor2"]))
    status = clean_text(get_any(row, ["event-stage-name", "eventStageName", "status-name", "statusName", "status", "state"]))
    status_id = clean_text(get_any(row, ["event-stage-id", "eventStageId", "status-id", "statusId"]))
    score, source, explicit_candidates = extract_explicit_period1_score(row)
    score_fields = extract_score_like_fields(row)
    score_tokens = extract_score_tokens_from_score_fields(score_fields)
    result_status = "ok" if score else "needs_mapping"
    return {
        "results_url": results_url,
        "landed_url": landed_url,
        "source_endpoint": source_endpoint,
        "event_id": event_id,
        "event_hash": event_hash,
        "player1": p1,
        "player2": p2,
        "match_name": f"{p1} - {p2}" if p1 and p2 else clean_text(get_any(row, ["name", "eventName", "matchName", "title"])),
        "status": status,
        "status_id": status_id,
        "first_set_score_candidate": score,
        "result_status": result_status,
        "result_source": source,
        "score_tokens_found": ";".join(score_tokens),
        "explicit_period1_candidates_json": json.dumps(explicit_candidates, ensure_ascii=False)[:2000],
        "score_like_fields_json": json.dumps(score_fields, ensure_ascii=False)[:4000],
        "raw_row_json": json.dumps(row, ensure_ascii=False)[:8000],
    }


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def goto_and_collect(page: Page, results_url: str, wait_ms: int, out_dir: Path, page_idx: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    endpoint_rows: list[dict[str, Any]] = []
    score_rows: list[dict[str, Any]] = []
    seen: set[str] = set()

    def on_response(resp: Response) -> None:
        if not should_capture(resp) or resp.url in seen:
            return
        seen.add(resp.url)
        decoded, raw, decode_status = decode_response(resp)
        rows = get_rows(decoded)
        endpoint_rows.append({
            "results_url": results_url,
            "landed_url": page.url,
            "endpoint_url": resp.url,
            "status": resp.status,
            "decode_status": decode_status,
            "row_count": len(rows),
            "raw_length": len(raw),
        })
        if decoded is not None:
            body_path = out_dir / "decoded_archive_bodies" / f"page_{page_idx:03d}_{len(endpoint_rows):03d}.json"
            ensure_dir(body_path.parent)
            body_path.write_text(json.dumps(decoded, ensure_ascii=False, indent=2)[:5000000], encoding="utf-8")
        for row in rows:
            score_rows.append(row_to_output(row, resp.url, results_url, page.url))

    page.on("response", on_response)
    try:
        base.log(f"Score field probe opening: {results_url}")
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
    return endpoint_rows, score_rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-archive-score-field-probe")
    parser.add_argument("--limit-pages", type=int, default=10)
    parser.add_argument("--wait-ms", type=int, default=3000)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    urls = base.read_urls_file(args.results_urls_file)
    if args.limit_pages and args.limit_pages > 0:
        urls = urls[: args.limit_pages]

    all_endpoint_rows: list[dict[str, Any]] = []
    all_score_rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for idx, url in enumerate(urls, start=1):
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    endpoint_rows, score_rows = goto_and_collect(page, url, args.wait_ms, out_dir, idx)
                except Exception as exc:
                    endpoint_rows, score_rows = [{"results_url": url, "error": str(exc)}], []
                all_endpoint_rows.extend(endpoint_rows)
                all_score_rows.extend(score_rows)
        finally:
            context.close()
            browser.close()

    endpoint_fields = ["results_url", "landed_url", "endpoint_url", "status", "decode_status", "row_count", "raw_length", "error"]
    score_fields = [
        "results_url", "landed_url", "source_endpoint", "event_id", "event_hash", "player1", "player2", "match_name",
        "status", "status_id", "first_set_score_candidate", "result_status", "result_source", "score_tokens_found",
        "explicit_period1_candidates_json", "score_like_fields_json", "raw_row_json",
    ]
    write_csv(out_dir / "archive_score_endpoint_inventory.csv", all_endpoint_rows, endpoint_fields)
    write_csv(out_dir / "archive_first_set_score_candidates.csv", all_score_rows, score_fields)

    summary = {
        "generated_at": now_iso(),
        "results_url_count": len(urls),
        "captured_endpoint_count": len(all_endpoint_rows),
        "event_row_count": len(all_score_rows),
        "mapped_first_set_count": sum(1 for r in all_score_rows if r.get("result_status") == "ok"),
        "needs_mapping_count": sum(1 for r in all_score_rows if r.get("result_status") != "ok"),
    }
    (out_dir / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    report = [
        "# OddsPortal Archive Score Field Probe",
        "",
        f"Generated: {summary['generated_at']}",
        f"URLs checked: {summary['results_url_count']}",
        f"Endpoints captured: {summary['captured_endpoint_count']}",
        f"Archive event rows: {summary['event_row_count']}",
        f"Mapped first-set scores: {summary['mapped_first_set_count']}",
        f"Needs mapping: {summary['needs_mapping_count']}",
    ]
    (out_dir / "score_field_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
