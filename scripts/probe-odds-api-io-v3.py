#!/usr/bin/env python3
"""
SlipIQ Odds-API.io V3 market probe.

Read-only. No sportsbook login. No bet placement.

Goal:
- Verify Odds-API.io key works.
- Discover tennis sport/leagues/events.
- Pull odds for a small number of events.
- Detect whether any odds payload contains first-set correct-score markets.
- Detect exact SlipIQ V3 outcomes: 3:6 / 4:6 / 5:7 or equivalent formats.

Requires env:
  ODDS_API_IO_KEY

Optional env:
  ODDS_API_IO_BOOKMAKERS=bet365,1xbet
  ODDS_API_IO_MAX_EVENTS=5
  ODDS_API_IO_SEARCH_QUERY=tennis
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

try:
    from odds_api import OddsAPIClient
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"Could not import odds_api SDK: {exc}"}, indent=2))
    sys.exit(2)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj)
        return obj
    except Exception:
        return repr(obj)


def as_list(x: Any) -> list[Any]:
    if x is None:
        return []
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for key in ["data", "sports", "leagues", "events", "results", "items", "bookmakers", "odds"]:
            if isinstance(x.get(key), list):
                return x[key]
    return [x]


def lower_blob(obj: Any) -> str:
    return json.dumps(safe_json(obj), ensure_ascii=False, default=str).lower()


def pick_tennis_sport(sports: Any) -> str:
    rows = as_list(sports)
    for row in rows:
        blob = lower_blob(row)
        if "tennis" in blob:
            if isinstance(row, dict):
                for key in ["key", "slug", "id", "sport", "name"]:
                    val = row.get(key)
                    if val and "tennis" in str(val).lower():
                        return str(val)
                for key in ["key", "slug", "id", "sport"]:
                    val = row.get(key)
                    if val:
                        return str(val)
            return "tennis"
    return "tennis"


def pick_event_id(event: Any) -> str | None:
    if not isinstance(event, dict):
        return None
    for key in ["id", "event_id", "eventId", "key"]:
        if event.get(key):
            return str(event[key])
    return None


def event_title(event: Any) -> str:
    if not isinstance(event, dict):
        return str(event)[:200]
    for key in ["name", "title", "event_name", "eventName"]:
        if event.get(key):
            return str(event[key])
    parts = []
    for key in ["home", "away", "home_team", "away_team", "participant1", "participant2", "player1", "player2"]:
        if event.get(key):
            parts.append(str(event[key]))
    return " vs ".join(parts) if parts else json.dumps(event, default=str)[:200]


def market_name_from_obj(obj: Any) -> str:
    if not isinstance(obj, dict):
        return ""
    for key in ["market", "market_name", "marketName", "market_key", "marketKey", "name", "type"]:
        if obj.get(key):
            return str(obj[key])
    return ""


def outcome_name_from_obj(obj: Any) -> str:
    if not isinstance(obj, dict):
        return str(obj)
    for key in ["outcome", "outcome_name", "outcomeName", "label", "name", "selection", "selection_name", "runner", "runner_name"]:
        if obj.get(key):
            return str(obj[key])
    return ""


def odds_from_obj(obj: Any) -> float | None:
    if not isinstance(obj, dict):
        return None
    for key in ["odds", "price", "decimal", "decimal_odds", "decimalOdds", "value"]:
        val = obj.get(key)
        if val is None:
            continue
        try:
            num = float(val)
            if 1.01 <= num <= 1000:
                return num
        except Exception:
            pass
    return None


def traverse(obj: Any, path: str = ""):
    yield path, obj
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from traverse(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from traverse(v, f"{path}[{i}]")


def looks_like_first_set_correct_score_market(text: str) -> bool:
    t = text.lower()
    has_score = "correct" in t and "score" in t
    has_set = "1st" in t or "first" in t or "set 1" in t or "set_1" in t or "period 1" in t
    return has_score and has_set


def normalize_score_label(text: str) -> str:
    t = text.strip().lower()
    t = t.replace(" ", "")
    t = t.replace(":", "-")
    m = re.search(r"([0-7])-([0-7])", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return t


def extract_v3_rows(event: dict[str, Any], odds_payload: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    event_id = pick_event_id(event) or ""
    title = event_title(event)

    for path, node in traverse(odds_payload):
        if not isinstance(node, dict):
            continue
        blob = lower_blob(node)
        path_l = path.lower()
        market = market_name_from_obj(node)
        outcome = outcome_name_from_obj(node)
        norm_outcome = normalize_score_label(outcome)
        found_market = looks_like_first_set_correct_score_market(blob) or looks_like_first_set_correct_score_market(path_l) or looks_like_first_set_correct_score_market(market)
        found_score = norm_outcome in {"3-6", "4-6", "5-7"} or any(x in blob.replace(":", "-") for x in ["3-6", "4-6", "5-7"])
        odd = odds_from_obj(node)
        if found_market or found_score:
            rows.append(
                {
                    "event_id": event_id,
                    "event_title": title,
                    "path": path,
                    "market_guess": market,
                    "outcome_guess": outcome,
                    "normalized_outcome": norm_outcome,
                    "decimal_odds_guess": odd,
                    "found_market_hint": found_market,
                    "found_v3_score_hint": found_score,
                    "raw_node": node,
                }
            )
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "event_id",
        "event_title",
        "path",
        "market_guess",
        "outcome_guess",
        "normalized_outcome",
        "decimal_odds_guess",
        "found_market_hint",
        "found_v3_score_hint",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    api_key = os.getenv("ODDS_API_IO_KEY", "").strip()
    if not api_key:
        print("Missing ODDS_API_IO_KEY GitHub secret.", file=sys.stderr)
        return 2

    out_dir = Path(os.getenv("OUT_DIR", "artifacts/output/odds-api-io-v3-probe"))
    out_dir.mkdir(parents=True, exist_ok=True)

    bookmakers = os.getenv("ODDS_API_IO_BOOKMAKERS", "bet365,1xbet").strip()
    max_events = int(os.getenv("ODDS_API_IO_MAX_EVENTS", "5"))
    search_query = os.getenv("ODDS_API_IO_SEARCH_QUERY", "tennis").strip()

    summary: dict[str, Any] = {
        "generated_at": now_iso(),
        "ok": False,
        "bookmakers_requested": bookmakers,
        "max_events": max_events,
        "search_query": search_query,
        "steps": [],
    }

    raw_dir = out_dir / "raw"
    raw_dir.mkdir(exist_ok=True)
    all_v3_rows: list[dict[str, Any]] = []

    try:
        with OddsAPIClient(api_key=api_key) as client:
            sports = client.get_sports()
            (raw_dir / "sports.json").write_text(json.dumps(safe_json(sports), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            tennis_sport = pick_tennis_sport(sports)
            summary["tennis_sport_guess"] = tennis_sport
            summary["steps"].append({"step": "get_sports", "ok": True, "tennis_sport_guess": tennis_sport})

            try:
                bookmakers_payload = client.get_bookmakers()
                (raw_dir / "bookmakers.json").write_text(json.dumps(safe_json(bookmakers_payload), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                summary["steps"].append({"step": "get_bookmakers", "ok": True})
            except Exception as exc:
                summary["steps"].append({"step": "get_bookmakers", "ok": False, "error": str(exc)})

            try:
                leagues = client.get_leagues(tennis_sport)
                (raw_dir / "tennis_leagues.json").write_text(json.dumps(safe_json(leagues), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                summary["steps"].append({"step": "get_leagues", "ok": True})
            except Exception as exc:
                summary["steps"].append({"step": "get_leagues", "ok": False, "error": str(exc)})

            events_payload = None
            events: list[Any] = []
            try:
                events_payload = client.get_events(sport=tennis_sport)
                (raw_dir / "tennis_events.json").write_text(json.dumps(safe_json(events_payload), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                events = as_list(events_payload)
                summary["steps"].append({"step": "get_events", "ok": True, "count": len(events)})
            except Exception as exc:
                summary["steps"].append({"step": "get_events", "ok": False, "error": str(exc)})

            if not events:
                try:
                    search_payload = client.search_events(query=search_query)
                    (raw_dir / "search_events.json").write_text(json.dumps(safe_json(search_payload), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                    events = as_list(search_payload)
                    summary["steps"].append({"step": "search_events", "ok": True, "count": len(events)})
                except Exception as exc:
                    summary["steps"].append({"step": "search_events", "ok": False, "error": str(exc)})

            event_summaries = []
            for event in events[:max_events]:
                event_id = pick_event_id(event)
                title = event_title(event)
                event_summaries.append({"event_id": event_id, "title": title})
                if not event_id:
                    continue
                try:
                    odds = client.get_event_odds(event_id=event_id, bookmakers=bookmakers)
                    (raw_dir / f"event_odds_{event_id}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                    rows = extract_v3_rows(event if isinstance(event, dict) else {"id": event_id, "name": title}, odds)
                    all_v3_rows.extend(rows)
                    summary["steps"].append({"step": "get_event_odds", "ok": True, "event_id": event_id, "title": title, "v3_hint_rows": len(rows)})
                except Exception as exc:
                    summary["steps"].append({"step": "get_event_odds", "ok": False, "event_id": event_id, "title": title, "error": str(exc)})

            summary["event_summaries"] = event_summaries

    except Exception as exc:
        summary["ok"] = False
        summary["error"] = str(exc)
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        return 1

    write_csv(out_dir / "v3_market_hints.csv", all_v3_rows)
    (out_dir / "v3_market_hints.json").write_text(json.dumps(safe_json(all_v3_rows), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    summary["ok"] = True
    summary["v3_hint_rows"] = len(all_v3_rows)
    summary["contains_first_set_correct_score_hint"] = any(r.get("found_market_hint") for r in all_v3_rows)
    summary["contains_v3_score_hint"] = any(r.get("found_v3_score_hint") for r in all_v3_rows)
    summary["final_verdict"] = (
        "POSSIBLE_V3_MARKET_FOUND" if summary["contains_first_set_correct_score_hint"] or summary["contains_v3_score_hint"] else "NO_V3_MARKET_FOUND_IN_TESTED_EVENTS"
    )
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
