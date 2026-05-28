#!/usr/bin/env python3
"""
First Set Lab / SlipIQ historical Azuro V3 data-feed subgraph backtester.

SAFE MODE ONLY:
- No wallet access.
- No signing.
- No order submission.
- No private keys.

Purpose:
For each historical First Set Lab alert, map the tennis match to an Azuro data-feed
subgraph Game at the block closest to the signal timestamp, isolate the First Set
Correct Score condition, extract target score odds, optionally extract virtualFunds
if the subgraph schema exposes it, and compare Azuro historical grouped odds to the
baseline odds logged by First Set Lab.

Required Python packages:
  pip install requests pandas

Input modes:
  1) CSV file with columns:
     player_one, player_two, match_date, signal_timestamp, target_market,
     target_scores, optional baseline_score_odds_json, optional baseline_grouped_odds

  2) Supabase REST source view, default proof_vault_recent_receipts_v2_protected.

Important:
Azuro's V3 data-feed subgraphs are deprecated for live feed rendering. This script
uses them only for historical, block-pinned replay/backtesting. Live execution or
current market data should use the Backend API instead.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import json
import math
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
import requests

DEFAULT_DATA_FEED_SUBGRAPH = "https://thegraph-1.onchainfeed.org/subgraphs/name/azuro-protocol/azuro-data-feed-polygon"
DEFAULT_SOURCE_VIEW = "proof_vault_recent_receipts_v2_protected"
DEFAULT_TARGET_MARKET = "First Set Correct Score"
ACTIVE_LANES = {
    "CORE_P1_ATP_GS_BET365": ["6:2", "6:3", "6:4"],
    "CORE_P2_GS_REVERSE_STRETCH_BET365": ["2:6", "4:6", "5:7"],
    "RESEARCH_P2_GS_26_46_BET365": ["2:6", "4:6", "5:7"],
    "VIP_P2_V3_SHAPE": ["3:6", "4:6", "5:7"],
}
SCORES_OF_INTEREST = ["6:2", "6:3", "6:4", "2:6", "4:6", "5:7", "3:6"]


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


def utc_now_run_id() -> str:
    return "azuro_hist_" + datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")


def parse_dt(value: Any) -> datetime:
    if value is None or str(value).strip() == "":
        raise ValueError("missing timestamp")
    text = str(value).strip()
    if text.isdigit():
        n = int(text)
        if n > 10_000_000_000:
            n = n // 1000
        return datetime.fromtimestamp(n, tz=timezone.utc)
    text = text.replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def norm(value: Any) -> str:
    text = clean(value).lower()
    text = re.sub(r"[^a-z0-9:.-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_score(value: Any) -> str:
    text = clean(value).replace("-", ":")
    m = re.search(r"\b(\d+)\s*:\s*(\d+)\b", text)
    return f"{m.group(1)}:{m.group(2)}" if m else ""


def parse_target_scores(value: Any, lane: Optional[str] = None) -> List[str]:
    if lane and lane in ACTIVE_LANES:
        return ACTIVE_LANES[lane]
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return []
    if isinstance(value, list):
        raw = value
    else:
        text = str(value).strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            raw = parsed if isinstance(parsed, list) else [text]
        except json.JSONDecodeError:
            raw = re.split(r"[,/|]", text)
    scores = [normalize_score(x) for x in raw]
    return [s for s in scores if s]


def parse_json_maybe(value: Any) -> Optional[Dict[str, Any]]:
    if value is None or value == "" or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def parse_players_from_match_name(match_name: str) -> Tuple[str, str]:
    raw = clean(match_name)
    raw = re.sub(r"\s+vs\.?\s+", " v ", raw, flags=re.I)
    raw = re.sub(r"\s+@\s+", " v ", raw, flags=re.I)
    raw = re.sub(r"\s+-\s+", " v ", raw, count=1)
    parts = [clean(x) for x in re.split(r"\s+v\s+", raw, flags=re.I) if clean(x)]
    if len(parts) >= 2:
        return parts[0], " v ".join(parts[1:])
    return raw, ""


def score_odds_from_json(score_odds_json: Optional[Dict[str, Any]], target_scores: List[str]) -> Optional[Dict[str, float]]:
    if not score_odds_json:
        return None
    out: Dict[str, float] = {}
    for score in target_scores:
        candidates = [score, score.replace(":", "-"), score.replace(":", "_")]
        for key in candidates:
            if key in score_odds_json:
                odd = decimal_odds(score_odds_json[key])
                if odd:
                    out[score] = odd
                break
    return out or None


def grouped_odds(odds: Iterable[Any]) -> Optional[float]:
    xs: List[float] = []
    for value in odds:
        odd = decimal_odds(value)
        if not odd or odd <= 1:
            return None
        xs.append(odd)
    if not xs:
        return None
    implied = sum(1.0 / x for x in xs)
    return 1.0 / implied if implied > 0 else None


def decimal_odds(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        n = float(str(value).replace(",", "."))
    except Exception:
        return None
    if not math.isfinite(n) or n <= 1:
        return None
    # Azuro raw odds may be 1e12 scaled. BigDecimal odds are usually already small.
    if n > 1_000_000:
        return n / 1e12
    return n


class GraphQLClient:
    def __init__(self, endpoint: str, timeout: int = 30, retries: int = 2, sleep_s: float = 0.5):
        self.endpoint = endpoint
        self.timeout = timeout
        self.retries = retries
        self.sleep_s = sleep_s

    def query(self, query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {"query": query, "variables": variables or {}}
        last_error: Optional[Exception] = None
        for attempt in range(self.retries + 1):
            try:
                response = requests.post(self.endpoint, json=payload, timeout=self.timeout)
                text = response.text
                if response.status_code >= 400:
                    raise RuntimeError(f"GraphQL HTTP {response.status_code}: {text[:700]}")
                body = response.json()
                if body.get("errors"):
                    raise RuntimeError(f"GraphQL errors: {json.dumps(body['errors'])[:1200]}")
                return body.get("data") or {}
            except Exception as exc:
                last_error = exc
                if attempt < self.retries:
                    time.sleep(self.sleep_s * (attempt + 1))
        raise RuntimeError(str(last_error))


def introspect_fields(client: GraphQLClient, type_name: str) -> List[str]:
    query = """
    query TypeFields($name: String!) {
      __type(name: $name) {
        fields { name }
      }
    }
    """
    try:
        data = client.query(query, {"name": type_name})
        return [f["name"] for f in ((data.get("__type") or {}).get("fields") or [])]
    except Exception:
        return []


def outcome_field_selection(outcome_fields: List[str]) -> str:
    # Keep this conservative. Unknown fields make GraphQL fail, so only request what schema exposes.
    wanted = [
        "id",
        "outcomeId",
        "title",
        "name",
        "currentOdds",
        "odds",
        "rawCurrentOdds",
        "virtualFunds",
        "rawVirtualFunds",
        "funds",
        "rawFunds",
    ]
    selected = [f for f in wanted if f in outcome_fields]
    if "id" not in selected:
        selected.insert(0, "id")
    if "outcomeId" not in selected and "outcomeId" in outcome_fields:
        selected.append("outcomeId")
    if "title" not in selected and "title" in outcome_fields:
        selected.append("title")
    return "\n".join(selected)


BLOCK_QUERY = """
query BlockByTimestamp($from: Int!, $to: Int!) {
  blocks(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_gte: $from, timestamp_lte: $to }) {
    number
    timestamp
  }
}
"""


def lookup_block(blocks_client: GraphQLClient, timestamp: datetime, window_seconds: int) -> Tuple[Optional[int], Optional[datetime], Dict[str, Any]]:
    ts = int(timestamp.timestamp())
    variables = {"from": ts - window_seconds, "to": ts}
    data = blocks_client.query(BLOCK_QUERY, variables)
    blocks = data.get("blocks") or []
    if not blocks:
        # Try forward fallback for sparse block subgraphs.
        variables = {"from": ts, "to": ts + window_seconds}
        data = blocks_client.query(BLOCK_QUERY, variables)
        blocks = data.get("blocks") or []
    if not blocks:
        return None, None, {"query": "BlockByTimestamp", "variables": variables, "response": data}
    block = blocks[0]
    block_number = int(block["number"])
    block_ts = datetime.fromtimestamp(int(block["timestamp"]), tz=timezone.utc)
    return block_number, block_ts, {"query": "BlockByTimestamp", "variables": variables, "response": data}


def build_games_query(outcome_selection: str) -> str:
    return f"""
query HistoricalGames($from: BigInt!, $to: BigInt!, $first: Int!, $block: Int!) {{
  games(first: $first, where: {{ startsAt_gte: $from, startsAt_lte: $to }}, block: {{ number: $block }}) {{
    id
    gameId
    title
    startsAt
    state
    sport {{ name slug }}
    league {{ name }}
    participants {{ name sortOrder }}
    conditions {{
      id
      conditionId
      title
      state
      isPrematchEnabled
      isLiveEnabled
      maxConditionPotentialLoss
      maxOutcomePotentialLoss
      currentConditionPotentialLoss
      outcomes {{
        {outcome_selection}
      }}
    }}
  }}
}}
"""


def build_game_query(outcome_selection: str) -> str:
    return f"""
query HistoricalGameConditions($gameId: ID!, $block: Int!) {{
  game(id: $gameId, block: {{ number: $block }}) {{
    id
    gameId
    title
    startsAt
    state
    sport {{ name slug }}
    league {{ name }}
    participants {{ name sortOrder }}
    conditions {{
      id
      conditionId
      title
      state
      isPrematchEnabled
      isLiveEnabled
      maxConditionPotentialLoss
      maxOutcomePotentialLoss
      currentConditionPotentialLoss
      outcomes {{
        {outcome_selection}
      }}
    }}
  }}
}}
"""


def game_text(game: Dict[str, Any]) -> str:
    participants = " ".join(clean(p.get("name")) for p in game.get("participants") or [])
    league = clean((game.get("league") or {}).get("name"))
    sport = clean((game.get("sport") or {}).get("name"))
    return norm(" ".join([clean(game.get("title")), participants, league, sport]))


def choose_game(alert: AlertRecord, games: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    p1 = norm(alert.player_one)
    p2 = norm(alert.player_two)
    best: Tuple[float, Optional[Dict[str, Any]]] = (0.0, None)
    for game in games:
        text = game_text(game)
        score = 0.0
        if p1 and p1 in text:
            score += 4
        if p2 and p2 in text:
            score += 4
        if "tennis" in text:
            score += 1
        participant_names = [norm(p.get("name")) for p in game.get("participants") or []]
        target_joined = " ".join([p1, p2])
        participant_joined = " ".join(participant_names)
        score += 2 * difflib.SequenceMatcher(None, target_joined, participant_joined).ratio()
        if score > best[0]:
            best = (score, game)
    return best[1] if best[0] >= 5.5 else None


def is_first_set_correct_score(condition: Dict[str, Any], target_market: str) -> bool:
    title = norm(condition.get("title"))
    target = norm(target_market)
    first_set = bool(re.search(r"first|1st|set 1|1 set", title))
    correct_score = "score" in title and ("correct" in title or "score" in target)
    not_match_score = "match correct score" not in title
    return first_set and correct_score and not_match_score


def outcome_title(outcome: Dict[str, Any]) -> str:
    return clean(outcome.get("title") or outcome.get("name") or outcome.get("id"))


def outcome_score(outcome: Dict[str, Any]) -> str:
    return normalize_score(outcome_title(outcome))


def outcome_id(outcome: Dict[str, Any]) -> str:
    return clean(outcome.get("outcomeId") or outcome.get("id"))


def outcome_odds(outcome: Dict[str, Any]) -> Optional[float]:
    for key in ["currentOdds", "odds", "rawCurrentOdds"]:
        odd = decimal_odds(outcome.get(key))
        if odd:
            return odd
    return None


def outcome_virtual_funds(outcome: Dict[str, Any]) -> Optional[Any]:
    for key in ["virtualFunds", "rawVirtualFunds", "funds", "rawFunds"]:
        if key in outcome:
            return outcome.get(key)
    return None


def find_market(game: Dict[str, Any], alert: AlertRecord) -> Optional[Dict[str, Any]]:
    conditions = game.get("conditions") or []
    exact = [c for c in conditions if is_first_set_correct_score(c, alert.target_market)]
    if exact:
        # Prefer the condition with most requested score labels present.
        return max(exact, key=lambda c: sum(1 for o in c.get("outcomes") or [] if outcome_score(o) in alert.target_scores))
    # Fallback: some data providers have poor titles. Use target score overlap only.
    overlap = []
    for condition in conditions:
        hits = sum(1 for o in condition.get("outcomes") or [] if outcome_score(o) in alert.target_scores)
        if hits:
            overlap.append((hits, condition))
    return max(overlap, key=lambda x: x[0])[1] if overlap else None


def extract_score_outcomes(condition: Dict[str, Any], target_scores: List[str]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    score_map: Dict[str, Dict[str, Any]] = {}
    vf_map: Dict[str, Any] = {}
    for outcome in condition.get("outcomes") or []:
        score = outcome_score(outcome)
        if score not in target_scores:
            continue
        odd = outcome_odds(outcome)
        vf = outcome_virtual_funds(outcome)
        score_map[score] = {
            "score": score,
            "outcome_id": outcome_id(outcome),
            "title": outcome_title(outcome),
            "odds": odd,
            "virtual_funds": vf,
            "raw": outcome,
        }
        if vf is not None:
            vf_map[score] = vf
    return score_map, vf_map


def build_empty_row(run_id: str, alert: AlertRecord, chain_id: str, subgraph_url: str, decision: str, reason: str) -> BacktestRow:
    return BacktestRow(
        run_id=run_id,
        source="azuro_historical_subgraph_backtest",
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


def backtest_alert(
    alert: AlertRecord,
    run_id: str,
    data_client: GraphQLClient,
    blocks_client: GraphQLClient,
    outcome_selection: str,
    chain_id: str,
    subgraph_url: str,
    block_window_seconds: int,
    match_window_hours: int,
    games_first: int,
) -> BacktestRow:
    row = build_empty_row(run_id, alert, chain_id, subgraph_url, "INIT", "")
    block_number, block_ts, block_lookup = lookup_block(blocks_client, alert.signal_timestamp, block_window_seconds)
    row.block_lookup_json = block_lookup
    row.raw_block_json = block_lookup
    if block_number is None:
        row.decision = "BLOCK_NOT_FOUND"
        row.reason = "Could not map signal_timestamp to a historical block from the configured blocks subgraph."
        return row

    row.block_number = block_number
    row.block_timestamp = block_ts.isoformat() if block_ts else None

    from_ts = int((alert.match_date - timedelta(hours=match_window_hours)).timestamp())
    to_ts = int((alert.match_date + timedelta(hours=match_window_hours)).timestamp())
    games_query = build_games_query(outcome_selection)
    data = data_client.query(games_query, {"from": str(from_ts), "to": str(to_ts), "first": games_first, "block": block_number})
    games = data.get("games") or []
    game = choose_game(alert, games)
    if not game:
        row.decision = "GAME_NOT_FOUND"
        row.reason = "No Azuro data-feed Game matched player names and match_date window at the historical block."
        return row

    # Re-fetch by exact game id at the same block to keep the row compact and deterministic.
    game_query = build_game_query(outcome_selection)
    game_data = data_client.query(game_query, {"gameId": game["id"], "block": block_number})
    game = game_data.get("game") or game
    row.azuro_game_id = clean(game.get("id") or game.get("gameId"))
    row.azuro_game_title = clean(game.get("title"))
    row.raw_game_json = game

    condition = find_market(game, alert)
    if not condition:
        row.decision = "MARKET_NOT_SUPPORTED_BY_AZURO_PROVIDER"
        row.reason = "Historical block has a matching game, but no First Set Correct Score condition/sheet was exposed."
        return row

    row.azuro_condition_id = clean(condition.get("id") or condition.get("conditionId"))
    row.azuro_market_title = clean(condition.get("title"))
    row.raw_condition_json = condition
    row.market_available = True

    score_outcomes, vf_map = extract_score_outcomes(condition, alert.target_scores)
    row.score_outcomes_json = score_outcomes
    row.virtual_funds_json = vf_map or None

    missing = [score for score in alert.target_scores if score not in score_outcomes]
    azuro_odds_by_score = [score_outcomes[s]["odds"] for s in alert.target_scores if s in score_outcomes]
    row.azuro_grouped_odds = grouped_odds(azuro_odds_by_score) if len(azuro_odds_by_score) == len(alert.target_scores) else None
    row.edge_vs_baseline = (row.azuro_grouped_odds - alert.baseline_grouped_odds) if row.azuro_grouped_odds and alert.baseline_grouped_odds else None

    if missing:
        row.decision = "SCORE_MISSING"
        row.reason = f"Market exists but target score outcomes missing: {', '.join(missing)}"
    elif row.azuro_grouped_odds is None:
        row.decision = "ODDS_MISSING"
        row.reason = "All target scores exist, but one or more historical Azuro odds values were unavailable/unparseable."
    else:
        row.decision = "AVAILABLE"
        row.reason = "Historical game, First Set Correct Score market, target outcomes, and odds were all available at the pinned block."
    return row


def load_csv(path_name: str) -> List[AlertRecord]:
    df = pd.read_csv(path_name)
    alerts: List[AlertRecord] = []
    for _, row in df.iterrows():
        lane = clean(row.get("strategy_lane")) or None
        match_name = clean(row.get("match_name")) or None
        p1 = clean(row.get("player_one"))
        p2 = clean(row.get("player_two"))
        if (not p1 or not p2) and match_name:
            p1, p2 = parse_players_from_match_name(match_name)
        target_scores = parse_target_scores(row.get("target_scores"), lane)
        baseline_json = parse_json_maybe(row.get("baseline_score_odds_json")) or parse_json_maybe(row.get("score_odds_json"))
        baseline_grouped = row.get("baseline_grouped_odds")
        baseline_grouped_f = float(baseline_grouped) if baseline_grouped not in [None, ""] and not pd.isna(baseline_grouped) else None
        if baseline_grouped_f is None:
            baseline_score_odds = score_odds_from_json(baseline_json, target_scores)
            baseline_grouped_f = grouped_odds((baseline_score_odds or {}).values()) if baseline_score_odds else None
        alerts.append(AlertRecord(
            player_one=p1,
            player_two=p2,
            match_date=parse_dt(row.get("match_date") or row.get("starts_at") or row.get("event_date")),
            signal_timestamp=parse_dt(row.get("signal_timestamp") or row.get("scanned_at") or row.get("created_at")),
            target_market=clean(row.get("target_market")) or DEFAULT_TARGET_MARKET,
            target_scores=target_scores,
            signal_id=clean(row.get("signal_id") or row.get("id")) or None,
            signal_key=clean(row.get("signal_key")) or None,
            match_name=match_name,
            strategy_lane=lane,
            baseline_grouped_odds=baseline_grouped_f,
            baseline_score_odds_json=baseline_json,
        ))
    return alerts


def supabase_get(url: str, key: str, path_and_query: str) -> Any:
    endpoint = f"{url.rstrip('/')}/rest/v1/{path_and_query}"
    response = requests.get(endpoint, headers={"apikey": key, "authorization": f"Bearer {key}"}, timeout=30)
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase GET failed {response.status_code}: {response.text[:700]}")
    return response.json()


def supabase_insert(url: str, key: str, table: str, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}"
    response = requests.post(
        endpoint,
        headers={"apikey": key, "authorization": f"Bearer {key}", "content-type": "application/json", "prefer": "return=minimal"},
        data=json.dumps(rows, default=json_default),
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Supabase insert failed {response.status_code}: {response.text[:1000]}")


def load_supabase_alerts(url: str, key: str, view: str, limit: int) -> List[AlertRecord]:
    select = ",".join([
        "id", "signal_key", "scanned_at", "event_date", "starts_at", "match_name", "strategy_lane",
        "public_signal_name", "official_decimal_odds", "original_official_decimal_odds", "score_odds_json", "status", "display_status"
    ])
    lanes = ",".join(ACTIVE_LANES.keys())
    query = f"{view}?select={select}&strategy_lane=in.({lanes})&order=scanned_at.desc&limit={limit}"
    rows = supabase_get(url, key, query)
    alerts: List[AlertRecord] = []
    for row in rows:
        match_name = clean(row.get("match_name"))
        p1, p2 = parse_players_from_match_name(match_name)
        lane = clean(row.get("strategy_lane")) or None
        target_scores = parse_target_scores(None, lane)
        baseline_json = row.get("score_odds_json") if isinstance(row.get("score_odds_json"), dict) else parse_json_maybe(row.get("score_odds_json"))
        baseline_score_odds = score_odds_from_json(baseline_json, target_scores)
        baseline_grouped = grouped_odds((baseline_score_odds or {}).values()) if baseline_score_odds else decimal_odds(row.get("original_official_decimal_odds")) or decimal_odds(row.get("official_decimal_odds"))
        signal_ts = parse_dt(row.get("scanned_at") or row.get("starts_at") or row.get("event_date"))
        match_dt = parse_dt(row.get("starts_at") or row.get("event_date") or row.get("scanned_at"))
        alerts.append(AlertRecord(
            player_one=p1,
            player_two=p2,
            match_date=match_dt,
            signal_timestamp=signal_ts,
            target_market=DEFAULT_TARGET_MARKET,
            target_scores=target_scores,
            signal_id=clean(row.get("id")) or None,
            signal_key=clean(row.get("signal_key")) or None,
            match_name=match_name,
            strategy_lane=lane,
            baseline_grouped_odds=baseline_grouped,
            baseline_score_odds_json=baseline_json,
        ))
    return alerts


def json_default(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
    return str(value)


def row_to_supabase(row: BacktestRow) -> Dict[str, Any]:
    d = asdict(row)
    return d


def rows_to_dataframe(rows: List[BacktestRow]) -> pd.DataFrame:
    flat_rows: List[Dict[str, Any]] = []
    for row in rows:
        d = asdict(row)
        d["target_scores"] = "/".join(row.target_scores)
        d["baseline_score_odds_json"] = json.dumps(row.baseline_score_odds_json or {}, sort_keys=True)
        d["score_outcomes_json"] = json.dumps(row.score_outcomes_json or {}, sort_keys=True)
        d["virtual_funds_json"] = json.dumps(row.virtual_funds_json or {}, sort_keys=True)
        flat_rows.append(d)
    return pd.DataFrame(flat_rows)


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Backtest First Set Lab alerts against historical Azuro data-feed subgraph blocks.")
    p.add_argument("--input-csv", default="", help="Optional CSV input. If omitted, load from Supabase source view.")
    p.add_argument("--out-dir", default="artifacts/output/azuro-historical-first-set-backtest")
    p.add_argument("--run-id", default=utc_now_run_id())
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--source-view", default=DEFAULT_SOURCE_VIEW)
    p.add_argument("--supabase-url", default=os.getenv("SUPABASE_URL", "https://qjvpkkcbscsypymxyker.supabase.co"))
    p.add_argument("--supabase-key", default=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    p.add_argument("--write-supabase", default=os.getenv("WRITE_SUPABASE", "true"), choices=["true", "false"])
    p.add_argument("--subgraph-url", default=os.getenv("AZURO_DATA_FEED_SUBGRAPH_URL", DEFAULT_DATA_FEED_SUBGRAPH))
    p.add_argument("--blocks-subgraph-url", default=os.getenv("BLOCKS_SUBGRAPH_URL", ""), help="Required for timestamp -> block mapping.")
    p.add_argument("--chain-id", default=os.getenv("CHAIN_ID", "polygon"))
    p.add_argument("--block-window-seconds", type=int, default=int(os.getenv("BLOCK_WINDOW_SECONDS", "900")))
    p.add_argument("--match-window-hours", type=int, default=int(os.getenv("MATCH_WINDOW_HOURS", "36")))
    p.add_argument("--games-first", type=int, default=int(os.getenv("GAMES_FIRST", "200")))
    p.add_argument("--timeout", type=int, default=int(os.getenv("GRAPHQL_TIMEOUT", "30")))
    return p


def main() -> int:
    args = build_arg_parser().parse_args()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not args.blocks_subgraph_url:
        raise SystemExit("BLOCKS_SUBGRAPH_URL is required. Exact signal_timestamp replay needs timestamp-to-block mapping.")

    if args.input_csv:
        alerts = load_csv(args.input_csv)
    else:
        if not args.supabase_key:
            raise SystemExit("SUPABASE_SERVICE_ROLE_KEY is required when --input-csv is not provided.")
        alerts = load_supabase_alerts(args.supabase_url, args.supabase_key, args.source_view, args.limit)

    data_client = GraphQLClient(args.subgraph_url, timeout=args.timeout)
    blocks_client = GraphQLClient(args.blocks_subgraph_url, timeout=args.timeout)

    outcome_fields = introspect_fields(data_client, "Outcome")
    outcome_selection = outcome_field_selection(outcome_fields)
    schema_note = {
        "outcome_fields": outcome_fields,
        "outcome_selection": outcome_selection,
        "virtual_funds_available": any(f in outcome_fields for f in ["virtualFunds", "rawVirtualFunds", "funds", "rawFunds"]),
    }

    rows: List[BacktestRow] = []
    for i, alert in enumerate(alerts, start=1):
        print(f"[{i}/{len(alerts)}] {alert.player_one} vs {alert.player_two} @ {alert.signal_timestamp.isoformat()} scores={alert.target_scores}")
        try:
            rows.append(backtest_alert(
                alert=alert,
                run_id=args.run_id,
                data_client=data_client,
                blocks_client=blocks_client,
                outcome_selection=outcome_selection,
                chain_id=args.chain_id,
                subgraph_url=args.subgraph_url,
                block_window_seconds=args.block_window_seconds,
                match_window_hours=args.match_window_hours,
                games_first=args.games_first,
            ))
        except Exception as exc:
            row = build_empty_row(args.run_id, alert, args.chain_id, args.subgraph_url, "API_ERROR", str(exc))
            rows.append(row)

    df = rows_to_dataframe(rows)
    csv_path = out_dir / "azuro_historical_first_set_backtest.csv"
    json_path = out_dir / "azuro_historical_first_set_backtest.json"
    summary_path = out_dir / "azuro_historical_first_set_backtest_summary.json"
    query_path = out_dir / "sample_time_travel_queries.graphql"

    df.to_csv(csv_path, index=False, quoting=csv.QUOTE_MINIMAL)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump([asdict(row) for row in rows], f, default=json_default, indent=2)

    summary = {
        "run_id": args.run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rows": len(rows),
        "subgraph_url": args.subgraph_url,
        "blocks_subgraph_url": args.blocks_subgraph_url,
        "schema_note": schema_note,
        "decisions": df["decision"].value_counts().to_dict() if len(df) else {},
        "available_rows": int((df["decision"] == "AVAILABLE").sum()) if len(df) else 0,
        "market_available_rows": int((df["market_available"] == True).sum()) if len(df) else 0,
        "note": "SAFE MODE historical subgraph backtest only. No wallet, signing, or order execution.",
    }
    with summary_path.open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    query_path.write_text(
        "# Timestamp -> block lookup\n" + BLOCK_QUERY + "\n\n"
        "# Historical game search pinned to block\n" + build_games_query(outcome_selection) + "\n\n"
        "# Historical game condition/outcome replay pinned to block\n" + build_game_query(outcome_selection) + "\n",
        encoding="utf-8",
    )

    if args.write_supabase == "true":
        if not args.supabase_key:
            raise SystemExit("SUPABASE_SERVICE_ROLE_KEY required for --write-supabase=true")
        supabase_insert(args.supabase_url, args.supabase_key, "azuro_historical_backtest_v1", [row_to_supabase(r) for r in rows])

    print(json.dumps(summary, indent=2))
    print(f"Wrote {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
