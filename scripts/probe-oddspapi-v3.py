#!/usr/bin/env python3
"""
SlipIQ OddsPapi V3 Probe

Read-only. No sportsbook login. No bet placement.

The public v4 docs currently show these endpoints:
- /v4/tournaments?sportId=...
- /v4/odds-by-tournaments?bookmaker=...&tournamentIds=...

The earlier PDF mentioned /mapping/markets, but the real v4 API returned 404 for that endpoint.
This probe therefore uses documented endpoints first and searches returned odds payloads for
SlipIQ V3 markets/outcomes: 3:6 / 4:6 / 5:7.
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
    info = {
        "url": redact(resp.url, key),
        "status_code": resp.status_code,
        "content_type": resp.headers.get("content-type"),
    }
    if resp.status_code >= 400:
        raise RuntimeError(json.dumps({**info, "body_preview": redact(resp.text[:1500], key)}, indent=2))
    try:
        return resp.json(), info
    except Exception:
        return {"raw_text": resp.text[:5000]}, info


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

        if mode == "mapping":
            # The real v4 API returned 404 for mapping. In mapping mode now, we verify docs endpoint access via tournaments.
            tournament_params = fixtures_params or {"sportId": "2"}
            tournaments, tinfo = request_json(base_url, "/v4/tournaments", key, params=tournament_params)
            (raw_dir / "tournaments.json").write_text(json.dumps(safe_json(tournaments), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            rows = [x for x in as_list(tournaments) if isinstance(x, dict)]
            summary["steps"].append({"step": "tournaments", "ok": True, "status_code": tinfo["status_code"], "count": len(rows)})
            summary["final_verdict"] = "API_KEY_AND_TOURNAMENTS_WORK_NEXT_RUN_LIVE_SMALL"
        else:
            tournament_params = fixtures_params or {"sportId": "2"}
            tournaments, tinfo = request_json(base_url, "/v4/tournaments", key, params=tournament_params)
            (raw_dir / "tournaments.json").write_text(json.dumps(safe_json(tournaments), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            tournament_rows = [x for x in as_list(tournaments) if isinstance(x, dict)]
            ids = [str(x.get("tournamentId")) for x in tournament_rows if x.get("tournamentId") is not None][:max_fixtures]
            write_csv(out_dir / "selected_tournaments.csv", [{"tournament_id": i} for i in ids], ["tournament_id"])
            summary["steps"].append({"step": "tournaments", "ok": True, "status_code": tinfo["status_code"], "count": len(tournament_rows), "selected_tournament_ids": ids})

            if ids:
                odds_params = {"bookmaker": bookmaker, "tournamentIds": ",".join(ids), "oddsFormat": "decimal"}
                odds, oinfo = request_json(base_url, "/v4/odds-by-tournaments", key, params=odds_params)
                (raw_dir / "odds_by_tournaments.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                all_v3_rows.extend(find_v3_odds(odds))
                all_market_mentions.extend(find_market_mentions(odds))
                fixture_count = len(as_list(odds))
                summary["steps"].append({"step": "odds_by_tournaments", "ok": True, "status_code": oinfo["status_code"], "fixture_count": fixture_count, "v3_rows": len(all_v3_rows), "market_mentions": len(all_market_mentions)})

            if len(all_v3_rows) > 0:
                summary["final_verdict"] = "V3_SCORE_HINTS_FOUND_IN_ODDS"
            elif len(all_market_mentions) > 0:
                summary["final_verdict"] = "MARKET_HINTS_FOUND_BUT_NO_3_6_4_6_5_7"
            else:
                summary["final_verdict"] = "NO_V3_MARKET_FOUND_IN_TESTED_TOURNAMENTS"

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
