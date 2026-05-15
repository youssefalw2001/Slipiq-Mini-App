#!/usr/bin/env python3
"""
SlipIQ OddsPortal archive/internal endpoint discovery probe.

Goal:
- Stop relying on visible page link scraping for match discovery.
- Use a clean public browser context.
- Open tournament results URLs.
- Capture OddsPortal XHR/fetch/document responses that look like archive/results/tournament/event feeds.
- Parse response bodies for event hashes, player-vs-player text, and match URLs.

This probe does NOT decode odds and does NOT run a backtest.
It only tries to create a clean event/match discovery dataset.

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
from urllib.parse import urljoin, urlparse, urldefrag

from playwright.sync_api import Page, Response, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_cookie_json_guarded import clear_oddsportal_route_memory

HASH_RE = re.compile(r"\b[A-Za-z0-9]{7,12}\b")
MATCH_PATH_RE = re.compile(r"/tennis/[^\s\"'<>]+?(?:-[A-Za-z0-9]{7,12})/?")
H2H_PATH_RE = re.compile(r"/tennis/h2h/[^\s\"'<>]+")
PLAYER_VS_RE = re.compile(
    r"(?P<p1>[A-Z][A-Za-zÀ-ž'.\-]+(?:\s+[A-Z][A-Za-zÀ-ž'.\-]+)*\s+[A-Z]\.?)\s*(?:-|–|v|vs)\s*(?P<p2>[A-Z][A-Za-zÀ-ž'.\-]+(?:\s+[A-Z][A-Za-zÀ-ž'.\-]+)*\s+[A-Z]\.?)"
)
DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.20\d{2}|\d{1,2}/\d{1,2}/20\d{2})\b")
SCORE_RE = re.compile(r"\b(?:[0-7]:[0-7]|[0-7]-[0-7])\b")

CAPTURE_PATH_PATTERNS = [
    "/ajax-sport-country-tournament-archive",
    "/ajax-sport-country-tournament",
    "/ajax-next-games",
    "/ajax-tournament",
    "/ajax-event",
    "/ajax-match",
    "/feed/",
    "/match-event/",
]
CAPTURE_URL_KEYWORDS = [
    "archive", "results", "tournament", "event", "match", "score", "tennis"
]
NOISY_PATH_PARTS = [
    "/build/assets/", "/country-flags/", "/logos/", "/fonts/",
    ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".ico",
]
NOISY_HOSTS = ["cookielaw.org", "googletagmanager.com", "google-analytics.com", "doubleclick.net"]
BAD_LANDED_PARTS = ["/bookmakers/", "/bookmakers"]
SENSITIVE_QUERY_KEYS = ["token", "apiKey", "apikey", "api_key", "key", "session", "auth", "password"]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: str) -> str:
    value = html.unescape(value or "")
    return re.sub(r"\s+", " ", value).strip()


def strip_hash(url: str) -> str:
    return urldefrag(url)[0].rstrip("/") + "/"


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


def is_bad_landed_url(url: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower().rstrip("/") + "/"
    return any(path.startswith(p.rstrip("/") + "/") for p in BAD_LANDED_PARTS) or "/tennis/" not in path or "/results/" not in path


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


def body_text(resp: Response, max_bytes: int) -> tuple[str, str]:
    try:
        body = resp.body()
    except Exception as exc:
        return "", f"body_read_error:{exc}"
    if body is None:
        return "", "empty_body"
    raw = body[:max_bytes]
    status = "ok"
    if len(body) > max_bytes:
        status = f"ok;truncated_from_{len(body)}"
    try:
        return raw.decode("utf-8", errors="replace"), status
    except Exception as exc:
        return "", f"decode_error:{exc}"


def flatten_json(obj: Any, prefix: str = "") -> Iterable[tuple[str, Any]]:
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            yield from flatten_json(v, key)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            key = f"{prefix}[{i}]" if prefix else f"[{i}]"
            yield from flatten_json(v, key)
    else:
        yield prefix, obj


def extract_hash_from_url(url: str) -> str:
    if "#" in url:
        h = url.split("#", 1)[1].split(":", 1)[0].split("?", 1)[0].strip("/")
        if HASH_RE.fullmatch(h):
            return h
    parsed = urlparse(url)
    last = parsed.path.strip("/").split("/")[-1]
    m = re.search(r"-([A-Za-z0-9]{7,12})$", last)
    return m.group(1) if m else ""


def normalize_match_url(path_or_url: str, base_url: str) -> str:
    absolute = urljoin(base_url, path_or_url)
    h = extract_hash_from_url(absolute)
    if h:
        return f"{strip_hash(absolute)}#{h}:cs;12"
    if "/tennis/h2h/" in urlparse(absolute).path:
        return f"{strip_hash(absolute)}#cs;12"
    return strip_hash(absolute)


def candidate_from_match_url(match_url: str, source: dict[str, Any], raw_text: str = "") -> dict[str, Any]:
    h = extract_hash_from_url(match_url)
    return {
        "source_type": source.get("source_type", "url_regex"),
        "source_endpoint": source.get("source_endpoint", ""),
        "results_url": source.get("results_url", ""),
        "landed_url": source.get("landed_url", ""),
        "event_hash": h,
        "player1": "",
        "player2": "",
        "match_date": "",
        "match_url": match_url,
        "confidence": "medium" if h else "low",
        "raw_text": clean_text(raw_text)[:500],
    }


def candidate_from_player_text(text: str, source: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for m in PLAYER_VS_RE.finditer(text):
        chunk = clean_text(text[max(0, m.start() - 120): m.end() + 120])
        date_m = DATE_RE.search(chunk)
        out.append({
            "source_type": source.get("source_type", "player_text_regex"),
            "source_endpoint": source.get("source_endpoint", ""),
            "results_url": source.get("results_url", ""),
            "landed_url": source.get("landed_url", ""),
            "event_hash": "",
            "player1": clean_text(m.group("p1")),
            "player2": clean_text(m.group("p2")),
            "match_date": date_m.group(1) if date_m else "",
            "match_url": "",
            "confidence": "low",
            "raw_text": chunk[:500],
        })
    return out


def extract_candidates_from_text(text: str, source: dict[str, Any], base_url: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for m in MATCH_PATH_RE.finditer(text):
        path = html.unescape(m.group(0)).split("#", 1)[0]
        match_url = normalize_match_url(path, base_url)
        key = f"url:{match_url}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        candidates.append(candidate_from_match_url(match_url, source, raw_text=path))
    for m in H2H_PATH_RE.finditer(text):
        path = html.unescape(m.group(0)).split("#", 1)[0]
        match_url = normalize_match_url(path, base_url)
        key = f"h2h:{match_url}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        candidates.append(candidate_from_match_url(match_url, {**source, "source_type": "h2h_regex"}, raw_text=path))
    # Player text is useful diagnostic but less reliable; include limited rows.
    for cand in candidate_from_player_text(text, {**source, "source_type": "player_text_regex"})[:200]:
        key = f"txt:{cand['player1']}:{cand['player2']}:{cand['match_date']}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        candidates.append(cand)
    return candidates


def extract_candidates_from_json(text: str, source: dict[str, Any], base_url: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(text)
    except Exception:
        return []
    candidates: list[dict[str, Any]] = []
    strings: list[str] = []
    # Record simple object-like rows when possible.
    if isinstance(data, list):
        objects = [x for x in data if isinstance(x, dict)]
    elif isinstance(data, dict):
        objects = [data]
        for _, v in flatten_json(data):
            if isinstance(v, dict):
                objects.append(v)
    else:
        objects = []
    for obj in objects[:1000]:
        flat = dict(flatten_json(obj))
        joined = " ".join(clean_text(str(v)) for v in flat.values() if isinstance(v, (str, int, float)))
        strings.append(joined)
        url_fields = [str(v) for k, v in flat.items() if isinstance(v, str) and "/tennis/" in v]
        hash_fields = [str(v) for k, v in flat.items() if isinstance(v, str) and HASH_RE.fullmatch(v)]
        p1 = next((str(v) for k, v in flat.items() if re.search(r"home|player1|participant1|competitor1|name1", k, re.I) and isinstance(v, str)), "")
        p2 = next((str(v) for k, v in flat.items() if re.search(r"away|player2|participant2|competitor2|name2", k, re.I) and isinstance(v, str)), "")
        date = next((str(v) for k, v in flat.items() if re.search(r"date|time|start", k, re.I) and isinstance(v, (str, int, float))), "")
        if url_fields or hash_fields or (p1 and p2):
            match_url = normalize_match_url(url_fields[0], base_url) if url_fields else ""
            event_hash = extract_hash_from_url(match_url) or (hash_fields[0] if hash_fields else "")
            candidates.append({
                "source_type": "json_object",
                "source_endpoint": source.get("source_endpoint", ""),
                "results_url": source.get("results_url", ""),
                "landed_url": source.get("landed_url", ""),
                "event_hash": event_hash,
                "player1": clean_text(p1),
                "player2": clean_text(p2),
                "match_date": clean_text(date)[:80],
                "match_url": match_url,
                "confidence": "high" if (event_hash and (p1 or p2 or match_url)) else "medium",
                "raw_text": joined[:500],
            })
    joined_all = "\n".join(strings)[:2_000_000]
    candidates.extend(extract_candidates_from_text(joined_all, {**source, "source_type": "json_text_regex"}, base_url))
    return candidates


def save_response_body(out_dir: Path, phase: str, idx: int, resp: Response, text: str) -> str:
    body_hash = hashlib.sha1(resp.url.encode("utf-8", errors="ignore")).hexdigest()[:12]
    ext = "json" if "json" in (resp.headers.get("content-type") or "").lower() else "txt"
    path = out_dir / "endpoint_bodies" / phase / f"{idx:04d}_{body_hash}.{ext}"
    ensure_dir(path.parent)
    path.write_text(text, encoding="utf-8", errors="replace")
    return str(path.relative_to(out_dir))


def goto_public(page: Page, url: str, wait_ms: int) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(wait_ms)


def scroll_and_wait(page: Page, wait_ms: int, rounds: int = 5) -> None:
    for _ in range(rounds):
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        except Exception:
            pass
        page.wait_for_timeout(max(800, wait_ms // 3))


def click_show_more(page: Page, wait_ms: int, max_clicks: int = 10) -> int:
    labels = ["show more", "show more matches", "load more", "more matches", "next", "więcej", "wiecej"]
    clicked = 0
    for _ in range(max_clicks):
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


def probe_results_url(page: Page, results_url: str, out_dir: Path, wait_ms: int, max_body_bytes: int, page_idx: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    endpoint_rows: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    seen_resp_urls: set[str] = set()
    response_counter = {"n": 0}

    def on_response(resp: Response) -> None:
        if not should_capture(resp):
            return
        if resp.url in seen_resp_urls:
            return
        seen_resp_urls.add(resp.url)
        response_counter["n"] += 1
        text, body_status = body_text(resp, max_body_bytes)
        body_file = save_response_body(out_dir, f"page_{page_idx:03d}", response_counter["n"], resp, text) if text else ""
        source = {"source_endpoint": redact_url(resp.url), "results_url": results_url, "landed_url": page.url, "source_type": "endpoint_body"}
        text_candidates = extract_candidates_from_text(text, source, page.url) if text else []
        json_candidates = extract_candidates_from_json(text, source, page.url) if text and "json" in (resp.headers.get("content-type") or "").lower() else []
        all_candidates = json_candidates + text_candidates
        candidates.extend(all_candidates)
        endpoint_rows.append({
            "results_url": results_url,
            "landed_url": page.url,
            "endpoint_url": redact_url(resp.url),
            "method": resp.request.method,
            "resource_type": resp.request.resource_type,
            "status": resp.status,
            "content_type": resp.headers.get("content-type") or "",
            "body_status": body_status,
            "body_file": body_file,
            "body_length": len(text),
            "candidate_count": len(all_candidates),
            "contains_archive": str("archive" in resp.url.lower()).lower(),
            "contains_match_event": str("/match-event/" in resp.url.lower()).lower(),
        })

    page.on("response", on_response)
    try:
        base.log(f"Archive endpoint discovery opening: {results_url}")
        goto_public(page, results_url, wait_ms)
        landed = page.url
        bad_landed = is_bad_landed_url(landed)
        if not bad_landed:
            scroll_and_wait(page, wait_ms, rounds=4)
            clicked = click_show_more(page, wait_ms, max_clicks=10)
            scroll_and_wait(page, wait_ms, rounds=3)
        else:
            clicked = 0
            base.log(f"BAD_LANDED_URL for archive endpoint probe: {results_url} -> {landed}")
        # Capture document/body as a last resort too.
        try:
            html_text = page.content()
            source = {"source_endpoint": "document_html", "results_url": results_url, "landed_url": landed, "source_type": "document_html"}
            candidates.extend(extract_candidates_from_text(html_text, source, landed))
            body_path = out_dir / "page_samples" / f"page_{page_idx:03d}_html.txt"
            ensure_dir(body_path.parent)
            body_path.write_text(html_text[:2_000_000], encoding="utf-8", errors="replace")
        except Exception:
            pass
        stats = {
            "results_url": results_url,
            "landed_url": landed,
            "bad_landed_url": str(bad_landed).lower(),
            "show_more_clicks": clicked,
            "captured_endpoint_count": len(endpoint_rows),
            "raw_candidate_count": len(candidates),
        }
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass
    return endpoint_rows, candidates, stats


def dedupe_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        event_hash = str(row.get("event_hash") or "")
        match_url = str(row.get("match_url") or "")
        p1 = str(row.get("player1") or "")
        p2 = str(row.get("player2") or "")
        key = event_hash or match_url or f"{p1}|{p2}|{row.get('match_date','')}|{row.get('source_endpoint','')}"
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


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
    parser.add_argument("--out", default="artifacts/output/oddsportal-archive-endpoint-discovery-probe")
    parser.add_argument("--limit-pages", type=int, default=5)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--max-body-bytes", type=int, default=1500000)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    results_urls = base.read_urls_file(args.results_urls_file)
    if args.limit_pages and args.limit_pages > 0:
        results_urls = results_urls[: args.limit_pages]

    all_endpoint_rows: list[dict[str, Any]] = []
    all_candidates: list[dict[str, Any]] = []
    page_stats: list[dict[str, Any]] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = browser.new_context(locale="en-US", timezone_id="UTC")
        page = context.new_page()
        try:
            for idx, results_url in enumerate(results_urls, start=1):
                clear_oddsportal_route_memory(context, page, args.wait_ms)
                try:
                    endpoint_rows, candidates, stats = probe_results_url(page, results_url, out_dir, args.wait_ms, args.max_body_bytes, idx)
                except Exception as exc:
                    base.log(f"Archive endpoint probe error on {results_url}: {exc}")
                    endpoint_rows, candidates, stats = [], [], {"results_url": results_url, "error": str(exc), "bad_landed_url": "unknown"}
                all_endpoint_rows.extend(endpoint_rows)
                all_candidates.extend(candidates)
                page_stats.append(stats)
        finally:
            context.close()
            browser.close()

    candidates = dedupe_candidates(all_candidates)
    # Prefer candidates with event hash or URL for decoded workflow.
    usable = [r for r in candidates if r.get("event_hash") or r.get("match_url")]

    endpoint_fields = ["results_url", "landed_url", "endpoint_url", "method", "resource_type", "status", "content_type", "body_status", "body_file", "body_length", "candidate_count", "contains_archive", "contains_match_event"]
    cand_fields = ["source_type", "source_endpoint", "results_url", "landed_url", "event_hash", "player1", "player2", "match_date", "match_url", "confidence", "raw_text"]
    write_csv(out_dir / "archive_endpoint_candidates.csv", all_endpoint_rows, endpoint_fields)
    write_csv(out_dir / "parsed_event_candidates.csv", candidates, cand_fields)
    write_csv(out_dir / "usable_match_candidates.csv", usable, cand_fields)
    write_csv(out_dir / "page_stats.csv", page_stats, ["results_url", "landed_url", "bad_landed_url", "show_more_clicks", "captured_endpoint_count", "raw_candidate_count", "error"])

    summary = {
        "generated_at": now_iso(),
        "public_discovery_context": True,
        "results_url_count": len(results_urls),
        "captured_endpoint_count": len(all_endpoint_rows),
        "parsed_candidate_count": len(candidates),
        "usable_candidate_count": len(usable),
        "bad_landed_pages": sum(1 for s in page_stats if str(s.get("bad_landed_url")) == "true"),
        "page_stats": page_stats,
        "recommendation": "If usable_candidate_count is high, use usable_match_candidates.csv as the discovery source for the decoded scraper. If low and endpoints were captured, inspect endpoint_bodies files named in archive_endpoint_candidates.csv.",
    }
    (out_dir / "archive_discovery_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out_dir / "run_summary.json").write_text(json.dumps({**summary, "stop_reason": "ARCHIVE_ENDPOINT_DISCOVERY_COMPLETE", "args": vars(args)}, indent=2), encoding="utf-8")

    lines = [
        "# OddsPortal Archive Endpoint Discovery Probe",
        "",
        f"Generated: {summary['generated_at']}",
        "Mode: clean public browser context",
        f"Pages checked: {len(results_urls)}",
        f"Bad landed pages: {summary['bad_landed_pages']}",
        f"Captured endpoint responses: {summary['captured_endpoint_count']}",
        f"Parsed candidates: {summary['parsed_candidate_count']}",
        f"Usable candidates: {summary['usable_candidate_count']}",
        "",
        "## Page stats",
    ]
    for st in page_stats:
        lines.append(f"- `{st.get('results_url')}`")
        lines.append(f"  - landed: `{st.get('landed_url','')}` bad_landed={st.get('bad_landed_url','')}")
        lines.append(f"  - endpoints={st.get('captured_endpoint_count',0)} raw_candidates={st.get('raw_candidate_count',0)}")
    (out_dir / "archive_discovery_report.md").write_text("\n".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
