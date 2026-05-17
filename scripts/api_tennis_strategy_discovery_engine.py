#!/usr/bin/env python3
"""SlipIQ API Tennis Strategy Discovery Engine.

God-mode historical strategy discovery using the existing API Tennis warehouse.

This is not a single-strategy backtest. It searches across strategy families:
- P2 V3 9-12 cluster
- P1 mirror 9-12 cluster
- Both-side 9-12 cluster
- Alternative clusters
- Exact-score candidates

It tests combinations of:
- book groups
- ATP/WTA
- tournament groups
- surface, if available
- trigger odds ranges
- real odds / grouped odds gates
- train/test split
- monthly stability
- drawdown and losing streak

Outputs:
- strategy_discovery_leaderboard.csv
- strategy_discovery_all_results.csv
- strategy_cards.json
- train_test_results.csv
- monthly_stability.csv
- bankroll_curves.csv
- candidate_strategy_rules.csv
- rejected_overfit_strategies.csv
- strategy_discovery_report.md
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}

SCORE_COLS = {
    "6:0": "odds_6_0",
    "6:1": "odds_6_1",
    "6:2": "odds_6_2",
    "6:3": "odds_6_3",
    "6:4": "odds_6_4",
    "7:5": "odds_7_5",
    "7:6": "odds_7_6",
    "0:6": "odds_0_6",
    "1:6": "odds_1_6",
    "2:6": "odds_2_6",
    "3:6": "odds_3_6",
    "4:6": "odds_4_6",
    "5:7": "odds_5_7",
    "6:7": "odds_6_7",
}

CLUSTER_FAMILIES = [
    {"family": "P2_V3_9_12", "side": "P2", "scores": ["3:6", "4:6", "5:7"], "trigger_score": "4:6"},
    {"family": "P1_MIRROR_9_12", "side": "P1", "scores": ["6:3", "6:4", "7:5"], "trigger_score": "6:4"},
    {"family": "P2_TIGHT_10_13", "side": "P2", "scores": ["4:6", "5:7", "6:7"], "trigger_score": "4:6"},
    {"family": "P1_TIGHT_10_13", "side": "P1", "scores": ["6:4", "7:5", "7:6"], "trigger_score": "6:4"},
    {"family": "P2_CORE_7_10", "side": "P2", "scores": ["3:6", "4:6"], "trigger_score": "4:6"},
    {"family": "P1_CORE_7_10", "side": "P1", "scores": ["6:3", "6:4"], "trigger_score": "6:4"},
    {"family": "P2_MID_LATE", "side": "P2", "scores": ["4:6", "5:7"], "trigger_score": "4:6"},
    {"family": "P1_MID_LATE", "side": "P1", "scores": ["6:4", "7:5"], "trigger_score": "6:4"},
    {"family": "P2_DOM_MID", "side": "P2", "scores": ["2:6", "3:6", "4:6"], "trigger_score": "4:6"},
    {"family": "P1_DOM_MID", "side": "P1", "scores": ["6:2", "6:3", "6:4"], "trigger_score": "6:4"},
]

EXACT_SCORES = ["6:3", "6:4", "7:5", "7:6", "3:6", "4:6", "5:7", "6:7", "6:2", "2:6"]

BOOK_GROUPS = {
    "ALL_BOOKS": None,
    "1xBet": {"1xBet"},
    "bet365": {"bet365"},
    "10Bet": {"10Bet"},
    "1xBet_bet365": {"1xBet", "bet365"},
    "bet365_10Bet": {"bet365", "10Bet"},
    "1xBet_bet365_10Bet": {"1xBet", "bet365", "10Bet"},
}

PRICE_GATES = [2.40, 2.50, 2.60, 2.70, 2.80, 2.90, 3.00, 3.05, 3.10, 3.15, 3.20, 3.25, 3.30, 3.40, 3.50, 3.75, 4.00, 4.50, 5.00, 6.00]

TRIGGER_RANGES = [
    ("ANY", None, None),
    ("TRIG_500_625", 5.00, 6.25),
    ("TRIG_625_699", 6.25, 6.99),
    ("TRIG_700_800", 7.00, 8.00),
    ("TRIG_800_1000", 8.00, 10.00),
    ("TRIG_600_800", 6.00, 8.00),
    ("TRIG_500_800", 5.00, 8.00),
]

EXACT_ODDS_RANGES = [
    ("ANY", None, None),
    ("EXACT_500_800", 5.00, 8.00),
    ("EXACT_600_900", 6.00, 9.00),
    ("EXACT_700_1000", 7.00, 10.00),
    ("EXACT_800_1200", 8.00, 12.00),
    ("EXACT_1200_1800", 12.00, 18.00),
]


def clean(x) -> str:
    return str(x or "").strip()


def fnum(x) -> Optional[float]:
    try:
        if x is None or str(x).strip() == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def grouped_odds(vals: Iterable[Optional[float]]) -> Optional[float]:
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums):
        return None
    implied = sum(1.0 / v for v in nums)
    return 1.0 / implied if implied else None


def tour_from_row(row: Dict) -> str:
    k = clean(row.get("event_type_key"))
    if k in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[k]
    s = f"{row.get('event_type_type','')} {row.get('tournament_name','')}".lower()
    if "wta" in s or "women" in s:
        return "WTA"
    if "atp" in s or "men" in s:
        return "ATP"
    return "UNKNOWN"


def tournament_group(row: Dict) -> str:
    t = clean(row.get("tournament_name")).lower()
    if any(k in t for k in ["australian open", "roland garros", "french open", "wimbledon", "us open"]):
        return "GRAND_SLAM"
    if any(k in t for k in ["indian wells", "miami", "monte carlo", "madrid", "rome", "italian open", "canada", "canadian open", "toronto", "montreal", "cincinnati", "shanghai", "paris", "beijing", "wuhan", "doha", "dubai", "qatar open"]):
        return "MASTERS_1000"
    if any(k in t for k in ["barcelona", "halle", "queen", "queens", "london", "stuttgart", "charleston", "washington", "hamburg", "tokyo", "acapulco", "eastbourne", "rotterdam", "basel", "vienna", "adelaide", "brisbane", "bad homburg", "berlin", "strasbourg", "antwerp", "dallas", "rio", "astana", "chengdu", "zhuhai", "seoul"]):
        return "STRONG_500_250"
    if any(k in t for k in ["challenger", "itf", "m25", "m15", "w15", "w25", "w35", "w50", "w75", "w100", "w125"]):
        return "LOWER_TIER"
    return "OTHER_TOUR"


def norm_surface(v: str) -> str:
    s = clean(v).lower()
    if not s:
        return "UNKNOWN"
    if "clay" in s:
        return "CLAY"
    if "grass" in s:
        return "GRASS"
    if "hard" in s:
        return "HARD"
    if "indoor" in s or "carpet" in s:
        return "INDOOR"
    return s.upper()


def side_for_score(score: str) -> str:
    a, b = score.split(":")
    return "P1" if int(a) > int(b) else "P2"


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def build_fixture_map(path: Optional[Path]) -> Dict[str, Dict]:
    if not path or not path.exists():
        return {}
    out: Dict[str, Dict] = {}
    for r in read_csv(path):
        key = clean(r.get("event_key"))
        if key and key not in out:
            out[key] = r
    return out


def normalize_wide(raw: Dict, fixture_map: Dict[str, Dict]) -> Dict:
    r = dict(raw)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "market_name", "tournament_name", "event_type_type", "first_set_score", "surface", "round"]:
        r[k] = clean(r.get(k))
    fixture = fixture_map.get(r["event_key"], {})
    for key in ["event_type_key", "event_type_type", "tournament_name", "surface", "round"]:
        if not r.get(key):
            r[key] = clean(fixture.get(key) or fixture.get(f"event_{key}"))
    for col in SCORE_COLS.values():
        r[col] = fnum(r.get(col))
    r["tour"] = tour_from_row(r)
    r["tournament_group"] = tournament_group(r)
    r["surface_norm"] = norm_surface(r.get("surface"))
    r["is_settled"] = bool(r.get("first_set_score"))
    try:
        time = r.get("event_time") or "00:00"
        dt = f"{r['event_date']}T{time if len(time) != 5 else time + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


def build_moneyline_maps(rows: List[Dict]):
    first_set = {}
    match = {}
    for raw in rows:
        r = dict(raw)
        event_key = clean(r.get("event_key"))
        bookmaker = clean(r.get("bookmaker"))
        market_name = clean(r.get("market_name"))
        if not event_key or not bookmaker:
            continue
        p1 = fnum(r.get("moneyline_p1"))
        p2 = fnum(r.get("moneyline_p2"))
        if p1 and p2:
            if p1 < p2:
                fav_side, fav_odds = "P1", p1
            elif p2 < p1:
                fav_side, fav_odds = "P2", p2
            else:
                fav_side, fav_odds = "EVEN", p1
        else:
            fav_side, fav_odds = clean(r.get("favorite_side")) or "unknown", fnum(r.get("favorite_odds"))
        if fav_odds is None:
            bucket = "unknown"
        elif fav_odds < 1.35:
            bucket = "strong_favorite"
        elif fav_odds < 1.65:
            bucket = "favorite"
        elif fav_odds < 1.95:
            bucket = "slight_favorite"
        else:
            bucket = "near_even"
        item = {"favorite_side": fav_side, "favorite_odds": fav_odds, "favorite_bucket": bucket, "moneyline_p1": p1, "moneyline_p2": p2, "market_name": market_name}
        key = (event_key, bookmaker)
        if "1st Set" in market_name or "First Set" in market_name:
            if key not in first_set or market_name.lower() == "home/away (1st set)":
                first_set[key] = item
        else:
            if key not in match or market_name.lower() == "home/away":
                match[key] = item
    return first_set, match


def side_bucket(side: str, fav_side: str, bucket: str) -> str:
    if not fav_side or fav_side == "unknown" or not bucket or bucket == "unknown":
        return "unknown"
    if fav_side == "EVEN":
        return "near_even"
    if side == fav_side:
        return bucket
    return {"near_even": "near_even", "slight_favorite": "slight_underdog", "favorite": "underdog", "strong_favorite": "strong_underdog"}.get(bucket, "unknown")


def build_candidates(rows: List[Dict], first_set_ml: Dict, match_ml: Dict) -> List[Dict]:
    out = []
    for r in rows:
        if not r.get("is_settled"):
            continue
        key = (r.get("event_key"), r.get("bookmaker"))
        fs = first_set_ml.get(key, {})
        mt = match_ml.get(key, {})
        base = {
            "event_key": r.get("event_key"),
            "event_date": r.get("event_date"),
            "event_time": r.get("event_time"),
            "ts": r.get("ts", 0),
            "player1": r.get("player1"),
            "player2": r.get("player2"),
            "match_name": r.get("match_name"),
            "bookmaker": r.get("bookmaker"),
            "tour": r.get("tour"),
            "event_type_key": r.get("event_type_key"),
            "tournament_group": r.get("tournament_group"),
            "tournament_name": r.get("tournament_name"),
            "surface": r.get("surface_norm"),
            "round": r.get("round"),
            "first_set_score": r.get("first_set_score"),
        }
        # Cluster family candidates.
        for fam in CLUSTER_FAMILIES:
            odds = [r.get(SCORE_COLS[s]) for s in fam["scores"]]
            bet_odds = grouped_odds(odds)
            trig = r.get(SCORE_COLS[fam["trigger_score"]])
            if not bet_odds or not trig:
                continue
            side = fam["side"]
            out.append({
                **base,
                "candidate_type": "CLUSTER",
                "strategy_family": fam["family"],
                "side": side,
                "scores": "/".join(fam["scores"]),
                "trigger_score": fam["trigger_score"],
                "trigger_odds": trig,
                "bet_odds": bet_odds,
                "won": r.get("first_set_score") in set(fam["scores"]),
                "first_set_side_bucket": side_bucket(side, fs.get("favorite_side", "unknown"), fs.get("favorite_bucket", "unknown")),
                "match_side_bucket": side_bucket(side, mt.get("favorite_side", "unknown"), mt.get("favorite_bucket", "unknown")),
            })
        # Exact-score candidates.
        for score in EXACT_SCORES:
            odds = r.get(SCORE_COLS.get(score, ""))
            if not odds:
                continue
            side = side_for_score(score)
            out.append({
                **base,
                "candidate_type": "EXACT",
                "strategy_family": f"EXACT_{score.replace(':','_')}",
                "side": side,
                "scores": score,
                "trigger_score": score,
                "trigger_odds": odds,
                "bet_odds": odds,
                "won": r.get("first_set_score") == score,
                "first_set_side_bucket": side_bucket(side, fs.get("favorite_side", "unknown"), fs.get("favorite_bucket", "unknown")),
                "match_side_bucket": side_bucket(side, mt.get("favorite_side", "unknown"), mt.get("favorite_bucket", "unknown")),
            })
    return out


def split_train_test(candidates: List[Dict], train_ratio: float) -> Tuple[set, set, str]:
    dates = sorted({r.get("event_date") for r in candidates if r.get("event_date")})
    if not dates:
        return set(), set(), ""
    idx = max(1, min(len(dates) - 1, int(len(dates) * train_ratio)))
    cutoff = dates[idx]
    train = {d for d in dates if d < cutoff}
    test = {d for d in dates if d >= cutoff}
    return train, test, cutoff


def apply_dedupe(rows: List[Dict], mode: str) -> List[Dict]:
    if mode == "BOOKMAKER_ROWS":
        # One row per event/book/family/side/scores.
        seen = set()
        out = []
        for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""), x.get("strategy_family", ""), x.get("scores", ""))):
            key = (r.get("event_key"), r.get("bookmaker"), r.get("strategy_family"), r.get("scores"))
            if key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out
    if mode == "UNIQUE_MATCH_BEST_ODDS":
        groups = defaultdict(list)
        for r in rows:
            groups[(r.get("event_key"), r.get("strategy_family"), r.get("scores"))].append(r)
        return [max(v, key=lambda x: x.get("bet_odds") or 0) for v in groups.values()]
    if mode == "ONE_PICK_PER_MATCH_BEST_EDGE_PROXY":
        groups = defaultdict(list)
        for r in rows:
            groups[r.get("event_key")].append(r)
        return [max(v, key=lambda x: (x.get("bet_odds") or 0, -abs((x.get("trigger_odds") or 0) - 6.7))) for v in groups.values()]
    return rows


def simulate(rows: List[Dict], start: float, risk: float, emit_curve=False):
    bank = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    curve = []
    for i, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))), 1):
        odds = r.get("bet_odds")
        if not odds or odds <= 1:
            continue
        stake = bank * risk
        if r.get("won"):
            pnl = stake * (odds - 1)
            bank += pnl
            losing = 0
        else:
            pnl = -stake
            bank += pnl
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bank)
        dd = (peak - bank) / peak if peak else 0
        max_dd = max(max_dd, dd)
        if emit_curve:
            curve.append({
                "bet_index": i,
                "event_date": r.get("event_date"),
                "event_key": r.get("event_key"),
                "bookmaker": r.get("bookmaker"),
                "strategy_family": r.get("strategy_family"),
                "scores": r.get("scores"),
                "bet_odds": odds,
                "won": str(bool(r.get("won"))).lower(),
                "stake": stake,
                "pnl": pnl,
                "bankroll": bank,
                "drawdown_pct": dd * 100,
            })
    return {
        "final_bankroll": bank,
        "compound_profit": bank - start,
        "compound_return_pct": ((bank / start) - 1) * 100 if start else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
    }, curve


def calc_metrics(rows: List[Dict], start: float, risk: float) -> Dict:
    rows = [r for r in rows if r.get("bet_odds") and r["bet_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    avg_odds = sum(r["bet_odds"] for r in rows) / bets if bets else None
    units = sum((r["bet_odds"] - 1) if r.get("won") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            month_pl[m] += (r["bet_odds"] - 1) if r.get("won") else -1
    sim, _ = simulate(rows, start, risk)
    hit = wins / bets if bets else None
    be = 1 / avg_odds if avg_odds else None
    return {
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": hit,
        "avg_odds": avg_odds,
        "breakeven_hit_rate": be,
        "edge_vs_breakeven": hit - be if hit is not None and be is not None else None,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "positive_months": sum(1 for v in month_pl.values() if v > 0),
        "positive_month_ratio": (sum(1 for v in month_pl.values() if v > 0) / len(months)) if months else None,
        "bets_per_month": bets / len(months) if months else None,
        **sim,
    }


def monthly_metrics(rows: List[Dict], rule_id: str) -> List[Dict]:
    by = defaultdict(list)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            by[m].append(r)
    out = []
    for m, arr in sorted(by.items()):
        bets = len(arr)
        wins = sum(1 for r in arr if r.get("won"))
        avg_odds = sum(r["bet_odds"] for r in arr) / bets if bets else None
        units = sum((r["bet_odds"] - 1) if r.get("won") else -1 for r in arr)
        out.append({"rule_id": rule_id, "month": m, "bets": bets, "wins": wins, "hit_rate": wins / bets if bets else None, "avg_odds": avg_odds, "flat_profit_units": units, "flat_roi": units / bets if bets else None})
    return out


def score_strategy(all_m: Dict, train_m: Dict, test_m: Dict, min_test_bets: int) -> Tuple[float, str]:
    if all_m["bets"] == 0:
        return -9999, "empty"
    reasons = []
    overfit_penalty = 0.0
    if train_m["bets"] < min_test_bets or test_m["bets"] < min_test_bets:
        overfit_penalty += 50
        reasons.append("low_train_or_test_volume")
    if train_m.get("flat_roi") is not None and test_m.get("flat_roi") is not None:
        if train_m["flat_roi"] > 0 and test_m["flat_roi"] < 0:
            overfit_penalty += 35
            reasons.append("train_positive_test_negative")
        if abs(train_m["flat_roi"] - test_m["flat_roi"]) > 0.35:
            overfit_penalty += 10
            reasons.append("unstable_roi")
    roi = all_m.get("flat_roi") or 0
    edge = all_m.get("edge_vs_breakeven") or 0
    volume_score = min(35, math.log10(max(all_m["bets"], 1)) * 12)
    roi_score = max(-50, min(80, roi * 150))
    edge_score = max(-30, min(50, edge * 250))
    month_score = (all_m.get("positive_month_ratio") or 0) * 25
    dd_penalty = max(0, (all_m.get("max_drawdown_pct") or 0) - 25) * 0.55
    streak_penalty = max(0, (all_m.get("worst_losing_streak") or 0) - 12) * 0.8
    score = roi_score + edge_score + volume_score + month_score - dd_penalty - streak_penalty - overfit_penalty
    return score, ";".join(reasons)


def in_range(v: Optional[float], lo: Optional[float], hi: Optional[float]) -> bool:
    if lo is None and hi is None:
        return True
    if v is None:
        return False
    if lo is not None and v < lo:
        return False
    if hi is not None and v > hi:
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", default="")
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-strategy-discovery-engine")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    ap.add_argument("--min-bets", type=int, default=50)
    ap.add_argument("--min-test-bets", type=int, default=15)
    ap.add_argument("--max-results", type=int, default=5000)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    fixture_map = build_fixture_map(Path(args.fixtures)) if args.fixtures else {}
    moneyline_rows = read_csv(Path(args.moneyline)) if args.moneyline and Path(args.moneyline).exists() else []
    first_set_ml, match_ml = build_moneyline_maps(moneyline_rows) if moneyline_rows else ({}, {})

    wide_rows = [normalize_wide(r, fixture_map) for r in read_csv(Path(args.first_set_wide))]
    candidates = build_candidates(wide_rows, first_set_ml, match_ml)
    train_dates, test_dates, split_cutoff = split_train_test(candidates, args.train_ratio)

    # Keep candidate file compact: only core columns.
    candidate_fields = ["event_key", "event_date", "bookmaker", "tour", "tournament_group", "surface", "candidate_type", "strategy_family", "side", "scores", "trigger_score", "trigger_odds", "bet_odds", "won", "first_set_score", "first_set_side_bucket", "match_side_bucket"]
    write_csv(out / "strategy_discovery_candidates.csv", candidates, candidate_fields)

    tours = ["ALL"] + sorted({r["tour"] for r in candidates if r.get("tour")})
    tgroups = ["ALL"] + sorted({r["tournament_group"] for r in candidates if r.get("tournament_group")})
    surfaces = ["ALL"] + sorted({r["surface"] for r in candidates if r.get("surface")})
    fs_buckets = ["ALL"] + sorted({r["first_set_side_bucket"] for r in candidates if r.get("first_set_side_bucket")})

    # Strategy families to scan. Exact and cluster handled through shared fields.
    strategy_families = sorted({r["strategy_family"] for r in candidates})
    modes = ["BOOKMAKER_ROWS", "UNIQUE_MATCH_BEST_ODDS", "ONE_PICK_PER_MATCH_BEST_EDGE_PROXY"]

    all_results = []
    train_test_rows = []
    monthly_rows_all = []
    rejected = []
    rule_rows = []
    curves = []

    rule_n = 0
    for family in strategy_families:
        family_type = "EXACT" if family.startswith("EXACT_") else "CLUSTER"
        family_candidates = [r for r in candidates if r["strategy_family"] == family]
        if not family_candidates:
            continue
        trigger_ranges = EXACT_ODDS_RANGES if family_type == "EXACT" else TRIGGER_RANGES
        for mode in modes:
            for book_group, allowed_books in BOOK_GROUPS.items():
                book_rows = family_candidates if allowed_books is None else [r for r in family_candidates if r["bookmaker"] in allowed_books]
                if not book_rows:
                    continue
                for tour_name in tours:
                    tour_rows = book_rows if tour_name == "ALL" else [r for r in book_rows if r["tour"] == tour_name]
                    if not tour_rows:
                        continue
                    # Keep cross-product disciplined. Test tournament and surface separately, plus focused combined pockets for ATP/WTA.
                    filter_specs = []
                    for tg in tgroups:
                        filter_specs.append((tg, "ALL", "ALL"))
                    for sf in surfaces:
                        filter_specs.append(("ALL", sf, "ALL"))
                    for fb in fs_buckets:
                        if fb != "unknown":
                            filter_specs.append(("ALL", "ALL", fb))
                    if tour_name in {"ATP", "WTA"}:
                        for tg in tgroups:
                            for sf in surfaces:
                                if tg != "ALL" and sf != "ALL":
                                    filter_specs.append((tg, sf, "ALL"))
                    seen_specs = set()
                    for tg, sf, fsb in filter_specs:
                        spec = (tg, sf, fsb)
                        if spec in seen_specs:
                            continue
                        seen_specs.add(spec)
                        base = tour_rows
                        if tg != "ALL":
                            base = [r for r in base if r["tournament_group"] == tg]
                        if sf != "ALL":
                            base = [r for r in base if r["surface"] == sf]
                        if fsb != "ALL":
                            base = [r for r in base if r["first_set_side_bucket"] == fsb]
                        if not base:
                            continue
                        for trig_label, trig_lo, trig_hi in trigger_ranges:
                            trig_rows = [r for r in base if in_range(r.get("trigger_odds"), trig_lo, trig_hi)]
                            if not trig_rows:
                                continue
                            for gate in PRICE_GATES:
                                rows = [r for r in trig_rows if r.get("bet_odds") and r["bet_odds"] >= gate]
                                if len(rows) < max(10, args.min_test_bets):
                                    continue
                                rows = apply_dedupe(rows, mode)
                                if len(rows) < max(10, args.min_test_bets):
                                    continue
                                rule_n += 1
                                rule_id = f"R{rule_n:06d}"
                                train_rows = [r for r in rows if r.get("event_date") in train_dates]
                                test_rows = [r for r in rows if r.get("event_date") in test_dates]
                                all_m = calc_metrics(rows, args.start_bankroll, args.risk_pct)
                                train_m = calc_metrics(train_rows, args.start_bankroll, args.risk_pct)
                                test_m = calc_metrics(test_rows, args.start_bankroll, args.risk_pct)
                                score, rejection_reason = score_strategy(all_m, train_m, test_m, args.min_test_bets)
                                base_rule = {
                                    "rule_id": rule_id,
                                    "strategy_family": family,
                                    "candidate_type": family_type,
                                    "mode": mode,
                                    "book_group": book_group,
                                    "tour": tour_name,
                                    "tournament_group": tg,
                                    "surface": sf,
                                    "first_set_side_bucket": fsb,
                                    "trigger_range": trig_label,
                                    "min_bet_odds": gate,
                                    "split_cutoff_date": split_cutoff,
                                    "strategy_score": score,
                                    "overfit_flags": rejection_reason,
                                }
                                result = {**base_rule, **all_m}
                                all_results.append(result)
                                train_test_rows.append({**base_rule, "split": "ALL", **all_m})
                                train_test_rows.append({**base_rule, "split": "TRAIN", **train_m})
                                train_test_rows.append({**base_rule, "split": "TEST", **test_m})
                                if all_m["bets"] >= args.min_bets:
                                    monthly_rows_all.extend(monthly_metrics(rows, rule_id))
                                rule_rows.append({**base_rule, "rule_description": f"{family} | {mode} | books={book_group} | tour={tour_name} | group={tg} | surface={sf} | fs_bucket={fsb} | trigger={trig_label} | bet_odds>={gate}"})
                                if rejection_reason:
                                    rejected.append(result)
                                if len(curves) < 2000 and all_m["bets"] >= args.min_bets and score > 60:
                                    _, curve = simulate(rows, args.start_bankroll, args.risk_pct, emit_curve=True)
                                    for c in curve[:300]:
                                        c["rule_id"] = rule_id
                                    curves.extend(curve[:300])
                                if len(all_results) >= args.max_results * 8:
                                    pass

    # Leaderboard: require min bets and sort by strategy score, not raw ROI.
    valid = [r for r in all_results if r.get("bets", 0) >= args.min_bets]
    leaderboard = sorted(valid, key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)[:args.max_results]
    high_roi = sorted(valid, key=lambda r: (r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)[:500]
    scalable = sorted([r for r in valid if r.get("bets", 0) >= 250], key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999), reverse=True)[:500]

    result_fields = ["rule_id", "strategy_score", "overfit_flags", "strategy_family", "candidate_type", "mode", "book_group", "tour", "tournament_group", "surface", "first_set_side_bucket", "trigger_range", "min_bet_odds", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "positive_month_ratio", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak", "split_cutoff_date"]
    write_csv(out / "strategy_discovery_all_results.csv", all_results, result_fields)
    write_csv(out / "strategy_discovery_leaderboard.csv", leaderboard, result_fields)
    write_csv(out / "strategy_discovery_high_roi.csv", high_roi, result_fields)
    write_csv(out / "strategy_discovery_scalable.csv", scalable, result_fields)

    tt_fields = ["split"] + result_fields
    write_csv(out / "train_test_results.csv", train_test_rows, tt_fields)
    monthly_fields = ["rule_id", "month", "bets", "wins", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi"]
    write_csv(out / "monthly_stability.csv", monthly_rows_all, monthly_fields)
    rule_fields = ["rule_id", "strategy_family", "candidate_type", "mode", "book_group", "tour", "tournament_group", "surface", "first_set_side_bucket", "trigger_range", "min_bet_odds", "split_cutoff_date", "strategy_score", "overfit_flags", "rule_description"]
    write_csv(out / "candidate_strategy_rules.csv", rule_rows, rule_fields)
    write_csv(out / "rejected_overfit_strategies.csv", rejected, result_fields)
    curve_fields = ["rule_id", "bet_index", "event_date", "event_key", "bookmaker", "strategy_family", "scores", "bet_odds", "won", "stake", "pnl", "bankroll", "drawdown_pct"]
    write_csv(out / "bankroll_curves.csv", curves, curve_fields)

    # Strategy cards for product decisions.
    def top_or_none(rows):
        return rows[0] if rows else None

    cards = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "split_cutoff_date": split_cutoff,
        "candidate_rows": len(candidates),
        "wide_rows": len(wide_rows),
        "fixture_map_rows": len(fixture_map),
        "moneyline_rows": len(moneyline_rows),
        "best_overall": top_or_none(leaderboard),
        "best_high_roi": top_or_none(high_roi),
        "best_scalable_250_plus_bets": top_or_none(scalable),
        "best_cluster": top_or_none([r for r in leaderboard if r["candidate_type"] == "CLUSTER"]),
        "best_exact": top_or_none([r for r in leaderboard if r["candidate_type"] == "EXACT"]),
        "best_single_book": top_or_none([r for r in leaderboard if r["book_group"] in {"1xBet", "bet365", "10Bet"}]),
        "best_three_book_volume": top_or_none([r for r in leaderboard if r["book_group"] == "1xBet_bet365_10Bet"]),
        "top_25": leaderboard[:25],
    }
    (out / "strategy_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")

    funnel = {
        "wide_rows": len(wide_rows),
        "settled_wide_rows": sum(1 for r in wide_rows if r.get("is_settled")),
        "candidate_rows": len(candidates),
        "cluster_candidates": sum(1 for r in candidates if r["candidate_type"] == "CLUSTER"),
        "exact_candidates": sum(1 for r in candidates if r["candidate_type"] == "EXACT"),
        "strategy_rules_tested": len(all_results),
        "leaderboard_min_bets": args.min_bets,
        "split_cutoff_date": split_cutoff,
        "surface_counts": dict(sorted(defaultdict(int, {s: sum(1 for r in candidates if r.get("surface") == s) for s in {r.get("surface") for r in candidates}}).items())),
        "bookmaker_counts": dict(sorted(defaultdict(int, {b: sum(1 for r in candidates if r.get("bookmaker") == b) for b in {r.get("bookmaker") for r in candidates}}).items(), key=lambda kv: (-kv[1], kv[0]))),
    }
    (out / "strategy_discovery_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# SlipIQ API Tennis Strategy Discovery Engine",
        "",
        "This engine searches strategy families across trigger ranges, real odds gates, books, tours, tournament groups, surface when available, train/test split, and stability.",
        "",
        "## Data funnel",
        f"Wide rows: {funnel['wide_rows']}",
        f"Settled wide rows: {funnel['settled_wide_rows']}",
        f"Candidate rows: {funnel['candidate_rows']}",
        f"Cluster candidates: {funnel['cluster_candidates']}",
        f"Exact candidates: {funnel['exact_candidates']}",
        f"Rules tested: {funnel['strategy_rules_tested']}",
        f"Train/test cutoff date: {split_cutoff}",
        "",
        f"## Top strategies, min {args.min_bets} bets, ranked by clean strategy score",
    ]
    for i, r in enumerate(leaderboard[:40], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} score={r['strategy_score']:.1f} {r['strategy_family']} {r['mode']} {r['book_group']} {r['tour']} {r['tournament_group']} {r['surface']} trigger={r['trigger_range']} gate>={r['min_bet_odds']}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r['edge_vs_breakeven'])}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}, flags={r['overfit_flags']}")
    lines += ["", "## Best scalable 250+ bet strategies"]
    for i, r in enumerate(scalable[:25], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} {r['strategy_family']} {r['book_group']} {r['tour']} {r['tournament_group']} gate>={r['min_bet_odds']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, score={r['strategy_score']:.1f}")
    lines += ["", "## Best raw ROI strategies, caution: may be lower volume / overfit"]
    for i, r in enumerate(high_roi[:25], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} {r['strategy_family']} {r['book_group']} {r['tour']} {r['tournament_group']} gate>={r['min_bet_odds']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, flags={r['overfit_flags']}")
    lines.append("\nInterpretation: prefer rules with positive train and test ROI, enough bets, positive month ratio, controlled drawdown, and no overfit flags. High raw ROI alone is not enough.")
    (out / "strategy_discovery_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
