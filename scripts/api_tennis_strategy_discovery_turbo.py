#!/usr/bin/env python3
"""SlipIQ API Tennis Strategy Discovery Turbo.

A faster version of the broad Strategy Discovery Engine.

It keeps the strongest search space:
- P2 V3 9-12 cluster
- P1 mirror 9-12 cluster
- Tight/core adjacent clusters
- key book groups: bet365, 1xBet, 10Bet, combos
- ATP/WTA/tournament groups
- price/trigger thresholds
- train/test validation
- volume/ROI/hit-rate/drawdown scoring

It skips the expensive parts by default:
- no giant candidate CSV upload
- no exhaustive exact-score hunting
- no huge all-results bankroll curves

This workflow is for fast strategy discovery, not production betting.
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

SCORE_COLS = {
    "6:0": "odds_6_0", "6:1": "odds_6_1", "6:2": "odds_6_2", "6:3": "odds_6_3", "6:4": "odds_6_4", "7:5": "odds_7_5", "7:6": "odds_7_6",
    "0:6": "odds_0_6", "1:6": "odds_1_6", "2:6": "odds_2_6", "3:6": "odds_3_6", "4:6": "odds_4_6", "5:7": "odds_5_7", "6:7": "odds_6_7",
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
]

BOOK_GROUPS = {
    "bet365": {"bet365"},
    "1xBet": {"1xBet"},
    "10Bet": {"10Bet"},
    "bet365_1xBet": {"bet365", "1xBet"},
    "bet365_10Bet": {"bet365", "10Bet"},
    "bet365_1xBet_10Bet": {"bet365", "1xBet", "10Bet"},
    "ALL_BOOKS": None,
}

TRIGGER_RANGES = [
    ("ANY", None, None),
    ("TRIG_500_625", 5.00, 6.25),
    ("TRIG_625_699", 6.25, 6.99),
    ("TRIG_700_800", 7.00, 8.00),
    ("TRIG_800_1000", 8.00, 10.00),
    ("TRIG_600_800", 6.00, 8.00),
]

PRICE_GATES = [2.30, 2.40, 2.50, 2.60, 2.70, 2.80, 2.90, 3.00, 3.05, 3.15, 3.30, 3.50, 4.00]
DAILY_CAPS = [0, 3, 5, 10]
MODES = ["BOOKMAKER_ROWS", "ONE_PICK_PER_MATCH", "ONE_PICK_PER_MATCH_PER_SIDE"]


def clean(x) -> str:
    return str(x or "").strip()


def fnum(x) -> Optional[float]:
    try:
        if x is None or clean(x) == "":
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
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "market_name", "tournament_name", "event_type_type", "first_set_score"]:
        r[k] = clean(r.get(k))
    fixture = fixture_map.get(r["event_key"], {})
    for key in ["event_type_key", "event_type_type", "tournament_name"]:
        if not r.get(key):
            r[key] = clean(fixture.get(key) or fixture.get(f"event_{key}"))
    for col in SCORE_COLS.values():
        r[col] = fnum(r.get(col))
    r["tour"] = tour_from_row(r)
    r["tournament_group"] = tournament_group(r)
    r["is_settled"] = bool(r.get("first_set_score"))
    try:
        time = r.get("event_time") or "00:00"
        dt = f"{r['event_date']}T{time if len(time) != 5 else time + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


def build_candidates(rows: List[Dict]) -> List[Dict]:
    out = []
    for r in rows:
        if not r.get("is_settled"):
            continue
        base = {
            "event_key": r.get("event_key"),
            "event_date": r.get("event_date"),
            "event_time": r.get("event_time"),
            "ts": r.get("ts", 0),
            "bookmaker": r.get("bookmaker"),
            "tour": r.get("tour"),
            "tournament_group": r.get("tournament_group"),
            "tournament_name": r.get("tournament_name"),
            "first_set_score": r.get("first_set_score"),
        }
        for fam in CLUSTER_FAMILIES:
            odds = [r.get(SCORE_COLS[s]) for s in fam["scores"]]
            bet_odds = grouped_odds(odds)
            trigger = r.get(SCORE_COLS[fam["trigger_score"]])
            if not bet_odds or not trigger:
                continue
            out.append({
                **base,
                "strategy_family": fam["family"],
                "side": fam["side"],
                "scores": "/".join(fam["scores"]),
                "trigger_score": fam["trigger_score"],
                "trigger_odds": trigger,
                "bet_odds": bet_odds,
                "won": r.get("first_set_score") in set(fam["scores"]),
            })
    return out


def split_train_test(candidates: List[Dict], train_ratio: float) -> Tuple[set, set, str]:
    dates = sorted({r.get("event_date") for r in candidates if r.get("event_date")})
    if len(dates) < 3:
        return set(dates), set(), dates[-1] if dates else ""
    idx = max(1, min(len(dates) - 1, int(len(dates) * train_ratio)))
    cutoff = dates[idx]
    return {d for d in dates if d < cutoff}, {d for d in dates if d >= cutoff}, cutoff


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


def dedupe(rows: List[Dict], mode: str) -> List[Dict]:
    if mode == "BOOKMAKER_ROWS":
        seen = set()
        out = []
        for r in sorted(rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""), x.get("strategy_family", ""))):
            key = (r.get("event_key"), r.get("bookmaker"), r.get("strategy_family"), r.get("scores"))
            if key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out
    if mode == "ONE_PICK_PER_MATCH":
        groups = defaultdict(list)
        for r in rows:
            groups[r.get("event_key")].append(r)
        return [max(v, key=lambda x: (x.get("bet_odds") or 0, x.get("trigger_odds") or 0)) for v in groups.values()]
    if mode == "ONE_PICK_PER_MATCH_PER_SIDE":
        groups = defaultdict(list)
        for r in rows:
            groups[(r.get("event_key"), r.get("side"))].append(r)
        return [max(v, key=lambda x: (x.get("bet_odds") or 0, x.get("trigger_odds") or 0)) for v in groups.values()]
    return rows


def daily_cap(rows: List[Dict], cap: int) -> List[Dict]:
    if cap <= 0:
        return rows
    by_day = defaultdict(list)
    for r in rows:
        by_day[r.get("event_date")].append(r)
    out = []
    for day in sorted(by_day):
        ranked = sorted(by_day[day], key=lambda x: (x.get("bet_odds") or 0, x.get("trigger_odds") or 0), reverse=True)
        used = set()
        keep = []
        for r in ranked:
            key = (r.get("event_key"), r.get("side"))
            if key in used:
                continue
            used.add(key)
            keep.append(r)
            if len(keep) >= cap:
                break
        out.extend(keep)
    return out


def metrics(rows: List[Dict], start_bankroll: float, risk_pct: float) -> Dict:
    rows = [r for r in rows if r.get("bet_odds") and r["bet_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    avg_odds = sum(r["bet_odds"] for r in rows) / bets if bets else None
    units = sum((r["bet_odds"] - 1) if r.get("won") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    family_counts = defaultdict(int)
    book_counts = defaultdict(int)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            month_pl[m] += (r["bet_odds"] - 1) if r.get("won") else -1
        family_counts[r.get("strategy_family") or "missing"] += 1
        book_counts[r.get("bookmaker") or "missing"] += 1
    bank = start_bankroll
    peak = bank
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""))):
        stake = bank * risk_pct
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
        "positive_month_ratio": (sum(1 for v in month_pl.values() if v > 0) / len(months)) if months else None,
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": bank,
        "compound_profit": bank - start_bankroll,
        "compound_return_pct": ((bank / start_bankroll) - 1) * 100 if start_bankroll else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
        "family_mix": json.dumps(dict(sorted(family_counts.items()))),
        "book_mix": json.dumps(dict(sorted(book_counts.items()))),
    }


def score_strategy(all_m: Dict, train_m: Dict, test_m: Dict, min_test_bets: int, min_bets: int) -> Tuple[float, str]:
    flags = []
    penalty = 0.0
    if all_m["bets"] < min_bets:
        flags.append("below_min_bets")
        penalty += 20
    if train_m["bets"] < min_test_bets or test_m["bets"] < min_test_bets:
        flags.append("low_train_or_test_volume")
        penalty += 45
    if (train_m.get("flat_roi") or 0) > 0 and (test_m.get("flat_roi") or 0) < 0:
        flags.append("train_positive_test_negative")
        penalty += 40
    if abs((train_m.get("flat_roi") or 0) - (test_m.get("flat_roi") or 0)) > 0.35:
        flags.append("unstable_train_test_roi")
        penalty += 10
    roi = all_m.get("flat_roi") or 0
    edge = all_m.get("edge_vs_breakeven") or 0
    volume = min(60, math.log10(max(all_m["bets"], 1)) * 22)
    month = (all_m.get("positive_month_ratio") or 0) * 28
    hit = (all_m.get("hit_rate") or 0) * 25
    dd_penalty = max(0, (all_m.get("max_drawdown_pct") or 0) - 25) * 0.55
    streak_penalty = max(0, (all_m.get("worst_losing_streak") or 0) - 12) * 0.8
    score = volume + roi * 130 + edge * 240 + month + hit - dd_penalty - streak_penalty - penalty
    return score, ";".join(flags)


def monthly_rows(rows: List[Dict], rule_id: str) -> List[Dict]:
    by = defaultdict(list)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            by[m].append(r)
    out = []
    for month, arr in sorted(by.items()):
        m = metrics(arr, 5000, 0.02)
        out.append({"rule_id": rule_id, "month": month, "bets": m["bets"], "wins": m["wins"], "hit_rate": m["hit_rate"], "avg_odds": m["avg_odds"], "flat_roi": m["flat_roi"], "flat_profit_units": m["flat_profit_units"]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-strategy-discovery-turbo")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    ap.add_argument("--min-bets", type=int, default=100)
    ap.add_argument("--min-test-bets", type=int, default=20)
    ap.add_argument("--max-rules", type=int, default=200000)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fixture_map = build_fixture_map(Path(args.fixtures)) if args.fixtures else {}
    wide_rows = [normalize_wide(r, fixture_map) for r in read_csv(Path(args.first_set_wide))]
    candidates = build_candidates(wide_rows)
    train_dates, test_dates, cutoff = split_train_test(candidates, args.train_ratio)

    families = sorted({r["strategy_family"] for r in candidates})
    tours = ["ALL", "ATP", "WTA"]
    tgroups = ["ALL"] + sorted({r["tournament_group"] for r in candidates if r.get("tournament_group")})

    results = []
    train_test = []
    monthly = []
    rules = []
    rule_n = 0

    for fam in families:
        fam_rows = [r for r in candidates if r["strategy_family"] == fam]
        if not fam_rows:
            continue
        for book_group, allowed_books in BOOK_GROUPS.items():
            book_rows = fam_rows if allowed_books is None else [r for r in fam_rows if r.get("bookmaker") in allowed_books]
            if not book_rows:
                continue
            for tour_name in tours:
                tour_rows = book_rows if tour_name == "ALL" else [r for r in book_rows if r.get("tour") == tour_name]
                if not tour_rows:
                    continue
                for tg in tgroups:
                    group_rows = tour_rows if tg == "ALL" else [r for r in tour_rows if r.get("tournament_group") == tg]
                    if not group_rows:
                        continue
                    for trig_label, lo, hi in TRIGGER_RANGES:
                        trig_rows = [r for r in group_rows if in_range(r.get("trigger_odds"), lo, hi)]
                        if len(trig_rows) < args.min_test_bets:
                            continue
                        for gate in PRICE_GATES:
                            gate_rows = [r for r in trig_rows if r.get("bet_odds") and r["bet_odds"] >= gate]
                            if len(gate_rows) < args.min_test_bets:
                                continue
                            for mode in MODES:
                                mode_rows = dedupe(gate_rows, mode)
                                if len(mode_rows) < args.min_test_bets:
                                    continue
                                for cap in DAILY_CAPS:
                                    rows = daily_cap(mode_rows, cap)
                                    if len(rows) < args.min_test_bets:
                                        continue
                                    rule_n += 1
                                    if rule_n > args.max_rules:
                                        break
                                    rule_id = f"TURBO{rule_n:06d}"
                                    train_rows = [r for r in rows if r.get("event_date") in train_dates]
                                    test_rows = [r for r in rows if r.get("event_date") in test_dates]
                                    m_all = metrics(rows, args.start_bankroll, args.risk_pct)
                                    m_train = metrics(train_rows, args.start_bankroll, args.risk_pct)
                                    m_test = metrics(test_rows, args.start_bankroll, args.risk_pct)
                                    strategy_score, flags = score_strategy(m_all, m_train, m_test, args.min_test_bets, args.min_bets)
                                    base = {"rule_id": rule_id, "strategy_family": fam, "book_group": book_group, "tour": tour_name, "tournament_group": tg, "trigger_range": trig_label, "min_bet_odds": gate, "mode": mode, "daily_cap": cap, "strategy_score": strategy_score, "overfit_flags": flags, "split_cutoff_date": cutoff}
                                    result = {**base, **m_all}
                                    results.append(result)
                                    train_test.append({**base, "split": "ALL", **m_all})
                                    train_test.append({**base, "split": "TRAIN", **m_train})
                                    train_test.append({**base, "split": "TEST", **m_test})
                                    rules.append({**base, "rule_description": f"{fam} | {book_group} | {tour_name} | {tg} | {trig_label} | odds>={gate} | {mode} | cap={cap}"})
                                    if m_all["bets"] >= args.min_bets:
                                        monthly.extend(monthly_rows(rows, rule_id))
                                if rule_n > args.max_rules:
                                    break
                            if rule_n > args.max_rules:
                                break
                        if rule_n > args.max_rules:
                            break
                    if rule_n > args.max_rules:
                        break
                if rule_n > args.max_rules:
                    break
            if rule_n > args.max_rules:
                break
        if rule_n > args.max_rules:
            break

    fields = ["rule_id", "strategy_score", "overfit_flags", "strategy_family", "book_group", "tour", "tournament_group", "trigger_range", "min_bet_odds", "mode", "daily_cap", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "positive_month_ratio", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak", "family_mix", "book_mix", "split_cutoff_date"]
    valid = [r for r in results if r.get("bets", 0) >= args.min_bets]
    leaderboard = sorted(valid, key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)
    scalable = sorted([r for r in valid if r.get("bets", 0) >= 300], key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999), reverse=True)
    high_volume = sorted(valid, key=lambda r: (r.get("bets") or 0, r.get("flat_roi") or -999), reverse=True)
    high_roi = sorted(valid, key=lambda r: (r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)

    write_csv(out / "strategy_discovery_turbo_all_results.csv", results, fields)
    write_csv(out / "strategy_discovery_turbo_leaderboard.csv", leaderboard[:1000], fields)
    write_csv(out / "strategy_discovery_turbo_scalable.csv", scalable[:1000], fields)
    write_csv(out / "strategy_discovery_turbo_high_volume.csv", high_volume[:1000], fields)
    write_csv(out / "strategy_discovery_turbo_high_roi.csv", high_roi[:1000], fields)
    write_csv(out / "strategy_discovery_turbo_train_test.csv", train_test, ["split"] + fields)
    write_csv(out / "strategy_discovery_turbo_monthly.csv", monthly, ["rule_id", "month", "bets", "wins", "hit_rate", "avg_odds", "flat_roi", "flat_profit_units"])
    write_csv(out / "strategy_discovery_turbo_candidate_rules.csv", rules, ["rule_id", "strategy_family", "book_group", "tour", "tournament_group", "trigger_range", "min_bet_odds", "mode", "daily_cap", "strategy_score", "overfit_flags", "split_cutoff_date", "rule_description"])

    cards = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "split_cutoff_date": cutoff,
        "wide_rows": len(wide_rows),
        "candidate_rows": len(candidates),
        "rules_tested": len(results),
        "best_overall": leaderboard[0] if leaderboard else None,
        "best_scalable_300_plus": scalable[0] if scalable else None,
        "highest_volume_positive_no_flags": next((r for r in high_volume if (r.get("flat_roi") or 0) > 0 and not r.get("overfit_flags")), None),
        "best_bet365": next((r for r in leaderboard if r.get("book_group") == "bet365"), None),
        "best_bet365_1xBet": next((r for r in leaderboard if r.get("book_group") == "bet365_1xBet"), None),
        "best_bet365_10Bet": next((r for r in leaderboard if r.get("book_group") == "bet365_10Bet"), None),
        "best_three_book": next((r for r in leaderboard if r.get("book_group") == "bet365_1xBet_10Bet"), None),
        "top_25": leaderboard[:25],
    }
    (out / "strategy_discovery_turbo_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")

    funnel = {
        "wide_rows": len(wide_rows),
        "settled_wide_rows": sum(1 for r in wide_rows if r.get("is_settled")),
        "candidate_rows": len(candidates),
        "rules_tested": len(results),
        "leaderboard_min_bets": args.min_bets,
        "split_cutoff_date": cutoff,
        "families": sorted({r.get("strategy_family") for r in candidates}),
    }
    (out / "strategy_discovery_turbo_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"

    lines = [
        "# Strategy Discovery Turbo",
        "",
        "Fast strategy discovery across key cluster families, book groups, trigger ranges, price gates, daily caps, and train/test validation.",
        "This is powerful but avoids exact-score exhaustion and giant raw candidate uploads.",
        "",
        "## Funnel",
        f"Wide rows: {funnel['wide_rows']}",
        f"Settled wide rows: {funnel['settled_wide_rows']}",
        f"Candidate rows: {funnel['candidate_rows']}",
        f"Rules tested: {funnel['rules_tested']}",
        f"Train/test cutoff: {cutoff}",
        "",
        f"## Top strategies, min {args.min_bets} bets",
    ]
    for i, r in enumerate(leaderboard[:40], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} score={r['strategy_score']:.1f} {r['strategy_family']} {r['book_group']} {r['tour']} {r['tournament_group']} {r['trigger_range']} odds>={r['min_bet_odds']} {r['mode']} cap={r['daily_cap']}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r['edge_vs_breakeven'])}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}, flags={r['overfit_flags']}")
    lines += ["", "## Highest-volume positive/no-flag candidates"]
    count = 0
    for r in high_volume:
        if (r.get("flat_roi") or 0) <= 0 or r.get("overfit_flags"):
            continue
        count += 1
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{count}. {r['rule_id']} {r['strategy_family']} {r['book_group']} {r['tour']} {r['tournament_group']} bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
        if count >= 25:
            break
    lines.append("\nInterpretation: use this as a fast replacement for the cancelled broad discovery engine. Prefer no overfit flags, positive train/test, high volume, and stable positive months.")
    (out / "strategy_discovery_turbo_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
