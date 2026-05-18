#!/usr/bin/env python3
"""SlipIQ / First Set Lab Wide-Net Strategy Discovery Engine.

Research-only workflow. Does not modify live scanner filters.

Purpose:
- Load API Tennis first-set correct-score wide data or a custom audit CSV.
- Generate all 2-score and 3-score dutched clusters from the 14 first-set scores.
- Search filters: tournament level, surface, tour, bookmaker, grouped price gates,
  market skew buckets, and favorite/underdog status when moneyline data exists.
- Walk-forward validation: train on first 6 months, test on month 7, validate on month 8.
- Wilson 95% confidence interval for hit rate.
- Bankroll simulation from $5,000 at 1%, 2%, and 4%, with daily caps 0/3/5.
- Output top sniper rules where ROI > 15%, hit rate > 38%, and max DD < 20% at 2%.

Expected data options:
1) API Tennis warehouse artifact wide file:
   first_set_correct_score_wide_combined.csv + optional fixtures_full_combined.csv
2) Custom CSV with columns like:
   match_date/event_date, player1, player2, tour, tournament_level/tournament_group,
   surface, bookmaker, odds_6_0 ... odds_6_7, actual_first_set_score/first_set_score.

Optional moneyline CSV:
   moneyline_favorite_combined.csv if available. Used only to classify cluster side as
   match favorite/underdog/unknown.

This workflow is intentionally wide but still capped by --max-rules for GitHub Actions.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from itertools import combinations
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

P1_SCORES = ["6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6"]
P2_SCORES = ["0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7"]
ALL_SCORES = P1_SCORES + P2_SCORES

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

EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}

DEFAULT_PRICE_RANGES = [
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
BOOK_GROUPS = {
    "bet365": {"bet365"},
    "1xBet": {"1xBet", "1xbet", "1XBet"},
    "bet365_1xBet": {"bet365", "1xBet", "1xbet", "1XBet"},
    "ALL": None,
}
TOUR_FILTERS = ["ALL", "ATP", "WTA"]
TOURNAMENT_FILTERS = ["ALL", "GRAND_SLAM", "MASTERS", "MASTERS_1000", "500_250", "STRONG_500_250", "CHALLENGER", "LOWER_TIER", "OTHER"]
SURFACE_FILTERS = ["ALL", "HARD", "CLAY", "GRASS", "INDOOR", "UNKNOWN"]
FAVORITE_FILTERS = ["ALL", "FAVORITE", "UNDERDOG", "UNKNOWN"]
SKEW_FILTERS = ["ALL", "LOW", "MID", "HIGH", "EXTREME"]


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
        return (0.0, 0.0)
    phat = wins / n
    denom = 1 + z * z / n
    center = (phat + z * z / (2 * n)) / denom
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n) / denom
    return max(0.0, center - margin), min(1.0, center + margin)


def parse_date(row: Dict) -> str:
    for k in ["match_date", "event_date", "date", "starts_at"]:
        v = clean(row.get(k))
        if v:
            return v[:10]
    return ""


def parse_ts(date_s: str, time_s: str = "") -> float:
    if not date_s:
        return 0.0
    t = clean(time_s)
    candidates = []
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
    v = first_present(row, ["tour", "event_type_type", "event_type", "league", "competition"])
    s = v.upper()
    if "WTA" in s or "WOMEN" in s:
        return "WTA"
    if "ATP" in s or "MEN" in s:
        return "ATP"
    k = clean(row.get("event_type_key"))
    if k in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[k]
    return "UNKNOWN"


def infer_tournament_group(row: Dict) -> str:
    raw = first_present(row, ["tournament_level", "tournament_group", "level", "category"])
    s = raw.upper().replace(" ", "_")
    if s:
        if "SLAM" in s or "GRAND" in s:
            return "GRAND_SLAM"
        if "MASTERS" in s or "1000" in s:
            return "MASTERS_1000"
        if "500" in s or "250" in s:
            return "STRONG_500_250"
        if "CHALLENGER" in s:
            return "CHALLENGER"
        if "ITF" in s or "LOWER" in s:
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


def normalize_score(score: str) -> str:
    s = clean(score).replace(" ", "")
    s = s.replace("-", ":")
    if s in ALL_SCORES:
        return s
    return s


def cluster_side(scores: Sequence[str]) -> str:
    p1 = sum(1 for s in scores if s in P1_SCORES)
    p2 = sum(1 for s in scores if s in P2_SCORES)
    if p1 == len(scores):
        return "P1"
    if p2 == len(scores):
        return "P2"
    return "MIXED"


def cluster_name(scores: Sequence[str]) -> str:
    return "/".join(scores)


def skew_bucket(scores: Sequence[str], odds: Sequence[float]) -> str:
    if len(odds) < 2 or any(not o or o <= 1 for o in odds):
        return "UNKNOWN"
    if len(odds) == 2:
        ratio = max(odds) / min(odds)
    else:
        ratio = odds[1] / ((odds[0] + odds[-1]) / 2.0) if (odds[0] and odds[-1]) else 999
    if ratio < 0.80:
        return "LOW"
    if ratio < 1.15:
        return "MID"
    if ratio < 1.75:
        return "HIGH"
    return "EXTREME"


def build_fixture_map(fixtures_path: Optional[Path]) -> Dict[str, Dict]:
    if not fixtures_path or not fixtures_path.exists():
        return {}
    out = {}
    for row in read_csv(fixtures_path):
        k = first_present(row, ["event_key", "fixture_id", "id"])
        if k and k not in out:
            out[k] = row
    return out


def build_moneyline_map(moneyline_path: Optional[Path]) -> Dict[str, Dict]:
    if not moneyline_path or not moneyline_path.exists():
        return {}
    out = {}
    for row in read_csv(moneyline_path):
        event = first_present(row, ["event_key", "fixture_id", "id"])
        book = first_present(row, ["bookmaker", "book", "bookmaker_name"])
        if not event:
            continue
        p1 = fnum(first_present(row, ["p1_odds", "home_odds", "odds_home", "player1_odds", "home"] ))
        p2 = fnum(first_present(row, ["p2_odds", "away_odds", "odds_away", "player2_odds", "away"] ))
        fav = first_present(row, ["favorite_side", "match_favorite", "favorite"] ).upper()
        if fav not in {"P1", "P2"} and p1 and p2:
            fav = "P1" if p1 < p2 else "P2"
        key = f"{event}|{book.lower()}"
        out[key] = {"favorite_side": fav if fav in {"P1", "P2"} else "UNKNOWN", "p1_odds": p1, "p2_odds": p2}
        out.setdefault(f"{event}|", out[key])
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
    normed = []
    diagnostic = {"input_rows": len(raw_rows), "settled_rows": 0, "missing_scores_rows": 0, "bookmakers": {}, "tours": {}, "tournament_groups": {}, "surfaces": {}}
    for raw in raw_rows:
        row = dict(raw)
        event_key = first_present(row, ["event_key", "fixture_id", "id"])
        fixture = fixtures.get(event_key, {})
        merged = {**fixture, **row}
        date_s = parse_date(merged)
        event_time = first_present(merged, ["event_time", "match_time", "time"])
        score = normalize_score(first_present(merged, ["actual_first_set_score", "first_set_score", "set1_score", "set_1_score"] ))
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
        diagnostic["bookmakers"][bookmaker] = diagnostic["bookmakers"].get(bookmaker, 0) + 1
        diagnostic["tours"][item["tour"]] = diagnostic["tours"].get(item["tour"], 0) + 1
        diagnostic["tournament_groups"][item["tournament_group"]] = diagnostic["tournament_groups"].get(item["tournament_group"], 0) + 1
        diagnostic["surfaces"][item["surface"]] = diagnostic["surfaces"].get(item["surface"], 0) + 1
        normed.append(item)
    return normed, diagnostic


def generate_clusters() -> List[Tuple[str, ...]]:
    clusters = []
    for side_scores in [P1_SCORES, P2_SCORES]:
        # all possible 2-score and 3-score clusters within one side only.
        for k in [2, 3]:
            for combo in combinations(side_scores, k):
                clusters.append(combo)
    return clusters


def build_candidates(rows: List[Dict], moneyline_map: Dict[str, Dict], clusters: List[Tuple[str, ...]]) -> Tuple[List[Dict], Dict]:
    out = []
    funnel = {"rows_seen": len(rows), "settled_rows": 0, "candidate_rows": 0, "missing_cluster_odds": 0}
    for row in rows:
        score = row.get("actual_first_set_score")
        if score not in ALL_SCORES:
            continue
        funnel["settled_rows"] += 1
        for cluster in clusters:
            odds = [row.get(f"odds_{s.replace(':','_')}") for s in cluster]
            go = grouped_odds(odds)
            if not go:
                funnel["missing_cluster_odds"] += 1
                continue
            side = cluster_side(cluster)
            fav = favorite_status(row.get("event_key", ""), row.get("bookmaker", ""), side, moneyline_map)
            out.append({
                "event_key": row.get("event_key"),
                "event_date": row.get("event_date"),
                "event_time": row.get("event_time"),
                "ts": row.get("ts", 0),
                "match_name": row.get("match_name"),
                "player1": row.get("player1"),
                "player2": row.get("player2"),
                "bookmaker": row.get("bookmaker"),
                "tour": row.get("tour"),
                "tournament_group": row.get("tournament_group"),
                "tournament_name": row.get("tournament_name"),
                "surface": row.get("surface"),
                "cluster": cluster_name(cluster),
                "cluster_size": len(cluster),
                "side": side,
                "grouped_odds": go,
                "skew_bucket": skew_bucket(cluster, odds),
                "favorite_status": fav,
                "actual_first_set_score": score,
                "won": score in set(cluster),
            })
            funnel["candidate_rows"] += 1
    return out, funnel


def months_in_order(candidates: List[Dict]) -> List[str]:
    return sorted({month_key(c.get("event_date", "")) for c in candidates if month_key(c.get("event_date", "")) != "UNKNOWN"})


def assign_periods(candidates: List[Dict], train_months: int = 6, test_months: int = 1, validate_months: int = 1) -> Tuple[Dict[str, str], Dict]:
    months = months_in_order(candidates)
    if len(months) < train_months + test_months + validate_months:
        # fall back to proportional split while keeping period names.
        n = len(months)
        t_end = max(1, int(n * 0.70))
        v_start = max(t_end + 1, int(n * 0.85)) if n >= 3 else n
        periods = {}
        for i, m in enumerate(months):
            periods[m] = "train" if i < t_end else "test" if i < v_start else "validate"
    else:
        periods = {}
        for i, m in enumerate(months):
            if i < train_months:
                periods[m] = "train"
            elif i < train_months + test_months:
                periods[m] = "test"
            elif i < train_months + test_months + validate_months:
                periods[m] = "validate"
            else:
                periods[m] = "future"
    meta = {"months": months, "periods": periods, "train_months": [m for m, p in periods.items() if p == "train"], "test_months": [m for m, p in periods.items() if p == "test"], "validate_months": [m for m, p in periods.items() if p == "validate"]}
    return periods, meta


def passes_rule(c: Dict, rule: Dict) -> bool:
    if rule["cluster"] != c["cluster"]:
        return False
    if rule["book_group"] != "ALL":
        allowed = BOOK_GROUPS[rule["book_group"]]
        if c["bookmaker"] not in allowed:
            return False
    if rule["tour"] != "ALL" and c["tour"] != rule["tour"]:
        return False
    if rule["tournament_group"] != "ALL":
        if rule["tournament_group"] == "MASTERS" and c["tournament_group"] != "MASTERS_1000":
            return False
        elif rule["tournament_group"] == "500_250" and c["tournament_group"] != "STRONG_500_250":
            return False
        elif c["tournament_group"] != rule["tournament_group"]:
            return False
    if rule["surface"] != "ALL" and c["surface"] != rule["surface"]:
        return False
    if rule["favorite_status"] != "ALL" and c["favorite_status"] != rule["favorite_status"]:
        return False
    if rule["skew_bucket"] != "ALL" and c["skew_bucket"] != rule["skew_bucket"]:
        return False
    if not (rule["price_min"] <= c["grouped_odds"] <= rule["price_max"]):
        return False
    return True


def apply_daily_cap(rows: List[Dict], cap: int) -> List[Dict]:
    ordered = sorted(rows, key=lambda r: (r.get("event_date", ""), -float(r.get("edge_sort", r.get("grouped_odds", 0))), r.get("ts", 0)))
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


def metrics(rows: List[Dict]) -> Dict:
    n = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    losses = n - wins
    profit = sum((float(r["grouped_odds"]) - 1.0) if r.get("won") else -1.0 for r in rows)
    avg_odds = sum(float(r["grouped_odds"]) for r in rows) / n if n else 0.0
    hit = wins / n if n else 0.0
    roi = profit / n if n else 0.0
    be = 1.0 / avg_odds if avg_odds else 0.0
    lo, hi = wilson_interval(wins, n)
    months = defaultdict(lambda: [0, 0.0])
    for r in rows:
        m = month_key(r.get("event_date", ""))
        months[m][0] += 1
        months[m][1] += (float(r["grouped_odds"]) - 1.0) if r.get("won") else -1.0
    positive_months = sum(1 for _, p in months.values() if p > 0)
    return {
        "bets": n,
        "wins": wins,
        "losses": losses,
        "hit_rate": hit,
        "avg_odds": avg_odds,
        "breakeven_hit_rate": be,
        "edge_vs_breakeven": hit - be,
        "profit_units": profit,
        "flat_roi": roi,
        "wilson_low": lo,
        "wilson_high": hi,
        "months": len(months),
        "positive_months": positive_months,
        "positive_month_ratio": positive_months / len(months) if months else 0.0,
    }


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
        curve.append({"idx": i, "date": r.get("event_date"), "bankroll": round(br, 2), "drawdown_pct": round(dd * 100, 4)})
    return {"risk_pct": risk_pct, "start_bankroll": start_bankroll, "final_bankroll": br, "return_pct": (br / start_bankroll - 1.0) if start_bankroll else 0.0, "max_drawdown_pct": max_dd, "worst_losing_streak": worst_streak, "curve": curve}


def build_rule_space(candidates: List[Dict], max_rules: int) -> Iterable[Dict]:
    clusters = sorted({c["cluster"] for c in candidates})
    observed_tournaments = sorted({c["tournament_group"] for c in candidates})
    observed_surfaces = sorted({c["surface"] for c in candidates})
    tournament_filters = ["ALL"] + [t for t in observed_tournaments if t]
    surface_filters = ["ALL"] + [s for s in observed_surfaces if s]
    count = 0
    for cluster in clusters:
        for book_group in BOOK_GROUPS:
            for tour in TOUR_FILTERS:
                for tournament_group in tournament_filters:
                    for surface in surface_filters:
                        for favorite_status in FAVORITE_FILTERS:
                            for skew_filter in SKEW_FILTERS:
                                for price_name, price_min, price_max in DEFAULT_PRICE_RANGES:
                                    count += 1
                                    if count > max_rules:
                                        return
                                    yield {
                                        "rule_id": f"WN{count:06d}",
                                        "cluster": cluster,
                                        "cluster_size": len(cluster.split("/")),
                                        "side": cluster_side(tuple(cluster.split("/"))),
                                        "book_group": book_group,
                                        "tour": tour,
                                        "tournament_group": tournament_group,
                                        "surface": surface,
                                        "favorite_status": favorite_status,
                                        "skew_bucket": skew_filter,
                                        "price_bucket": price_name,
                                        "price_min": price_min,
                                        "price_max": price_max,
                                    }


def overfit_flags(train_m: Dict, test_m: Dict, val_m: Dict, min_test_bets: int, min_validate_bets: int) -> List[str]:
    flags = []
    if train_m["bets"] < 50:
        flags.append("LOW_TRAIN_SAMPLE")
    if test_m["bets"] < min_test_bets:
        flags.append("LOW_TEST_SAMPLE")
    if val_m["bets"] < min_validate_bets:
        flags.append("LOW_VALIDATE_SAMPLE")
    if train_m["flat_roi"] > 0.15 and test_m["flat_roi"] < 0:
        flags.append("TEST_ROI_FLIPPED_NEGATIVE")
    if test_m["flat_roi"] > 0.15 and val_m["flat_roi"] < 0:
        flags.append("VALIDATE_ROI_FLIPPED_NEGATIVE")
    if train_m["hit_rate"] - test_m["hit_rate"] > 0.15:
        flags.append("TRAIN_TEST_HIT_DECAY")
    if test_m["hit_rate"] - val_m["hit_rate"] > 0.15:
        flags.append("TEST_VALIDATE_HIT_DECAY")
    if train_m["wilson_low"] < train_m["breakeven_hit_rate"]:
        flags.append("TRAIN_WILSON_NOT_ABOVE_BREAKEVEN")
    return flags


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-csv", required=True, help="First-set correct-score wide CSV or custom audit CSV.")
    ap.add_argument("--fixtures", default="", help="Optional fixtures CSV for tournament/tour metadata.")
    ap.add_argument("--moneyline", default="", help="Optional moneyline/favorite CSV.")
    ap.add_argument("--out", default="artifacts/output/api-tennis-wide-net-strategy-discovery")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--train-months", type=int, default=6)
    ap.add_argument("--test-months", type=int, default=1)
    ap.add_argument("--validate-months", type=int, default=1)
    ap.add_argument("--min-bets", type=int, default=100)
    ap.add_argument("--min-test-bets", type=int, default=15)
    ap.add_argument("--min-validate-bets", type=int, default=15)
    ap.add_argument("--max-rules", type=int, default=250000)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    input_path = Path(args.input_csv)
    fixtures_path = Path(args.fixtures) if args.fixtures else None
    moneyline_path = Path(args.moneyline) if args.moneyline else None

    rows, ingest_diag = normalize_rows(input_path, fixtures_path)
    moneyline_map = build_moneyline_map(moneyline_path)
    clusters = generate_clusters()
    candidates, funnel = build_candidates(rows, moneyline_map, clusters)
    periods, split_meta = assign_periods(candidates, args.train_months, args.test_months, args.validate_months)
    for c in candidates:
        c["period"] = periods.get(month_key(c.get("event_date", "")), "future")

    leaderboard = []
    train_test_rows = []
    risk_rows = []
    monthly_rows = []
    curves = {}
    rules_tested = 0

    for rule in build_rule_space(candidates, args.max_rules):
        rules_tested += 1
        rows_rule = [c for c in candidates if passes_rule(c, rule)]
        if len(rows_rule) < args.min_bets:
            continue
        # Sort quality for caps: highest model theoretical edge first = biggest price / lowest breakeven.
        for rr in rows_rule:
            rr["edge_sort"] = rr["grouped_odds"]
        for daily_cap in DAILY_CAPS:
            capped = apply_daily_cap(rows_rule, daily_cap)
            if len(capped) < args.min_bets:
                continue
            all_m = metrics(capped)
            if all_m["flat_roi"] <= 0:
                continue
            train_rows = [r for r in capped if r.get("period") == "train"]
            test_rows = [r for r in capped if r.get("period") == "test"]
            val_rows = [r for r in capped if r.get("period") == "validate"]
            train_m = metrics(train_rows)
            test_m = metrics(test_rows)
            val_m = metrics(val_rows)
            flags = overfit_flags(train_m, test_m, val_m, args.min_test_bets, args.min_validate_bets)
            sim_2 = simulate_bankroll(capped, args.start_bankroll, 0.02)
            rule_id = f"{rule['rule_id']}_CAP{daily_cap}"
            row = {
                **rule,
                "rule_id": rule_id,
                "daily_cap": daily_cap,
                **{f"all_{k}": v for k, v in all_m.items()},
                "max_drawdown_2pct": sim_2["max_drawdown_pct"],
                "final_bankroll_2pct": sim_2["final_bankroll"],
                "return_2pct": sim_2["return_pct"],
                "worst_losing_streak_2pct": sim_2["worst_losing_streak"],
                "train_bets": train_m["bets"], "train_hit_rate": train_m["hit_rate"], "train_roi": train_m["flat_roi"], "train_wilson_low": train_m["wilson_low"],
                "test_bets": test_m["bets"], "test_hit_rate": test_m["hit_rate"], "test_roi": test_m["flat_roi"], "test_wilson_low": test_m["wilson_low"],
                "validate_bets": val_m["bets"], "validate_hit_rate": val_m["hit_rate"], "validate_roi": val_m["flat_roi"], "validate_wilson_low": val_m["wilson_low"],
                "overfit_flags": ";".join(flags),
                "score": all_m["flat_roi"] * 100 + all_m["hit_rate"] * 25 + min(all_m["bets"], 500) / 100 - sim_2["max_drawdown_pct"] * 50 - len(flags) * 10,
            }
            leaderboard.append(row)
            train_test_rows.append({"rule_id": rule_id, **rule, "daily_cap": daily_cap, **{f"train_{k}": v for k, v in train_m.items()}, **{f"test_{k}": v for k, v in test_m.items()}, **{f"validate_{k}": v for k, v in val_m.items()}, "overfit_flags": ";".join(flags)})
            for risk_pct in RISK_PCTS:
                sim = simulate_bankroll(capped, args.start_bankroll, risk_pct)
                risk_rows.append({"rule_id": rule_id, "risk_pct": risk_pct, "daily_cap": daily_cap, "bets": len(capped), "final_bankroll": sim["final_bankroll"], "return_pct": sim["return_pct"], "max_drawdown_pct": sim["max_drawdown_pct"], "worst_losing_streak": sim["worst_losing_streak"]})
                if risk_pct == 0.02:
                    curves[rule_id] = sim["curve"][-1000:]
            month_stats = defaultdict(list)
            for r in capped:
                month_stats[month_key(r.get("event_date", ""))].append(r)
            for m, rs in month_stats.items():
                mm = metrics(rs)
                monthly_rows.append({"rule_id": rule_id, "month": m, **mm})

    leaderboard.sort(key=lambda r: (r.get("score", 0), r.get("all_flat_roi", 0), r.get("all_bets", 0)), reverse=True)
    sniper = [r for r in leaderboard if r["all_flat_roi"] > 0.15 and r["all_hit_rate"] > 0.38 and r["max_drawdown_2pct"] < 0.20 and "ROI_FLIPPED_NEGATIVE" not in r["overfit_flags"]][:3]

    base_fields = [
        "rule_id", "cluster", "cluster_size", "side", "book_group", "tour", "tournament_group", "surface", "favorite_status", "skew_bucket", "price_bucket", "price_min", "price_max", "daily_cap",
        "all_bets", "all_wins", "all_losses", "all_hit_rate", "all_avg_odds", "all_breakeven_hit_rate", "all_edge_vs_breakeven", "all_profit_units", "all_flat_roi", "all_wilson_low", "all_wilson_high", "all_months", "all_positive_months", "all_positive_month_ratio",
        "train_bets", "train_hit_rate", "train_roi", "train_wilson_low", "test_bets", "test_hit_rate", "test_roi", "test_wilson_low", "validate_bets", "validate_hit_rate", "validate_roi", "validate_wilson_low",
        "final_bankroll_2pct", "return_2pct", "max_drawdown_2pct", "worst_losing_streak_2pct", "overfit_flags", "score",
    ]
    write_csv(out_dir / "wide_net_strategy_leaderboard.csv", leaderboard[:2000], base_fields)
    write_csv(out_dir / "wide_net_strategy_top_snipers.csv", sniper, base_fields)
    write_csv(out_dir / "wide_net_strategy_train_test.csv", train_test_rows[:5000], list(train_test_rows[0].keys()) if train_test_rows else ["rule_id"])
    write_csv(out_dir / "wide_net_strategy_risk_sims.csv", risk_rows[:10000], list(risk_rows[0].keys()) if risk_rows else ["rule_id"])
    write_csv(out_dir / "wide_net_strategy_monthly.csv", monthly_rows[:15000], list(monthly_rows[0].keys()) if monthly_rows else ["rule_id"])
    write_json(out_dir / "wide_net_strategy_bankroll_curves.json", {k: curves[k] for k in list(curves)[:50]})
    write_json(out_dir / "wide_net_strategy_cards.json", sniper)
    audit = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "input_csv": str(input_path),
        "fixtures_csv": str(fixtures_path) if fixtures_path else "",
        "moneyline_csv": str(moneyline_path) if moneyline_path else "",
        "ingest": ingest_diag,
        "funnel": funnel,
        "clusters_generated": len(clusters),
        "rules_tested": rules_tested,
        "split": split_meta,
        "leaderboard_rows": len(leaderboard),
        "top_sniper_rows": len(sniper),
    }
    write_json(out_dir / "wide_net_strategy_audit.json", audit)

    def pct(x):
        return f"{float(x) * 100:.2f}%"

    lines = [
        "# SlipIQ Wide-Net Strategy Discovery Report",
        "",
        f"Generated: {audit['generated_at']}",
        "",
        "## Ingest",
        f"Input rows: {ingest_diag['input_rows']}",
        f"Settled rows: {ingest_diag['settled_rows']}",
        f"Candidate rows: {funnel['candidate_rows']}",
        f"Clusters generated: {len(clusters)}",
        f"Rules tested: {rules_tested}",
        f"Leaderboard rows: {len(leaderboard)}",
        "",
        "## Walk-forward split",
        f"Train months: {', '.join(split_meta['train_months']) or 'n/a'}",
        f"Test months: {', '.join(split_meta['test_months']) or 'n/a'}",
        f"Validate months: {', '.join(split_meta['validate_months']) or 'n/a'}",
        "",
        "## Top 3 Sniper Rules",
    ]
    if not sniper:
        lines += ["No rule met ROI > 15%, hit rate > 38%, and max DD < 20% at 2% staking. See leaderboard for near-misses."]
    else:
        for i, r in enumerate(sniper, 1):
            lines += [
                f"### {i}. {r['rule_id']}",
                f"Cluster: `{r['cluster']}` ({r['side']}, {r['cluster_size']}-score)",
                f"Books: {r['book_group']} | Tour: {r['tour']} | Tournament: {r['tournament_group']} | Surface: {r['surface']}",
                f"Favorite filter: {r['favorite_status']} | Skew: {r['skew_bucket']} | Price: {r['price_min']:.2f}-{r['price_max']:.2f} | Daily cap: {r['daily_cap'] or 'none'}",
                f"Bets: {r['all_bets']} | Wins: {r['all_wins']} | Hit rate: {pct(r['all_hit_rate'])} | Avg odds: {r['all_avg_odds']:.3f}",
                f"Breakeven: {pct(r['all_breakeven_hit_rate'])} | Edge: {pct(r['all_edge_vs_breakeven'])} | Flat ROI: {pct(r['all_flat_roi'])}",
                f"Wilson 95% hit CI: {pct(r['all_wilson_low'])} - {pct(r['all_wilson_high'])}",
                f"Train ROI: {pct(r['train_roi'])} | Test ROI: {pct(r['test_roi'])} | Validate ROI: {pct(r['validate_roi'])}",
                f"2% comp final: ${r['final_bankroll_2pct']:.2f} | Max DD: {pct(r['max_drawdown_2pct'])} | Worst LS: {r['worst_losing_streak_2pct']}",
                f"Flags: {r['overfit_flags'] or 'None'}",
                "",
            ]
    lines += [
        "## Notes",
        "This is a research-only wide-net search. A rule is not production-ready until it survives live pre-match timing, live odds availability, settlement, and sufficient out-of-sample volume.",
    ]
    (out_dir / "wide_net_strategy_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
