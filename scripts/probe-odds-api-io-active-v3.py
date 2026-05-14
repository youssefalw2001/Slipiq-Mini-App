#!/usr/bin/env python3
"""
SlipIQ Odds-API.io active tennis V3 probe.

Read-only. No sportsbook login. No bet placement.

This version avoids the first API page ordering problem by preferring live/pending
singles events instead of settled historical-looking rows.
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

try:
    from odds_api import OddsAPIClient
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"Could not import odds_api SDK: {exc}"}, indent=2))
    sys.exit(2)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj, default=str)
        return obj
    except Exception:
        return repr(obj)


def as_list(x: Any) -> list[Any]:
    if x is None:
        return []
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for key in ["data", "events", "results", "items", "odds", "bookmakers", "sports", "leagues"]:
            if isinstance(x.get(key), list):
                return x[key]
    return [x]


def lower_blob(obj: Any) -> str:
    return json.dumps(safe_json(obj), ensure_ascii=False, default=str).lower()


def pick_event_id(event: Any) -> str | None:
    if not isinstance(event, dict):
        return None
    for key in ["id", "event_id", "eventId", "key"]:
        if event.get(key) is not None:
            return str(event[key])
    return None


def event_title(event: Any) -> str:
    if not isinstance(event, dict):
        return str(event)[:200]
    for key in ["name", "title", "event_name", "eventName"]:
        if event.get(key):
            return str(event[key])
    home = event.get("home") or event.get("home_team") or event.get("player1") or event.get("participant1")
    away = event.get("away") or event.get("away_team") or event.get("player2") or event.get("participant2")
    if home or away:
        return f"{home or ''} vs {away or ''}".strip()
    return json.dumps(event, default=str)[:200]


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        s = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except Exception:
        return None


def is_probably_doubles(event: dict[str, Any]) -> bool:
    title = event_title(event).lower()
    league = lower_blob(event.get("league", {}))
    return " / " in title or " doubles" in league or "doubles" in title


def event_rank(event: dict[str, Any]) -> tuple[int, int, float, str]:
    status = str(event.get("status") or "").lower()
    dt = parse_dt(event.get("date") or event.get("start_time") or event.get("starts_at"))
    now = utc_now()
    if status == "live":
        status_rank = 0
    elif status in {"pending", "scheduled", "not_started"}:
        status_rank = 1
    elif status == "settled":
        status_rank = 3
    else:
        status_rank = 2
    doubles_penalty = 1 if is_probably_doubles(event) else 0
    if dt is None:
        time_score = 999999999.0
    else:
        # Prefer events from the last hour through the next 48 hours.
        seconds_from_now = (dt - now).total_seconds()
        if seconds_from_now < -3600:
            time_score = abs(seconds_from_now) + 500000
        else:
            time_score = abs(seconds_from_now)
    return (status_rank, doubles_penalty, time_score, event_title(event))


def market_name_from_obj(obj: Any) -> str:
    if not isinstance(obj, dict):
        return ""
    for key in ["market", "market_name", "marketName", "market_key", "marketKey", "name", "type", "label"]:
        if obj.get(key):
            return str(obj[key])
    return ""


def outcome_name_from_obj(obj: Any) -> str:
    if not isinstance(obj, dict):
        return str(obj)
    for key in ["outcome", "outcome_name", "outcomeName", "selection", "selection_name", "runner", "runner_name", "name", "label"]:
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
            next_path = f"{path}.{k}" if path else str(k)
            yield from traverse(v, next_path)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from traverse(v, f"{path}[{i}]")


def normalize_score_label(text: str) -> str:
    t = str(text).strip().lower().replace(" ", "").replace(":", "-")
    m = re.search(r"([0-7])-([0-7])", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return t


def looks_like_first_set_correct_score(text: str) -> bool:
    t = text.lower()
    return ("correct" in t and "score" in t and ("first" in t or "1st" in t or "set 1" in t or "set_1" in t or "p1" in t or "period 1" in t))


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
        norm = normalize_score_label(outcome)
        blob_dash = blob.replace(":", "-")
        found_market = looks_like_first_set_correct_score(blob) or looks_like_first_set_correct_score(path_l) or looks_like_first_set_correct_score(market)
        found_score = norm in {"3-6", "4-6", "5-7"} or any(s in blob_dash for s in ["3-6", "4-6", "5-7"])
        if found_market or found_score:
            rows.append({
                "event_id": event_id,
                "event_title": title,
                "path": path,
                "market_guess": market,
                "outcome_guess": outcome,
                "normalized_outcome": norm,
                "decimal_odds_guess": odds_from_obj(node),
                "found_market_hint": found_market,
                "found_v3_score_hint": found_score,
                "raw_node": node,
            })
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    key = os.getenv("ODDS_API_IO_KEY", "").strip()
    if not key:
        print("Missing ODDS_API_IO_KEY GitHub secret.", file=sys.stderr)
        return 2

    bookmakers = os.getenv("ODDS_API_IO_BOOKMAKERS", "Bet365,1xbet").strip()
    max_events = int(os.getenv("ODDS_API_IO_MAX_EVENTS", "12"))
    out_dir = Path(os.getenv("OUT_DIR", "artifacts/output/odds-api-io-active-v3-probe"))
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "generated_at": now_iso(),
        "ok": False,
        "bookmakers_requested": bookmakers,
        "max_events": max_events,
        "steps": [],
    }
    all_events: list[dict[str, Any]] = []
    all_v3_rows: list[dict[str, Any]] = []

    try:
        with OddsAPIClient(api_key=key) as client:
            sports = client.get_sports()
            (raw_dir / "sports.json").write_text(json.dumps(safe_json(sports), indent=2, default=str), encoding="utf-8")
            summary["steps"].append({"step": "get_sports", "ok": True})

            try:
                selected = client.get_selected_bookmakers()
                (raw_dir / "selected_bookmakers.json").write_text(json.dumps(safe_json(selected), indent=2, default=str), encoding="utf-8")
                summary["selected_bookmakers"] = safe_json(selected)
                summary["steps"].append({"step": "get_selected_bookmakers", "ok": True})
            except Exception as exc:
                summary["steps"].append({"step": "get_selected_bookmakers", "ok": False, "error": str(exc)})

            try:
                live_payload = client.get_live_events(sport="tennis")
                (raw_dir / "live_events.json").write_text(json.dumps(safe_json(live_payload), indent=2, default=str), encoding="utf-8")
                live_events = [e for e in as_list(live_payload) if isinstance(e, dict)]
                all_events.extend(live_events)
                summary["steps"].append({"step": "get_live_events", "ok": True, "count": len(live_events)})
            except Exception as exc:
                summary["steps"].append({"step": "get_live_events", "ok": False, "error": str(exc)})

            events_payload = client.get_events(sport="tennis")
            (raw_dir / "tennis_events.json").write_text(json.dumps(safe_json(events_payload), indent=2, default=str), encoding="utf-8")
            events = [e for e in as_list(events_payload) if isinstance(e, dict)]
            all_events.extend(events)
            summary["steps"].append({"step": "get_events", "ok": True, "count": len(events)})

            unique: dict[str, dict[str, Any]] = {}
            for event in all_events:
                eid = pick_event_id(event)
                if eid:
                    unique[eid] = event
            ranked = sorted(unique.values(), key=event_rank)
            selected_events = ranked[:max_events]

            candidate_rows = []
            for event in selected_events:
                candidate_rows.append({
                    "event_id": pick_event_id(event),
                    "title": event_title(event),
                    "status": event.get("status"),
                    "date": event.get("date") or event.get("start_time") or event.get("starts_at"),
                    "league": (event.get("league") or {}).get("name") if isinstance(event.get("league"), dict) else event.get("league"),
                    "rank": str(event_rank(event)),
                })
            write_csv(out_dir / "selected_events.csv", candidate_rows, ["event_id", "title", "status", "date", "league", "rank"])
            summary["selected_event_count"] = len(selected_events)
            summary["selected_events"] = candidate_rows

            odds_empty = 0
            odds_nonempty = 0
            for event in selected_events:
                eid = pick_event_id(event)
                if not eid:
                    continue
                title = event_title(event)
                try:
                    odds = client.get_event_odds(event_id=eid, bookmakers=bookmakers)
                    (raw_dir / f"event_odds_{eid}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                    bookmaker_obj = odds.get("bookmakers") if isinstance(odds, dict) else None
                    has_bookmakers = bool(bookmaker_obj)
                    if has_bookmakers:
                        odds_nonempty += 1
                    else:
                        odds_empty += 1
                    rows = extract_v3_rows(event, odds)
                    all_v3_rows.extend(rows)
                    summary["steps"].append({
                        "step": "get_event_odds",
                        "ok": True,
                        "event_id": eid,
                        "title": title,
                        "has_bookmakers": has_bookmakers,
                        "v3_hint_rows": len(rows),
                    })
                except Exception as exc:
                    summary["steps"].append({"step": "get_event_odds", "ok": False, "event_id": eid, "title": title, "error": str(exc)})

    except Exception as exc:
        summary["ok"] = False
        summary["error"] = str(exc)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
        return 1

    write_csv(out_dir / "v3_market_hints.csv", all_v3_rows, [
        "event_id", "event_title", "path", "market_guess", "outcome_guess",
        "normalized_outcome", "decimal_odds_guess", "found_market_hint", "found_v3_score_hint"
    ])
    (out_dir / "v3_market_hints.json").write_text(json.dumps(safe_json(all_v3_rows), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    summary["ok"] = True
    summary["v3_hint_rows"] = len(all_v3_rows)
    summary["contains_first_set_correct_score_hint"] = any(r.get("found_market_hint") for r in all_v3_rows)
    summary["contains_v3_score_hint"] = any(r.get("found_v3_score_hint") for r in all_v3_rows)
    summary["final_verdict"] = "POSSIBLE_V3_MARKET_FOUND" if (summary["contains_first_set_correct_score_hint"] or summary["contains_v3_score_hint"]) else "NO_V3_MARKET_FOUND_IN_TESTED_ACTIVE_EVENTS"
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
