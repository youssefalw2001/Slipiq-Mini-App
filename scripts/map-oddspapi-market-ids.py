#!/usr/bin/env python3
"""
SlipIQ OddsPapi Market-ID Mapper

Read-only. No sportsbook login. No bet placement.

Purpose:
- Pull a small OddsPapi tennis sample, preferably 1xBet because it has the richest feed.
- Group numeric market IDs by observed structure.
- Output examples so we can identify markets useful for synthetic V3:
  moneyline, handicap/spread, totals, game totals, set winner, first-set total, player totals.

Required env:
  ODDSPAPI_KEY

Optional env:
  ODDSPAPI_BASE_URL=https://api.oddspapi.io
  ODDSPAPI_BOOKMAKER=1xbet
  ODDSPAPI_SPORT_ID=12
  ODDSPAPI_MAX_CHUNKS=5
  ODDSPAPI_CHUNK_SIZE=3
"""
from __future__ import annotations

import csv
import json
import os
import statistics
import time
from collections import Counter, defaultdict
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
        for k in ["data", "markets", "fixtures", "odds", "results", "items", "response", "tournaments"]:
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


def get_value(d: dict[str, Any], keys: list[str]) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


def request_json(base_url: str, path: str, key: str, params: dict[str, Any] | None = None, allow_404: bool = False) -> tuple[Any | None, dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    q = dict(params or {})
    q["apiKey"] = key
    last_info = None
    for attempt in range(2):
        resp = requests.get(url, headers={"Accept": "application/json"}, params=q, timeout=35)
        info = {"url": redact(resp.url, key), "status_code": resp.status_code, "attempt": attempt + 1}
        last_info = info
        if resp.status_code == 429 and attempt == 0:
            wait_s = 2.0
            try:
                retry_ms = resp.json().get("error", {}).get("retryMs")
                if retry_ms is not None:
                    wait_s = max(1.0, float(retry_ms) / 1000 + 0.7)
            except Exception:
                pass
            time.sleep(wait_s)
            continue
        if resp.status_code == 404 and allow_404:
            return None, {**info, "not_found": True, "body_preview": redact(resp.text[:500], key)}
        if resp.status_code >= 400:
            raise RuntimeError(json.dumps({**info, "body_preview": redact(resp.text[:1500], key)}, indent=2))
        return resp.json(), info
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


def extract_rows(payload: Any, bookmaker: str) -> list[dict[str, Any]]:
    rows = []
    for fixture_index, fixture in enumerate(as_list(payload)):
        if not isinstance(fixture, dict):
            continue
        fixture_id = get_value(fixture, ["fixtureId", "id"])
        tournament_id = get_value(fixture, ["tournamentId"])
        start_time = get_value(fixture, ["startTime", "trueStartTime"])
        status_id = get_value(fixture, ["statusId", "status"])
        book_odds = fixture.get("bookmakerOdds") if isinstance(fixture.get("bookmakerOdds"), dict) else {}
        book_obj = book_odds.get(bookmaker) or book_odds.get(bookmaker.lower()) or book_odds.get(bookmaker.upper())
        if not isinstance(book_obj, dict):
            continue
        fixture_path = get_value(book_obj, ["fixturePath", "bookmakerFixturePath", "url"])
        for market_key, market in as_items(book_obj.get("markets")):
            if not isinstance(market, dict):
                continue
            market_id = str(get_value(market, ["marketId", "id", "key"]) or market_key)
            market_name = str(get_value(market, ["marketName", "name", "label", "type", "marketType"]) or market_id)
            for outcome_key, outcome in as_items(market.get("outcomes")):
                if not isinstance(outcome, dict):
                    continue
                outcome_id = str(get_value(outcome, ["outcomeId", "id", "key"]) or outcome_key)
                outcome_name = str(get_value(outcome, ["outcomeName", "name", "label", "selection", "participantName"]) or outcome_id)
                players = as_items(outcome.get("players")) or [("", outcome)]
                for player_key, player in players:
                    if not isinstance(player, dict):
                        continue
                    price = get_value(player, ["price", "odds", "decimal", "decimalOdds", "value"])
                    line = get_value(player, ["line", "handicap", "points", "total"])
                    active = get_value(player, ["active"])
                    main_line = get_value(player, ["mainLine"])
                    changed_at = get_value(player, ["changedAt", "updatedAt", "bookmakerChangedAt"])
                    try:
                        price_float = float(price) if price is not None else None
                    except Exception:
                        price_float = None
                    try:
                        line_float = float(line) if line is not None else None
                    except Exception:
                        line_float = None
                    rows.append({
                        "fixture_id": fixture_id,
                        "tournament_id": tournament_id,
                        "start_time": start_time,
                        "status_id": status_id,
                        "fixture_path": fixture_path,
                        "market_id": market_id,
                        "market_name": market_name,
                        "outcome_id": outcome_id,
                        "outcome_name": outcome_name,
                        "player_key": player_key,
                        "line": line,
                        "line_float": line_float,
                        "price": price,
                        "price_float": price_float,
                        "active": active,
                        "main_line": main_line,
                        "changed_at": changed_at,
                    })
    return rows


def infer_market_type(rows: list[dict[str, Any]]) -> str:
    mid = str(rows[0].get("market_id")) if rows else ""
    outcome_ids = {str(r.get("outcome_id")) for r in rows}
    outcome_names = " ".join(sorted({str(r.get("outcome_name")) for r in rows}))[:500].lower()
    lines = [r.get("line_float") for r in rows if r.get("line_float") is not None]
    prices = [r.get("price_float") for r in rows if r.get("price_float") is not None and r.get("price_float") > 0]
    if mid == "121":
        return "moneyline"
    if mid == "123":
        return "handicap_spread"
    if mid == "12404":
        return "exact_first_set_correct_score"
    if any(s in outcome_names for s in ["3-6", "3:6", "4-6", "4:6", "5-7", "5:7"]):
        return "v3_score_related"
    if lines:
        # Two common structures: over/under totals and handicaps. We cannot name numeric IDs perfectly yet.
        has_pos_neg = any(x < 0 for x in lines) and any(x > 0 for x in lines)
        has_half = any(abs(x - round(x)) == 0.5 for x in lines)
        if has_pos_neg:
            return "likely_handicap_or_spread"
        if has_half or "over" in outcome_names or "under" in outcome_names:
            return "likely_total_games_or_points"
        return "line_based_market"
    if len(outcome_ids) == 2 and prices:
        return "two_way_price_market"
    if len(outcome_ids) >= 3 and prices:
        return "multiway_price_market"
    return "unknown"


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
    bookmaker = os.getenv("ODDSPAPI_BOOKMAKER", "1xbet").strip()
    sport_id = os.getenv("ODDSPAPI_SPORT_ID", "12").strip()
    max_chunks = int(os.getenv("ODDSPAPI_MAX_CHUNKS", "5"))
    chunk_size = int(os.getenv("ODDSPAPI_CHUNK_SIZE", "3"))
    out_dir = Path(os.getenv("OUT_DIR", "artifacts/output/oddspapi-market-id-map"))
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {"generated_at": now_iso(), "ok": False, "bookmaker": bookmaker, "sport_id": sport_id, "max_chunks": max_chunks, "chunk_size": chunk_size, "steps": []}

    try:
        tournaments, tinfo = request_json(base_url, "/v4/tournaments", key, params={"sportId": sport_id})
        (raw_dir / "tournaments.json").write_text(json.dumps(safe_json(tournaments), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tournament_rows = [x for x in as_list(tournaments) if isinstance(x, dict)]
        active_rows = sorted([x for x in tournament_rows if fixture_count_score(x) > 0], key=tournament_sort_key)
        selected = active_rows[: max_chunks * chunk_size]
        ids = [str(x.get("tournamentId")) for x in selected if x.get("tournamentId") is not None]
        selected_rows = [{"tournamentId": x.get("tournamentId"), "tournamentName": x.get("tournamentName"), "categoryName": x.get("categoryName"), "liveFixtures": x.get("liveFixtures"), "upcomingFixtures": x.get("upcomingFixtures"), "futureFixtures": x.get("futureFixtures")} for x in selected]
        write_csv(out_dir / "selected_tournaments.csv", selected_rows, ["tournamentId", "tournamentName", "categoryName", "liveFixtures", "upcomingFixtures", "futureFixtures"])
        summary["steps"].append({"step": "tournaments", "status_code": tinfo.get("status_code"), "total": len(tournament_rows), "active": len(active_rows), "selected": len(selected)})

        all_rows = []
        chunk_summaries = []
        for chunk_index, start in enumerate(range(0, len(ids), chunk_size), start=1):
            if chunk_index > max_chunks:
                break
            chunk = ids[start : start + chunk_size]
            params = {"bookmaker": bookmaker, "tournamentIds": ",".join(chunk), "oddsFormat": "decimal"}
            odds, info = request_json(base_url, "/v4/odds-by-tournaments", key, params=params, allow_404=True)
            time.sleep(1.3)
            chunk_summary = {"chunk_index": chunk_index, "tournament_ids": chunk, "status_code": info.get("status_code"), "not_found": bool(info.get("not_found"))}
            if odds is None:
                chunk_summaries.append(chunk_summary)
                continue
            (raw_dir / f"odds_by_tournaments_{chunk_index}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            rows = extract_rows(odds, bookmaker)
            all_rows.extend(rows)
            chunk_summary["fixture_count"] = len(as_list(odds))
            chunk_summary["row_count"] = len(rows)
            chunk_summary["unique_markets"] = len({r.get("market_id") for r in rows})
            chunk_summaries.append(chunk_summary)

        row_fields = ["fixture_id", "tournament_id", "start_time", "status_id", "fixture_path", "market_id", "market_name", "outcome_id", "outcome_name", "player_key", "line", "price", "active", "main_line", "changed_at"]
        write_csv(out_dir / "all_market_rows.csv", all_rows, row_fields)

        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in all_rows:
            grouped[str(r.get("market_id"))].append(r)

        market_map_rows = []
        examples = []
        for market_id, rows in sorted(grouped.items(), key=lambda kv: (-len(kv[1]), kv[0])):
            prices = [r.get("price_float") for r in rows if r.get("price_float") is not None and r.get("price_float") > 0]
            lines = [r.get("line_float") for r in rows if r.get("line_float") is not None]
            outcome_ids = sorted({str(r.get("outcome_id")) for r in rows})
            outcome_names = sorted({str(r.get("outcome_name")) for r in rows if str(r.get("outcome_name")) not in {"", "None"}})
            fixture_ids = sorted({str(r.get("fixture_id")) for r in rows if r.get("fixture_id") is not None})
            inferred = infer_market_type(rows)
            market_map_rows.append({
                "market_id": market_id,
                "inferred_type": inferred,
                "row_count": len(rows),
                "priced_rows": len(prices),
                "fixture_count": len(fixture_ids),
                "outcome_id_count": len(outcome_ids),
                "sample_outcome_ids": ",".join(outcome_ids[:12]),
                "sample_outcome_names": " | ".join(outcome_names[:8]),
                "line_count": len(lines),
                "line_min": min(lines) if lines else "",
                "line_max": max(lines) if lines else "",
                "sample_lines": ",".join(str(x) for x in sorted(set(lines))[:12]),
                "price_min": min(prices) if prices else "",
                "price_max": max(prices) if prices else "",
                "price_median": statistics.median(prices) if prices else "",
                "example_fixture_id": fixture_ids[0] if fixture_ids else "",
                "example_fixture_path": next((str(r.get("fixture_path")) for r in rows if r.get("fixture_path")), ""),
            })
            for r in rows[:6]:
                examples.append({
                    "market_id": market_id,
                    "inferred_type": inferred,
                    "fixture_id": r.get("fixture_id"),
                    "outcome_id": r.get("outcome_id"),
                    "outcome_name": r.get("outcome_name"),
                    "player_key": r.get("player_key"),
                    "line": r.get("line"),
                    "price": r.get("price"),
                    "active": r.get("active"),
                    "main_line": r.get("main_line"),
                    "fixture_path": r.get("fixture_path"),
                })

        write_csv(out_dir / "market_id_map.csv", market_map_rows, ["market_id", "inferred_type", "row_count", "priced_rows", "fixture_count", "outcome_id_count", "sample_outcome_ids", "sample_outcome_names", "line_count", "line_min", "line_max", "sample_lines", "price_min", "price_max", "price_median", "example_fixture_id", "example_fixture_path"])
        write_csv(out_dir / "market_examples.csv", examples, ["market_id", "inferred_type", "fixture_id", "outcome_id", "outcome_name", "player_key", "line", "price", "active", "main_line", "fixture_path"])

        inferred_counts = Counter(r["inferred_type"] for r in market_map_rows)
        write_csv(out_dir / "inferred_type_summary.csv", [{"inferred_type": k, "market_count": v} for k, v in inferred_counts.most_common()], ["inferred_type", "market_count"])

        summary["steps"].append({"step": "odds_by_tournaments", "chunks": chunk_summaries})
        summary["total_rows"] = len(all_rows)
        summary["unique_market_ids"] = len(grouped)
        summary["inferred_type_counts"] = dict(inferred_counts)
        summary["exact_first_set_correct_score_market_ids"] = [r["market_id"] for r in market_map_rows if r["inferred_type"] == "exact_first_set_correct_score"]
        summary["likely_total_market_ids"] = [r["market_id"] for r in market_map_rows if "total" in r["inferred_type"]]
        summary["likely_handicap_market_ids"] = [r["market_id"] for r in market_map_rows if "handicap" in r["inferred_type"] or "spread" in r["inferred_type"]]
        summary["final_verdict"] = "MAPPED_MARKET_IDS_FOR_SYNTHETIC_MODEL"
        if summary["exact_first_set_correct_score_market_ids"]:
            summary["final_verdict"] = "EXACT_FIRST_SET_CORRECT_SCORE_MARKET_FOUND"
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
