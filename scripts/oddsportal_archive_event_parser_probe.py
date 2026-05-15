#!/usr/bin/env python3
"""
SlipIQ OddsPortal archive event parser probe.

This version decrypts OddsPortal archive/tournament endpoint bodies before parsing.
The archive endpoint uses the same encrypted .dat-style payload format as the
match odds endpoint we already decoded.

It parses decoded JSON rows such as:
  d.rows[] with id, encodeEventId, home-name, away-name, status-name

It does NOT decode odds and does NOT backtest.

Read-only. No betting. No sportsbook login. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urldefrag, urljoin, urlparse

from playwright.sync_api import Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import clear_oddsportal_route_memory
from oddsportal_decoded_v3_probe import decode_oddsportal_dat

PLAYER_PAIR_RE = re.compile(
    r"(?P<p1>[A-Z][A-Za-zÀ-ž'.\-]+(?:\s+[A-Z][A-Za-zÀ-ž'.\-]+)*\s+[A-Z]\.?)\s*(?:-|–|v|vs)\s*(?P<p2>[A-Z][A-Za-zÀ-ž'.\-]+(?:\s+[A-Z][A-Za-zÀ-ž'.\-]+)*\s+[A-Z]\.?)"
)
HASH_RE = re.compile(r"\b[A-Za-z0-9]{7,12}\b")
DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.20\d{2}|\d{1,2}/\d{1,2}/20\d{2})\b")

CAPTURE_PATH_PATTERNS = [
    "/ajax-sport-country-tournament-archive",
    "/ajax-sport-country-tournament",
    "/ajax-next-games",
    "/ajax-tournament",
    "/ajax-event",
    "/ajax-match",
    "/feed/",
]
CAPTURE_URL_KEYWORDS = ["archive", "results", "tournament", "event", "match", "score", "tennis"]
NOISY_PATH_PARTS = ["/build/assets/", "/country-flags/", "/logos/", "/fonts/", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".ico"]
NOISY_HOSTS = ["cookielaw.org", "googletagmanager.com", "google-analytics.com", "doubleclick.net"]
BAD_LANDED_PARTS = ["/bookmakers/", "/bookmakers"]

FAKE_HASH_WORDS = {
    "kingdom", "australian", "australia", "france", "italy", "spain", "united",
    "tennis", "results", "wimbledon", "french", "open", "rome", "madrid", "miami",
    "masters", "archive", "fixtures", "standings", "bookmakers", "matches",
    "atp", "wta", "doubles", "singles", "challenger", "women", "men",
}
EVENT_ID_KEYS = {"id", "eventid", "event_id", "matchid", "match_id", "gameid", "game_id"}
NAME_KEYS = {"name", "eventname", "event_name", "matchname", "match_name", "title", "participants", "label"}
URL_KEYS = {"url", "href", "link", "path", "slug", "permalink"}
DATE_KEYS = {"date", "time", "starttime", "start_time", "start", "timestamp", "datestart"}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


def is_bad_landed_url(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower().rstrip("/") + "/"
    return any(path.startswith(p.rstrip("/") + "/") for p in BAD_LANDED_PARTS) or "/tennis/" not in path or "/results/" not in path


def extract_hash_from_url(url: str) -> str:
    if "#" in url:
        h = url.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
        if HASH_RE.fullmatch(h) and h.lower() not in FAKE_HASH_WORDS:
            return h
    parsed = urlparse(url)
    last = parsed.path.strip("/").split("/")[-1]
    m = re.search(r"-([A-Za-z0-9]{7,12})$", last)
    if m and m.group(1).lower() not in FAKE_HASH_WORDS:
        return m.group(1)
    return ""


def normalize_match_url(value: str, base_url: str) -> str:
    if not value:
        return ""
    absolute = urljoin(base_url, html.unescape(value))
    parsed = urlparse(absolute)
    path = parsed.path.lower()
    if "oddsportal.com" not in parsed.netloc or "/tennis/" not in path:
        return ""
    if any(part in path for part in ["/bookmakers", "/bonus", "/predictions", "/rankings", "/standings", "/draw", "/archive"]):
        return ""
    event_hash = extract_hash_from_url(absolute)
    if event_hash:
        return f"{strip_hash(absolute)}#{event_hash}:cs;12"
    if "/tennis/h2h/" in path:
        return f"{strip_hash(absolute)}#cs;12"
    return ""


def should_capture(resp: Response) -> bool:
    parsed = urlparse(resp.url)
    host = parsed.netloc.lower()
    path = parsed.path.lower()
    url_lower = resp.url.lower()
    content_type = (resp.headers.get("content-type") or "").lower()
    resource_type = resp.request.resource_type
    if "oddsportal.com" not in host:
        return False
    if any(noisy in host for noisy in NOISY_HOSTS):
        return False
    if any(part in path for part in NOISY_PATH_PARTS):
        return False
    if any(p in path for p in CAPTURE_PATH_PATTERNS):
        return True
    if resource_type in {"xhr", "fetch"} and any(k in url_lower for k in CAPTURE_URL_KEYWORDS):
        return True
    if "json" in content_type and any(k in url_lower for k in CAPTURE_URL_KEYWORDS):
        return True
    if resource_type == "document" and "/tennis/" in path and "/results/" in path:
        return True
    return False


def read_response_text(resp: Response, max_bytes: int) -> tuple[str, str]:
    try:
        body = resp.body()
    except Exception as exc:
        return "", f"body_read_error:{exc}"
    if not body:
        return "", "empty_body"
    raw = body[:max_bytes]
    status = "ok"
    if len(body) > max_bytes:
        status = f"ok;truncated_from_{len(body)}"
    return raw.decode("utf-8", errors="replace"), status


def decode_payload_if_possible(text: str) -> tuple[Any | None, str]:
    if not text:
        return None, "empty"
    stripped = text.strip()
    try:
        return json.loads(stripped), "plain_json"
    except Exception:
        pass
    try:
        return decode_oddsportal_dat(stripped), "decoded_encrypted"
    except Exception as exc:
        return None, f"decode_failed:{exc}"


def flatten(obj: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            yield from flatten(v, key)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            key = f"{prefix}[{i}]" if prefix else f"[{i}]"
            yield from flatten(v, key)
    else:
        yield prefix, obj


def iter_dicts(obj: Any) -> Iterable[dict[str, Any]]:
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from iter_dicts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_dicts(v)


def split_player_pair(value: str) -> tuple[str, str]:
    text = clean_text(value)
    m = PLAYER_PAIR_RE.search(text)
    if not m:
        return "", ""
    return clean_text(m.group("p1")), clean_text(m.group("p2"))


def first_value_by_keys(flat: dict[str, Any], wanted: set[str]) -> str:
    for k, v in flat.items():
        if norm_key(k.split(".")[-1]) in wanted and v not in (None, ""):
            return clean_text(v)
    return ""


def get_any(row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in row and row.get(key) not in (None, ""):
            return row.get(key)
    return ""


def row_player_name(value: Any) -> str:
    if isinstance(value, dict):
        for k in ["name", "participantName", "shortName", "slug"]:
            if value.get(k):
                return clean_text(value.get(k))
        return clean_text(" ".join(str(v) for v in value.values() if isinstance(v, (str, int, float))))
    return clean_text(value)


def extract_events_from_archive_rows(decoded: Any, source_endpoint: str, results_url: str, landed_url: str) -> list[dict[str, Any]]:
    rows = None
    if isinstance(decoded, dict):
        d = decoded.get("d") if isinstance(decoded.get("d"), dict) else decoded
        for key in ["rows", "events", "matches", "data"]:
            if isinstance(d.get(key), list):
                rows = d.get(key)
                break
    if not isinstance(rows, list):
        return []

    out: list[dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        event_id = clean_text(get_any(item, ["id", "eventId", "event_id", "matchId", "match_id"]))
        encode_id = clean_text(get_any(item, ["encodeEventId", "encodedEventId", "eventHash", "hash", "eid"]))
        home = row_player_name(get_any(item, ["home-name", "homeName", "home", "participant1", "homeParticipant", "homeTeam", "player1", "competitor1"]))
        away = row_player_name(get_any(item, ["away-name", "awayName", "away", "participant2", "awayParticipant", "awayTeam", "player2", "competitor2"]))
        name = clean_text(get_any(item, ["name", "eventName", "matchName", "title"]))
        if (not home or not away) and name:
            p1, p2 = split_player_pair(name)
            home = home or p1
            away = away or p2
        if not name and home and away:
            name = f"{home} - {away}"
        if not home or not away:
            continue
        status = clean_text(get_any(item, ["status-name", "statusName", "status", "state"]))
        match_date = clean_text(get_any(item, ["date", "startTime", "start_time", "time", "timestamp", "datestart"]))
        raw_url = clean_text(get_any(item, ["url", "href", "link", "path", "slug"]))
        match_url = normalize_match_url(raw_url, landed_url) if raw_url else ""
        confidence = "high_archive_row" if event_id and encode_id else "medium_archive_row"
        out.append({
            "source_type": "decoded_archive_row",
            "source_endpoint": source_endpoint,
            "results_url": results_url,
            "landed_url": landed_url,
            "event_id": event_id,
            "event_hash": encode_id,
            "player1": home,
            "player2": away,
            "match_name": name,
            "match_date": match_date[:80],
            "status": status,
            "match_url": match_url,
            "confidence": confidence,
            "raw_text": clean_text(json.dumps(item, ensure_ascii=False))[:1000],
        })
    return out


def best_name_from_flat(flat: dict[str, Any]) -> str:
    for k, v in flat.items():
        if norm_key(k.split(".")[-1]) in NAME_KEYS:
            val = clean_text(v)
            if PLAYER_PAIR_RE.search(val):
                return val
    for v in flat.values():
        val = clean_text(v)
        if PLAYER_PAIR_RE.search(val):
            return val
    return ""


def best_url_from_flat(flat: dict[str, Any], base_url: str) -> str:
    for k, v in flat.items():
        if norm_key(k.split(".")[-1]) in URL_KEYS or "/tennis/" in clean_text(v):
            url = normalize_match_url(clean_text(v), base_url)
            if url:
                return url
    return ""


def extract_real_events_from_json_obj(data: Any, source_endpoint: str, results_url: str, landed_url: str) -> list[dict[str, Any]]:
    out = extract_events_from_archive_rows(data, source_endpoint, results_url, landed_url)
    if out:
        return out
    for obj in iter_dicts(data):
        flat = dict(flatten(obj))
        name = best_name_from_flat(flat)
        if not name:
            continue
        p1, p2 = split_player_pair(name)
        if not p1 or not p2:
            continue
        event_id = first_value_by_keys(flat, EVENT_ID_KEYS)
        match_date = first_value_by_keys(flat, DATE_KEYS)
        if not match_date:
            date_m = DATE_RE.search(" ".join(clean_text(v) for v in flat.values()))
            match_date = date_m.group(1) if date_m else ""
        match_url = best_url_from_flat(flat, landed_url)
        event_hash = extract_hash_from_url(match_url) if match_url else ""
        raw = clean_text(" ".join(str(v) for v in list(flat.values())[:80]))[:1000]
        confidence = "high_event_object" if event_id else "medium_event_object"
        out.append({
            "source_type": "json_event_object",
            "source_endpoint": source_endpoint,
            "results_url": results_url,
            "landed_url": landed_url,
            "event_id": event_id,
            "event_hash": event_hash,
            "player1": p1,
            "player2": p2,
            "match_name": f"{p1} - {p2}",
            "match_date": match_date[:80],
            "status": "",
            "match_url": match_url,
            "confidence": confidence,
            "raw_text": raw,
        })
    return out


def extract_real_events_from_text(text: str, source_endpoint: str, results_url: str, landed_url: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for m in PLAYER_PAIR_RE.finditer(text):
        p1 = clean_text(m.group("p1"))
        p2 = clean_text(m.group("p2"))
        if not p1 or not p2:
            continue
        chunk = clean_text(text[max(0, m.start() - 300): m.end() + 500])
        id_m = re.search(r'"(?:id|eventId|event_id|matchId|match_id)"\s*:\s*"?(\d{4,})"?', chunk, re.I)
        hash_m = re.search(r'"(?:encodeEventId|encodedEventId|eventHash|hash)"\s*:\s*"?([A-Za-z0-9]{7,12})"?', chunk, re.I)
        url_m = re.search(r'(/tennis/[^\s"\'<>]+)', chunk)
        date_m = DATE_RE.search(chunk)
        match_url = normalize_match_url(url_m.group(1), landed_url) if url_m else ""
        event_hash = hash_m.group(1) if hash_m and hash_m.group(1).lower() not in FAKE_HASH_WORDS else extract_hash_from_url(match_url)
        key = f"{p1}|{p2}|{id_m.group(1) if id_m else ''}|{event_hash}|{match_url}"
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "source_type": "text_event_pair",
            "source_endpoint": source_endpoint,
            "results_url": results_url,
            "landed_url": landed_url,
            "event_id": id_m.group(1) if id_m else "",
            "event_hash": event_hash,
            "player1": p1,
            "player2": p2,
            "match_name": f"{p1} - {p2}",
            "match_date": date_m.group(1) if date_m else "",
            "status": "",
            "match_url": match_url,
            "confidence": "medium_text_pair" if id_m or event_hash else "low_text_pair",
            "raw_text": chunk[:1000],
        })
    return out


def dedupe_events(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    priority = {"high_archive_row": 0, "medium_archive_row": 1, "high_event_object": 2, "medium_event_object": 3, "medium_text_pair": 4, "low_text_pair": 5}
    for row in sorted(rows, key=lambda r: priority.get(str(r.get("confidence")), 9)):
        event_id = str(row.get("event_id") or "")
        event_hash = str(row.get("event_hash") or "")
        match_url = str(row.get("match_url") or "")
        p1 = str(row.get("player1") or "")
        p2 = str(row.get("player2") or "")
        key = event_id or event_hash or match_url or f"{p1}|{p2}|{row.get('match_date','')}"
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def save_body(out_dir: Path, page_idx: int, resp_idx: int, url: str, text: str, suffix: str = "raw") -> str:
    h = hashlib.sha1(url.encode("utf-8", errors="ignore")).hexdigest()[:12]
    path = out_dir / "endpoint_bodies" / f"page_{page_idx:03d}_{resp_idx:03d}_{h}_{suffix}.txt"
    ensure_dir(path.parent)
    path.write_text(text[:2_000_000], encoding="utf-8", errors="replace")
    return str(path.relative_to(out_dir))


def goto_public(page: Page, url: str, wait_ms: int) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(wait_ms)


def scroll_and_click(page: Page, wait_ms: int) -> int:
    clicked = 0
    for _ in range(4):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(750, wait_ms // 3))
    labels = ["show more", "show more matches", "load more", "more matches", "next", "więcej", "wiecej"]
    for _ in range(12):
        try:
            did = bool(page.evaluate(
                """
                (labels) => {
                  const nodes = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                  const visible = (el) => { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
                  for (const el of nodes) {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (!txt || !visible(el)) continue;
                    if (labels.some(p => txt.includes(p))) { el.click(); return true; }
                  }
                  return false;
                }
                """,
                labels,
            ))
        except Exception:
            did = False
        if not did:
            break
        clicked += 1
        page.wait_for_timeout(wait_ms)
    return clicked


def probe_page(page: Page, results_url: str, out_dir: Path, wait_ms: int, max_body_bytes: int, page_idx: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    endpoint_rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    counter = {"n": 0}

    def on_response(resp: Response) -> None:
        if not should_capture(resp) or resp.url in seen_urls:
            return
        seen_urls.add(resp.url)
        counter["n"] += 1
        text, body_status = read_response_text(resp, max_body_bytes)
        raw_body_file = save_body(out_dir, page_idx, counter["n"], resp.url, text, "raw") if text else ""
        landed = page.url
        decoded, decode_status = decode_payload_if_possible(text)
        decoded_body_file = ""
        parsed: list[dict[str, Any]] = []
        if decoded is not None:
            decoded_text = json.dumps(decoded, ensure_ascii=False, indent=2)
            decoded_body_file = save_body(out_dir, page_idx, counter["n"], resp.url, decoded_text, "decoded")
            parsed.extend(extract_real_events_from_json_obj(decoded, resp.url, results_url, landed))
        if not parsed and text:
            parsed.extend(extract_real_events_from_text(text, resp.url, results_url, landed))
        events.extend(parsed)
        endpoint_rows.append({
            "results_url": results_url,
            "landed_url": landed,
            "endpoint_url": resp.url,
            "status": resp.status,
            "content_type": resp.headers.get("content-type") or "",
            "resource_type": resp.request.resource_type,
            "body_status": body_status,
            "decode_status": decode_status,
            "raw_body_file": raw_body_file,
            "decoded_body_file": decoded_body_file,
            "body_length": len(text),
            "parsed_real_events": len(parsed),
        })

    page.on("response", on_response)
    try:
        base.log(f"Archive event parser opening: {results_url}")
        goto_public(page, results_url, wait_ms)
        landed = page.url
        bad_landed = is_bad_landed_url(landed)
        clicked = 0 if bad_landed else scroll_and_click(page, wait_ms)
        try:
            doc = page.content()
            events.extend(extract_real_events_from_text(doc, "document_html", results_url, landed))
        except Exception:
            pass
        stats = {
            "results_url": results_url,
            "landed_url": landed,
            "bad_landed_url": str(bad_landed).lower(),
            "show_more_clicks": clicked,
            "captured_endpoint_count": len(endpoint_rows),
            "raw_event_count": len(events),
        }
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass
    return endpoint_rows, events, stats


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-urls-file", default="data/oddsportal_major_results_urls.txt")
    parser.add_argument("--out", default="artifacts/output/oddsportal-archive-event-parser-probe")
    parser.add_argument("--limit-pages", type=int, default=5)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--max-body-bytes", type=int, default=2000000)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    results_urls = base.read_urls_file(args.results_urls_file)
    if args.limit_pages and args.limit_pages > 0:
        results_urls = results_urls[: args.limit_pages]

    all_endpoint_rows: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    page_stats: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for idx, results_url in enumerate(results_urls, start=1):
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    endpoint_rows, events, stats = probe_page(page, results_url, out_dir, args.wait_ms, args.max_body_bytes, idx)
                except Exception as exc:
                    base.log(f"Archive event parser error on {results_url}: {exc}")
                    endpoint_rows, events, stats = [], [], {"results_url": results_url, "error": str(exc), "raw_event_count": 0}
                all_endpoint_rows.extend(endpoint_rows)
                all_events.extend(events)
                page_stats.append(stats)
        finally:
            context.close()
            browser.close()

    events = dedupe_events(all_events)
    high_conf = [r for r in events if str(r.get("confidence", "")).startswith("high") or str(r.get("confidence", "")).startswith("medium_archive") or str(r.get("confidence", "")).startswith("medium_event")]

    event_fields = ["source_type", "source_endpoint", "results_url", "landed_url", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "status", "match_url", "confidence", "raw_text"]
    endpoint_fields = ["results_url", "landed_url", "endpoint_url", "status", "content_type", "resource_type", "body_status", "decode_status", "raw_body_file", "decoded_body_file", "body_length", "parsed_real_events"]
    write_csv(out_dir / "parsed_real_events.csv", events, event_fields)
    write_csv(out_dir / "high_confidence_events.csv", high_conf, event_fields)
    write_csv(out_dir / "endpoint_parse_inventory.csv", all_endpoint_rows, endpoint_fields)
    write_csv(out_dir / "page_stats.csv", page_stats, ["results_url", "landed_url", "bad_landed_url", "show_more_clicks", "captured_endpoint_count", "raw_event_count", "error"])

    summary = {
        "generated_at": now_iso(),
        "public_discovery_context": True,
        "results_url_count": len(results_urls),
        "captured_endpoint_count": len(all_endpoint_rows),
        "parsed_real_event_count": len(events),
        "high_confidence_event_count": len(high_conf),
        "bad_landed_pages": sum(1 for s in page_stats if str(s.get("bad_landed_url")) == "true"),
        "decoded_endpoint_count": sum(1 for r in all_endpoint_rows if r.get("decode_status") == "decoded_encrypted"),
        "page_stats": page_stats,
        "recommendation": "If high_confidence_event_count is high, use these decoded archive rows as the match discovery layer. If match_url is missing but event_hash exists, build event_hash-to-match-page resolver next.",
    }
    (out_dir / "event_parser_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out_dir / "run_summary.json").write_text(json.dumps({**summary, "stop_reason": "ARCHIVE_EVENT_PARSER_COMPLETE", "args": vars(args)}, indent=2), encoding="utf-8")
    lines = [
        "# OddsPortal Archive Event Parser Probe",
        "",
        f"Generated: {summary['generated_at']}",
        "Mode: clean public browser context",
        f"Pages checked: {len(results_urls)}",
        f"Bad landed pages: {summary['bad_landed_pages']}",
        f"Captured endpoint responses: {summary['captured_endpoint_count']}",
        f"Decoded encrypted endpoints: {summary['decoded_endpoint_count']}",
        f"Parsed real events: {summary['parsed_real_event_count']}",
        f"High-confidence events: {summary['high_confidence_event_count']}",
        "",
        "## Page stats",
    ]
    for st in page_stats:
        lines.append(f"- `{st.get('results_url')}`")
        lines.append(f"  - landed: `{st.get('landed_url','')}` bad_landed={st.get('bad_landed_url','')}")
        lines.append(f"  - endpoints={st.get('captured_endpoint_count',0)} raw_events={st.get('raw_event_count',0)}")
    (out_dir / "event_parser_report.md").write_text("\n".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
