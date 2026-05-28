#!/usr/bin/env python3
"""
First Set Lab / SlipIQ historical Azuro data-feed backtest runner v2.

SAFE MODE ONLY:
- No private keys
- No signing
- No order submission
- No wallet calls

Why v2 exists:
The first runner hard-exited when blocks_subgraph_url was missing. This runner
fails closed into CSV/JSON artifacts instead of killing the GitHub job. It also
supports an optional JSON-RPC timestamp-to-block fallback.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import json
import math
import os
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
import requests

DEFAULT_SOURCE_VIEW = "proof_vault_recent_receipts_v2_protected"
DEFAULT_DATA_FEED_SUBGRAPH = "https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon"
DEFAULT_TARGET_MARKET = "First Set Correct Score"
ACTIVE_LANES = {
    "CORE_P1_ATP_GS_BET365": ["6:2", "6:3", "6:4"],
    "CORE_P2_GS_REVERSE_STRETCH_BET365": ["2:6", "4:6", "5:7"],
    "RESEARCH_P2_GS_26_46_BET365": ["2:6", "4:6", "5:7"],
    "VIP_P2_V3_SHAPE": ["3:6", "4:6", "5:7"],
}


@dataclass
class AlertRecord:
    player_one: str
    player_two: str
    match_date: datetime
    signal_timestamp: datetime
    target_market: str
    target_scores: List[str]
    signal_id: Optional[str] = None
    signal_key: Optional[str] = None
    match_name: Optional[str] = None
    strategy_lane: Optional[str] = None
    baseline_grouped_odds: Optional[float] = None
    baseline_score_odds_json: Optional[Dict[str, Any]] = None


@dataclass
class BacktestRow:
    run_id: str
    source: str
    signal_id: Optional[str]
    signal_key: Optional[str]
    player_one: str
    player_two: str
    match_name: str
    match_date: str
    signal_timestamp: str
    strategy_lane: Optional[str]
    target_market: str
    target_scores: List[str]
    baseline_grouped_odds: Optional[float]
    baseline_score_odds_json: Optional[Dict[str, Any]]
    chain_id: str
    subgraph_url: str
    block_number: Optional[int]
    block_timestamp: Optional[str]
    block_lookup_json: Optional[Dict[str, Any]]
    azuro_game_id: Optional[str]
    azuro_game_title: Optional[str]
    azuro_condition_id: Optional[str]
    azuro_market_title: Optional[str]
    market_available: bool
    score_outcomes_json: Dict[str, Any]
    azuro_grouped_odds: Optional[float]
    edge_vs_baseline: Optional[float]
    virtual_funds_json: Optional[Dict[str, Any]]
    decision: str
    reason: str
    raw_game_json: Optional[Dict[str, Any]]
    raw_condition_json: Optional[Dict[str, Any]]
    raw_block_json: Optional[Dict[str, Any]]


def now_run_id() -> str:
    return "azuro_hist_v2_" + datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def norm(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9:.-]+", " ", clean(value).lower())).strip()


def parse_dt(value: Any) -> datetime:
    if value is None or clean(value) == "":
        raise ValueError("missing timestamp")
    text = clean(value)
    if text.isdigit():
        n = int(text)
        if n > 10_000_000_000:
            n //= 1000
        return datetime.fromtimestamp(n, tz=timezone.utc)
    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def normalize_score(value: Any) -> str:
    m = re.search(r"\b(\d+)\s*[:-]\s*(\d+)\b", clean(value))
    return f"{m.group(1)}:{m.group(2)}" if m else ""


def parse_players(match_name: str) -> Tuple[str, str]:
    raw = re.sub(r"\s+vs\.?\s+", " v ", clean(match_name), flags=re.I)
    raw = re.sub(r"\s+@\s+", " v ", raw, flags=re.I)
    parts = [clean(x) for x in re.split(r"\s+v\s+", raw, flags=re.I) if clean(x)]
    return (parts[0], " v ".join(parts[1:])) if len(parts) >= 2 else (raw, "")


def parse_scores(value: Any, lane: Optional[str]) -> List[str]:
    if lane in ACTIVE_LANES:
        return ACTIVE_LANES[lane]
    if value is None or clean(value) == "":
        return []
    if isinstance(value, list):
        raw = value
    else:
        text = clean(value)
        try:
            loaded = json.loads(text)
            raw = loaded if isinstance(loaded, list) else [text]
        except Exception:
            raw = re.split(r"[,/|]", text)
    return [s for s in (normalize_score(x) for x in raw) if s]


def decimal_odds(value: Any) -> Optional[float]:
    if value is None or clean(value) == "":
        return None
    try:
        n = float(str(value).replace(",", "."))
    except Exception:
        return None
    if not math.isfinite(n) or n <= 1:
        return None
    return n / 1e12 if n > 1_000_000 else n


def grouped_odds(values: Iterable[Any]) -> Optional[float]:
    odds = []
    for v in values:
        o = decimal_odds(v)
        if not o:
            return None
        odds.append(o)
    if not odds:
        return None
    implied = sum(1 / o for o in odds)
    return 1 / implied if implied else None


def json_maybe(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if value is None or clean(value) == "":
        return None
    try:
        out = json.loads(str(value))
        return out if isinstance(out, dict) else None
    except Exception:
        return None


def score_odds_from_json(score_json: Optional[Dict[str, Any]], scores: List[str]) -> Optional[Dict[str, float]]:
    if not score_json:
        return None
    out = {}
    for s in scores:
        for key in [s, s.replace(":", "-"), s.replace(":", "_")]:
            if key in score_json:
                odd = decimal_odds(score_json[key])
                if odd:
                    out[s] = odd
                break
    return out or None


class GraphQLClient:
    def __init__(self, url: str, timeout: int = 30):
        self.url = url
        self.timeout = timeout

    def query(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        r = requests.post(self.url, json={"query": query, "variables": variables or {}}, timeout=self.timeout)
        if r.status_code >= 400:
            raise RuntimeError(f"GraphQL HTTP {r.status_code}: {r.text[:700]}")
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(f"GraphQL errors: {json.dumps(body['errors'])[:1200]}")
        return body.get("data") or {}


def gql_fields(client: GraphQLClient, type_name: str) -> List[str]:
    q = """
    query TypeFields($name: String!) { __type(name: $name) { fields { name } } }
    """
    try:
        data = client.query(q, {"name": type_name})
        return [x["name"] for x in ((data.get("__type") or {}).get("fields") or [])]
    except Exception:
        return []


def pick_outcome_fields(fields: List[str]) -> str:
    wanted = ["id", "outcomeId", "title", "name", "currentOdds", "odds", "rawCurrentOdds", "virtualFunds", "rawVirtualFunds", "funds", "rawFunds"]
    selected = [x for x in wanted if x in fields]
    if "id" not in selected:
        selected.insert(0, "id")
    return "\n".join(selected)


BLOCKS_QUERY = """
query BlockByTimestamp($from: Int!, $to: Int!) {
  blocks(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $from, timestamp_lte: $to }) {
    number
    timestamp
  }
}
"""


def block_by_subgraph(client: GraphQLClient, ts: datetime, window: int) -> Tuple[Optional[int], Optional[datetime], Dict[str, Any]]:
    unix = int(ts.timestamp())
    for lo, hi in [(unix - window, unix), (unix, unix + window)]:
        data = client.query(BLOCKS_QUERY, {"from": lo, "to": hi})
        blocks = data.get("blocks") or []
        if blocks:
            b = blocks[0]
            return int(b["number"]), datetime.fromtimestamp(int(b["timestamp"]), tz=timezone.utc), {"source": "blocks_subgraph", "response": data}
    return None, None, {"source": "blocks_subgraph", "response": data}


def rpc_call(url: str, method: str, params: List[Any], timeout: int) -> Any:
    r = requests.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"RPC HTTP {r.status_code}: {r.text[:700]}")
    body = r.json()
    if body.get("error"):
        raise RuntimeError(f"RPC error: {body['error']}")
    return body.get("result")


def rpc_block(url: str, n: int, timeout: int) -> Dict[str, Any]:
    block = rpc_call(url, "eth_getBlockByNumber", [hex(n), False], timeout)
    if not block:
        raise RuntimeError(f"RPC returned no block for {n}")
    return block


def block_by_rpc(url: str, ts: datetime, timeout: int) -> Tuple[Optional[int], Optional[datetime], Dict[str, Any]]:
    target = int(ts.timestamp())
    latest_hex = rpc_call(url, "eth_blockNumber", [], timeout)
    latest = int(latest_hex, 16)
    lo, hi = 1, latest
    best = None
    calls = 0
    while lo <= hi and calls < 80:
        calls += 1
        mid = (lo + hi) // 2
        b = rpc_block(url, mid, timeout)
        bts = int(b["timestamp"], 16)
        if bts <= target:
            best = (mid, bts, b)
            lo = mid + 1
        else:
            hi = mid - 1
    if not best:
        return None, None, {"source": "rpc", "error": "no block <= timestamp"}
    n, bts, raw = best
    return n, datetime.fromtimestamp(bts, tz=timezone.utc), {"source": "rpc", "calls": calls, "block": raw}


def empty_row(run_id: str, alert: AlertRecord, chain_id: str, subgraph_url: str, decision: str, reason: str) -> BacktestRow:
    return BacktestRow(
        run_id=run_id,
        source="azuro_historical_subgraph_backtest_v2",
        signal_id=alert.signal_id,
        signal_key=alert.signal_key,
        player_one=alert.player_one,
        player_two=alert.player_two,
        match_name=alert.match_name or f"{alert.player_one} vs {alert.player_two}",
        match_date=alert.match_date.isoformat(),
        signal_timestamp=alert.signal_timestamp.isoformat(),
        strategy_lane=alert.strategy_lane,
        target_market=alert.target_market,
        target_scores=alert.target_scores,
        baseline_grouped_odds=alert.baseline_grouped_odds,
        baseline_score_odds_json=alert.baseline_score_odds_json,
        chain_id=chain_id,
        subgraph_url=subgraph_url,
        block_number=None,
        block_timestamp=None,
        block_lookup_json=None,
        azuro_game_id=None,
        azuro_game_title=None,
        azuro_condition_id=None,
        azuro_market_title=None,
        market_available=False,
        score_outcomes_json={},
        azuro_grouped_odds=None,
        edge_vs_baseline=None,
        virtual_funds_json=None,
        decision=decision,
        reason=reason,
        raw_game_json=None,
        raw_condition_json=None,
        raw_block_json=None,
    )


def build_games_query(outcome_fields: str) -> str:
    return f"""
query HistoricalGames($from: BigInt!, $to: BigInt!, $first: Int!, $block: Int!) {{
  games(first: $first, where: {{ startsAt_gte: $from, startsAt_lte: $to }}, block: {{ number: $block }}) {{
    id
    gameId
    title
    startsAt
    sport {{ name slug }}
    league {{ name }}
    participants {{ name sortOrder }}
    conditions {{
      id
      conditionId
      title
      outcomes {{ {outcome_fields} }}
    }}
  }}
}}
"""


def game_text(game: Dict[str, Any]) -> str:
    participants = " ".join(clean(p.get("name")) for p in (game.get("participants") or []))
    return norm(" ".join([clean(game.get("title")), participants, clean((game.get("league") or {}).get("name")), clean((game.get("sport") or {}).get("name"))]))


def choose_game(alert: AlertRecord, games: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    p1, p2 = norm(alert.player_one), norm(alert.player_two)
    best_score, best = 0.0, None
    for game in games:
        tx = game_text(game)
        score = (4 if p1 and p1 in tx else 0) + (4 if p2 and p2 in tx else 0) + (1 if "tennis" in tx else 0)
        score += 2 * difflib.SequenceMatcher(None, f"{p1} {p2}", tx).ratio()
        if score > best_score:
            best_score, best = score, game
    return best if best_score >= 5.0 else None


def is_first_set_score(condition: Dict[str, Any]) -> bool:
    title = norm(condition.get("title"))
    return bool(re.search(r"first|1st|set 1|1 set", title)) and "score" in title and "match correct score" not in title


def outcome_score(outcome: Dict[str, Any]) -> str:
    return normalize_score(outcome.get("title") or outcome.get("name") or outcome.get("id"))


def outcome_odds(outcome: Dict[str, Any]) -> Optional[float]:
    for key in ["currentOdds", "odds", "rawCurrentOdds"]:
        o = decimal_odds(outcome.get(key))
        if o:
            return o
    return None


def virtual_funds(outcome: Dict[str, Any]) -> Any:
    for key in ["virtualFunds", "rawVirtualFunds", "funds", "rawFunds"]:
        if key in outcome:
            return outcome.get(key)
    return None


def find_condition(game: Dict[str, Any], scores: List[str]) -> Optional[Dict[str, Any]]:
    conditions = game.get("conditions") or []
    candidates = [c for c in conditions if is_first_set_score(c)] or conditions
    scored = []
    for c in candidates:
        hits = sum(1 for o in (c.get("outcomes") or []) if outcome_score(o) in scores)
        if hits:
            scored.append((hits, c))
    return max(scored, key=lambda x: x[0])[1] if scored else None


def backtest(alert: AlertRecord, args: argparse.Namespace, outcome_fields: str) -> BacktestRow:
    row = empty_row(args.run_id, alert, args.chain_id, args.subgraph_url, "INIT", "")
    if args.blocks_subgraph_url:
        block_n, block_ts, block_raw = block_by_subgraph(GraphQLClient(args.blocks_subgraph_url, args.timeout), alert.signal_timestamp, args.block_window_seconds)
    elif args.rpc_url:
        block_n, block_ts, block_raw = block_by_rpc(args.rpc_url, alert.signal_timestamp, args.timeout)
    else:
        row.decision = "BLOCK_SOURCE_MISSING"
        row.reason = "Provide blocks_subgraph_url or rpc_url. Historical replay needs timestamp-to-block mapping."
        return row
    row.block_lookup_json = block_raw
    row.raw_block_json = block_raw
    row.block_number = block_n
    row.block_timestamp = block_ts.isoformat() if block_ts else None
    if not block_n:
        row.decision = "BLOCK_NOT_FOUND"
        row.reason = "Could not map signal timestamp to block."
        return row

    data_client = GraphQLClient(args.subgraph_url, args.timeout)
    q = build_games_query(outcome_fields)
    from_ts = int((alert.match_date - timedelta(hours=args.match_window_hours)).timestamp())
    to_ts = int((alert.match_date + timedelta(hours=args.match_window_hours)).timestamp())
    data = data_client.query(q, {"from": str(from_ts), "to": str(to_ts), "first": args.games_first, "block": block_n})
    games = data.get("games") or []
    game = choose_game(alert, games)
    if not game:
        row.decision = "GAME_NOT_FOUND"
        row.reason = "No Azuro game matched players/date at pinned block."
        return row
    row.azuro_game_id = clean(game.get("id") or game.get("gameId"))
    row.azuro_game_title = clean(game.get("title"))
    row.raw_game_json = game
    condition = find_condition(game, alert.target_scores)
    if not condition:
        row.decision = "MARKET_NOT_SUPPORTED_BY_AZURO_PROVIDER"
        row.reason = "Matching game found, but First Set Correct Score market/sheet was absent."
        return row
    row.market_available = True
    row.azuro_condition_id = clean(condition.get("id") or condition.get("conditionId"))
    row.azuro_market_title = clean(condition.get("title"))
    row.raw_condition_json = condition
    score_rows = {}
    vf = {}
    for o in condition.get("outcomes") or []:
        score = outcome_score(o)
        if score not in alert.target_scores:
            continue
        item = {"score": score, "outcome_id": clean(o.get("outcomeId") or o.get("id")), "title": clean(o.get("title") or o.get("name")), "odds": outcome_odds(o), "virtual_funds": virtual_funds(o), "raw": o}
        score_rows[score] = item
        if item["virtual_funds"] is not None:
            vf[score] = item["virtual_funds"]
    row.score_outcomes_json = score_rows
    row.virtual_funds_json = vf or None
    missing = [s for s in alert.target_scores if s not in score_rows]
    if missing:
        row.decision = "SCORE_MISSING"
        row.reason = "Missing score outcomes: " + ", ".join(missing)
        return row
    row.azuro_grouped_odds = grouped_odds([score_rows[s]["odds"] for s in alert.target_scores])
    row.edge_vs_baseline = (row.azuro_grouped_odds - alert.baseline_grouped_odds) if row.azuro_grouped_odds and alert.baseline_grouped_odds else None
    if row.azuro_grouped_odds is None:
        row.decision = "ODDS_MISSING"
        row.reason = "Score outcomes exist, but odds were unavailable/unparseable."
    else:
        row.decision = "AVAILABLE"
        row.reason = "Historical game, market, score outcomes, and odds found at pinned block."
    return row


def supabase_get(url: str, key: str, path: str) -> Any:
    r = requests.get(f"{url.rstrip('/')}/rest/v1/{path}", headers={"apikey": key, "authorization": f"Bearer {key}"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase GET {r.status_code}: {r.text[:700]}")
    return r.json()


def supabase_insert(url: str, key: str, table: str, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    r = requests.post(f"{url.rstrip('/')}/rest/v1/{table}", headers={"apikey": key, "authorization": f"Bearer {key}", "content-type": "application/json", "prefer": "return=minimal"}, data=json.dumps(rows, default=json_default), timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase INSERT {r.status_code}: {r.text[:1000]}")


def load_supabase(args: argparse.Namespace) -> List[AlertRecord]:
    select = "id,signal_key,scanned_at,event_date,starts_at,match_name,strategy_lane,official_decimal_odds,original_official_decimal_odds,score_odds_json"
    lanes = ",".join(ACTIVE_LANES.keys())
    rows = supabase_get(args.supabase_url, args.supabase_key, f"{args.source_view}?select={select}&strategy_lane=in.({lanes})&order=scanned_at.desc&limit={args.limit}")
    alerts = []
    for r in rows:
        lane = clean(r.get("strategy_lane")) or None
        scores = parse_scores(None, lane)
        base_json = r.get("score_odds_json") if isinstance(r.get("score_odds_json"), dict) else None
        base_odds = score_odds_from_json(base_json, scores)
        baseline_grouped = grouped_odds((base_odds or {}).values()) if base_odds else decimal_odds(r.get("original_official_decimal_odds")) or decimal_odds(r.get("official_decimal_odds"))
        p1, p2 = parse_players(clean(r.get("match_name")))
        alerts.append(AlertRecord(
            player_one=p1,
            player_two=p2,
            match_date=parse_dt(r.get("starts_at") or r.get("event_date") or r.get("scanned_at")),
            signal_timestamp=parse_dt(r.get("scanned_at") or r.get("starts_at") or r.get("event_date")),
            target_market=DEFAULT_TARGET_MARKET,
            target_scores=scores,
            signal_id=clean(r.get("id")) or None,
            signal_key=clean(r.get("signal_key")) or None,
            match_name=clean(r.get("match_name")),
            strategy_lane=lane,
            baseline_grouped_odds=baseline_grouped,
            baseline_score_odds_json=base_json,
        ))
    return alerts


def load_csv(path: str) -> List[AlertRecord]:
    df = pd.read_csv(path)
    alerts = []
    for _, r in df.iterrows():
        lane = clean(r.get("strategy_lane")) or None
        match = clean(r.get("match_name"))
        p1, p2 = clean(r.get("player_one")), clean(r.get("player_two"))
        if (not p1 or not p2) and match:
            p1, p2 = parse_players(match)
        scores = parse_scores(r.get("target_scores"), lane)
        base_json = json.loads(r.get("baseline_score_odds_json")) if clean(r.get("baseline_score_odds_json")) else None
        base = decimal_odds(r.get("baseline_grouped_odds")) or grouped_odds((score_odds_from_json(base_json, scores) or {}).values())
        alerts.append(AlertRecord(p1, p2, parse_dt(r.get("match_date")), parse_dt(r.get("signal_timestamp")), clean(r.get("target_market")) or DEFAULT_TARGET_MARKET, scores, clean(r.get("signal_id")) or None, clean(r.get("signal_key")) or None, match, lane, base, base_json))
    return alerts


def json_default(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return str(v)


def dataframe(rows: List[BacktestRow]) -> pd.DataFrame:
    out = []
    for r in rows:
        d = asdict(r)
        d["target_scores"] = "/".join(r.target_scores)
        d["baseline_score_odds_json"] = json.dumps(r.baseline_score_odds_json or {}, sort_keys=True)
        d["score_outcomes_json"] = json.dumps(r.score_outcomes_json or {}, sort_keys=True)
        d["virtual_funds_json"] = json.dumps(r.virtual_funds_json or {}, sort_keys=True)
        out.append(d)
    return pd.DataFrame(out)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    p.add_argument("--input-csv", default="")
    p.add_argument("--out-dir", default="artifacts/output/azuro-historical-first-set-backtest")
    p.add_argument("--run-id", default="azuro_hist_v2_" + datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-"))
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--source-view", default=DEFAULT_SOURCE_VIEW)
    p.add_argument("--supabase-url", default=os.getenv("SUPABASE_URL", "https://qjvpkkcbscsypymxyker.supabase.co"))
    p.add_argument("--supabase-key", default=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    p.add_argument("--write-supabase", default=os.getenv("WRITE_SUPABASE", "true"), choices=["true", "false"])
    p.add_argument("--subgraph-url", default=os.getenv("AZURO_DATA_FEED_SUBGRAPH_URL", DEFAULT_DATA_FEED_SUBGRAPH))
    p.add_argument("--blocks-subgraph-url", default=os.getenv("BLOCKS_SUBGRAPH_URL", ""))
    p.add_argument("--rpc-url", default=os.getenv("RPC_URL", ""))
    p.add_argument("--chain-id", default=os.getenv("CHAIN_ID", "polygon"))
    p.add_argument("--block-window-seconds", type=int, default=int(os.getenv("BLOCK_WINDOW_SECONDS", "900")))
    p.add_argument("--match-window-hours", type=int, default=int(os.getenv("MATCH_WINDOW_HOURS", "36")))
    p.add_argument("--games-first", type=int, default=int(os.getenv("GAMES_FIRST", "200")))
    p.add_argument("--timeout", type=int, default=int(os.getenv("GRAPHQL_TIMEOUT", "30")))
    return p


def main() -> int:
    args = parser().parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    alerts = load_csv(args.input_csv) if args.input_csv else load_supabase(args)
    outcome_fields = pick_outcome_fields(gql_fields(GraphQLClient(args.subgraph_url, args.timeout), "Outcome"))
    if not outcome_fields.strip():
        outcome_fields = "id"
    rows = []
    for i, alert in enumerate(alerts, start=1):
        print(f"[{i}/{len(alerts)}] {alert.match_name or alert.player_one + ' vs ' + alert.player_two} {alert.target_scores}")
        try:
            rows.append(backtest(alert, args, outcome_fields))
        except Exception as exc:
            rows.append(empty_row(args.run_id, alert, args.chain_id, args.subgraph_url, "API_ERROR", str(exc)))
    df = dataframe(rows)
    df.to_csv(out_dir / "azuro_historical_first_set_backtest.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    (out_dir / "azuro_historical_first_set_backtest.json").write_text(json.dumps([asdict(r) for r in rows], default=json_default, indent=2), encoding="utf-8")
    summary = {
        "run_id": args.run_id,
        "rows": len(rows),
        "subgraph_url": args.subgraph_url,
        "blocks_subgraph_url": args.blocks_subgraph_url,
        "rpc_url_configured": bool(args.rpc_url),
        "outcome_fields": outcome_fields.split(),
        "decisions": df["decision"].value_counts().to_dict() if len(df) else {},
        "note": "SAFE MODE historical backtest. No wallet, no signing, no order submission. If BLOCK_SOURCE_MISSING appears, provide blocks_subgraph_url or rpc_url.",
    }
    (out_dir / "azuro_historical_first_set_backtest_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out_dir / "sample_time_travel_queries.graphql").write_text(BLOCKS_QUERY + "\n\n" + build_games_query(outcome_fields), encoding="utf-8")
    if args.write_supabase == "true" and args.supabase_key:
        # Do not insert BLOCK_SOURCE_MISSING rows; they are operator config errors, not historical evidence.
        insert_rows = [asdict(r) for r in rows if r.decision != "BLOCK_SOURCE_MISSING"]
        supabase_insert(args.supabase_url, args.supabase_key, "azuro_historical_backtest_v1", insert_rows)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
