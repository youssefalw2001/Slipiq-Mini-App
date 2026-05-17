#!/usr/bin/env python3
"""SlipIQ Winning-Side 9-12 Cluster Audit + Optimizer.

Focus ONLY on the grouped first-set 9-12 strategy.

P1 mirror cluster:
  6:3 / 6:4 / 7:5
P2 cluster:
  3:6 / 4:6 / 5:7

Purpose:
- Audit funnel counts before judging ROI.
- Force ATP/WTA from event_type_key when possible.
- Verify score orientation samples.
- Verify Home/Away and Home/Away (1st Set) mapping samples.
- Build one candidate per match + bookmaker + side.
- Output fixed-book, random-book stress, and best-book diagnostic results separately.

Inputs from full warehouse artifact:
- first_set_correct_score_wide_combined.csv
- moneyline_favorite_combined.csv
- fixtures_full_combined.csv optional
- odds_full_long_combined.csv optional, only for raw Home/Away audit labels
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

P1_SCORES = {"6:3", "6:4", "7:5"}
P2_SCORES = {"3:6", "4:6", "5:7"}
P1_SCORE_COLS = ["odds_6_3", "odds_6_4", "odds_7_5"]
P2_SCORE_COLS = ["odds_3_6", "odds_4_6", "odds_5_7"]
EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}


def clean(x):
    return str(x or "").strip()


def fnum(x):
    try:
        if x is None or str(x).strip() == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def grouped_odds(vals):
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums):
        return None
    imp = sum(1 / v for v in nums)
    return 1 / imp if imp else None


def safe_pct(a, b):
    return None if not b else a / b


def tour_from_row(row):
    key = clean(row.get("event_type_key"))
    if key in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[key]
    s = f"{row.get('event_type_type','')} {row.get('tournament_name','')}".lower()
    if "wta" in s or "women" in s:
        return "WTA"
    if "atp" in s or "men" in s:
        return "ATP"
    return "UNKNOWN"


def tournament_group(row):
    t = row.get("tournament_name", "").lower()
    if any(k in t for k in ["australian open", "roland garros", "french open", "wimbledon", "us open"]):
        return "GRAND_SLAM"
    if any(k in t for k in ["indian wells", "miami", "monte carlo", "madrid", "rome", "italian open", "canada", "canadian open", "toronto", "montreal", "cincinnati", "shanghai", "paris", "beijing", "wuhan", "doha", "dubai", "qatar open"]):
        return "MASTERS_1000"
    if any(k in t for k in ["barcelona", "halle", "queen", "queens", "london", "stuttgart", "charleston", "washington", "hamburg", "tokyo", "acapulco", "eastbourne", "rotterdam", "basel", "vienna", "adelaide", "brisbane", "bad homburg", "berlin", "strasbourg", "antwerp", "dallas", "rio", "astana", "chengdu", "zhuhai", "seoul"]):
        return "STRONG_500_250"
    if any(k in t for k in ["challenger", "itf", "m25", "m15", "w15", "w25", "w35", "w50", "w75", "w100", "w125"]):
        return "LOWER_TIER"
    return "OTHER_TOUR"


def odds_band(v):
    if v is None:
        return "missing"
    bins = [(0, 2.8), (2.8, 3.0), (3.0, 3.2), (3.2, 3.5), (3.5, 3.75), (3.75, 4.0), (4.0, 4.5), (4.5, 5.0), (5.0, 6.0), (6.0, 999)]
    for a, b in bins:
        if a <= v < b:
            return f"{a:.2f}-{b:.2f}" if b < 999 else "6.00+"
    return "other"


def middle_band(v):
    if v is None:
        return "missing"
    bins = [(0, 6.25), (6.25, 7.0), (7.0, 8.0), (8.0, 9.0), (9.0, 10.0), (10.0, 12.0), (12.0, 999)]
    for a, b in bins:
        if a <= v < b:
            return f"{a:.2f}-{b:.2f}" if b < 999 else "12.00+"
    return "other"


def bucket_from_fav_odds(odds: Optional[float]) -> str:
    if odds is None:
        return "unknown"
    if odds < 1.35:
        return "strong_favorite"
    if odds < 1.65:
        return "favorite"
    if odds < 1.95:
        return "slight_favorite"
    return "near_even"


def side_bucket(side: str, favorite_side: str, fav_bucket: str) -> str:
    if favorite_side in {"", "unknown"} or fav_bucket == "unknown":
        return "unknown"
    if favorite_side == "EVEN":
        return "near_even"
    if side == favorite_side:
        return fav_bucket
    if fav_bucket == "near_even":
        return "near_even"
    if fav_bucket == "slight_favorite":
        return "slight_underdog"
    if fav_bucket == "favorite":
        return "underdog"
    if fav_bucket == "strong_favorite":
        return "strong_underdog"
    return "unknown"


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def normalize_wide(row):
    row = dict(row)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tournament_name", "event_type_type", "first_set_score", "market_name"]:
        row[k] = clean(row.get(k))
    row["event_time"] = row["event_time"] or "00:00"
    row["tour_forced"] = tour_from_row(row)
    row["tournament_group"] = tournament_group(row)
    for col in P1_SCORE_COLS + P2_SCORE_COLS:
        row[col] = fnum(row.get(col))
    row["p1_cluster_odds_calc"] = fnum(row.get("p1_cluster_odds")) or grouped_odds([row[c] for c in P1_SCORE_COLS])
    row["p2_cluster_odds_calc"] = fnum(row.get("p2_cluster_odds")) or grouped_odds([row[c] for c in P2_SCORE_COLS])
    try:
        dt = f"{row['event_date']}T{row['event_time'] if len(row['event_time']) != 5 else row['event_time'] + ':00'}"
        row["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        row["ts"] = 0
    return row


def normalize_ml(row):
    row = dict(row)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "market_name", "tournament_name", "event_type_type"]:
        row[k] = clean(row.get(k))
    row["moneyline_p1"] = fnum(row.get("moneyline_p1"))
    row["moneyline_p2"] = fnum(row.get("moneyline_p2"))
    fav_side = clean(row.get("favorite_side"))
    if row["moneyline_p1"] and row["moneyline_p2"]:
        if row["moneyline_p1"] < row["moneyline_p2"]:
            fav_side = "P1"
            fav_odds = row["moneyline_p1"]
        elif row["moneyline_p2"] < row["moneyline_p1"]:
            fav_side = "P2"
            fav_odds = row["moneyline_p2"]
        else:
            fav_side = "EVEN"
            fav_odds = row["moneyline_p1"]
    else:
        fav_odds = fnum(row.get("favorite_odds"))
    row["favorite_side"] = fav_side or "unknown"
    row["favorite_odds"] = fav_odds
    row["favorite_bucket"] = clean(row.get("favorite_bucket")) or bucket_from_fav_odds(fav_odds)
    row["market_kind"] = "first_set" if "1st Set" in row["market_name"] or "First Set" in row["market_name"] else "match"
    return row


def build_moneyline_maps(rows):
    first_set, match = {}, {}
    markets = defaultdict(int)
    for raw in rows:
        r = normalize_ml(raw)
        if not r["event_key"] or not r["bookmaker"]:
            continue
        key = (r["event_key"], r["bookmaker"])
        markets[r["market_name"]] += 1
        if r["market_kind"] == "first_set":
            existing = first_set.get(key)
            if existing is None or r["market_name"].lower() == "home/away (1st set)":
                first_set[key] = r
        else:
            existing = match.get(key)
            if existing is None or r["market_name"].lower() == "home/away":
                match[key] = r
    return first_set, match, dict(markets)


def build_candidates(wide_rows, first_set_ml, match_ml):
    out = []
    for r in wide_rows:
        key = (r["event_key"], r["bookmaker"])
        fs = first_set_ml.get(key, {})
        mt = match_ml.get(key, {})
        base = {
            "event_key": r["event_key"],
            "event_type_key": r["event_type_key"],
            "event_date": r["event_date"],
            "event_time": r["event_time"],
            "player1": r["player1"],
            "player2": r["player2"],
            "match_name": r["match_name"],
            "bookmaker": r["bookmaker"],
            "tour": r["tour_forced"],
            "event_type_type": r.get("event_type_type", ""),
            "tournament_group": r["tournament_group"],
            "tournament_name": r["tournament_name"],
            "surface": r.get("surface", ""),
            "first_set_score": r["first_set_score"],
            "first_set_favorite_side": fs.get("favorite_side", "unknown"),
            "first_set_favorite_odds": fs.get("favorite_odds"),
            "first_set_favorite_bucket": fs.get("favorite_bucket", "unknown"),
            "p1_first_set_moneyline": fs.get("moneyline_p1"),
            "p2_first_set_moneyline": fs.get("moneyline_p2"),
            "match_favorite_side": mt.get("favorite_side", "unknown"),
            "match_favorite_odds": mt.get("favorite_odds"),
            "match_favorite_bucket": mt.get("favorite_bucket", "unknown"),
            "p1_match_moneyline": mt.get("moneyline_p1"),
            "p2_match_moneyline": mt.get("moneyline_p2"),
            "ts": r.get("ts", 0),
        }
        if r.get("p1_cluster_odds_calc") and r.get("odds_6_4"):
            co = r["p1_cluster_odds_calc"]
            mo = r["odds_6_4"]
            side = "P1"
            out.append({
                **base,
                "side": side,
                "cluster_scores": "6:3/6:4/7:5",
                "cluster_odds": co,
                "middle_score": "6:4",
                "middle_score_odds": mo,
                "side_cluster_win": r["first_set_score"] in P1_SCORES,
                "odds_band": odds_band(co),
                "middle_odds_band": middle_band(mo),
                "first_set_side_bucket": side_bucket(side, base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
                "match_side_bucket": side_bucket(side, base["match_favorite_side"], base["match_favorite_bucket"]),
                "odds_6_3": r.get("odds_6_3"),
                "odds_6_4": r.get("odds_6_4"),
                "odds_7_5": r.get("odds_7_5"),
            })
        if r.get("p2_cluster_odds_calc") and r.get("odds_4_6"):
            co = r["p2_cluster_odds_calc"]
            mo = r["odds_4_6"]
            side = "P2"
            out.append({
                **base,
                "side": side,
                "cluster_scores": "3:6/4:6/5:7",
                "cluster_odds": co,
                "middle_score": "4:6",
                "middle_score_odds": mo,
                "side_cluster_win": r["first_set_score"] in P2_SCORES,
                "odds_band": odds_band(co),
                "middle_odds_band": middle_band(mo),
                "first_set_side_bucket": side_bucket(side, base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
                "match_side_bucket": side_bucket(side, base["match_favorite_side"], base["match_favorite_bucket"]),
                "odds_3_6": r.get("odds_3_6"),
                "odds_4_6": r.get("odds_4_6"),
                "odds_5_7": r.get("odds_5_7"),
            })
    return out


def simulate(rows, start=5000.0, risk=0.02, emit_curve=False):
    bankroll = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    curve = []
    for idx, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""), x.get("side", ""))), 1):
        odds = r.get("cluster_odds")
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk
        if r.get("side_cluster_win"):
            pnl = stake * (odds - 1)
            bankroll += pnl
            losing = 0
        else:
            pnl = -stake
            bankroll += pnl
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bankroll)
        dd = (peak - bankroll) / peak if peak else 0
        max_dd = max(max_dd, dd)
        if emit_curve:
            curve.append({
                "bet_index": idx,
                "event_date": r.get("event_date", ""),
                "event_key": r.get("event_key", ""),
                "bookmaker": r.get("bookmaker", ""),
                "side": r.get("side", ""),
                "cluster_odds": odds,
                "won": str(bool(r.get("side_cluster_win"))).lower(),
                "stake": stake,
                "pnl": pnl,
                "bankroll": bankroll,
                "drawdown_pct": dd * 100,
            })
    result = {
        "final_bankroll": bankroll,
        "compound_profit": bankroll - start,
        "compound_return_pct": ((bankroll / start) - 1) * 100 if start else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
    }
    return result, curve


def metrics(rows, label, start, risk, **group):
    rows = [r for r in rows if r.get("cluster_odds") and r["cluster_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("side_cluster_win"))
    avg_odds = sum(r["cluster_odds"] for r in rows) / bets if bets else None
    units = sum((r["cluster_odds"] - 1) if r.get("side_cluster_win") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            month_pl[m] += (r["cluster_odds"] - 1) if r.get("side_cluster_win") else -1
    sim, _ = simulate(rows, start, risk)
    return {
        "label": label,
        **group,
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg_odds,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "positive_months": sum(1 for v in month_pl.values() if v > 0),
        "bets_per_month": bets / len(months) if months else None,
        **sim,
    }


def choose_best_book_rows(rows):
    # Diagnostic only: per event+side choose highest cluster odds among rows that already pass filter.
    groups = defaultdict(list)
    for r in rows:
        groups[(r.get("event_key"), r.get("side"))].append(r)
    out = []
    for arr in groups.values():
        out.append(max(arr, key=lambda x: x.get("cluster_odds") or 0))
    return out


def choose_random_book_rows(rows, seed=20260517):
    rng = random.Random(seed)
    groups = defaultdict(list)
    for r in rows:
        groups[(r.get("event_key"), r.get("side"))].append(r)
    out = []
    for key in sorted(groups):
        out.append(rng.choice(groups[key]))
    return out


def build_filters():
    return [
        ("ALL_BOTH_SIDE", lambda r: True),
        ("ATP_BET365_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_BET365_10BET_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["bookmaker"] in {"bet365", "10Bet"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_STRICT_V3_BOTHSIDE_MIDDLE_625_699_CLUSTER_330_PLUS", lambda r: r["tour"] == "ATP" and 6.25 <= r["middle_score_odds"] <= 6.99 and r["cluster_odds"] >= 3.30),
        ("ATP_VOLUME_V3_BOTHSIDE_MIDDLE_700_900_CLUSTER_300_350", lambda r: r["tour"] == "ATP" and 7.0 <= r["middle_score_odds"] <= 9.0 and 3.0 <= r["cluster_odds"] < 3.5),
        ("ATP_STRONG_500_250_CLUSTER_330_PLUS_MIDDLE_800_1000", lambda r: r["tour"] == "ATP" and r["tournament_group"] == "STRONG_500_250" and r["cluster_odds"] >= 3.30 and 8.0 <= r["middle_score_odds"] <= 10.0),
        ("ATP_STRONG_500_250_CLUSTER_350_375_MIDDLE_800_1000", lambda r: r["tour"] == "ATP" and r["tournament_group"] == "STRONG_500_250" and 3.5 <= r["cluster_odds"] < 3.75 and 8.0 <= r["middle_score_odds"] <= 10.0),
    ]


def funnel_counts(wide_rows, candidates):
    out = {}
    out["first_set_wide_rows"] = len(wide_rows)
    out["settled_wide_rows"] = sum(1 for r in wide_rows if r.get("first_set_score"))
    out["unique_matches_wide"] = len({r.get("event_key") for r in wide_rows if r.get("event_key")})
    out["match_book_rows"] = len({(r.get("event_key"), r.get("bookmaker")) for r in wide_rows})
    out["side_candidates_total"] = len(candidates)
    out["p1_side_candidates"] = sum(1 for r in candidates if r.get("side") == "P1")
    out["p2_side_candidates"] = sum(1 for r in candidates if r.get("side") == "P2")
    out["side_candidates_with_first_set_ml"] = sum(1 for r in candidates if r.get("first_set_favorite_side") not in {"", "unknown", None})
    out["side_candidates_with_match_ml"] = sum(1 for r in candidates if r.get("match_favorite_side") not in {"", "unknown", None})

    def count_by(rows, key):
        d = defaultdict(int)
        for r in rows:
            d[clean(r.get(key)) or "missing"] += 1
        return dict(sorted(d.items(), key=lambda kv: (-kv[1], kv[0])))

    out["wide_by_event_type_key"] = count_by(wide_rows, "event_type_key")
    out["candidates_by_tour"] = count_by(candidates, "tour")
    out["candidates_by_bookmaker"] = count_by(candidates, "bookmaker")
    out["candidates_by_side"] = count_by(candidates, "side")
    out["candidates_by_tournament_group"] = count_by(candidates, "tournament_group")
    out["candidates_by_cluster_odds_band"] = count_by(candidates, "odds_band")
    out["candidates_by_middle_odds_band"] = count_by(candidates, "middle_odds_band")
    out["candidates_by_first_set_side_bucket"] = count_by(candidates, "first_set_side_bucket")
    out["candidates_by_match_side_bucket"] = count_by(candidates, "match_side_bucket")

    filter_steps = [
        ("all_candidates", lambda r: True),
        ("ATP_only", lambda r: r["tour"] == "ATP"),
        ("ATP_bet365", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365"),
        ("ATP_bet365_cluster_300_350", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365" and 3.0 <= r["cluster_odds"] < 3.5),
        ("ATP_bet365_cluster_300_350_middle_700_900", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_bet365_10Bet_cluster_300_350_middle_700_900", lambda r: r["tour"] == "ATP" and r["bookmaker"] in {"bet365", "10Bet"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
    ]
    out["filter_funnel"] = [{"step": name, "rows": sum(1 for r in candidates if fn(r))} for name, fn in filter_steps]
    return out


def build_orientation_sample(wide_rows, limit=25):
    rows = [r for r in wide_rows if r.get("first_set_score")]
    rows = sorted(rows, key=lambda r: (r.get("event_date", ""), r.get("event_key", ""), r.get("bookmaker", "")))
    sample = []
    seen = set()
    for r in rows:
        if r["event_key"] in seen:
            continue
        seen.add(r["event_key"])
        fs = r.get("first_set_score")
        winner_side = "unknown"
        if ":" in fs:
            try:
                a, b = [int(x) for x in fs.split(":")[:2]]
                winner_side = "P1" if a > b else "P2" if b > a else "tie"
            except Exception:
                winner_side = "parse_error"
        sample.append({
            "event_key": r.get("event_key", ""),
            "event_date": r.get("event_date", ""),
            "player1": r.get("player1", ""),
            "player2": r.get("player2", ""),
            "match_name": r.get("match_name", ""),
            "raw_first_set_score_from_wide": fs,
            "parsed_first_set_score": fs,
            "winner_side_from_score": winner_side,
            "has_6_4_market": str(bool(r.get("odds_6_4"))).lower(),
            "has_4_6_market": str(bool(r.get("odds_4_6"))).lower(),
            "p1_cluster_win": str(fs in P1_SCORES).lower(),
            "p2_cluster_win": str(fs in P2_SCORES).lower(),
            "bookmaker_sample": r.get("bookmaker", ""),
        })
        if len(sample) >= limit:
            break
    return sample


def build_home_away_audit(wide_rows, first_set_ml, match_ml, limit=25):
    sample = []
    seen = set()
    for r in sorted(wide_rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""))):
        key = (r.get("event_key"), r.get("bookmaker"))
        if key in seen:
            continue
        fs = first_set_ml.get(key)
        mt = match_ml.get(key)
        if not fs and not mt:
            continue
        seen.add(key)
        first_set_score = r.get("first_set_score", "")
        fs_winner = "unknown"
        if ":" in first_set_score:
            try:
                a, b = [int(x) for x in first_set_score.split(":")[:2]]
                fs_winner = "P1" if a > b else "P2" if b > a else "tie"
            except Exception:
                fs_winner = "parse_error"
        sample.append({
            "event_key": r.get("event_key", ""),
            "event_date": r.get("event_date", ""),
            "bookmaker": r.get("bookmaker", ""),
            "player1": r.get("player1", ""),
            "player2": r.get("player2", ""),
            "first_set_score": first_set_score,
            "actual_first_set_winner_side": fs_winner,
            "first_set_market_name": fs.get("market_name", "") if fs else "",
            "p1_first_set_home_assumed_odds": fs.get("moneyline_p1", "") if fs else "",
            "p2_first_set_away_assumed_odds": fs.get("moneyline_p2", "") if fs else "",
            "first_set_favorite_side": fs.get("favorite_side", "") if fs else "",
            "first_set_favorite_bucket": fs.get("favorite_bucket", "") if fs else "",
            "match_market_name": mt.get("market_name", "") if mt else "",
            "p1_match_home_assumed_odds": mt.get("moneyline_p1", "") if mt else "",
            "p2_match_away_assumed_odds": mt.get("moneyline_p2", "") if mt else "",
            "match_favorite_side": mt.get("favorite_side", "") if mt else "",
            "match_favorite_bucket": mt.get("favorite_bucket", "") if mt else "",
        })
        if len(sample) >= limit:
            break
    return sample


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", required=True)
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-9-12-cluster-audit-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--random-seed", type=int, default=20260517)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    wide_rows = [normalize_wide(r) for r in read_csv(Path(args.first_set_wide))]
    ml_rows = read_csv(Path(args.moneyline))
    first_set_ml, match_ml, ml_markets = build_moneyline_maps(ml_rows)
    candidates = build_candidates(wide_rows, first_set_ml, match_ml)

    funnel = funnel_counts(wide_rows, candidates)
    funnel["moneyline_rows"] = len(ml_rows)
    funnel["first_set_moneyline_pairs"] = len(first_set_ml)
    funnel["match_moneyline_pairs"] = len(match_ml)
    funnel["moneyline_markets"] = dict(sorted(ml_markets.items(), key=lambda kv: kv[1], reverse=True))

    orientation = build_orientation_sample(wide_rows, 25)
    home_away = build_home_away_audit(wide_rows, first_set_ml, match_ml, 25)

    filters = build_filters()
    result_fields = ["mode", "label", "bookmaker", "tour", "tournament_group", "side", "first_set_side_bucket", "match_side_bucket", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "positive_months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]

    fixed_results = []
    random_results = []
    best_book_results = []
    books = sorted({r["bookmaker"] for r in candidates if r.get("bookmaker")})
    tours = ["ATP", "WTA", "UNKNOWN"]
    buckets = sorted({r["first_set_side_bucket"] for r in candidates})

    for name, fn in filters:
        filtered = [r for r in candidates if fn(r)]
        fixed_results.append({"mode": "fixed_filter_all", **metrics(filtered, name, args.start_bankroll, args.risk_pct)})
        random_results.append({"mode": "random_book_stress", **metrics(choose_random_book_rows(filtered, args.random_seed), name, args.start_bankroll, args.risk_pct)})
        best_book_results.append({"mode": "best_book_diagnostic", **metrics(choose_best_book_rows(filtered), name, args.start_bankroll, args.risk_pct)})
        for book in books:
            br = [r for r in filtered if r["bookmaker"] == book]
            if br:
                fixed_results.append({"mode": "fixed_book", **metrics(br, name, args.start_bankroll, args.risk_pct, bookmaker=book)})
        for tour in tours:
            tr = [r for r in filtered if r["tour"] == tour]
            if tr:
                fixed_results.append({"mode": "fixed_tour", **metrics(tr, name, args.start_bankroll, args.risk_pct, tour=tour)})
        for bucket in buckets:
            fr = [r for r in filtered if r["first_set_side_bucket"] == bucket]
            if fr:
                fixed_results.append({"mode": "fixed_favorite_bucket", **metrics(fr, name, args.start_bankroll, args.risk_pct, first_set_side_bucket=bucket)})

    # Extra broad grid for finding where volume/ROI lives without over-filtering too early.
    for bookset_name, bookset in [
        ("bet365", {"bet365"}),
        ("10Bet", {"10Bet"}),
        ("bet365_10Bet", {"bet365", "10Bet"}),
        ("bet365_10Bet_Betano", {"bet365", "10Bet", "Betano"}),
    ]:
        for tour in ["ATP", "WTA"]:
            for cluster_range in [(3.0, 3.5), (3.2, 3.5), (3.3, 4.0), (3.5, 3.75), (3.5, 4.5)]:
                for middle_range in [(6.25, 6.99), (7.0, 9.0), (8.0, 10.0), (9.0, 12.0)]:
                    label = f"GRID_{bookset_name}_{tour}_CLUSTER_{cluster_range[0]}_{cluster_range[1]}_MIDDLE_{middle_range[0]}_{middle_range[1]}"
                    rows = [r for r in candidates if r["bookmaker"] in bookset and r["tour"] == tour and cluster_range[0] <= r["cluster_odds"] < cluster_range[1] and middle_range[0] <= r["middle_score_odds"] <= middle_range[1]]
                    if len(rows) >= 25:
                        fixed_results.append({"mode": "fixed_book_grid", **metrics(rows, label, args.start_bankroll, args.risk_pct, bookmaker=bookset_name, tour=tour)})
                        random_results.append({"mode": "random_book_stress_grid", **metrics(choose_random_book_rows(rows, args.random_seed), label, args.start_bankroll, args.risk_pct, bookmaker=bookset_name, tour=tour)})
                        best_book_results.append({"mode": "best_book_diagnostic_grid", **metrics(choose_best_book_rows(rows), label, args.start_bankroll, args.risk_pct, bookmaker=bookset_name, tour=tour)})

    candidate_fields = ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "event_type_type", "tournament_group", "tournament_name", "surface", "side", "cluster_scores", "cluster_odds", "middle_score", "middle_score_odds", "odds_band", "middle_odds_band", "side_cluster_win", "first_set_score", "p1_first_set_moneyline", "p2_first_set_moneyline", "first_set_favorite_side", "first_set_favorite_bucket", "first_set_side_bucket", "p1_match_moneyline", "p2_match_moneyline", "match_favorite_side", "match_favorite_bucket", "match_side_bucket"]
    write_csv(out / "both_side_candidates.csv", candidates, candidate_fields)
    write_csv(out / "orientation_audit_sample.csv", orientation, list(orientation[0].keys()) if orientation else ["event_key"])
    write_csv(out / "home_away_mapping_audit.csv", home_away, list(home_away[0].keys()) if home_away else ["event_key"])
    write_csv(out / "fixed_book_results.csv", fixed_results, result_fields)
    write_csv(out / "random_book_stress_results.csv", random_results, result_fields)
    write_csv(out / "best_book_results.csv", best_book_results, result_fields)

    leaderboard = sorted([r for r in fixed_results if r.get("bets", 0) >= 50 and r.get("flat_roi") is not None], key=lambda r: (r["flat_roi"], r["bets"]), reverse=True)[:200]
    write_csv(out / "fixed_book_leaderboard.csv", leaderboard, result_fields)

    # Curves for the most important target models.
    curve_rows = []
    curve_targets = [
        ("ATP_bet365_cluster_300_350_middle_700_900", [r for r in candidates if r["tour"] == "ATP" and r["bookmaker"] == "bet365" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0]),
        ("ATP_bet365_10Bet_cluster_300_350_middle_700_900", [r for r in candidates if r["tour"] == "ATP" and r["bookmaker"] in {"bet365", "10Bet"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0]),
    ]
    for label, rows in curve_targets:
        _, curve = simulate(rows, args.start_bankroll, args.risk_pct, emit_curve=True)
        for c in curve:
            c["curve_label"] = label
        curve_rows.extend(curve)
    curve_fields = ["curve_label", "bet_index", "event_date", "event_key", "bookmaker", "side", "cluster_odds", "won", "stake", "pnl", "bankroll", "drawdown_pct"]
    write_csv(out / "bankroll_curves.csv", curve_rows, curve_fields)

    with (out / "funnel_report.json").open("w", encoding="utf-8") as f:
        json.dump(funnel, f, indent=2)

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "funnel": funnel,
        "top_fixed_results": leaderboard[:30],
        "top_random_results": sorted([r for r in random_results if r.get("bets", 0) >= 50 and r.get("flat_roi") is not None], key=lambda r: (r["flat_roi"], r["bets"]), reverse=True)[:30],
        "top_best_book_results": sorted([r for r in best_book_results if r.get("bets", 0) >= 50 and r.get("flat_roi") is not None], key=lambda r: (r["flat_roi"], r["bets"]), reverse=True)[:30],
    }
    with (out / "optimizer_summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"

    lines = [
        "# SlipIQ Winning-Side 9-12 Cluster Audit + Optimizer",
        "",
        "## Funnel",
        f"First-set wide rows: {funnel['first_set_wide_rows']}",
        f"Settled wide rows: {funnel['settled_wide_rows']}",
        f"Match-book rows: {funnel['match_book_rows']}",
        f"Side candidates total: {funnel['side_candidates_total']}",
        f"P1 side candidates: {funnel['p1_side_candidates']}",
        f"P2 side candidates: {funnel['p2_side_candidates']}",
        f"First-set moneyline pairs: {funnel['first_set_moneyline_pairs']}",
        f"Match moneyline pairs: {funnel['match_moneyline_pairs']}",
        "",
        "## Filter funnel",
    ]
    for step in funnel["filter_funnel"]:
        lines.append(f"- {step['step']}: {step['rows']}")
    lines += ["", "## Top fixed-book results, min 50 bets"]
    for i, m in enumerate(summary["top_fixed_results"][:30], 1):
        avg = "n/a" if m.get("avg_odds") is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('mode','')} {m.get('bookmaker','')} {m.get('tour','')} {m.get('first_set_side_bucket','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top random-book stress results, min 50 bets"]
    for i, m in enumerate(summary["top_random_results"][:20], 1):
        avg = "n/a" if m.get("avg_odds") is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('mode','')} {m.get('bookmaker','')} {m.get('tour','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top best-book diagnostic results, min 50 bets"]
    for i, m in enumerate(summary["top_best_book_results"][:20], 1):
        avg = "n/a" if m.get("avg_odds") is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('mode','')} {m.get('bookmaker','')} {m.get('tour','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines.append("\nDo not trust favorite-bucket ROI until home_away_mapping_audit.csv confirms Home=Player1 and Away=Player2.")
    (out / "optimizer_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
