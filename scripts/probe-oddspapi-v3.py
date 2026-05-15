#!/usr/bin/env python3
"""
SlipIQ OddsPapi V3 Probe

Read-only. No sportsbook login. No bet placement.

The public v4 docs currently show these endpoints:
- /v4/tournaments?sportId=...
- /v4/odds-by-tournaments?bookmaker=...&tournamentIds=...

This probe selects tennis tournaments with future/upcoming/live fixtures first, then tries
small tournament chunks until odds are found or the free-trial-safe limit is reached.
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.parse
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


def traverse(obj: Any, path: str = ""):
    yield path, obj
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from traverse(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from traverse(v, f"{path}[{i}]")


def lower_blob(obj: Any) -> str:
    return json.dumps(safe_json(obj), ensure_ascii=False, default=str).lower()


def parse_params(raw: str) -> dict[str, Any]:
    raw = (raw or "{}").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    return dict(urllib.parse.parse_qsl(raw, keep_blank_values=True))


def request_json(base_url: str, path: str, key: str, params: dict[str, Any] | None = None, timeout: int = 30) -> tuple[Any, dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    q = dict(params or {})
    q["apiKey"] = key
    resp = requests.get(url, headers={"Accept": "application/json"}, params=q, timeout=timeout)
    info = {"url": redact(resp.url, key), "status_code": resp.status_code, "content_type": resp.headers.get("content-type")}
    if resp.status_code >= 400:
        raise RuntimeError(json.dumps({**info, "body_preview": redact(resp.text[:1500], key)}, indent=2))
    try:
        return resp.json(), info
    except Exception:
        return {"raw_text": resp.text[:5000]}, info


def request_json_allow_404(base_url: str, path: str, key: str, params: dict[str, Any] | None = None, timeout: int = 30) -> tuple[Any | None, dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    q = dict(params or {})
    q["apiKey"] = key
    resp = requests.get(url, headers={"Accept": "application/json"}, params=q, timeout=timeout)
    info = {"url": redact(resp.url, key), "status_code": resp.status_code, "content_type": resp.headers.get("content-type")}
    if resp.status_code == 404:
        return None, {**info, "not_found": True, "body_preview": redact(resp.text[:500], key)}
    if resp.status_code >= 400:
        raise RuntimeError(json.dumps({**info, "body_preview": redact(resp.text[:1500], key)}, indent=2))
    try:
        return resp.json(), info
    except Exception:
        return {"raw_text": resp.text[:5000]}, info


def fixture_count_score(t: dict[str, Any]) -> int:
    total = 0
    for k in ["liveFixtures", "upcomingFixtures", "futureFixtures"]:
        try:
            total += int(t.get(k) or 0)
        except Exception:
            pass
    return total


def tournament_sort_key(t: dict[str, Any]) -> tuple[int, str]:
    try:
        live = int(t.get("liveFixtures") or 0)
        upcoming = int(t.get("upcomingFixtures") or 0)
        future = int(t.get("futureFixtures") or 0)
    except Exception:
        live = upcoming = future = 0
    return (-(live * 100000 + upcoming * 1000 + future), str(t.get("tournamentName") or ""))


def find_market_mentions(payload: Any) -> list[dict[str, Any]]:
    hits = []
    for path, node in traverse(payload):
        if not isinstance(node, dict):
            continue
        blob = lower_blob(node)
        is_correct_score = "correct" in blob and "score" in blob
        is_first_set = "first" in blob or "1st" in blob or "set 1" in blob or "period 1" in blob or "p1" in blob
        if is_correct_score or is_first_set:
            hits.append({"path": path, "correct_score_hint": is_correct_score, "first_set_hint": is_first_set, "raw_node": node})
    return hits


def find_v3_odds(payload: Any) -> list[dict[str, Any]]:
    rows = []
    for path, node in traverse(payload):
        blob = lower_blob(node).replace(":", "-")
        score_hint = None
        for score in ["3-6", "4-6", "5-7"]:
            if score in blob:
                score_hint = score
                break
        if not score_hint:
            continue
        decimal_odds = None
        if isinstance(node, dict):
            for k in ["odds", "price", "decimal", "decimalOdds", "decimal_odds", "value"]:
                if node.get(k) is not None:
                    try:
                        val = float(node[k])
                        if 1.01 <= val <= 1000:
                            decimal_odds = val
                            break
                    except Exception:
                        pass
        rows.append({"path": path, "score_hint": score_hint, "decimal_odds_guess": decimal_odds, "raw_node": node})
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

    base_url = os.getenv("ODDSPAPI_BASE_URL", "https://api.oddspapi.io").strip().rstrip("/")
    mode = os.getenv("ODDSPAPI_MODE", "live_small").strip().lower()
    bookmaker = os.getenv("ODDSPAPI_BOOKMAKER", "bet365").strip()
    max_fixtures = int(os.getenv("ODDSPAPI_MAX_FIXTURES", "3"))
    fixtures_params = parse_params(os.getenv("ODDSPAPI_FIXTURES_PARAMS", "{}"))
    out_dir = Path(os.getenv("OUT_DIR", "artifacts/output/oddspapi-v3-probe"))
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "generated_at": now_iso(),
        "ok": False,
        "base_url": base_url,
        "mode": mode,
        "bookmaker": bookmaker,
        "max_fixtures": max_fixtures,
        "steps": [],
    }

    try:
        all_v3_rows: list[dict[str, Any]] = []
        all_market_mentions: list[dict[str, Any]] = []
        attempted_chunks: list[dict[str, Any]] = []

        tournament_params = fixtures_params or {"sportId": "12"}
        tournaments, tinfo = request_json(base_url, "/v4/tournaments", key, params=tournament_params)
        (raw_dir / "tournaments.json").write_text(json.dumps(safe_json(tournaments), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tournament_rows = [x for x in as_list(tournaments) if isinstance(x, dict)]
        active_rows = [x for x in tournament_rows if fixture_count_score(x) > 0]
        active_rows = sorted(active_rows, key=tournament_sort_key)
        selected = active_rows[: max(max_fixtures * 5, max_fixtures)]
        selected_out = [
            {
                "tournamentId": x.get("tournamentId"),
                "tournamentName": x.get("tournamentName"),
                "categoryName": x.get("categoryName"),
                "liveFixtures": x.get("liveFixtures"),
                "upcomingFixtures": x.get("upcomingFixtures"),
                "futureFixtures": x.get("futureFixtures"),
            }
            for x in selected
        ]
        write_csv(out_dir / "selected_tournaments.csv", selected_out, ["tournamentId", "tournamentName", "categoryName", "liveFixtures", "upcomingFixtures", "futureFixtures"])
        summary["steps"].append({"step": "tournaments", "ok": True, "status_code": tinfo["status_code"], "count": len(tournament_rows), "active_count": len(active_rows)})

        if mode == "mapping":
            summary["final_verdict"] = "API_KEY_AND_TENNIS_TOURNAMENTS_WORK_NEXT_RUN_LIVE_SMALL"
        else:
            ids = [str(x.get("tournamentId")) for x in selected if x.get("tournamentId") is not None]
            chunk_size = max(1, min(3, max_fixtures))
            max_chunks = max(1, max_fixtures)
            for idx in range(0, len(ids), chunk_size):
                if len(attempted_chunks) >= max_chunks:
                    break
                chunk = ids[idx : idx + chunk_size]
                odds_params = {"bookmaker": bookmaker, "tournamentIds": ",".join(chunk), "oddsFormat": "decimal"}
                odds, oinfo = request_json_allow_404(base_url, "/v4/odds-by-tournaments", key, params=odds_params)
                attempted = {"tournament_ids": chunk, "status_code": oinfo.get("status_code"), "not_found": bool(oinfo.get("not_found"))}
                attempted_chunks.append(attempted)
                if odds is None:
                    continue
                (raw_dir / f"odds_by_tournaments_{len(attempted_chunks)}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                v3 = find_v3_odds(odds)
                mentions = find_market_mentions(odds)
                all_v3_rows.extend(v3)
                all_market_mentions.extend(mentions)
                attempted["fixture_count"] = len(as_list(odds))
                attempted["v3_rows"] = len(v3)
                attempted["market_mentions"] = len(mentions)
                # Stop early if we find actual V3 hints.
                if v3:
                    break

            summary["steps"].append({"step": "odds_by_tournaments_chunks", "ok": True, "attempted_chunks": attempted_chunks})
            if len(all_v3_rows) > 0:
                summary["final_verdict"] = "V3_SCORE_HINTS_FOUND_IN_ODDS"
            elif len(all_market_mentions) > 0:
                summary["final_verdict"] = "MARKET_HINTS_FOUND_BUT_NO_3_6_4_6_5_7"
            else:
                summary["final_verdict"] = "NO_V3_MARKET_FOUND_IN_TESTED_ACTIVE_TOURNAMENTS"

        write_csv(out_dir / "v3_odds_hints.csv", all_v3_rows, ["path", "score_hint", "decimal_odds_guess"])
        write_csv(out_dir / "market_mentions.csv", all_market_mentions, ["path", "correct_score_hint", "first_set_hint"])
        (out_dir / "v3_odds_hints.json").write_text(json.dumps(safe_json(all_v3_rows), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        (out_dir / "market_mentions.json").write_text(json.dumps(safe_json(all_market_mentions), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        summary["v3_odds_hint_count"] = len(all_v3_rows)
        summary["market_mention_count"] = len(all_market_mentions)
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
