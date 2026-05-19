#!/usr/bin/env python3
"""SlipIQ / First Set Lab Fast Wide-Net Strategy Discovery Engine.

Research-only workflow. Does not modify live scanner filters.

This version adds a proper future-holdout audit.

Split behavior:
- train: first N months, default 6
- test: next N months, default 1
- validate: next N months, default 1
- future: every remaining later month

Why this matters:
A rule can look great in train/test/validate but still be overfit if the remaining
future months collapse. The top sniper list now requires the future holdout to be
positive with enough sample. Rules that look exciting but fail future-holdout checks
are still exported as a research watchlist.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from itertools import combinations
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

P1_SCORES = ["6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6"]
P2_SCORES = ["0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7"]
ALL_SCORES = P1_SCORES + P2_SCORES
EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}

SCORE_ALIASES = {
    "6:0": ["odds_6_0", "odds_6:0", "6:0", "score_6_0", "score_6:0"],
    "6:1": ["odds_6_1", "odds_6:1", "6:1", "score_6_1", "score_6:1"],
    "6:2": ["odds_6_2", "odds_6:2", "6:2", "score_6_2", "score_6:2"],
    "6:3": ["odds_6_3", "odds_6:3", "6:3", "score_6_3", "score_6:3"],
    "6:4": ["odds_6_4", "odds_6:4", "6:4", "score_6_4", "score_6:4"],
    "7:5": ["odds_7_5", "odds_7:5", "7:5", "score_7_5", "score_7:5"],
    "7:6": ["odds_7_6", "odds_7:6", "7:6", "score_7_6", "score_7:6"],
    "0:6": ["odds_0_6", "odds_0:6", "0:6", "score_0_6", "score_0:6"],
    "1:6": ["odds_1_6", "odds_1:6", "1:6", "score_1_6", "score_1:6"],
    "2:6": ["odds_2_6", "odds_2:6", "2:6", "score_2_6", "score_2:6"],
    "3:6": ["odds_3_6", "odds_3:6", "3:6", "score_3_6", "score_3:6"],
    "4:6": ["odds_4_6", "odds_4:6", "4:6", "score_4_6", "score_4:6"],
    "5:7": ["odds_5_7", "odds_5:7", "5:7", "score_5_7", "score_5:7"],
    "6:7": ["odds_6_7", "odds_6:7", "6:7", "score_6_7", "score_6:7"],
}

PRICE_BUCKETS = [
    ("P250_300", 2.50, 3.00),
    ("P275_325", 2.75, 3.25),
    ("P300_350", 3.00, 3.50),
    ("P325_375", 3.25, 3.75),
    ("P350_400", 3.50, 4.00),
    ("P375_450", 3.75, 4.50),
    ("P250_450", 2.50, 4.50),
]
DAILY_CAPS = [0, 3, 5]
RISK_PCTS = [0.01, 0.02, 0.04]


def clean(x) -> str:
    return str(x or "").strip()


def norm_key(k: str) -> str:
    return clean(k).lower().replace(" ", "_").replace("-", "_")


def fnum(x) -> Optional[float]:
    try:
        s = clean(x)
        if not s or s.lower() in {"nan", "none", "null"}:
            return None
        v = float(s)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def grouped_odds(vals: Iterable[Optional[float]]) -> Optional[float]:
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1.0 for v in nums):
        return None
    implied = sum(1.0 / v for v in nums)
    return 1.0 / implied if implied > 0 else None


def wilson_interval(wins: int, n: int, z: float = 1.96) -> Tuple[float, float]:
    if n <= 0:
        return 0.0, 0.0
    phat = wins / n
    denom = 1 + z * z / n
    center = (phat + z * z / (2 * n)) / denom
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: Sequence[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(fields), extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")


def first_present(row: Dict, keys: Sequence[str]) -> str:
    for k in keys:
        if k in row and clean(row.get(k)):
            return clean(row.get(k))
    return ""


def parse_date(row: Dict) -> str:
    for k in ["match_date", "event_date", "date", "starts_at"]:
        v = clean(row.get(k))
        if v:
            return v[:10]
    return ""


def parse_ts(date_s: str, time_s: str = "") -> float:
    if not date_s:
        return 0.0
    candidates = []
    t = clean(time_s)
    if t:
        candidates.append(f"{date_s}T{t if len(t) != 5 else t + ':00'}")
    candidates.extend([date_s, date_s[:10]])
    for c in candidates:
        try:
            return datetime.fromisoformat(c.replace("Z", "+00:00")).timestamp()
        except Exception:
            pass
    return 0.0


def month_key(date_s: str) -> str:
    return date_s[:7] if date_s and len(date_s) >= 7 else "UNKNOWN"


def normalize_score(score: str) -> str:
    s = clean(score).replace(" ", "").replace("-", ":")
    return s if s in ALL_SCORES else s


def odds_for_score(row: Dict, score: str) -> Optional[float]:
    lower_map = {norm_key(k): v for k, v in row.items()}
    for alias in SCORE_ALIASES[score]:
        if alias in row:
            return fnum(row.get(alias))
        nk = norm_key(alias)
        if nk in lower_map:
            return fnum(lower_map[nk])
    return None


def infer_tour(row: Dict) -> str:
    v = first_present(row, ["tour", "event_type_type", "event_type", "league", "competition"]).upper()
    if "WTA" in v or "WOMEN" in v:
        return "WTA"
    if "ATP" in v or "MEN" in v:
        return "ATP"
    k = clean(row.get("event_type_key"))
    if k in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[k]
    return "UNKNOWN"


def infer_tournament_group(row: Dict) -> str:
    raw = first_present(row, ["tournament_level", "tournament_group", "level", "category"]).upper().replace(" ", "_")
    if raw:
        if "SLAM" in raw or "GRAND" in raw:
            return "GRAND_SLAM"
        if "MASTERS" in raw or "1000" in raw:
            return "MASTERS_1000"
        if "500" in raw or "250" in raw:
            return "STRONG_500_250"
        if "CHALLENGER" in raw:
            return "CHALLENGER"
        if "LOWER" in raw or "ITF" in raw:
            return "LOWER_TIER"
    t = first_present(row, ["tournament_name", "tournament", "competition"]).lower()
    if any(k in t for k in ["australian open", "roland garros", "french open", "wimbledon", "us open"]):
        return "GRAND_SLAM"
    if any(k in t for k in ["indian wells", "miami", "monte carlo", "madrid", "rome", "canada", "toronto", "montreal", "cincinnati", "shanghai", "paris masters", "doha", "dubai"]):
        return "MASTERS_1000"
    if any(k in t for k in ["barcelona", "halle", "queen", "queens", "hamburg", "tokyo", "acapulco", "rotterdam", "basel", "vienna", "adelaide", "brisbane", "rio", "dallas", "strasbourg", "berlin"]):
        return "STRONG_500_250"
    if "challenger" in t:
        return "CHALLENGER"
    if any(k in t for k in ["itf", "m15", "m25", "w15", "w25", "w35", "w50", "w75", "w100", "w125"]):
        return "LOWER_TIER"
    return "OTHER"


def infer_surface(row: Dict) -> str:
    s = first_present(row, ["surface", "court_surface", "event_surface"]).upper()
    if "CLAY" in s:
        return "CLAY"
    if "GRASS" in s:
        return "GRASS"
    if "INDOOR" in s:
        return "INDOOR"
    if "HARD" in s:
        return "HARD"
    return "UNKNOWN"


def cluster_side(scores: Sequence[str]) -> str:
    if all(s in P1_SCORES for s in scores):
        return "P1"
    if all(s in P2_SCORES for s in scores):
        return "P2"
    return "MIXED"


def cluster_name(scores: Sequence[str]) -> str:
    return "/".join(scores)


def skew_bucket(odds: Sequence[float]) -> str:
    if len(odds) < 2 or any(o <= 1 for o in odds):
        return "UNKNOWN"
    if len(odds) == 2:
        ratio = max(odds) / min(odds)
    else:
        ratio = odds[1] / ((odds[0] + odds[-1]) / 2.0) if odds[0] and odds[-1] else 999
    if ratio < 0.80:
        return "LOW"
    if ratio < 1.15:
        return "MID"
    if ratio < 1.75:
        return "HIGH"
    return "EXTREME"


def generate_clusters() -> List[Tuple[str, ...]]:
    clusters: List[Tuple[str, ...]] = []
    for side_scores in [P1_SCORES, P2_SCORES]:
        for k in [2, 3]:
            clusters.extend(combinations(side_scores, k))
    return clusters


def build_fixture_map(fixtures_path: Optional[Path]) -> Dict[str, Dict]:
    if not fixtures_path or not fixtures_path.exists():
        return {}
    out: Dict[str, Dict] = {}
    for row in read_csv(fixtures_path):
        k = first_present(row, ["event_key", "fixture_id", "id"])
        if k and k not in out:
            out[k] = row
    return out


def build_moneyline_map(moneyline_path: Optional[Path]) -> Dict[str, Dict]:
    if not moneyline_path or not moneyline_path.exists():
        return {}
    out: Dict[str, Dict] = {}
    for row in read_csv(moneyline_path):
        event = first_present(row, ["event_key", "fixture_id", "id"])
        book = first_present(row, ["bookmaker", "book", "bookmaker_name"])
        if not event:
            continue
        p1 = fnum(first_present(row, ["p1_odds", "home_odds", "odds_home", "player1_odds", "home"]))
        p2 = fnum(first_present(row, ["p2_odds", "away_odds", "odds_away", "player2_odds", "away"]))
        fav = first_present(row, ["favorite_side", "match_favorite", "favorite"]).upper()
        if fav not in {"P1", "P2"} and p1 and p2:
            fav = "P1" if p1 < p2 else "P2"
        rec = {"favorite_side": fav if fav in {"P1", "P2"} else "UNKNOWN", "p1_odds": p1, "p2_odds": p2}
        out[f"{event}|{book.lower()}"] = rec
        out.setdefault(f"{event}|", rec)
    return out


def favorite_status(event_key: str, bookmaker: str, side: str, moneyline_map: Dict[str, Dict]) -> str:
    if side not in {"P1", "P2"}:
        return "UNKNOWN"
    rec = moneyline_map.get(f"{event_key}|{bookmaker.lower()}") or moneyline_map.get(f"{event_key}|")
    if not rec:
        return "UNKNOWN"
    fav = rec.get("favorite_side")
    if fav not in {"P1", "P2"}:
        return "UNKNOWN"
    return "FAVORITE" if fav == side else "UNDERDOG"


def normalize_rows(input_path: Path, fixtures_path: Optional[Path]) -> Tuple[List[Dict], Dict]:
    fixtures = build_fixture_map(fixtures_path)
    raw_rows = read_csv(input_path)
    normed: List[Dict] = []
    diagnostic = {"input_rows": len(raw_rows), "settled_rows": 0, "missing_scores_rows": 0, "bookmakers": {}, "tours": {}, "tournament_groups": {}, "surfaces": {}}
    for raw in raw_rows:
        event_key = first_present(raw, ["event_key", "fixture_id", "id"])
        merged = {**fixtures.get(event_key, {}), **raw}
        date_s = parse_date(merged)
        event_time = first_present(merged, ["event_time", "match_time", "time"])
        score = normalize_score(first_present(merged, ["actual_first_set_score", "first_set_score", "set1_score", "set_1_score"]))
        bookmaker = first_present(merged, ["bookmaker", "book", "bookmaker_name"]) or "UNKNOWN"
        item = {
            "event_key": event_key or f"{date_s}|{first_present(merged, ['player1','home_team','event_first_player'])}|{first_present(merged, ['player2','away_team','event_second_player'])}|{bookmaker}",
            "event_date": date_s,
            "event_time": event_time,
            "ts": parse_ts(date_s, event_time),
            "player1": first_present(merged, ["player1", "home_player", "home_team", "event_first_player"]),
            "player2": first_present(merged, ["player2", "away_player", "away_team", "event_second_player"]),
            "match_name": first_present(merged, ["match_name"]),
            "bookmaker": bookmaker,
            "tour": infer_tour(merged),
            "tournament_group": infer_tournament_group(merged),
            "tournament_name": first_present(merged, ["tournament_name", "tournament", "competition"]),
            "surface": infer_surface(merged),
            "actual_first_set_score": score,
        }
        if not item["match_name"]:
            item["match_name"] = f"{item['player1']} vs {item['player2']}".strip(" vs ")
        for s in ALL_SCORES:
            item[f"odds_{s.replace(':','_')}"] = odds_for_score(merged, s)
        if score in ALL_SCORES:
            diagnostic["settled_rows"] += 1
        else:
            diagnostic["missing_scores_rows"] += 1
        for key, val in [("bookmakers", bookmaker), ("tours", item["tour"]), ("tournament_groups", item["tournament_group"]), ("surfaces", item["surface"])]:
            diagnostic[key][val] = diagnostic[key].get(val, 0) + 1
        normed.append(item)
    return normed, diagnostic


def months_in_order(candidates: List[Dict]) -> List[str]:
    return sorted({month_key(c.get("event_date", "")) for c in candidates if month_key(c.get("event_date", "")) != "UNKNOWN"})


def assign_periods(candidates: List[Dict], train_months: int, test_months: int, validate_months: int) -> Tuple[Dict[str, str], Dict]:
    months = months_in_order(candidates)
    periods: Dict[str, str] = {}
    if len(months) >= train_months + test_months + validate_months:
        for i, m in enumerate(months):
            if i < train_months:
                periods[m] = "train"
            elif i < train_months + test_months:
                periods[m] = "test"
            elif i < train_months + test_months + validate_months:
                periods[m] = "validate"
            else:
                periods[m] = "future"
    else:
        n = len(months)
        t_end = max(1, int(n * 0.70))
        v_start = max(t_end + 1, int(n * 0.85)) if n >= 3 else n
        for i, m in enumerate(months):
            periods[m] = "train" if i < t_end else "test" if i < v_start else "validate"
    meta = {
        "months": months,
        "periods": periods,
        "train_months": [m for m, p in periods.items() if p == "train"],
        "test_months": [m for m, p in periods.items() if p == "test"],
        "validate_months": [m for m, p in periods.items() if p == "validate"],
        "future_months": [m for m, p in periods.items() if p == "future"],
    }
    return periods, meta


def book_groups_for(book: str) -> List[str]:
    b = book.lower()
    if b == "bet365":
        return ["bet365", "bet365_1xBet", "ALL"]
    if b == "1xbet":
        return ["1xBet", "bet365_1xBet", "ALL"]
    return ["ALL"]


def price_buckets_for(price: float) -> List[Tuple[str, float, float]]:
    return [(name, lo, hi) for name, lo, hi in PRICE_BUCKETS if lo <= price <= hi]


def option_values(v: str, include_unknown_specific: bool = False) -> List[str]:
    if not v:
        return ["ALL"]
    if v == "UNKNOWN" and not include_unknown_specific:
        return ["ALL"]
    return [v, "ALL"]


def build_candidates(rows: List[Dict], moneyline_map: Dict[str, Dict], clusters: List[Tuple[str, ...]], allowed_books: set, price_min: float, price_max: float) -> Tuple[List[Dict], Dict]:
    out: List[Dict] = []
    funnel = {"rows_seen": len(rows), "settled_rows": 0, "candidate_rows": 0, "missing_cluster_odds": 0, "price_filtered_out": 0, "book_filtered_out": 0}
    for row in rows:
        score = row.get("actual_first_set_score")
        if score not in ALL_SCORES:
            continue
        funnel["settled_rows"] += 1
        book = row.get("bookmaker", "UNKNOWN")
        if allowed_books and book.lower() not in allowed_books:
            funnel["book_filtered_out"] += 1
            continue
        for cluster in clusters:
            odds = [row.get(f"odds_{s.replace(':','_')}") for s in cluster]
            go = grouped_odds(odds)
            if not go:
                funnel["missing_cluster_odds"] += 1
                continue
            if go < price_min or go > price_max:
                funnel["price_filtered_out"] += 1
                continue
            side = cluster_side(cluster)
            fav = favorite_status(row.get("event_key", ""), book, side, moneyline_map)
            out.append({
                "event_key": row.get("event_key"), "event_date": row.get("event_date"), "event_time": row.get("event_time"), "ts": row.get("ts", 0),
                "match_name": row.get("match_name"), "bookmaker": book, "tour": row.get("tour"), "tournament_group": row.get("tournament_group"), "tournament_name": row.get("tournament_name"), "surface": row.get("surface"),
                "cluster": cluster_name(cluster), "cluster_size": len(cluster), "side": side, "grouped_odds": go, "skew_bucket": skew_bucket([float(x) for x in odds]), "favorite_status": fav,
                "actual_first_set_score": score, "won": score in set(cluster), "period": "unknown",
            })
            funnel["candidate_rows"] += 1
    return out, funnel


def metrics(rows: List[Dict]) -> Dict:
    n = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    profit = sum((float(r["grouped_odds"]) - 1.0) if r.get("won") else -1.0 for r in rows)
    avg_odds = sum(float(r["grouped_odds"]) for r in rows) / n if n else 0.0
    hit = wins / n if n else 0.0
    roi = profit / n if n else 0.0
    be = 1.0 / avg_odds if avg_odds else 0.0
    lo, hi = wilson_interval(wins, n)
    month_profit = defaultdict(float)
    for r in rows:
        month_profit[month_key(r.get("event_date", ""))] += (float(r["grouped_odds"]) - 1.0) if r.get("won") else -1.0
    positive_months = sum(1 for v in month_profit.values() if v > 0)
    return {"bets": n, "wins": wins, "losses": n - wins, "hit_rate": hit, "avg_odds": avg_odds, "breakeven_hit_rate": be, "edge_vs_breakeven": hit - be, "profit_units": profit, "flat_roi": roi, "wilson_low": lo, "wilson_high": hi, "months": len(month_profit), "positive_months": positive_months, "positive_month_ratio": positive_months / len(month_profit) if month_profit else 0.0}


def aggregate_add(agg: Dict, cand: Dict) -> None:
    agg["bets"] += 1
    agg["wins"] += 1 if cand["won"] else 0
    agg["profit"] += (float(cand["grouped_odds"]) - 1.0) if cand["won"] else -1.0
    agg["odds_sum"] += float(cand["grouped_odds"])
    p = cand.get("period", "unknown")
    agg[f"{p}_bets"] += 1
    agg[f"{p}_wins"] += 1 if cand["won"] else 0
    agg[f"{p}_profit"] += (float(cand["grouped_odds"]) - 1.0) if cand["won"] else -1.0


def rollup_keys(c: Dict) -> Iterable[Tuple]:
    for price_name, lo, hi in price_buckets_for(float(c["grouped_odds"])):
        for book_group in book_groups_for(c["bookmaker"]):
            for tour in option_values(c["tour"]):
                for tourn in option_values(c["tournament_group"]):
                    for surface in option_values(c["surface"]):
                        for fav in option_values(c["favorite_status"]):
                            for skew in option_values(c["skew_bucket"], include_unknown_specific=True):
                                yield (c["cluster"], book_group, tour, tourn, surface, fav, skew, price_name, lo, hi)


def aggregate_rules(candidates: List[Dict], max_bucket_updates: int) -> Tuple[Dict[Tuple, Dict], int, bool]:
    aggs: Dict[Tuple, Dict] = defaultdict(lambda: defaultdict(float))
    updates = 0
    stopped_early = False
    for c in candidates:
        for key in rollup_keys(c):
            aggregate_add(aggs[key], c)
            updates += 1
            if max_bucket_updates and updates >= max_bucket_updates:
                stopped_early = True
                return aggs, updates, stopped_early
    return aggs, updates, stopped_early


def key_to_rule(key: Tuple, idx: int) -> Dict:
    cluster, book_group, tour, tourn, surface, fav, skew, price_name, lo, hi = key
    return {"rule_id": f"WNFAST{idx:06d}", "cluster": cluster, "cluster_size": len(cluster.split("/")), "side": cluster_side(tuple(cluster.split("/"))), "book_group": book_group, "tour": tour, "tournament_group": tourn, "surface": surface, "favorite_status": fav, "skew_bucket": skew, "price_bucket": price_name, "price_min": lo, "price_max": hi}


def agg_metrics(a: Dict, period: str = "") -> Dict:
    if period:
        n = int(a.get(f"{period}_bets", 0))
        wins = int(a.get(f"{period}_wins", 0))
        profit = float(a.get(f"{period}_profit", 0.0))
        avg_odds = 0.0
    else:
        n = int(a.get("bets", 0))
        wins = int(a.get("wins", 0))
        profit = float(a.get("profit", 0.0))
        avg_odds = float(a.get("odds_sum", 0.0)) / n if n else 0.0
    hit = wins / n if n else 0.0
    roi = profit / n if n else 0.0
    be = 1.0 / avg_odds if avg_odds else 0.0
    lo, hi = wilson_interval(wins, n)
    return {"bets": n, "wins": wins, "losses": n - wins, "hit_rate": hit, "avg_odds": avg_odds, "breakeven_hit_rate": be, "edge_vs_breakeven": hit - be, "profit_units": profit, "flat_roi": roi, "wilson_low": lo, "wilson_high": hi}


def overfit_flags(train: Dict, test: Dict, val: Dict, future: Dict, min_test: int, min_val: int, min_future: int) -> List[str]:
    flags = []
    if train["bets"] < 50:
        flags.append("LOW_TRAIN_SAMPLE")
    if test["bets"] < min_test:
        flags.append("LOW_TEST_SAMPLE")
    if val["bets"] < min_val:
        flags.append("LOW_VALIDATE_SAMPLE")
    if future["bets"] < min_future:
        flags.append("LOW_FUTURE_SAMPLE")
    if train["flat_roi"] > 0.10 and test["flat_roi"] < 0:
        flags.append("TEST_ROI_FLIPPED_NEGATIVE")
    if test["flat_roi"] > 0.10 and val["flat_roi"] < 0:
        flags.append("VALIDATE_ROI_FLIPPED_NEGATIVE")
    if val["flat_roi"] > 0.10 and future["bets"] >= min_future and future["flat_roi"] < 0:
        flags.append("FUTURE_ROI_FLIPPED_NEGATIVE")
    if train["hit_rate"] - test["hit_rate"] > 0.15:
        flags.append("TRAIN_TEST_HIT_DECAY")
    if test["hit_rate"] - val["hit_rate"] > 0.15:
        flags.append("TEST_VALIDATE_HIT_DECAY")
    if val["hit_rate"] - future["hit_rate"] > 0.15 and future["bets"] >= min_future:
        flags.append("VALIDATE_FUTURE_HIT_DECAY")
    return flags


def rule_score(all_m: Dict, train_m: Dict, test_m: Dict, val_m: Dict, future_m: Dict, flags: List[str]) -> float:
    future_component = future_m["flat_roi"] * 55 if future_m["bets"] else -20
    return (
        all_m["flat_roi"] * 110
        + all_m["hit_rate"] * 28
        + min(all_m["bets"], 700) / 120
        + test_m["flat_roi"] * 30
        + val_m["flat_roi"] * 30
        + future_component
        - len(flags) * 12
    )


def candidate_matches_rule(c: Dict, r: Dict) -> bool:
    if c["cluster"] != r["cluster"]:
        return False
    cb = c["bookmaker"].lower()
    if r["book_group"] == "bet365" and cb != "bet365":
        return False
    if r["book_group"] == "1xBet" and cb != "1xbet":
        return False
    if r["book_group"] == "bet365_1xBet" and cb not in {"bet365", "1xbet"}:
        return False
    if r["tour"] != "ALL" and c["tour"] != r["tour"]:
        return False
    if r["tournament_group"] != "ALL" and c["tournament_group"] != r["tournament_group"]:
        return False
    if r["surface"] != "ALL" and c["surface"] != r["surface"]:
        return False
    if r["favorite_status"] != "ALL" and c["favorite_status"] != r["favorite_status"]:
        return False
    if r["skew_bucket"] != "ALL" and c["skew_bucket"] != r["skew_bucket"]:
        return False
    return r["price_min"] <= float(c["grouped_odds"]) <= r["price_max"]


def apply_daily_cap(rows: List[Dict], cap: int) -> List[Dict]:
    ordered = sorted(rows, key=lambda r: (r.get("event_date", ""), -float(r.get("grouped_odds", 0)), r.get("ts", 0)))
    if cap <= 0:
        return ordered
    counts = defaultdict(int)
    out = []
    for r in ordered:
        d = r.get("event_date") or "UNKNOWN"
        if counts[d] >= cap:
            continue
        counts[d] += 1
        out.append(r)
    return out


def simulate_bankroll(rows: List[Dict], start_bankroll: float, risk_pct: float) -> Dict:
    br = start_bankroll
    peak = br
    max_dd = 0.0
    worst_streak = 0
    cur_streak = 0
    curve = []
    for i, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("match_name", ""))), 1):
        stake = max(0.0, br * risk_pct)
        if r.get("won"):
            br += stake * (float(r["grouped_odds"]) - 1.0)
            cur_streak = 0
        else:
            br -= stake
            cur_streak += 1
            worst_streak = max(worst_streak, cur_streak)
        peak = max(peak, br)
        dd = (peak - br) / peak if peak > 0 else 1.0
        max_dd = max(max_dd, dd)
        if i <= 2000:
            curve.append({"idx": i, "date": r.get("event_date"), "bankroll": round(br, 2), "drawdown_pct": round(dd * 100, 4)})
    return {"risk_pct": risk_pct, "start_bankroll": start_bankroll, "final_bankroll": br, "return_pct": (br / start_bankroll - 1.0) if start_bankroll else 0.0, "max_drawdown_pct": max_dd, "worst_losing_streak": worst_streak, "curve": curve}


def pct(x) -> str:
    return f"{float(x) * 100:.2f}%"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-csv", required=True)
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--moneyline", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-wide-net-strategy-discovery")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--train-months", type=int, default=6)
    ap.add_argument("--test-months", type=int, default=1)
    ap.add_argument("--validate-months", type=int, default=1)
    ap.add_argument("--min-bets", type=int, default=100)
    ap.add_argument("--min-test-bets", type=int, default=15)
    ap.add_argument("--min-validate-bets", type=int, default=15)
    ap.add_argument("--min-future-bets", type=int, default=20)
    ap.add_argument("--max-rules", type=int, default=800, help="Number of promising aggregate rules to fully simulate after fast pre-score.")
    ap.add_argument("--max-bucket-updates", type=int, default=0, help="Optional emergency cap for aggregate bucket updates. 0 = no cap.")
    ap.add_argument("--books", default="bet365,1xBet", help="Comma-separated bookmaker filter. Default targets current audit books.")
    ap.add_argument("--price-min", type=float, default=2.50)
    ap.add_argument("--price-max", type=float, default=4.50)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    input_path = Path(args.input_csv)
    fixtures_path = Path(args.fixtures) if args.fixtures else None
    moneyline_path = Path(args.moneyline) if args.moneyline else None
    allowed_books = {b.strip().lower() for b in args.books.split(",") if b.strip()}

    rows, ingest_diag = normalize_rows(input_path, fixtures_path)
    moneyline_map = build_moneyline_map(moneyline_path)
    clusters = generate_clusters()
    candidates, funnel = build_candidates(rows, moneyline_map, clusters, allowed_books, args.price_min, args.price_max)
    periods, split_meta = assign_periods(candidates, args.train_months, args.test_months, args.validate_months)
    for c in candidates:
        c["period"] = periods.get(month_key(c.get("event_date", "")), "future")

    aggs, bucket_updates, stopped_early = aggregate_rules(candidates, args.max_bucket_updates)
    pre_rows = []
    idx = 0
    for key, a in aggs.items():
        all_m = agg_metrics(a)
        if all_m["bets"] < args.min_bets or all_m["flat_roi"] <= 0:
            continue
        train_m = agg_metrics(a, "train")
        test_m = agg_metrics(a, "test")
        val_m = agg_metrics(a, "validate")
        future_m = agg_metrics(a, "future")
        flags = overfit_flags(train_m, test_m, val_m, future_m, args.min_test_bets, args.min_validate_bets, args.min_future_bets)
        idx += 1
        rule = key_to_rule(key, idx)
        pre_rows.append({
            **rule,
            **{f"all_{k}": v for k, v in all_m.items()},
            "train_bets": train_m["bets"], "train_hit_rate": train_m["hit_rate"], "train_roi": train_m["flat_roi"], "train_wilson_low": train_m["wilson_low"],
            "test_bets": test_m["bets"], "test_hit_rate": test_m["hit_rate"], "test_roi": test_m["flat_roi"], "test_wilson_low": test_m["wilson_low"],
            "validate_bets": val_m["bets"], "validate_hit_rate": val_m["hit_rate"], "validate_roi": val_m["flat_roi"], "validate_wilson_low": val_m["wilson_low"],
            "future_bets": future_m["bets"], "future_hit_rate": future_m["hit_rate"], "future_roi": future_m["flat_roi"], "future_wilson_low": future_m["wilson_low"],
            "overfit_flags": ";".join(flags),
            "pre_score": rule_score(all_m, train_m, test_m, val_m, future_m, flags),
        })

    pre_rows.sort(key=lambda r: (r["pre_score"], r["future_roi"], r["all_flat_roi"], r["all_bets"]), reverse=True)
    to_simulate = pre_rows[: max(1, args.max_rules)]

    leaderboard = []
    train_test_rows = []
    risk_rows = []
    monthly_rows = []
    curves = {}
    for r in to_simulate:
        base_rows = [c for c in candidates if candidate_matches_rule(c, r)]
        for cap in DAILY_CAPS:
            capped = apply_daily_cap(base_rows, cap)
            if len(capped) < args.min_bets:
                continue
            all_m = metrics(capped)
            if all_m["flat_roi"] <= 0:
                continue
            train_m = metrics([x for x in capped if x["period"] == "train"])
            test_m = metrics([x for x in capped if x["period"] == "test"])
            val_m = metrics([x for x in capped if x["period"] == "validate"])
            future_m = metrics([x for x in capped if x["period"] == "future"])
            flags = overfit_flags(train_m, test_m, val_m, future_m, args.min_test_bets, args.min_validate_bets, args.min_future_bets)
            sim2 = simulate_bankroll(capped, args.start_bankroll, 0.02)
            rule_id = f"{r['rule_id']}_CAP{cap}"
            out = {
                **{k: r[k] for k in ["cluster", "cluster_size", "side", "book_group", "tour", "tournament_group", "surface", "favorite_status", "skew_bucket", "price_bucket", "price_min", "price_max"]},
                "rule_id": rule_id,
                "daily_cap": cap,
                **{f"all_{k}": v for k, v in all_m.items()},
                "train_bets": train_m["bets"], "train_hit_rate": train_m["hit_rate"], "train_roi": train_m["flat_roi"], "train_wilson_low": train_m["wilson_low"],
                "test_bets": test_m["bets"], "test_hit_rate": test_m["hit_rate"], "test_roi": test_m["flat_roi"], "test_wilson_low": test_m["wilson_low"],
                "validate_bets": val_m["bets"], "validate_hit_rate": val_m["hit_rate"], "validate_roi": val_m["flat_roi"], "validate_wilson_low": val_m["wilson_low"],
                "future_bets": future_m["bets"], "future_hit_rate": future_m["hit_rate"], "future_roi": future_m["flat_roi"], "future_wilson_low": future_m["wilson_low"],
                "final_bankroll_2pct": sim2["final_bankroll"], "return_2pct": sim2["return_pct"], "max_drawdown_2pct": sim2["max_drawdown_pct"], "worst_losing_streak_2pct": sim2["worst_losing_streak"],
                "overfit_flags": ";".join(flags),
                "score": rule_score(all_m, train_m, test_m, val_m, future_m, flags) - sim2["max_drawdown_pct"] * 80,
            }
            leaderboard.append(out)
            train_test_rows.append({"rule_id": rule_id, **{f"train_{k}": v for k, v in train_m.items()}, **{f"test_{k}": v for k, v in test_m.items()}, **{f"validate_{k}": v for k, v in val_m.items()}, **{f"future_{k}": v for k, v in future_m.items()}, "overfit_flags": out["overfit_flags"]})
            for rp in RISK_PCTS:
                sim = simulate_bankroll(capped, args.start_bankroll, rp)
                risk_rows.append({"rule_id": rule_id, "risk_pct": rp, "daily_cap": cap, "bets": len(capped), "final_bankroll": sim["final_bankroll"], "return_pct": sim["return_pct"], "max_drawdown_pct": sim["max_drawdown_pct"], "worst_losing_streak": sim["worst_losing_streak"]})
                if rp == 0.02 and len(curves) < 50:
                    curves[rule_id] = sim["curve"][-1000:]
            by_month = defaultdict(list)
            for x in capped:
                by_month[month_key(x.get("event_date", ""))].append(x)
            for m, rs in by_month.items():
                monthly_rows.append({"rule_id": rule_id, "month": m, **metrics(rs)})

    leaderboard.sort(key=lambda r: (r["score"], r["future_roi"], r["all_flat_roi"], r["all_bets"]), reverse=True)
    research_watchlist = [r for r in leaderboard if r["all_flat_roi"] > 0.15 and r["all_hit_rate"] > 0.38 and r["max_drawdown_2pct"] < 0.20][:25]
    clean_snipers = [
        r for r in research_watchlist
        if r["future_bets"] >= args.min_future_bets
        and r["future_roi"] > 0
        and "ROI_FLIPPED_NEGATIVE" not in r["overfit_flags"]
        and "LOW_FUTURE_SAMPLE" not in r["overfit_flags"]
    ][:3]

    base_fields = [
        "rule_id", "cluster", "cluster_size", "side", "book_group", "tour", "tournament_group", "surface", "favorite_status", "skew_bucket", "price_bucket", "price_min", "price_max", "daily_cap",
        "all_bets", "all_wins", "all_losses", "all_hit_rate", "all_avg_odds", "all_breakeven_hit_rate", "all_edge_vs_breakeven", "all_profit_units", "all_flat_roi", "all_wilson_low", "all_wilson_high", "all_months", "all_positive_months", "all_positive_month_ratio",
        "train_bets", "train_hit_rate", "train_roi", "train_wilson_low", "test_bets", "test_hit_rate", "test_roi", "test_wilson_low", "validate_bets", "validate_hit_rate", "validate_roi", "validate_wilson_low", "future_bets", "future_hit_rate", "future_roi", "future_wilson_low",
        "final_bankroll_2pct", "return_2pct", "max_drawdown_2pct", "worst_losing_streak_2pct", "overfit_flags", "score",
    ]
    write_csv(out_dir / "wide_net_strategy_leaderboard.csv", leaderboard[:2000], base_fields)
    write_csv(out_dir / "wide_net_strategy_top_snipers.csv", clean_snipers, base_fields)
    write_csv(out_dir / "wide_net_strategy_research_watchlist.csv", research_watchlist, base_fields)
    write_csv(out_dir / "wide_net_strategy_train_test.csv", train_test_rows[:5000], list(train_test_rows[0].keys()) if train_test_rows else ["rule_id"])
    write_csv(out_dir / "wide_net_strategy_risk_sims.csv", risk_rows[:10000], list(risk_rows[0].keys()) if risk_rows else ["rule_id"])
    write_csv(out_dir / "wide_net_strategy_monthly.csv", monthly_rows[:15000], list(monthly_rows[0].keys()) if monthly_rows else ["rule_id"])
    write_json(out_dir / "wide_net_strategy_bankroll_curves.json", curves)
    write_json(out_dir / "wide_net_strategy_cards.json", clean_snipers)
    audit = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "fast_engine": True,
        "future_holdout_enabled": True,
        "input_csv": str(input_path),
        "fixtures_csv": str(fixtures_path) if fixtures_path else "",
        "moneyline_csv": str(moneyline_path) if moneyline_path else "",
        "books_filter": sorted(allowed_books),
        "price_min": args.price_min,
        "price_max": args.price_max,
        "min_future_bets": args.min_future_bets,
        "ingest": ingest_diag,
        "funnel": funnel,
        "clusters_generated": len(clusters),
        "candidate_rows_after_filter": len(candidates),
        "bucket_updates": bucket_updates,
        "bucket_update_cap_hit": stopped_early,
        "aggregate_buckets": len(aggs),
        "pre_scored_rules": len(pre_rows),
        "fully_simulated_base_rules": len(to_simulate),
        "leaderboard_rows": len(leaderboard),
        "research_watchlist_rows": len(research_watchlist),
        "clean_top_sniper_rows": len(clean_snipers),
        "split": split_meta,
    }
    write_json(out_dir / "wide_net_strategy_audit.json", audit)

    lines = [
        "# SlipIQ Fast Wide-Net Strategy Discovery Report", "",
        f"Generated: {audit['generated_at']}", "",
        "## Runtime strategy", "This fast engine builds candidate rows once, pre-scores aggregate rule buckets, then only runs drawdown/compounding simulations on the strongest candidate rules.", "",
        "## Future-holdout audit", "Top snipers now require the remaining future months to be positive with enough sample. Exciting rules that fail this are exported to `wide_net_strategy_research_watchlist.csv` instead of being treated as production-ready.", "",
        "## Ingest", f"Input rows: {ingest_diag['input_rows']}", f"Settled rows: {ingest_diag['settled_rows']}", f"Candidate rows after book/price filter: {len(candidates)}", f"Aggregate buckets: {len(aggs)}", f"Pre-scored rules: {len(pre_rows)}", f"Fully simulated base rules: {len(to_simulate)}", f"Leaderboard rows: {len(leaderboard)}", f"Research watchlist rows: {len(research_watchlist)}", f"Clean top sniper rows: {len(clean_snipers)}", "",
        "## Walk-forward split", f"Train months: {', '.join(split_meta['train_months']) or 'n/a'}", f"Test months: {', '.join(split_meta['test_months']) or 'n/a'}", f"Validate months: {', '.join(split_meta['validate_months']) or 'n/a'}", f"Future holdout months: {', '.join(split_meta['future_months']) or 'n/a'}", "",
        "## Clean Top 3 Sniper Rules",
    ]
    if not clean_snipers:
        lines.append("No rule met ROI > 15%, hit rate > 38%, max DD < 20%, and positive future-holdout checks. Check `wide_net_strategy_research_watchlist.csv` for promising but unproven rules.")
    else:
        for i, r in enumerate(clean_snipers, 1):
            lines += [
                f"### {i}. {r['rule_id']}",
                f"Cluster: `{r['cluster']}` ({r['side']}, {r['cluster_size']}-score)",
                f"Books: {r['book_group']} | Tour: {r['tour']} | Tournament: {r['tournament_group']} | Surface: {r['surface']}",
                f"Favorite: {r['favorite_status']} | Skew: {r['skew_bucket']} | Price: {r['price_min']:.2f}-{r['price_max']:.2f} | Daily cap: {r['daily_cap'] or 'none'}",
                f"Bets: {r['all_bets']} | Wins: {r['all_wins']} | Hit: {pct(r['all_hit_rate'])} | Avg odds: {r['all_avg_odds']:.3f}",
                f"Breakeven: {pct(r['all_breakeven_hit_rate'])} | Edge: {pct(r['all_edge_vs_breakeven'])} | Flat ROI: {pct(r['all_flat_roi'])}",
                f"Wilson 95% hit CI: {pct(r['all_wilson_low'])} - {pct(r['all_wilson_high'])}",
                f"Train ROI: {pct(r['train_roi'])} | Test ROI: {pct(r['test_roi'])} | Validate ROI: {pct(r['validate_roi'])} | Future ROI: {pct(r['future_roi'])} on {r['future_bets']} bets",
                f"2% comp final: ${r['final_bankroll_2pct']:.2f} | Max DD: {pct(r['max_drawdown_2pct'])} | Worst LS: {r['worst_losing_streak_2pct']}",
                f"Flags: {r['overfit_flags'] or 'None'}", "",
            ]
    lines += ["## Research watchlist", "Rules that hit the old sniper thresholds but did not pass clean future-holdout checks are kept in `wide_net_strategy_research_watchlist.csv` for deeper audit.", "", "## Notes", "This is still research-only. Do not update live filters until a rule survives live pre-match timing and settlement proof."]
    (out_dir / "wide_net_strategy_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
