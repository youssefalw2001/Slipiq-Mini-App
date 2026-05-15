#!/usr/bin/env python3
"""
SlipIQ OddsPapi Market Inventory

Read-only. No sportsbook login. No bet placement.

Purpose:
- Pull a small free-trial-safe sample of OddsPapi tennis pre-game odds.
- Inventory every market/outcome returned by bookmaker.
- Identify which markets can feed the synthetic V3 model.

Important OddsPapi shape:
bookmakerOdds.bet365.markets is a dict keyed by marketId, and outcomes/players are dicts too.
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import requests


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj, default=str)
        return obj
    except Exception:
        return repr(obj)


def redact(text: str, key: str) -> str:
    return text.replace(key, "***REDACTED***") if key else text


def as_list(obj: Any) -> list[Any]:
    if obj is None:
        return []
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in ["data", "markets", "fixtures", "odds", "results", "items", "response", "tournaments", "outcomes"]:
            if isinstance(obj.get(k), list):
                return obj[k]
    return [obj]


def as_items(obj: Any):
    if obj is None:
        return []
    if isinstance(obj, dict):
        return list(obj.items())
    if isinstance(obj, list):
        return [(str(i), v) for i, v in enumerate(obj)]
    return []


def lower_blob(obj: Any) -> str:
    return json.dumps(safe_json(obj), ensure_ascii=False, default=str).lower()


def request_json(base_url: str, path: str, key: str, params: dict[str, Any] | None = None, timeout: int = 30, allow_404: bool = False) -> tuple[Any | None, dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    q = dict(params or {})
    q["apiKey"] = key
    last_info: dict[str, Any] | None = None
    for attempt in range(2):
        resp = requests.get(url, headers={"Accept": "application/json"}, params=q, timeout=timeout)
        info = {"url": redact(resp.url, key), "status_code": resp.status_code, "content_type": resp.headers.get("content-type"), "attempt": attempt + 1}
        last_info = info
        if resp.status_code == 429 and attempt == 0:
            wait_s = 2.0
            try:
                retry_ms = resp.json().get("error", {}).get("retryMs")
                if retry_ms is not None:
                    wait_s = max(1.0, float(retry_ms) / 1000.0 + 0.6)
            except Exception:
                pass
            time.sleep(wait_s)
            continue
        if resp.status_code == 404 and allow_404:
            return None, {**info, "not_found": True, "body_preview": redact(resp.text[:500], key)}
        if resp.status_code >= 400:
            raise RuntimeError(json.dumps({**info, "body_preview": redact(resp.text[:1500], key)}, indent=2))
        try:
            return resp.json(), info
        except Exception:
            return {"raw_text": resp.text[:5000]}, info
    raise RuntimeError(json.dumps({**(last_info or {}), "body_preview": "request failed"}, indent=2))


def fixture_count_score(t: dict[str, Any]) -> int:
    total = 0
    for k in ["liveFixtures", "upcomingFixtures", "futureFixtures"]:
        try:
            total += int(t.get(k) or 0)
        except Exception:
            pass
    return total


def tournament_sort_key(t: dict[str, Any]) -> tuple[int, str]:
    live = int(t.get("liveFixtures") or 0)
    upcoming = int(t.get("upcomingFixtures") or 0)
    future = int(t.get("futureFixtures") or 0)
    return (-(live * 100000 + upcoming * 1000 + future), str(t.get("tournamentName") or ""))


def get_value(d: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in d and d[key] is not None:
            return d[key]
    return None


def classify_market(market_id: str, text: str) -> str:
    t = f"{market_id} {text}".lower()
    # Known tennis market IDs observed in Oddspapi/RapidAPI testing.
    if str(market_id) == "121":
        return "moneyline"
    if str(market_id) == "123":
        return "handicap_spread"
    if str(market_id) in {"1237", "1238", "1241", "1242", "1225", "1226"}:
        return "total_or_handicap_unknown_line"
    if str(market_id) == "12404":
        return "exact_first_set_correct_score"
    if "correct" in t and "score" in t and ("first" in t or "1st" in t or "set 1" in t or "period 1" in t or "p1" in t):
        return "exact_first_set_correct_score"
    if "correct" in t and "score" in t:
        return "correct_score_other"
    if ("first" in t or "1st" in t or "set 1" in t or "period 1" in t or "p1" in t) and ("winner" in t or "moneyline" in t or "ml" in t):
        return "first_set_winner"
    if ("first" in t or "1st" in t or "set 1" in t or "period 1" in t or "p1" in t) and ("total" in t or "over" in t or "under" in t):
        return "first_set_total"
    if "total" in t and ("game" in t or "games" in t):
        return "game_total"
    if "total" in t or "over" in t or "under" in t:
        return "total"
    if "handicap" in t or "spread" in t:
        return "handicap_spread"
    if "moneyline" in t or "winner" in t or t.strip() in {"ml", "121"}:
        return "moneyline"
    return "unknown"


def score_hint(text: str) -> str:
    blob = text.replace(":", "-")
    for score in ["3-6", "4-6", "5-7"]:
        if score in blob:
            return score
    return ""


def extract_market_rows(payload: Any, bookmaker: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for fixture_index, fixture in enumerate(as_list(payload)):
        if not isinstance(fixture, dict):
            continue
        fixture_id = get_value(fixture, ["fixtureId", "id"])
        tournament_id = get_value(fixture, ["tournamentId"])
        start_time = get_value(fixture, ["startTime", "trueStartTime"])
        status_id = get_value(fixture, ["statusId", "status"])
        fixture_name = get_value(fixture, ["fixtureName", "eventName", "name", "title"])
        bookmaker_odds = fixture.get("bookmakerOdds") if isinstance(fixture.get("bookmakerOdds"), dict) else {}
        book_obj = bookmaker_odds.get(bookmaker) or bookmaker_odds.get(bookmaker.lower()) or bookmaker_odds.get(bookmaker.upper())
        if not isinstance(book_obj, dict):
            continue
        fixture_path = get_value(book_obj, ["fixturePath", "bookmakerFixturePath", "url"])
        markets_obj = book_obj.get("markets")
        for market_index, (market_id_key, market) in enumerate(as_items(markets_obj)):
            if not isinstance(market, dict):
                continue
            market_id = str(get_value(market, ["marketId", "id", "key"]) or market_id_key)
            market_name = get_value(market, ["marketName", "name", "label", "type", "marketType"]) or market_id
            market_blob = lower_blob(market)
            market_class = classify_market(market_id, str(market_name) + " " + market_blob)
            outcomes_obj = market.get("outcomes")
            for outcome_id_key, outcome in as_items(outcomes_obj):
                if not isinstance(outcome, dict):
                    continue
                outcome_id = str(get_value(outcome, ["outcomeId", "id", "key"]) or outcome_id_key)
                outcome_name = get_value(outcome, ["outcomeName", "name", "label", "selection", "participantName"])
                players_obj = outcome.get("players")
                player_items = as_items(players_obj) or [("", outcome)]
                for player_key, player in player_items:
                    if not isinstance(player, dict):
                        continue
                    line = get_value(player, ["line", "handicap", "points", "total"])
                    price = get_value(player, ["price", "odds", "decimal", "decimalOdds", "value"])
                    american = get_value(player, ["priceAmerican", "american", "americanOdds"])
                    changed_at = get_value(player, ["changedAt", "updatedAt", "bookmakerChangedAt"])
                    active = get_value(player, ["active"])
                    main_line = get_value(player, ["mainLine"])
                    full_text = f"{market_name} {outcome_name} {line} {market_blob} {lower_blob(outcome)} {lower_blob(player)}"
                    rows.append({
                        "fixture_index": fixture_index,
                        "fixture_id": fixture_id,
                        "fixture_name": fixture_name,
                        "tournament_id": tournament_id,
                        "start_time": start_time,
                        "status_id": status_id,
                        "bookmaker": bookmaker,
                        "fixture_path": fixture_path,
                        "market_index": market_index,
                        "market_id": market_id,
                        "market_name": market_name,
                        "market_class": market_class,
                        "outcome_id": outcome_id,
                        "outcome_name": outcome_name,
                        "player_key": player_key,
                        "line": line,
                        "price": price,
                        "price_american": american,
                        "active": active,
                        "main_line": main_line,
                        "changed_at": changed_at,
                        "v3_score_hint": score_hint(full_text),
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
    key = os.getenv("ODDSPAPI_KEY", "").strip()
    if not key:
        print("Missing ODDSPAPI_KEY GitHub secret.", file=sys.stderr)
        return 2
    base_url = os.getenv("ODDSPAPI_BASE_URL", "https://api.oddspapi.io").strip()
    bookmaker = os.getenv("ODDSPAPI_BOOKMAKER", "bet365").strip()
    sport_id = os.getenv("ODDSPAPI_SPORT_ID", "12").strip()
    max_chunks = int(os.getenv("ODDSPAPI_MAX_CHUNKS", "4"))
    chunk_size = int(os.getenv("ODDSPAPI_CHUNK_SIZE", "3"))
    out_dir = Path(os.getenv("OUT_DIR", "artifacts/output/oddspapi-market-inventory"))
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {"generated_at": now_iso(), "ok": False, "base_url": base_url, "bookmaker": bookmaker, "sport_id": sport_id, "max_chunks": max_chunks, "chunk_size": chunk_size, "steps": []}
    try:
        tournaments, tinfo = request_json(base_url, "/v4/tournaments", key, params={"sportId": sport_id})
        (raw_dir / "tournaments.json").write_text(json.dumps(safe_json(tournaments), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tournament_rows = [x for x in as_list(tournaments) if isinstance(x, dict)]
        active_rows = sorted([x for x in tournament_rows if fixture_count_score(x) > 0], key=tournament_sort_key)
        selected = active_rows[: max_chunks * chunk_size]
        selected_rows = [{"tournamentId": x.get("tournamentId"), "tournamentName": x.get("tournamentName"), "categoryName": x.get("categoryName"), "liveFixtures": x.get("liveFixtures"), "upcomingFixtures": x.get("upcomingFixtures"), "futureFixtures": x.get("futureFixtures")} for x in selected]
        write_csv(out_dir / "selected_tournaments.csv", selected_rows, ["tournamentId", "tournamentName", "categoryName", "liveFixtures", "upcomingFixtures", "futureFixtures"])
        summary["steps"].append({"step": "tournaments", "ok": True, "status_code": tinfo["status_code"], "total": len(tournament_rows), "active": len(active_rows), "selected": len(selected)})

        all_market_rows: list[dict[str, Any]] = []
        chunk_summaries: list[dict[str, Any]] = []
        ids = [str(x.get("tournamentId")) for x in selected if x.get("tournamentId") is not None]
        for chunk_index, start in enumerate(range(0, len(ids), chunk_size), start=1):
            if chunk_index > max_chunks:
                break
            chunk = ids[start : start + chunk_size]
            params = {"bookmaker": bookmaker, "tournamentIds": ",".join(chunk), "oddsFormat": "decimal"}
            odds, info = request_json(base_url, "/v4/odds-by-tournaments", key, params=params, allow_404=True)
            time.sleep(1.2)
            chunk_summary = {"chunk_index": chunk_index, "tournament_ids": chunk, "status_code": info.get("status_code"), "not_found": bool(info.get("not_found"))}
            if odds is None:
                chunk_summaries.append(chunk_summary)
                continue
            (raw_dir / f"odds_by_tournaments_{chunk_index}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            rows = extract_market_rows(odds, bookmaker)
            all_market_rows.extend(rows)
            chunk_summary["fixture_count"] = len(as_list(odds))
            chunk_summary["market_rows"] = len(rows)
            chunk_summary["unique_market_ids"] = len({str(r.get("market_id")) for r in rows if r.get("market_id") is not None})
            chunk_summaries.append(chunk_summary)

        market_fields = ["fixture_index", "fixture_id", "fixture_name", "tournament_id", "start_time", "status_id", "bookmaker", "fixture_path", "market_index", "market_id", "market_name", "market_class", "outcome_id", "outcome_name", "player_key", "line", "price", "price_american", "active", "main_line", "changed_at", "v3_score_hint"]
        write_csv(out_dir / "market_inventory_rows.csv", all_market_rows, market_fields)
        market_counts = Counter(str(r.get("market_id")) + " | " + str(r.get("market_name")) + " | " + str(r.get("market_class")) for r in all_market_rows)
        class_counts = Counter(str(r.get("market_class")) for r in all_market_rows)
        market_summary_rows = [{"market": k, "row_count": v} for k, v in market_counts.most_common()]
        class_summary_rows = [{"market_class": k, "row_count": v} for k, v in class_counts.most_common()]
        write_csv(out_dir / "market_summary.csv", market_summary_rows, ["market", "row_count"])
        write_csv(out_dir / "market_class_summary.csv", class_summary_rows, ["market_class", "row_count"])
        useful_classes = {"moneyline", "handicap_spread", "total", "game_total", "player_game_total", "first_set_winner", "first_set_total", "first_set_handicap", "exact_first_set_correct_score", "total_or_handicap_unknown_line"}
        useful_rows = [r for r in all_market_rows if r.get("market_class") in useful_classes and str(r.get("price")) not in {"", "None", "0", "0.0"}]
        write_csv(out_dir / "synthetic_model_input_candidates.csv", useful_rows, market_fields)
        summary["steps"].append({"step": "odds_by_tournaments", "ok": True, "chunks": chunk_summaries})
        summary["total_market_rows"] = len(all_market_rows)
        summary["priced_market_rows"] = len([r for r in all_market_rows if str(r.get("price")) not in {"", "None", "0", "0.0"}])
        summary["unique_markets"] = len(market_counts)
        summary["market_class_counts"] = dict(class_counts)
        summary["v3_score_hint_rows"] = len([r for r in all_market_rows if r.get("v3_score_hint")])
        summary["exact_first_set_correct_score_rows"] = len([r for r in all_market_rows if r.get("market_class") == "exact_first_set_correct_score"])
        summary["synthetic_candidate_rows"] = len(useful_rows)
        summary["final_verdict"] = ("EXACT_FIRST_SET_CORRECT_SCORE_FOUND" if summary["exact_first_set_correct_score_rows"] else "V3_SCORE_HINTS_FOUND" if summary["v3_score_hint_rows"] else "SYNTHETIC_INPUT_MARKETS_FOUND" if summary["synthetic_candidate_rows"] else "NO_USEFUL_MARKETS_FOUND")
        summary["ok"] = True
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
        return 0
    except Exception as exc:
        summary["ok"] = False
        summary["error"] = redact(str(exc), key)
        (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
