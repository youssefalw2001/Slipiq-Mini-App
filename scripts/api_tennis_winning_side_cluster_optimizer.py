#!/usr/bin/env python3
"""SlipIQ Winning-Side First Set Cluster Optimizer.

This optimizer upgrades the old P2-only V3 analysis into a side-agnostic
first-set winning cluster test.

For every match/book row it creates two candidate rows:
- P1 cluster: 6:3 / 6:4 / 7:5
- P2 cluster: 3:6 / 4:6 / 5:7

It does not use best-book selection. It tests fixed-book strategies, tour splits,
tournament groups, grouped-odds bands, middle-score odds bands, and a temporary
favorite proxy based on P1 vs P2 cluster odds. If moneyline fields are added later,
this script can be extended to use true moneyline favorite buckets.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

P1_CLUSTER_SCORES = {"6:3", "6:4", "7:5"}
P2_CLUSTER_SCORES = {"3:6", "4:6", "5:7"}


def fnum(x):
    try:
        if x is None or str(x).strip() == "":
            return None
        value = float(x)
        return value if math.isfinite(value) else None
    except Exception:
        return None


def bval(x):
    return str(x).strip().lower() == "true"


def clean(x):
    return str(x or "").strip()


def tour(row):
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


def normalize(row):
    row = dict(row)
    row["bookmaker"] = clean(row.get("bookmaker"))
    row["match_key"] = clean(row.get("match_key"))
    row["event_date"] = clean(row.get("event_date"))
    row["event_time"] = clean(row.get("event_time") or "00:00")
    row["player1"] = clean(row.get("player1"))
    row["player2"] = clean(row.get("player2"))
    row["match_name"] = clean(row.get("match_name"))
    row["tournament_name"] = clean(row.get("tournament_name"))
    row["event_type_type"] = clean(row.get("event_type_type"))
    row["first_set_score"] = clean(row.get("first_set_score"))
    row["result_status"] = clean(row.get("result_status")).lower()
    row["event_type_key"] = clean(row.get("event_type_key"))

    row["p1_cluster_odds"] = fnum(row.get("p1_grouped_9_12"))
    row["p2_cluster_odds"] = fnum(row.get("p2_grouped_9_12"))
    row["p1_middle_score_odds"] = fnum(row.get("odds_p1_6_4"))
    row["p2_middle_score_odds"] = fnum(row.get("odds_p2_4_6"))
    row["p1_6_3"] = fnum(row.get("odds_p1_6_3"))
    row["p1_6_4"] = fnum(row.get("odds_p1_6_4"))
    row["p1_7_5"] = fnum(row.get("odds_p1_7_5"))
    row["p2_3_6"] = fnum(row.get("odds_p2_3_6"))
    row["p2_4_6"] = fnum(row.get("odds_p2_4_6"))
    row["p2_5_7"] = fnum(row.get("odds_p2_5_7"))

    row["tour"] = tour(row)
    row["tournament_group"] = tournament_group(row)

    dt = f"{row['event_date']}T{row['event_time'] if len(row['event_time']) != 5 else row['event_time'] + ':00'}"
    try:
        row["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        row["ts"] = 0
    return row


def dedupe(rows):
    seen, out = set(), []
    for r in rows:
        key = (r.get("match_key"), r.get("bookmaker"), r.get("event_type_key"))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def favorite_proxy(p1_odds: Optional[float], p2_odds: Optional[float]) -> Tuple[str, str, Optional[float]]:
    """Return favorite_side, bucket, ratio using lower cluster odds as temporary favorite proxy."""
    if not p1_odds or not p2_odds or p1_odds <= 1 or p2_odds <= 1:
        return "unknown", "unknown", None
    if abs(p1_odds - p2_odds) < 0.05:
        return "even", "near_even", 1.0
    if p1_odds < p2_odds:
        side = "P1"
        ratio = p2_odds / p1_odds
    else:
        side = "P2"
        ratio = p1_odds / p2_odds
    if ratio < 1.12:
        bucket = "near_even"
    elif ratio < 1.35:
        bucket = "slight_favorite"
    elif ratio < 1.75:
        bucket = "favorite"
    else:
        bucket = "strong_favorite"
    return side, bucket, ratio


def side_bucket(side: str, fav_side: str, fav_bucket: str) -> str:
    if fav_side in {"unknown", "even"}:
        return fav_bucket
    if side == fav_side:
        return fav_bucket
    if fav_bucket == "slight_favorite":
        return "slight_underdog"
    if fav_bucket == "favorite":
        return "underdog"
    if fav_bucket == "strong_favorite":
        return "strong_underdog"
    return "near_even"


def side_rows_from_base(row):
    fav_side, fav_bucket, fav_ratio = favorite_proxy(row.get("p1_cluster_odds"), row.get("p2_cluster_odds"))
    first_score = row.get("first_set_score")
    base = {
        "source_match_key": row.get("match_key"),
        "event_type_key": row.get("event_type_key"),
        "event_date": row.get("event_date"),
        "event_time": row.get("event_time"),
        "player1": row.get("player1"),
        "player2": row.get("player2"),
        "match_name": row.get("match_name"),
        "bookmaker": row.get("bookmaker"),
        "tour": row.get("tour"),
        "surface": "",
        "tournament_group": row.get("tournament_group"),
        "tournament_name": row.get("tournament_name"),
        "first_set_score": first_score,
        "favorite_side": fav_side,
        "favorite_bucket": fav_bucket,
        "favorite_proxy_ratio": fav_ratio,
        "moneyline_p1": "",
        "moneyline_p2": "",
        "ts": row.get("ts", 0),
    }
    out = []
    if row.get("p1_cluster_odds") and row.get("p1_middle_score_odds"):
        out.append({
            **base,
            "side_selected": "P1",
            "cluster_scores": "6:3/6:4/7:5",
            "cluster_odds": row.get("p1_cluster_odds"),
            "middle_score_odds": row.get("p1_middle_score_odds"),
            "middle_score": "6:4",
            "cluster_win": first_score in P1_CLUSTER_SCORES,
            "side_favorite_bucket": side_bucket("P1", fav_side, fav_bucket),
            "score_a_odds": row.get("p1_6_3"),
            "score_b_odds": row.get("p1_6_4"),
            "score_c_odds": row.get("p1_7_5"),
        })
    if row.get("p2_cluster_odds") and row.get("p2_middle_score_odds"):
        out.append({
            **base,
            "side_selected": "P2",
            "cluster_scores": "3:6/4:6/5:7",
            "cluster_odds": row.get("p2_cluster_odds"),
            "middle_score_odds": row.get("p2_middle_score_odds"),
            "middle_score": "4:6",
            "cluster_win": first_score in P2_CLUSTER_SCORES,
            "side_favorite_bucket": side_bucket("P2", fav_side, fav_bucket),
            "score_a_odds": row.get("p2_3_6"),
            "score_b_odds": row.get("p2_4_6"),
            "score_c_odds": row.get("p2_5_7"),
        })
    return out


def simulate(rows, start_bankroll=5000.0, risk_pct=0.02):
    bankroll = start_bankroll
    peak = start_bankroll
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("source_match_key", ""), x.get("side_selected", ""))):
        odds = r.get("cluster_odds")
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk_pct
        if r.get("cluster_win"):
            bankroll += stake * (odds - 1)
            losing = 0
        else:
            bankroll -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bankroll)
        if peak > 0:
            max_dd = max(max_dd, (peak - bankroll) / peak)
    return bankroll, bankroll - start_bankroll, ((bankroll / start_bankroll) - 1) * 100, max_dd * 100, worst_losing


def metrics(rows, label, start_bankroll, risk_pct, **group):
    rows = [r for r in rows if r.get("cluster_odds") and r.get("cluster_odds") > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("cluster_win"))
    losses = bets - wins
    avg_odds = sum(r["cluster_odds"] for r in rows) / bets if bets else None
    profit_units = sum((r["cluster_odds"] - 1) if r.get("cluster_win") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    final, profit, ret, dd, streak = simulate(rows, start_bankroll, risk_pct)
    return {
        "label": label,
        **group,
        "bets": bets,
        "wins": wins,
        "losses": losses,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg_odds,
        "flat_profit_units": profit_units,
        "flat_roi": profit_units / bets if bets else None,
        "months": len(months),
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": final,
        "compound_profit": profit,
        "compound_return_pct": ret,
        "max_drawdown_pct": dd,
        "worst_losing_streak": streak,
    }


def random_side_rows(rows, rng):
    by_match_book = defaultdict(list)
    for r in rows:
        key = (r.get("source_match_key"), r.get("bookmaker"))
        by_match_book[key].append(r)
    out = []
    for arr in by_match_book.values():
        if arr:
            out.append(rng.choice(arr))
    return out


def pct(v):
    return "n/a" if v is None else f"{v*100:.2f}%"


def money(v):
    return "n/a" if v is None else f"${v:,.0f}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--out", default="artifacts/output/api-tennis-winning-side-cluster-optimizer")
    parser.add_argument("--start-bankroll", type=float, default=5000.0)
    parser.add_argument("--risk-pct", type=float, default=0.02)
    parser.add_argument("--random-trials", type=int, default=250)
    parser.add_argument("--seed", type=int, default=20260517)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with open(args.csv, newline="", encoding="utf-8") as f:
        base_rows = [normalize(r) for r in csv.DictReader(f)]
    base_rows = dedupe(base_rows)

    side_rows = []
    for row in base_rows:
        if row.get("result_status") not in {"won", "lost"}:
            continue
        side_rows.extend(side_rows_from_base(row))

    books = sorted({r["bookmaker"] for r in side_rows if r.get("bookmaker")})
    tours = sorted({r["tour"] for r in side_rows if r.get("tour")})
    groups = sorted({r["tournament_group"] for r in side_rows if r.get("tournament_group")})
    fav_buckets = sorted({r["side_favorite_bucket"] for r in side_rows if r.get("side_favorite_bucket")})

    filters: List[Tuple[str, Callable[[Dict], bool]]] = [
        ("ALL_SIDE_CLUSTER", lambda r: True),
        ("CLUSTER_280_330", lambda r: 2.8 <= r["cluster_odds"] < 3.3),
        ("CLUSTER_300_350", lambda r: 3.0 <= r["cluster_odds"] < 3.5),
        ("CLUSTER_300_375", lambda r: 3.0 <= r["cluster_odds"] < 3.75),
        ("CLUSTER_330_400", lambda r: 3.3 <= r["cluster_odds"] < 4.0),
        ("CLUSTER_350_450", lambda r: 3.5 <= r["cluster_odds"] < 4.5),
        ("MIDDLE_650_850", lambda r: 6.5 <= r["middle_score_odds"] <= 8.5),
        ("MIDDLE_700_900", lambda r: 7.0 <= r["middle_score_odds"] <= 9.0),
        ("MIDDLE_700_950", lambda r: 7.0 <= r["middle_score_odds"] <= 9.5),
        ("CLUSTER_300_350_MIDDLE_700_900", lambda r: 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_CLUSTER_300_375_MIDDLE_700_950", lambda r: r["tour"] == "ATP" and 3.0 <= r["cluster_odds"] < 3.75 and 7.0 <= r["middle_score_odds"] <= 9.5),
        ("ATP_FAV_OR_SLIGHT_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["side_favorite_bucket"] in {"slight_favorite", "favorite", "strong_favorite", "near_even"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_SLIGHT_OR_EVEN_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["side_favorite_bucket"] in {"near_even", "slight_favorite"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("WTA_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "WTA" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
    ]

    result_fields = [
        "label", "bookmaker", "tour", "tournament_group", "side_selected", "side_favorite_bucket",
        "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi",
        "months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct",
        "max_drawdown_pct", "worst_losing_streak",
    ]

    results = []
    for book in books:
        br = [r for r in side_rows if r["bookmaker"] == book]
        for name, fn in filters:
            results.append(metrics([r for r in br if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book))
        for t in ["ATP", "WTA"]:
            tr = [r for r in br if r["tour"] == t]
            for name, fn in filters:
                results.append(metrics([r for r in tr if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book, tour=t))
        for side in ["P1", "P2"]:
            sr = [r for r in br if r["side_selected"] == side]
            for name, fn in filters:
                results.append(metrics([r for r in sr if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book, side_selected=side))

    group_results = []
    for group in groups:
        gr = [r for r in side_rows if r["tournament_group"] == group]
        for name, fn in filters:
            group_results.append(metrics([r for r in gr if fn(r)], name, args.start_bankroll, args.risk_pct, tournament_group=group))
        for book in books:
            gbr = [r for r in gr if r["bookmaker"] == book]
            for name, fn in filters:
                group_results.append(metrics([r for r in gbr if fn(r)], name, args.start_bankroll, args.risk_pct, tournament_group=group, bookmaker=book))

    fav_results = []
    for bucket in fav_buckets:
        fr = [r for r in side_rows if r["side_favorite_bucket"] == bucket]
        for name, fn in filters:
            fav_results.append(metrics([r for r in fr if fn(r)], name, args.start_bankroll, args.risk_pct, side_favorite_bucket=bucket))
        for book in books:
            fbr = [r for r in fr if r["bookmaker"] == book]
            for name, fn in filters:
                fav_results.append(metrics([r for r in fbr if fn(r)], name, args.start_bankroll, args.risk_pct, side_favorite_bucket=bucket, bookmaker=book))

    random_trials = defaultdict(list)
    for i in range(args.random_trials):
        rng = random.Random(args.seed + i)
        sample = random_side_rows(side_rows, rng)
        for name, fn in filters:
            random_trials[name].append(metrics([r for r in sample if fn(r)], name, args.start_bankroll, args.risk_pct))
    random_results = []
    for name, arr in random_trials.items():
        def avg(key):
            vals = [a[key] for a in arr if a[key] is not None]
            return sum(vals) / len(vals) if vals else None
        random_results.append({
            "label": name,
            "trials": len(arr),
            "avg_bets": avg("bets"),
            "avg_hit_rate": avg("hit_rate"),
            "avg_odds": avg("avg_odds"),
            "avg_flat_roi": avg("flat_roi"),
            "avg_final_bankroll": avg("final_bankroll"),
            "avg_max_drawdown_pct": avg("max_drawdown_pct"),
            "avg_worst_losing_streak": avg("worst_losing_streak"),
            "min_final_bankroll": min(a["final_bankroll"] for a in arr),
            "max_final_bankroll": max(a["final_bankroll"] for a in arr),
        })

    side_fields = [
        "source_match_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "surface",
        "tournament_group", "tournament_name", "first_set_score", "side_selected", "cluster_scores", "cluster_odds",
        "middle_score", "middle_score_odds", "cluster_win", "score_a_odds", "score_b_odds", "score_c_odds",
        "favorite_side", "favorite_bucket", "side_favorite_bucket", "favorite_proxy_ratio", "moneyline_p1", "moneyline_p2",
    ]

    with open(out / "side_cluster_rows.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=side_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(side_rows)

    with open(out / "fixed_book_side_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    with open(out / "tournament_group_side_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(group_results)

    with open(out / "favorite_bucket_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(fav_results)

    if random_results:
        with open(out / "random_side_results.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(random_results[0].keys()), extrasaction="ignore")
            w.writeheader()
            w.writerows(random_results)

    leaderboard = sorted(
        [m for m in results + group_results + fav_results if m["bets"] >= 50 and m["flat_roi"] is not None],
        key=lambda m: (m["flat_roi"], m["bets"]),
        reverse=True,
    )[:300]
    with open(out / "winning_side_filter_leaderboard.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(leaderboard)

    top_fixed = sorted([m for m in results if m["bets"] >= 50], key=lambda m: m["flat_roi"] or -999, reverse=True)[:30]
    top_group = sorted([m for m in group_results if m["bets"] >= 50], key=lambda m: m["flat_roi"] or -999, reverse=True)[:30]
    top_fav = sorted([m for m in fav_results if m["bets"] >= 50], key=lambda m: m["flat_roi"] or -999, reverse=True)[:30]
    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "input_csv": args.csv,
        "base_rows": len(base_rows),
        "side_cluster_rows": len(side_rows),
        "unique_matches": len({r["source_match_key"] for r in side_rows}),
        "bookmakers": books,
        "tours": tours,
        "tournament_groups": groups,
        "favorite_buckets": fav_buckets,
        "start_bankroll": args.start_bankroll,
        "risk_pct": args.risk_pct,
        "random_trials": args.random_trials,
        "top_fixed_results": top_fixed,
        "top_tournament_results": top_group,
        "top_favorite_bucket_results": top_fav,
        "random_results": random_results,
    }
    (out / "optimizer_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# Winning-Side First Set Cluster Optimizer",
        "",
        f"Base rows: {len(base_rows)}",
        f"Side cluster rows: {len(side_rows)}",
        f"Unique matches: {summary['unique_matches']}",
        f"Books tested: {', '.join(books)}",
        f"Start bankroll: ${args.start_bankroll:,.0f}",
        f"Risk per bet: {args.risk_pct*100:.2f}%",
        "",
        "## Top fixed-book side-cluster filters, min 50 bets",
    ]
    for i, m in enumerate(top_fixed, 1):
        avg_odds = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('bookmaker','')} {m.get('tour','')} {m.get('side_selected','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg_odds}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top tournament-group side-cluster filters, min 50 bets"]
    for i, m in enumerate(top_group, 1):
        avg_odds = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('tournament_group','')} {m.get('bookmaker','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg_odds}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top favorite-bucket filters, min 50 bets"]
    for i, m in enumerate(top_fav, 1):
        avg_odds = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('side_favorite_bucket','')} {m.get('bookmaker','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg_odds}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Random side stress test"]
    for m in random_results:
        lines.append(f"- {m['label']}: avg_bets={m['avg_bets']:.1f}, avg_hit={pct(m['avg_hit_rate'])}, avg_ROI={pct(m['avg_flat_roi'])}, avg_final={money(m['avg_final_bankroll'])}, min_final={money(m['min_final_bankroll'])}, max_final={money(m['max_final_bankroll'])}")
    lines.append("\nNote: favorite_side/favorite_bucket are temporary proxies based on P1 vs P2 cluster odds, not real moneyline odds.")
    (out / "optimizer_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
