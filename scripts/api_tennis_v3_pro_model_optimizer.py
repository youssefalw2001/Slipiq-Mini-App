#!/usr/bin/env python3
"""SlipIQ V3 Pro Model Optimizer.

Turns V3 from one hard rule into a learned/scored signal engine.

What it does:
- Builds P2 V3 candidates: trigger 4:6, bet 3:6/4:6/5:7 grouped.
- Builds P1 mirror candidates: trigger 6:4, bet 6:3/6:4/7:5 grouped.
- Splits data chronologically into train/test.
- Learns simple categorical feature weights from TRAIN only.
- Scores every candidate using train-learned feature lift.
- Tests score thresholds, daily caps, book groups, ATP/WTA, tournament groups.
- Produces VIP / Core / Volume style leaderboards with train/test validation.

This is still a research optimizer. It does not place bets.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}
P2_SCORES = ["3:6", "4:6", "5:7"]
P1_SCORES = ["6:3", "6:4", "7:5"]
SCORE_COLS = {
    "6:0": "odds_6_0", "6:1": "odds_6_1", "6:2": "odds_6_2", "6:3": "odds_6_3", "6:4": "odds_6_4", "7:5": "odds_7_5", "7:6": "odds_7_6",
    "0:6": "odds_0_6", "1:6": "odds_1_6", "2:6": "odds_2_6", "3:6": "odds_3_6", "4:6": "odds_4_6", "5:7": "odds_5_7", "6:7": "odds_6_7",
}
BOOK_GROUPS = {
    "ALL_BOOKS": None,
    "1xBet": {"1xBet"},
    "bet365": {"bet365"},
    "10Bet": {"10Bet"},
    "1xBet_bet365": {"1xBet", "bet365"},
    "bet365_10Bet": {"bet365", "10Bet"},
    "1xBet_bet365_10Bet": {"1xBet", "bet365", "10Bet"},
}
DAILY_CAPS = [0, 3, 5, 10]


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


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


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


def trigger_zone(v: Optional[float]) -> str:
    if v is None:
        return "missing"
    if v < 5.0:
        return "TRIG_LT_500"
    if v < 6.25:
        return "TRIG_500_625"
    if v <= 6.99:
        return "TRIG_625_699"
    if v < 8.0:
        return "TRIG_700_800"
    if v < 10.0:
        return "TRIG_800_1000"
    return "TRIG_1000_PLUS"


def price_bucket(v: Optional[float]) -> str:
    if v is None:
        return "missing"
    if v < 2.6:
        return "PRICE_LT_260"
    if v < 2.8:
        return "PRICE_260_280"
    if v < 3.0:
        return "PRICE_280_300"
    if v < 3.05:
        return "PRICE_300_305"
    if v < 3.15:
        return "PRICE_305_315"
    if v < 3.30:
        return "PRICE_315_330"
    if v < 3.50:
        return "PRICE_330_350"
    if v < 4.0:
        return "PRICE_350_400"
    return "PRICE_400_PLUS"


def shape_bucket(side: str, o1: Optional[float], mid: Optional[float], o3: Optional[float], grouped: Optional[float]) -> str:
    if not o1 or not mid or not o3 or not grouped:
        return "SHAPE_UNKNOWN"
    # Relative shape around the middle-score trigger price.
    early_ratio = o1 / mid
    late_ratio = o3 / mid
    group_ratio = grouped / mid
    if group_ratio >= 0.52:
        base = "HIGH_GROUP_RATIO"
    elif group_ratio >= 0.46:
        base = "MID_GROUP_RATIO"
    else:
        base = "LOW_GROUP_RATIO"
    if early_ratio < 1.0 and late_ratio > 1.8:
        tail = "EARLY_SHORT_LATE_LONG"
    elif early_ratio > 1.4 and late_ratio > 1.4:
        tail = "OUTERS_LONG"
    elif abs(early_ratio - late_ratio) <= 0.35:
        tail = "BALANCED"
    else:
        tail = "MIXED"
    return f"{base}_{tail}"


def fav_bucket(odds: Optional[float]) -> str:
    if odds is None:
        return "unknown"
    if odds < 1.35:
        return "strong_favorite"
    if odds < 1.65:
        return "favorite"
    if odds < 1.95:
        return "slight_favorite"
    return "near_even"


def side_bucket(side: str, fav_side: str, bucket: str) -> str:
    if not fav_side or fav_side == "unknown" or not bucket or bucket == "unknown":
        return "unknown"
    if fav_side == "EVEN":
        return "near_even"
    if side == fav_side:
        return bucket
    return {"near_even": "near_even", "slight_favorite": "slight_underdog", "favorite": "underdog", "strong_favorite": "strong_underdog"}.get(bucket, "unknown")


def build_fixture_map(path: Optional[Path]) -> Dict[str, Dict]:
    if not path or not path.exists():
        return {}
    out = {}
    for r in read_csv(path):
        k = clean(r.get("event_key"))
        if k and k not in out:
            out[k] = r
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
        event_key = clean(raw.get("event_key"))
        bookmaker = clean(raw.get("bookmaker"))
        market_name = clean(raw.get("market_name"))
        if not event_key or not bookmaker:
            continue
        p1 = fnum(raw.get("moneyline_p1"))
        p2 = fnum(raw.get("moneyline_p2"))
        if p1 and p2:
            if p1 < p2:
                fav_side, fav_odds = "P1", p1
            elif p2 < p1:
                fav_side, fav_odds = "P2", p2
            else:
                fav_side, fav_odds = "EVEN", p1
        else:
            fav_side, fav_odds = clean(raw.get("favorite_side")) or "unknown", fnum(raw.get("favorite_odds"))
        item = {"favorite_side": fav_side, "favorite_odds": fav_odds, "favorite_bucket": fav_bucket(fav_odds), "moneyline_p1": p1, "moneyline_p2": p2, "market_name": market_name}
        key = (event_key, bookmaker)
        if "1st Set" in market_name or "First Set" in market_name:
            if key not in first_set or market_name.lower() == "home/away (1st set)":
                first_set[key] = item
        else:
            if key not in match or market_name.lower() == "home/away":
                match[key] = item
    return first_set, match


def build_candidates(wide_rows: List[Dict], first_set_ml: Dict, match_ml: Dict) -> List[Dict]:
    out = []
    for r in wide_rows:
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
            "tournament_group": r.get("tournament_group"),
            "tournament_name": r.get("tournament_name"),
            "surface": r.get("surface_norm"),
            "round": r.get("round"),
            "first_set_score": r.get("first_set_score"),
        }
        # P2 V3 candidate.
        p2_odds = [r.get(SCORE_COLS[s]) for s in P2_SCORES]
        p2_grouped = grouped_odds(p2_odds)
        p2_trigger = r.get(SCORE_COLS["4:6"])
        if p2_grouped and p2_trigger:
            side = "P2"
            out.append({
                **base,
                "family": "P2_V3_9_12",
                "side": side,
                "scores": "/".join(P2_SCORES),
                "trigger_score": "4:6",
                "trigger_odds": p2_trigger,
                "bet_odds": p2_grouped,
                "won": r.get("first_set_score") in set(P2_SCORES),
                "trigger_zone": trigger_zone(p2_trigger),
                "price_bucket": price_bucket(p2_grouped),
                "shape_bucket": shape_bucket(side, p2_odds[0], p2_odds[1], p2_odds[2], p2_grouped),
                "first_set_side_bucket": side_bucket(side, fs.get("favorite_side", "unknown"), fs.get("favorite_bucket", "unknown")),
                "match_side_bucket": side_bucket(side, mt.get("favorite_side", "unknown"), mt.get("favorite_bucket", "unknown")),
            })
        # P1 mirror candidate.
        p1_odds = [r.get(SCORE_COLS[s]) for s in P1_SCORES]
        p1_grouped = grouped_odds(p1_odds)
        p1_trigger = r.get(SCORE_COLS["6:4"])
        if p1_grouped and p1_trigger:
            side = "P1"
            out.append({
                **base,
                "family": "P1_MIRROR_9_12",
                "side": side,
                "scores": "/".join(P1_SCORES),
                "trigger_score": "6:4",
                "trigger_odds": p1_trigger,
                "bet_odds": p1_grouped,
                "won": r.get("first_set_score") in set(P1_SCORES),
                "trigger_zone": trigger_zone(p1_trigger),
                "price_bucket": price_bucket(p1_grouped),
                "shape_bucket": shape_bucket(side, p1_odds[0], p1_odds[1], p1_odds[2], p1_grouped),
                "first_set_side_bucket": side_bucket(side, fs.get("favorite_side", "unknown"), fs.get("favorite_bucket", "unknown")),
                "match_side_bucket": side_bucket(side, mt.get("favorite_side", "unknown"), mt.get("favorite_bucket", "unknown")),
            })
    return out


def split_train_test(candidates: List[Dict], train_ratio: float):
    dates = sorted({r.get("event_date") for r in candidates if r.get("event_date")})
    if len(dates) < 3:
        return set(dates), set(), dates[-1] if dates else ""
    idx = max(1, min(len(dates) - 1, int(len(dates) * train_ratio)))
    cutoff = dates[idx]
    train = {d for d in dates if d < cutoff}
    test = {d for d in dates if d >= cutoff}
    return train, test, cutoff


def calc_metrics(rows: List[Dict], start: float, risk: float) -> Dict:
    rows = [r for r in rows if r.get("bet_odds") and r["bet_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    avg_odds = sum(r["bet_odds"] for r in rows) / bets if bets else None
    units = sum((r["bet_odds"] - 1) if r.get("won") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            month_pl[month] += (r["bet_odds"] - 1) if r.get("won") else -1
    bank = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))):
        stake = bank * risk
        if r.get("won"):
            bank += stake * (r["bet_odds"] - 1)
            losing = 0
        else:
            bank -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bank)
        max_dd = max(max_dd, (peak - bank) / peak if peak else 0)
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
        "positive_month_ratio": sum(1 for v in month_pl.values() if v > 0) / len(months) if months else None,
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": bank,
        "compound_profit": bank - start,
        "compound_return_pct": ((bank / start) - 1) * 100 if start else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
    }


def learn_feature_weights(train_rows: List[Dict], min_rows: int) -> List[Dict]:
    fields = ["family", "bookmaker", "tour", "tournament_group", "surface", "trigger_zone", "price_bucket", "shape_bucket", "first_set_side_bucket", "match_side_bucket"]
    weights = []
    overall = calc_metrics(train_rows, 5000, 0.02)
    overall_roi = overall.get("flat_roi") or 0
    overall_edge = overall.get("edge_vs_breakeven") or 0
    for field in fields:
        groups = defaultdict(list)
        for r in train_rows:
            groups[clean(r.get(field)) or "missing"].append(r)
        for value, rows in groups.items():
            if len(rows) < min_rows:
                continue
            m = calc_metrics(rows, 5000, 0.02)
            roi = m.get("flat_roi") or 0
            edge = m.get("edge_vs_breakeven") or 0
            lift = (roi - overall_roi) * 100 + (edge - overall_edge) * 250
            # Small shrinkage so tiny feature groups do not dominate.
            shrink = min(1.0, len(rows) / (min_rows * 3.0))
            weight = max(-30.0, min(30.0, lift * shrink))
            weights.append({
                "feature": field,
                "value": value,
                "train_rows": len(rows),
                "train_wins": m["wins"],
                "train_hit_rate": m["hit_rate"],
                "train_avg_odds": m["avg_odds"],
                "train_roi": m["flat_roi"],
                "train_edge": m["edge_vs_breakeven"],
                "weight": weight,
            })
    return weights


def score_candidates(candidates: List[Dict], weights: List[Dict]) -> None:
    weight_map = {(w["feature"], w["value"]): fnum(w["weight"]) or 0.0 for w in weights}
    for r in candidates:
        score = 50.0
        for field in ["family", "bookmaker", "tour", "tournament_group", "surface", "trigger_zone", "price_bucket", "shape_bucket", "first_set_side_bucket", "match_side_bucket"]:
            score += weight_map.get((field, clean(r.get(field)) or "missing"), 0.0)
        # Add direct price reward but not too much; model should not only chase high odds.
        odds = r.get("bet_odds") or 0
        if odds >= 3.5:
            score += 5
        elif odds >= 3.15:
            score += 3
        elif odds < 2.7:
            score -= 4
        r["v3_pro_score"] = round(score, 4)


def apply_daily_cap(rows: List[Dict], cap: int) -> List[Dict]:
    if cap <= 0:
        return rows
    by_day = defaultdict(list)
    for r in rows:
        by_day[r.get("event_date")].append(r)
    out = []
    for day in sorted(by_day):
        ranked = sorted(by_day[day], key=lambda x: (x.get("v3_pro_score") or 0, x.get("bet_odds") or 0), reverse=True)
        seen_events = set()
        keep = []
        for r in ranked:
            if r.get("event_key") in seen_events:
                continue
            seen_events.add(r.get("event_key"))
            keep.append(r)
            if len(keep) >= cap:
                break
        out.extend(keep)
    return out


def dedupe_mode(rows: List[Dict], mode: str) -> List[Dict]:
    if mode == "BOOKMAKER_ROWS":
        return rows
    if mode == "ONE_PICK_PER_MATCH":
        groups = defaultdict(list)
        for r in rows:
            groups[r.get("event_key")].append(r)
        return [max(v, key=lambda x: (x.get("v3_pro_score") or 0, x.get("bet_odds") or 0)) for v in groups.values()]
    return rows


def strategy_score(m_all: Dict, m_train: Dict, m_test: Dict, min_test_bets: int) -> Tuple[float, str]:
    flags = []
    penalty = 0.0
    if m_train["bets"] < min_test_bets or m_test["bets"] < min_test_bets:
        flags.append("low_train_or_test_volume")
        penalty += 40
    if (m_train.get("flat_roi") or 0) > 0 and (m_test.get("flat_roi") or 0) < 0:
        flags.append("train_positive_test_negative")
        penalty += 35
    if abs((m_train.get("flat_roi") or 0) - (m_test.get("flat_roi") or 0)) > 0.40:
        flags.append("unstable_train_test_roi")
        penalty += 10
    roi = m_all.get("flat_roi") or 0
    edge = m_all.get("edge_vs_breakeven") or 0
    volume = min(40, math.log10(max(m_all["bets"], 1)) * 13)
    month = (m_all.get("positive_month_ratio") or 0) * 28
    drawdown_penalty = max(0, (m_all.get("max_drawdown_pct") or 0) - 25) * 0.45
    streak_penalty = max(0, (m_all.get("worst_losing_streak") or 0) - 12) * 0.7
    score = roi * 140 + edge * 250 + volume + month - drawdown_penalty - streak_penalty - penalty
    return score, ";".join(flags)


def monthly_rows(rows: List[Dict], rule_id: str) -> List[Dict]:
    by_month = defaultdict(list)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            by_month[month].append(r)
    out = []
    for month, arr in sorted(by_month.items()):
        m = calc_metrics(arr, 5000, 0.02)
        out.append({"rule_id": rule_id, "month": month, "bets": m["bets"], "wins": m["wins"], "hit_rate": m["hit_rate"], "avg_odds": m["avg_odds"], "flat_roi": m["flat_roi"], "flat_profit_units": m["flat_profit_units"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", default="")
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-v3-pro-model-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    ap.add_argument("--min-feature-rows", type=int, default=40)
    ap.add_argument("--min-bets", type=int, default=50)
    ap.add_argument("--min-test-bets", type=int, default=15)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fixture_map = build_fixture_map(Path(args.fixtures)) if args.fixtures else {}
    ml_rows = read_csv(Path(args.moneyline)) if args.moneyline and Path(args.moneyline).exists() else []
    first_set_ml, match_ml = build_moneyline_maps(ml_rows) if ml_rows else ({}, {})

    wide = [normalize_wide(r, fixture_map) for r in read_csv(Path(args.first_set_wide))]
    candidates = build_candidates(wide, first_set_ml, match_ml)
    train_dates, test_dates, cutoff = split_train_test(candidates, args.train_ratio)
    train_candidates = [r for r in candidates if r.get("event_date") in train_dates]
    weights = learn_feature_weights(train_candidates, args.min_feature_rows)
    score_candidates(candidates, weights)

    candidate_fields = ["event_key", "event_date", "bookmaker", "family", "side", "scores", "tour", "tournament_group", "surface", "trigger_score", "trigger_odds", "trigger_zone", "bet_odds", "price_bucket", "shape_bucket", "first_set_side_bucket", "match_side_bucket", "v3_pro_score", "won", "first_set_score"]
    write_csv(out / "v3_pro_signal_candidates.csv", candidates, candidate_fields)
    weight_fields = ["feature", "value", "train_rows", "train_wins", "train_hit_rate", "train_avg_odds", "train_roi", "train_edge", "weight"]
    write_csv(out / "v3_pro_feature_weights.csv", weights, weight_fields)

    score_values = sorted({r["v3_pro_score"] for r in candidates})
    if score_values:
        thresholds = sorted(set([round(score_values[int((len(score_values)-1)*p)], 2) for p in [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.925, 0.95]] + [55, 60, 65, 70, 75, 80, 85, 90]))
    else:
        thresholds = [60]

    families = ["ALL", "P2_V3_9_12", "P1_MIRROR_9_12"]
    tours = ["ALL", "ATP", "WTA"]
    tgroups = ["ALL"] + sorted({r["tournament_group"] for r in candidates})
    modes = ["BOOKMAKER_ROWS", "ONE_PICK_PER_MATCH"]

    results = []
    train_test = []
    monthly = []
    rules = []
    curves = []
    rule_i = 0

    for family in families:
        fam_rows = candidates if family == "ALL" else [r for r in candidates if r["family"] == family]
        if not fam_rows:
            continue
        for book_group, allowed_books in BOOK_GROUPS.items():
            book_rows = fam_rows if allowed_books is None else [r for r in fam_rows if r["bookmaker"] in allowed_books]
            if not book_rows:
                continue
            for tour_name in tours:
                tour_rows = book_rows if tour_name == "ALL" else [r for r in book_rows if r["tour"] == tour_name]
                if not tour_rows:
                    continue
                for tg in tgroups:
                    group_rows = tour_rows if tg == "ALL" else [r for r in tour_rows if r["tournament_group"] == tg]
                    if not group_rows:
                        continue
                    for threshold in thresholds:
                        thresh_rows = [r for r in group_rows if r.get("v3_pro_score", 0) >= threshold]
                        if len(thresh_rows) < max(10, args.min_test_bets):
                            continue
                        for mode in modes:
                            mode_rows = dedupe_mode(thresh_rows, mode)
                            if len(mode_rows) < max(10, args.min_test_bets):
                                continue
                            for cap in DAILY_CAPS:
                                rows = apply_daily_cap(mode_rows, cap)
                                if len(rows) < max(10, args.min_test_bets):
                                    continue
                                rule_i += 1
                                rule_id = f"V3PRO{rule_i:06d}"
                                train_rows = [r for r in rows if r.get("event_date") in train_dates]
                                test_rows = [r for r in rows if r.get("event_date") in test_dates]
                                m_all = calc_metrics(rows, args.start_bankroll, args.risk_pct)
                                m_train = calc_metrics(train_rows, args.start_bankroll, args.risk_pct)
                                m_test = calc_metrics(test_rows, args.start_bankroll, args.risk_pct)
                                score, flags = strategy_score(m_all, m_train, m_test, args.min_test_bets)
                                base = {"rule_id": rule_id, "model": "V3_PRO", "family": family, "mode": mode, "book_group": book_group, "tour": tour_name, "tournament_group": tg, "score_threshold": threshold, "daily_cap": cap, "split_cutoff_date": cutoff, "strategy_score": score, "overfit_flags": flags}
                                result = {**base, **m_all}
                                results.append(result)
                                train_test.append({**base, "split": "ALL", **m_all})
                                train_test.append({**base, "split": "TRAIN", **m_train})
                                train_test.append({**base, "split": "TEST", **m_test})
                                rules.append({**base, "rule_description": f"{family} | {book_group} | {tour_name} | {tg} | score>={threshold} | cap={cap} | {mode}"})
                                if m_all["bets"] >= args.min_bets:
                                    monthly.extend(monthly_rows(rows, rule_id))
                                if len(curves) < 3000 and m_all["bets"] >= args.min_bets and score > 70:
                                    bank = args.start_bankroll
                                    peak = bank
                                    for idx, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", "")))[:300], 1):
                                        stake = bank * args.risk_pct
                                        if r["won"]:
                                            pnl = stake * (r["bet_odds"] - 1)
                                            bank += pnl
                                        else:
                                            pnl = -stake
                                            bank += pnl
                                        peak = max(peak, bank)
                                        curves.append({"rule_id": rule_id, "bet_index": idx, "event_date": r.get("event_date"), "event_key": r.get("event_key"), "bookmaker": r.get("bookmaker"), "family": r.get("family"), "bet_odds": r.get("bet_odds"), "v3_pro_score": r.get("v3_pro_score"), "won": str(bool(r.get("won"))).lower(), "stake": stake, "pnl": pnl, "bankroll": bank, "drawdown_pct": ((peak-bank)/peak*100 if peak else 0)})

    fields = ["rule_id", "model", "strategy_score", "overfit_flags", "family", "mode", "book_group", "tour", "tournament_group", "score_threshold", "daily_cap", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "positive_month_ratio", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak", "split_cutoff_date"]
    valid = [r for r in results if r.get("bets", 0) >= args.min_bets]
    leaderboard = sorted(valid, key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)
    scalable = sorted([r for r in valid if r.get("bets", 0) >= 250], key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999), reverse=True)
    high_roi = sorted(valid, key=lambda r: (r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)

    write_csv(out / "v3_pro_all_results.csv", results, fields)
    write_csv(out / "v3_pro_leaderboard.csv", leaderboard[:1000], fields)
    write_csv(out / "v3_pro_scalable.csv", scalable[:500], fields)
    write_csv(out / "v3_pro_high_roi.csv", high_roi[:500], fields)
    write_csv(out / "v3_pro_train_test.csv", train_test, ["split"] + fields)
    write_csv(out / "v3_pro_monthly_stability.csv", monthly, ["rule_id", "month", "bets", "wins", "hit_rate", "avg_odds", "flat_roi", "flat_profit_units"])
    write_csv(out / "v3_pro_candidate_rules.csv", rules, ["rule_id", "model", "family", "mode", "book_group", "tour", "tournament_group", "score_threshold", "daily_cap", "split_cutoff_date", "strategy_score", "overfit_flags", "rule_description"])
    write_csv(out / "v3_pro_bankroll_curves.csv", curves, ["rule_id", "bet_index", "event_date", "event_key", "bookmaker", "family", "bet_odds", "v3_pro_score", "won", "stake", "pnl", "bankroll", "drawdown_pct"])

    cards = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "split_cutoff_date": cutoff,
        "wide_rows": len(wide),
        "candidate_rows": len(candidates),
        "train_candidates": len(train_candidates),
        "rules_tested": len(results),
        "best_overall": leaderboard[0] if leaderboard else None,
        "best_scalable_250_plus": scalable[0] if scalable else None,
        "best_high_roi": high_roi[0] if high_roi else None,
        "best_single_book": next((r for r in leaderboard if r["book_group"] in {"1xBet", "bet365", "10Bet"}), None),
        "best_p2": next((r for r in leaderboard if r["family"] == "P2_V3_9_12"), None),
        "best_p1_mirror": next((r for r in leaderboard if r["family"] == "P1_MIRROR_9_12"), None),
        "top_25": leaderboard[:25],
    }
    (out / "v3_pro_strategy_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")

    funnel = {
        "wide_rows": len(wide),
        "settled_wide_rows": sum(1 for r in wide if r.get("is_settled")),
        "candidate_rows": len(candidates),
        "p2_candidates": sum(1 for r in candidates if r["family"] == "P2_V3_9_12"),
        "p1_candidates": sum(1 for r in candidates if r["family"] == "P1_MIRROR_9_12"),
        "rules_tested": len(results),
        "leaderboard_min_bets": args.min_bets,
        "split_cutoff_date": cutoff,
        "surface_counts": dict(sorted({s: sum(1 for r in candidates if r.get("surface") == s) for s in {r.get("surface") for r in candidates}}.items())),
    }
    (out / "v3_pro_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"

    lines = [
        "# SlipIQ V3 Pro Model Optimizer",
        "",
        "V3 Pro turns the fixed V3 rule into a train-learned signal score using book, tour, tournament group, trigger zone, price bucket, cluster shape, and favorite bucket features.",
        "",
        "## Data funnel",
        f"Wide rows: {funnel['wide_rows']}",
        f"Settled wide rows: {funnel['settled_wide_rows']}",
        f"Candidates: {funnel['candidate_rows']}",
        f"P2 candidates: {funnel['p2_candidates']}",
        f"P1 mirror candidates: {funnel['p1_candidates']}",
        f"Rules tested: {funnel['rules_tested']}",
        f"Train/test cutoff date: {cutoff}",
        "",
        "## Top V3 Pro strategies",
    ]
    for i, r in enumerate(leaderboard[:40], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} score={r['strategy_score']:.1f} {r['family']} {r['mode']} {r['book_group']} {r['tour']} {r['tournament_group']} score>={r['score_threshold']} cap={r['daily_cap']}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r['edge_vs_breakeven'])}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}, flags={r['overfit_flags']}")
    lines += ["", "## Best scalable 250+ bet V3 Pro strategies"]
    for i, r in enumerate(scalable[:25], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} {r['family']} {r['book_group']} {r['tour']} {r['tournament_group']} score>={r['score_threshold']} cap={r['daily_cap']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, score={r['strategy_score']:.1f}")
    lines.append("\nInterpretation: prioritize rules that survive train/test, have enough volume, positive edge over breakeven, acceptable drawdown, and no overfit flags. V3 Pro is a candidate model, not final proof until live pre-match tracking confirms timing and execution.")
    (out / "v3_pro_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
