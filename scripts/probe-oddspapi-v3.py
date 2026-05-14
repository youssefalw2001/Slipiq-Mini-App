#!/usr/bin/env python3
"""
SlipIQ OddsPapi V3 Probe

Read-only. No sportsbook login. No bet placement.

Goal:
1. Verify OddsPapi API key works.
2. Fetch market mapping and find the exact First Set Correct Score market.
3. Optionally fetch a small number of fixtures/odds and search for SlipIQ V3 outcomes:
   3:6 / 4:6 / 5:7.

Required env:
  ODDSPAPI_KEY

Optional env:
  ODDSPAPI_BASE_URL=https://v1.oddspapi.io/en
  ODDSPAPI_AUTH_MODE=auto
  ODDSPAPI_MODE=mapping
  ODDSPAPI_BOOKMAKER=bet365
  ODDSPAPI_MAX_FIXTURES=3
  ODDSPAPI_FIXTURES_PARAMS={}

Modes:
  mapping     -> only /mapping/markets, safest first test
  live_small  -> mapping + /fixtures + /fixtures/odds for a few fixtures
  full_small  -> same as live_small, plus tries historical for the first fixture if possible
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

import requests


SCORE_TARGETS = {"3-6", "4-6", "5-7", "3:6", "4:6", "5:7"}
MARKET_NEEDLES = [
    "correct score first set",
    "first set correct score",
    "1st set correct score",
    "correct score 1st set",
    "set 1 correct score",
    "correct score set 1",
    "period 1 correct score",
    "correct score period 1",
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_json(obj: Any) -> Any:
    try:
        json.dumps(obj, default=str)
        return obj
    except Exception:
        return repr(obj)


def redact(text: str, key: str) -> str:
    if not key:
        return text
    return text.replace(key, "***REDACTED***")


def as_list(obj: Any) -> list[Any]:
    if obj is None:
        return []
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for k in ["data", "markets", "fixtures", "odds", "results", "items", "response"]:
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


def normalize_score(text: Any) -> str:
    t = str(text or "").strip().lower().replace(" ", "").replace(":", "-")
    m = re.search(r"([0-7])-([0-7])", t)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return t


def pick_id(obj: Any) -> str | None:
    if not isinstance(obj, dict):
        return None
    for k in ["id", "fixtureId", "fixture_id", "fixture", "eventId", "event_id", "matchId", "match_id"]:
        if obj.get(k) is not None:
            return str(obj[k])
    return None


def pick_name(obj: Any) -> str:
    if not isinstance(obj, dict):
        return str(obj)[:200]
    for k in ["name", "title", "label", "marketName", "market_name", "eventName", "event_name"]:
        if obj.get(k):
            return str(obj[k])
    home = obj.get("home") or obj.get("homeTeam") or obj.get("home_team") or obj.get("player1") or obj.get("participant1")
    away = obj.get("away") or obj.get("awayTeam") or obj.get("away_team") or obj.get("player2") or obj.get("participant2")
    if home or away:
        return f"{home or ''} vs {away or ''}".strip()
    return json.dumps(obj, ensure_ascii=False, default=str)[:200]


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


def auth_variants(key: str, mode: str) -> list[dict[str, Any]]:
    mode = (mode or "auto").lower().strip()
    all_modes = [
        {"name": "bearer", "headers": {"Authorization": f"Bearer {key}"}, "params": {}},
        {"name": "x-api-key", "headers": {"x-api-key": key}, "params": {}},
        {"name": "api-key-header", "headers": {"api-key": key}, "params": {}},
        {"name": "apikey-query", "headers": {}, "params": {"apiKey": key}},
        {"name": "api_key-query", "headers": {}, "params": {"api_key": key}},
        {"name": "token-query", "headers": {}, "params": {"token": key}},
    ]
    if mode == "auto":
        return all_modes
    aliases = {
        "bearer": "bearer",
        "x-api-key": "x-api-key",
        "api-key": "api-key-header",
        "apikey": "apikey-query",
        "api_key": "api_key-query",
        "token": "token-query",
    }
    wanted = aliases.get(mode, mode)
    return [v for v in all_modes if v["name"] == wanted] or all_modes[:1]


def request_json(
    base_url: str,
    path: str,
    key: str,
    auth_mode: str,
    params: dict[str, Any] | None = None,
    chosen_auth: dict[str, Any] | None = None,
    timeout: int = 30,
) -> tuple[Any, dict[str, Any]]:
    base_url = base_url.rstrip("/")
    path = path if path.startswith("/") else f"/{path}"
    url = f"{base_url}{path}"
    params = dict(params or {})
    variants = [chosen_auth] if chosen_auth else auth_variants(key, auth_mode)
    errors = []
    for variant in variants:
        headers = {"Accept": "application/json", **variant.get("headers", {})}
        q = {**params, **variant.get("params", {})}
        try:
            resp = requests.get(url, headers=headers, params=q, timeout=timeout)
            info = {
                "url": redact(resp.url, key),
                "status_code": resp.status_code,
                "auth_mode_used": variant.get("name"),
                "content_type": resp.headers.get("content-type"),
            }
            text = resp.text
            if resp.status_code < 400:
                try:
                    return resp.json(), info
                except Exception:
                    return {"raw_text": text[:5000]}, info
            errors.append({**info, "body_preview": redact(text[:1000], key)})
        except Exception as exc:
            errors.append({"auth_mode_used": variant.get("name"), "error": str(exc)})
    raise RuntimeError(json.dumps({"message": "All auth/request attempts failed", "errors": errors}, indent=2))


def find_first_set_correct_score_markets(payload: Any) -> list[dict[str, Any]]:
    hits = []
    for path, node in traverse(payload):
        if not isinstance(node, dict):
            continue
        blob = lower_blob(node)
        name = pick_name(node)
        name_l = name.lower()
        strong = any(n in blob for n in MARKET_NEEDLES) or any(n in name_l for n in MARKET_NEEDLES)
        loose = "correct" in blob and "score" in blob and ("first" in blob or "1st" in blob or "set 1" in blob or "period 1" in blob or "p1" in blob)
        if strong or loose:
            hits.append({
                "path": path,
                "market_id": pick_id(node),
                "market_name": name,
                "strong_match": strong,
                "raw_node": node,
            })
    return hits


def find_v3_odds(payload: Any) -> list[dict[str, Any]]:
    rows = []
    for path, node in traverse(payload):
        blob = lower_blob(node)
        blob_dash = blob.replace(":", "-")
        score_hint = None
        for score in ["3-6", "4-6", "5-7"]:
            if score in blob_dash:
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
        rows.append({
            "path": path,
            "score_hint": score_hint,
            "decimal_odds_guess": decimal_odds,
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
    key = os.getenv("ODDSPAPI_KEY", "").strip()
    if not key:
        print("Missing ODDSPAPI_KEY GitHub secret.", file=sys.stderr)
        return 2

    base_url = os.getenv("ODDSPAPI_BASE_URL", "https://v1.oddspapi.io/en").strip().rstrip("/")
    auth_mode = os.getenv("ODDSPAPI_AUTH_MODE", "auto").strip()
    mode = os.getenv("ODDSPAPI_MODE", "mapping").strip().lower()
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
        "auth_mode_requested": auth_mode,
        "mode": mode,
        "bookmaker": bookmaker,
        "max_fixtures": max_fixtures,
        "steps": [],
    }

    chosen_auth = None
    try:
        mapping, info = request_json(base_url, "/mapping/markets", key, auth_mode)
        chosen_auth = {"name": info["auth_mode_used"]}
        # Rebuild chosen auth with actual headers/params by name.
        for variant in auth_variants(key, "auto"):
            if variant["name"] == info["auth_mode_used"]:
                chosen_auth = variant
                break
        (raw_dir / "mapping_markets.json").write_text(json.dumps(safe_json(mapping), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        market_hits = find_first_set_correct_score_markets(mapping)
        write_csv(out_dir / "first_set_correct_score_market_hits.csv", market_hits, ["path", "market_id", "market_name", "strong_match"])
        summary["auth_mode_used"] = info["auth_mode_used"]
        summary["market_hit_count"] = len(market_hits)
        summary["market_hits_preview"] = [{k: h.get(k) for k in ["path", "market_id", "market_name", "strong_match"]} for h in market_hits[:20]]
        summary["steps"].append({"step": "mapping_markets", "ok": True, "status_code": info["status_code"], "market_hit_count": len(market_hits)})

        all_v3_rows: list[dict[str, Any]] = []
        selected_fixtures: list[dict[str, Any]] = []

        if mode in {"live_small", "full_small"}:
            fixtures, finfo = request_json(base_url, "/fixtures", key, auth_mode, params=fixtures_params, chosen_auth=chosen_auth)
            (raw_dir / "fixtures.json").write_text(json.dumps(safe_json(fixtures), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
            fixture_rows = [x for x in as_list(fixtures) if isinstance(x, dict)]
            for fx in fixture_rows[:max_fixtures]:
                selected_fixtures.append({"fixture_id": pick_id(fx), "fixture_name": pick_name(fx), "raw": fx})
            write_csv(out_dir / "selected_fixtures.csv", selected_fixtures, ["fixture_id", "fixture_name"])
            summary["steps"].append({"step": "fixtures", "ok": True, "status_code": finfo["status_code"], "fixture_count": len(fixture_rows), "selected": len(selected_fixtures)})

            for fx in selected_fixtures:
                fixture_id = fx.get("fixture_id")
                if not fixture_id:
                    continue
                params = {"fixtureId": fixture_id, "bookmaker": bookmaker}
                try:
                    odds, oinfo = request_json(base_url, "/fixtures/odds", key, auth_mode, params=params, chosen_auth=chosen_auth)
                    (raw_dir / f"fixture_odds_{fixture_id}.json").write_text(json.dumps(safe_json(odds), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                    v3 = find_v3_odds(odds)
                    for row in v3:
                        row["fixture_id"] = fixture_id
                        row["fixture_name"] = fx.get("fixture_name")
                    all_v3_rows.extend(v3)
                    summary["steps"].append({"step": "fixture_odds", "ok": True, "fixture_id": fixture_id, "fixture_name": fx.get("fixture_name"), "v3_rows": len(v3)})
                except Exception as exc:
                    summary["steps"].append({"step": "fixture_odds", "ok": False, "fixture_id": fixture_id, "fixture_name": fx.get("fixture_name"), "error": str(exc)[:1000]})

            if mode == "full_small" and selected_fixtures:
                fixture_id = selected_fixtures[0].get("fixture_id")
                if fixture_id:
                    try:
                        hist_params = {"fixtureId": fixture_id, "bookmaker": bookmaker}
                        hist, hinfo = request_json(base_url, "/fixtures/odds/historical", key, auth_mode, params=hist_params, chosen_auth=chosen_auth)
                        (raw_dir / f"historical_odds_{fixture_id}.json").write_text(json.dumps(safe_json(hist), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
                        hist_v3 = find_v3_odds(hist)
                        for row in hist_v3:
                            row["fixture_id"] = fixture_id
                            row["fixture_name"] = selected_fixtures[0].get("fixture_name")
                        all_v3_rows.extend(hist_v3)
                        summary["steps"].append({"step": "historical_odds", "ok": True, "fixture_id": fixture_id, "v3_rows": len(hist_v3)})
                    except Exception as exc:
                        summary["steps"].append({"step": "historical_odds", "ok": False, "fixture_id": fixture_id, "error": str(exc)[:1000]})

        write_csv(out_dir / "v3_odds_hints.csv", all_v3_rows, ["fixture_id", "fixture_name", "path", "score_hint", "decimal_odds_guess"])
        (out_dir / "v3_odds_hints.json").write_text(json.dumps(safe_json(all_v3_rows), indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        summary["v3_odds_hint_count"] = len(all_v3_rows)
        summary["ok"] = True
        if len(market_hits) > 0 and len(all_v3_rows) > 0:
            summary["final_verdict"] = "MARKET_MAPPING_AND_V3_ODDS_HINTS_FOUND"
        elif len(market_hits) > 0:
            summary["final_verdict"] = "MARKET_MAPPING_FOUND_NEXT_TEST_ODDS"
        else:
            summary["final_verdict"] = "NO_FIRST_SET_CORRECT_SCORE_MAPPING_FOUND"
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
