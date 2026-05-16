#!/usr/bin/env python3
"""
Stake live tennis first-set correct-score probe for SlipIQ.

Purpose:
- Query Stake's GraphQL endpoint directly for tennis sports events.
- Inventory event markets/outcomes.
- Find first-set correct-score style markets.
- Extract outcomes 3:6 / 4:6 / 5:7.
- Calculate Player 2 grouped 9-12 odds.
- Optionally match Stake events to recent Supabase SlipIQ signals by player names.

Read-only research. This script does not place bets.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import aiohttp

STAKE_GRAPHQL_URL = "https://stake.com/_api/graphql"
TARGET_SCORES = ["3:6", "4:6", "5:7"]
MARKET_KEYWORDS = [
    "1st set correct score",
    "first set correct score",
    "set 1 correct score",
    "1st set score",
    "first set score",
]

SPORTS_EVENTS_QUERY_FULL = """
query SportsEvents($first: Int, $sportSlug: String) {
  sportsEvents(first: $first, sportSlug: $sportSlug) {
    edges {
      node {
        id
        name
        startTime
        status
        live
        sport { name slug __typename }
        league { name slug __typename }
        competitors { name __typename }
        markets {
          id
          name
          status
          outcomes {
            id
            name
            odds
            status
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    pageInfo { hasNextPage endCursor __typename }
    __typename
  }
}
"""

SPORTS_EVENTS_QUERY_BASIC = """
query SportsEvents($first: Int, $sportSlug: String) {
  sportsEvents(first: $first, sportSlug: $sportSlug) {
    edges {
      node {
        id
        name
        startTime
        sport { name slug __typename }
        league { name slug __typename }
        competitors { name __typename }
        markets {
          name
          outcomes { name odds __typename }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", clean_text(value).lower()).strip()


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def safe_float(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except Exception:
        return None


def decimal_grouped(values: list[float | None]) -> float | None:
    if any(v is None or v <= 1 for v in values):
        return None
    inv = sum(1.0 / float(v) for v in values if v)
    if inv <= 0:
        return None
    return round(1.0 / inv, 6)


def canonical_score(value: Any) -> str:
    text = clean_text(value)
    text = text.replace("-", ":").replace(" ", "")
    m = re.search(r"(\d+)[:](\d+)", text)
    return f"{m.group(1)}:{m.group(2)}" if m else text


def market_matches(name: str) -> bool:
    n = norm(name)
    return any(k in n for k in MARKET_KEYWORDS)


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def stake_headers() -> dict[str, str]:
    ua = os.getenv("STAKE_USER_AGENT") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    headers = {
        "User-Agent": ua,
        "Accept": "application/graphql+json, application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        "Origin": "https://stake.com",
        "Referer": "https://stake.com/",
        "X-Language": "en",
    }
    token = os.getenv("STAKE_ACCESS_TOKEN") or ""
    if token:
        headers["X-Access-Token"] = token
    return headers


def stake_cookies() -> dict[str, str]:
    cookies: dict[str, str] = {}
    session_cookie = os.getenv("STAKE_SESSION_COOKIE") or ""
    cf_clearance = os.getenv("STAKE_CF_CLEARANCE") or ""
    if session_cookie:
        cookies["session"] = session_cookie
    if cf_clearance:
        cookies["cf_clearance"] = cf_clearance
    return cookies


async def graphql_request(session: aiohttp.ClientSession, query: str, variables: dict[str, Any], operation_name: str = "SportsEvents") -> dict[str, Any]:
    payload = {"query": query, "variables": variables, "operationName": operation_name}
    async with session.post(STAKE_GRAPHQL_URL, json=payload) as resp:
        text = await resp.text()
        try:
            data = json.loads(text)
        except Exception:
            raise RuntimeError(f"Stake GraphQL non-JSON response status={resp.status} body={text[:500]}")
        if resp.status >= 400:
            raise RuntimeError(f"Stake GraphQL HTTP {resp.status}: {json.dumps(data)[:800]}")
        if data.get("errors"):
            raise RuntimeError(f"Stake GraphQL errors: {json.dumps(data.get('errors'))[:1000]}")
        return data.get("data") or {}


async def fetch_stake_events(first: int, sport_slug: str) -> tuple[list[dict[str, Any]], str]:
    timeout = aiohttp.ClientTimeout(total=45)
    async with aiohttp.ClientSession(headers=stake_headers(), cookies=stake_cookies() or None, timeout=timeout) as session:
        variables = {"first": first, "sportSlug": sport_slug}
        try:
            data = await graphql_request(session, SPORTS_EVENTS_QUERY_FULL, variables)
            query_used = "full"
        except Exception as full_exc:
            data = await graphql_request(session, SPORTS_EVENTS_QUERY_BASIC, variables)
            query_used = f"basic_after_full_failed:{full_exc}"
    container = data.get("sportsEvents") or {}
    edges = container.get("edges") or []
    events = [e.get("node") for e in edges if isinstance(e, dict) and isinstance(e.get("node"), dict)]
    return events, query_used


def event_competitors(event: dict[str, Any]) -> tuple[str, str, str]:
    competitors = event.get("competitors") or []
    names = [clean_text(c.get("name")) for c in competitors if isinstance(c, dict) and clean_text(c.get("name"))]
    p1 = names[0] if len(names) > 0 else ""
    p2 = names[1] if len(names) > 1 else ""
    name = clean_text(event.get("name")) or (f"{p1} vs {p2}" if p1 and p2 else "")
    return p1, p2, name


def flatten_market_inventory(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for event in events:
        p1, p2, match_name = event_competitors(event)
        league = event.get("league") or {}
        sport = event.get("sport") or {}
        markets = event.get("markets") or []
        for market in markets if isinstance(markets, list) else []:
            if not isinstance(market, dict):
                continue
            outcomes = market.get("outcomes") or []
            rows.append({
                "stake_event_id": event.get("id", ""),
                "match_name": match_name,
                "player1": p1,
                "player2": p2,
                "start_time": event.get("startTime", ""),
                "status": event.get("status", ""),
                "live": event.get("live", ""),
                "sport_name": sport.get("name", "") if isinstance(sport, dict) else "",
                "sport_slug": sport.get("slug", "") if isinstance(sport, dict) else "",
                "league_name": league.get("name", "") if isinstance(league, dict) else "",
                "league_slug": league.get("slug", "") if isinstance(league, dict) else "",
                "market_id": market.get("id", ""),
                "market_name": market.get("name", ""),
                "market_status": market.get("status", ""),
                "outcome_count": len(outcomes) if isinstance(outcomes, list) else "",
                "target_market_candidate": bool_text(market_matches(market.get("name", ""))),
                "outcome_names_preview": " | ".join(clean_text(o.get("name")) for o in outcomes[:20] if isinstance(o, dict)),
            })
    return rows


def extract_v3_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for event in events:
        p1, p2, match_name = event_competitors(event)
        league = event.get("league") or {}
        sport = event.get("sport") or {}
        markets = event.get("markets") or []
        for market in markets if isinstance(markets, list) else []:
            if not isinstance(market, dict) or not market_matches(market.get("name", "")):
                continue
            outcomes = market.get("outcomes") or []
            odds_by_score: dict[str, dict[str, Any]] = {}
            for outcome in outcomes if isinstance(outcomes, list) else []:
                if not isinstance(outcome, dict):
                    continue
                score = canonical_score(outcome.get("name"))
                if score in TARGET_SCORES:
                    odds_by_score[score] = outcome
            values = [safe_float((odds_by_score.get(score) or {}).get("odds")) for score in TARGET_SCORES]
            grouped = decimal_grouped(values)
            out.append({
                "scraped_at": now_iso(),
                "stake_event_id": event.get("id", ""),
                "match_name": match_name,
                "player1": p1,
                "player2": p2,
                "start_time": event.get("startTime", ""),
                "status": event.get("status", ""),
                "live": event.get("live", ""),
                "sport_name": sport.get("name", "") if isinstance(sport, dict) else "",
                "sport_slug": sport.get("slug", "") if isinstance(sport, dict) else "",
                "league_name": league.get("name", "") if isinstance(league, dict) else "",
                "league_slug": league.get("slug", "") if isinstance(league, dict) else "",
                "market_id": market.get("id", ""),
                "market_name": market.get("name", ""),
                "market_status": market.get("status", ""),
                "outcome_3_6_id": (odds_by_score.get("3:6") or {}).get("id", ""),
                "outcome_4_6_id": (odds_by_score.get("4:6") or {}).get("id", ""),
                "outcome_5_7_id": (odds_by_score.get("5:7") or {}).get("id", ""),
                "stake_3_6_decimal": values[0] or "",
                "stake_4_6_decimal": values[1] or "",
                "stake_5_7_decimal": values[2] or "",
                "stake_grouped_9_12": grouped or "",
                "has_all_target_scores": bool_text(bool(grouped)),
            })
    return out


def supabase_headers() -> dict[str, str]:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or ""
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def supabase_ready() -> bool:
    return bool((os.getenv("SUPABASE_URL") or "").strip() and (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip())


def fetch_supabase_signals(limit: int, scanner_run_id: str = "") -> list[dict[str, Any]]:
    if not supabase_ready():
        return []
    base_url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    params = {
        "select": "id,created_at,scanner_run_id,match_name,player1,player2,reconstructed_p2_9_12_odds,verified_grouped_odds,candidate_bucket,signal_class,raw_payload",
        "order": "created_at.desc",
        "limit": str(limit),
    }
    if scanner_run_id:
        params["scanner_run_id"] = f"eq.{scanner_run_id}"
    url = f"{base_url}/rest/v1/private_v3_signal_log?{urlencode(params)}"
    req = Request(url, headers=supabase_headers(), method="GET")
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def name_tokens(name: str) -> set[str]:
    return {t for t in norm(name).split() if len(t) >= 2}


def match_score(signal: dict[str, Any], stake_row: dict[str, Any]) -> int:
    sig_p1 = clean_text(signal.get("player1"))
    sig_p2 = clean_text(signal.get("player2"))
    raw = signal.get("raw_payload") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    if not sig_p1 and isinstance(raw, dict):
        sig_p1 = clean_text(raw.get("player1"))
    if not sig_p2 and isinstance(raw, dict):
        sig_p2 = clean_text(raw.get("player2"))
    if not sig_p1 or not sig_p2:
        # Fall back to match_name token overlap.
        return len(name_tokens(signal.get("match_name", "")) & name_tokens(stake_row.get("match_name", "")))
    a = name_tokens(sig_p1)
    b = name_tokens(sig_p2)
    s1 = name_tokens(stake_row.get("player1", ""))
    s2 = name_tokens(stake_row.get("player2", ""))
    direct = len(a & s1) + len(b & s2)
    reverse = len(a & s2) + len(b & s1)
    return max(direct, reverse)


def match_stake_to_signals(stake_rows: list[dict[str, Any]], signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for sig in signals:
        best_row = None
        best_score = 0
        for row in stake_rows:
            score = match_score(sig, row)
            if score > best_score:
                best_score = score
                best_row = row
        if best_row:
            bet365_grouped = safe_float(sig.get("verified_grouped_odds") or sig.get("reconstructed_p2_9_12_odds"))
            stake_grouped = safe_float(best_row.get("stake_grouped_9_12"))
            diff = stake_grouped - bet365_grouped if stake_grouped and bet365_grouped else None
            pct = diff / bet365_grouped * 100.0 if diff is not None and bet365_grouped else None
            matches.append({
                "signal_id": sig.get("id", ""),
                "signal_match_name": sig.get("match_name", ""),
                "signal_player1": sig.get("player1", ""),
                "signal_player2": sig.get("player2", ""),
                "signal_bucket": sig.get("candidate_bucket", ""),
                "signal_class": sig.get("signal_class", ""),
                "bet365_grouped_9_12": bet365_grouped or "",
                "stake_event_id": best_row.get("stake_event_id", ""),
                "stake_match_name": best_row.get("match_name", ""),
                "stake_player1": best_row.get("player1", ""),
                "stake_player2": best_row.get("player2", ""),
                "stake_league_name": best_row.get("league_name", ""),
                "stake_market_id": best_row.get("market_id", ""),
                "stake_3_6_decimal": best_row.get("stake_3_6_decimal", ""),
                "stake_4_6_decimal": best_row.get("stake_4_6_decimal", ""),
                "stake_5_7_decimal": best_row.get("stake_5_7_decimal", ""),
                "stake_grouped_9_12": stake_grouped or "",
                "stake_vs_bet365_diff": round(diff, 6) if diff is not None else "",
                "stake_vs_bet365_pct": round(pct, 2) if pct is not None else "",
                "stake_better": bool_text(bool(diff is not None and diff > 0)),
                "match_score": best_score,
            })
    return matches


def market_inventory_fields() -> list[str]:
    return [
        "stake_event_id", "match_name", "player1", "player2", "start_time", "status", "live", "sport_name", "sport_slug",
        "league_name", "league_slug", "market_id", "market_name", "market_status", "outcome_count", "target_market_candidate", "outcome_names_preview",
    ]


def v3_fields() -> list[str]:
    return [
        "scraped_at", "stake_event_id", "match_name", "player1", "player2", "start_time", "status", "live", "sport_name", "sport_slug",
        "league_name", "league_slug", "market_id", "market_name", "market_status", "outcome_3_6_id", "outcome_4_6_id", "outcome_5_7_id",
        "stake_3_6_decimal", "stake_4_6_decimal", "stake_5_7_decimal", "stake_grouped_9_12", "has_all_target_scores",
    ]


def match_fields() -> list[str]:
    return [
        "signal_id", "signal_match_name", "signal_player1", "signal_player2", "signal_bucket", "signal_class", "bet365_grouped_9_12",
        "stake_event_id", "stake_match_name", "stake_player1", "stake_player2", "stake_league_name", "stake_market_id",
        "stake_3_6_decimal", "stake_4_6_decimal", "stake_5_7_decimal", "stake_grouped_9_12",
        "stake_vs_bet365_diff", "stake_vs_bet365_pct", "stake_better", "match_score",
    ]


async def async_main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="artifacts/output/stake-live-tennis-correct-score")
    parser.add_argument("--first", type=int, default=100)
    parser.add_argument("--sport-slug", default="tennis")
    parser.add_argument("--supabase-signal-limit", type=int, default=10)
    parser.add_argument("--scanner-run-id", default="")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "stake_access_token_present": bool(os.getenv("STAKE_ACCESS_TOKEN")),
        "stake_session_cookie_present": bool(os.getenv("STAKE_SESSION_COOKIE")),
        "stake_cf_clearance_present": bool(os.getenv("STAKE_CF_CLEARANCE")),
        "supabase_ready": supabase_ready(),
        "query_used": "",
        "events_returned": 0,
        "market_inventory_rows": 0,
        "target_market_rows": 0,
        "target_rows_with_all_scores": 0,
        "supabase_signals_loaded": 0,
        "signal_matches": 0,
        "stake_better_matches": 0,
        "stop_reason": "NOT_STARTED",
    }

    try:
        events, query_used = await fetch_stake_events(args.first, args.sport_slug)
        meta["query_used"] = query_used
    except Exception as exc:
        meta["stop_reason"] = f"STAKE_FETCH_FAILED:{exc}"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    inventory = flatten_market_inventory(events)
    v3_rows = extract_v3_rows(events)
    try:
        signals = fetch_supabase_signals(args.supabase_signal_limit, args.scanner_run_id)
    except Exception:
        signals = []
    matches = match_stake_to_signals([r for r in v3_rows if r.get("has_all_target_scores") == "true"], signals)

    write_csv(out_dir / "stake_live_market_inventory.csv", inventory, market_inventory_fields())
    write_csv(out_dir / "stake_first_set_correct_score_rows.csv", v3_rows, v3_fields())
    write_csv(out_dir / "stake_signal_matches.csv", matches, match_fields())
    (out_dir / "stake_events_raw.json").write_text(json.dumps(events, indent=2, default=str)[:10_000_000], encoding="utf-8")

    meta.update({
        "events_returned": len(events),
        "market_inventory_rows": len(inventory),
        "target_market_rows": len(v3_rows),
        "target_rows_with_all_scores": sum(1 for r in v3_rows if r.get("has_all_target_scores") == "true"),
        "supabase_signals_loaded": len(signals),
        "signal_matches": len(matches),
        "stake_better_matches": sum(1 for r in matches if r.get("stake_better") == "true"),
        "stop_reason": "STAKE_LIVE_TENNIS_PROBE_COMPLETE",
    })
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    report = [
        "# Stake Live Tennis Correct Score Probe",
        "",
        f"Generated: {meta['generated_at']}",
        f"Stake events returned: {len(events)}",
        f"Market inventory rows: {len(inventory)}",
        f"Target first-set correct-score rows: {len(v3_rows)}",
        f"Rows with all 3:6 / 4:6 / 5:7: {meta['target_rows_with_all_scores']}",
        f"Supabase signals loaded: {len(signals)}",
        f"Signal matches: {len(matches)}",
        f"Stake better matches: {meta['stake_better_matches']}",
        "",
        "## Stake grouped prices",
    ]
    for row in v3_rows[:50]:
        report.append(
            f"- {row.get('match_name')} | {row.get('league_name')} | {row.get('market_name')} | "
            f"3:6={row.get('stake_3_6_decimal') or '-'} 4:6={row.get('stake_4_6_decimal') or '-'} "
            f"5:7={row.get('stake_5_7_decimal') or '-'} grouped={row.get('stake_grouped_9_12') or '-'}"
        )
    report.extend(["", "## Signal matches"])
    for row in matches[:50]:
        report.append(
            f"- {row.get('signal_match_name')} -> {row.get('stake_match_name')} | "
            f"Stake={row.get('stake_grouped_9_12') or '-'} bet365={row.get('bet365_grouped_9_12') or '-'} "
            f"better={row.get('stake_better')} score={row.get('match_score')}"
        )
    (out_dir / "stake_live_tennis_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


def main() -> int:
    return asyncio.run(async_main())


if __name__ == "__main__":
    raise SystemExit(main())
