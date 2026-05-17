#!/usr/bin/env python3
"""SlipIQ moneyline-aware first-set correct-score optimizer.

Runs inside GitHub Actions against the combined warehouse artifact.

Inputs:
- first_set_correct_score_wide_combined.csv
- moneyline_favorite_combined.csv

Purpose:
- Join first-set correct-score odds with real moneyline/favorite markets.
- Build side-level P1/P2 cluster candidates.
- Test true first-set favorite buckets using Home/Away (1st Set) first.
- Also test full-match Home/Away favorite buckets.
- No best-book selection.
- Fixed-book, tour, tournament, favorite bucket, and odds-band simulations.
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

P1_CLUSTER = {"6:3", "6:4", "7:5"}
P2_CLUSTER = {"3:6", "4:6", "5:7"}


def fnum(x):
    try:
        if x is None or str(x).strip() == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def clean(x):
    return str(x or "").strip()


def bval(x):
    return str(x).strip().lower() == "true"


def grouped(values):
    nums = [fnum(v) for v in values]
    if any(v is None or v <= 1 for v in nums):
        return None
    imp = sum(1 / v for v in nums)
    return 1 / imp if imp else None


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


def normalize_wide(row):
    row = dict(row)
    row["event_key"] = clean(row.get("event_key"))
    row["bookmaker"] = clean(row.get("bookmaker"))
    row["event_date"] = clean(row.get("event_date"))
    row["event_time"] = clean(row.get("event_time") or "00:00")
    row["player1"] = clean(row.get("player1"))
    row["player2"] = clean(row.get("player2"))
    row["match_name"] = clean(row.get("match_name"))
    row["tournament_name"] = clean(row.get("tournament_name"))
    row["event_type_type"] = clean(row.get("event_type_type"))
    row["first_set_score"] = clean(row.get("first_set_score"))
    row["tour"] = tour(row)
    row["tournament_group"] = tournament_group(row)
    for col in ["odds_6_3", "odds_6_4", "odds_7_5", "odds_3_6", "odds_4_6", "odds_5_7"]:
        row[col] = fnum(row.get(col))
    row["p1_cluster_odds"] = fnum(row.get("p1_cluster_odds")) or grouped([row.get("odds_6_3"), row.get("odds_6_4"), row.get("odds_7_5")])
    row["p2_cluster_odds"] = fnum(row.get("p2_cluster_odds")) or grouped([row.get("odds_3_6"), row.get("odds_4_6"), row.get("odds_5_7")])
    try:
        dt = f"{row['event_date']}T{row['event_time'] if len(row['event_time']) != 5 else row['event_time'] + ':00'}"
        row["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        row["ts"] = 0
    return row


def normalize_ml(row):
    row = dict(row)
    row["event_key"] = clean(row.get("event_key"))
    row["bookmaker"] = clean(row.get("bookmaker"))
    row["market_name"] = clean(row.get("market_name"))
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
    row["favorite_side"] = fav_side
    row["favorite_odds"] = fav_odds
    row["favorite_bucket"] = clean(row.get("favorite_bucket")) or bucket_from_fav_odds(fav_odds)
    row["market_type"] = "first_set" if "1st Set" in row["market_name"] or "First Set" in row["market_name"] else "match"
    return row


def build_moneyline_maps(rows):
    first_set = {}
    match = {}
    markets = defaultdict(int)
    for r in rows:
        r = normalize_ml(r)
        if not r["event_key"] or not r["bookmaker"]:
            continue
        markets[r["market_name"]] += 1
        key = (r["event_key"], r["bookmaker"])
        if r["market_type"] == "first_set":
            existing = first_set.get(key)
            if existing is None or r["market_name"].lower() == "home/away (1st set)":
                first_set[key] = r
        else:
            existing = match.get(key)
            if existing is None or r["market_name"].lower() == "home/away":
                match[key] = r
    return first_set, match, markets


def side_rows_from_wide(row, first_set_ml, match_ml):
    key = (row["event_key"], row["bookmaker"])
    fs = first_set_ml.get(key, {})
    mt = match_ml.get(key, {})
    first_score = row.get("first_set_score")
    base = {
        "event_key": row["event_key"],
        "event_date": row["event_date"],
        "event_time": row["event_time"],
        "player1": row["player1"],
        "player2": row["player2"],
        "match_name": row["match_name"],
        "bookmaker": row["bookmaker"],
        "tour": row["tour"],
        "tournament_group": row["tournament_group"],
        "tournament_name": row["tournament_name"],
        "first_set_score": first_score,
        "first_set_favorite_side": fs.get("favorite_side", "unknown"),
        "first_set_favorite_odds": fs.get("favorite_odds"),
        "first_set_favorite_bucket": fs.get("favorite_bucket", "unknown"),
        "moneyline_p1_1st_set": fs.get("moneyline_p1"),
        "moneyline_p2_1st_set": fs.get("moneyline_p2"),
        "match_favorite_side": mt.get("favorite_side", "unknown"),
        "match_favorite_odds": mt.get("favorite_odds"),
        "match_favorite_bucket": mt.get("favorite_bucket", "unknown"),
        "moneyline_p1_match": mt.get("moneyline_p1"),
        "moneyline_p2_match": mt.get("moneyline_p2"),
        "ts": row.get("ts", 0),
    }
    out = []
    if row.get("p1_cluster_odds") and row.get("odds_6_4"):
        out.append({
            **base,
            "side_selected": "P1",
            "cluster_scores": "6:3/6:4/7:5",
            "cluster_odds": row.get("p1_cluster_odds"),
            "middle_score": "6:4",
            "middle_score_odds": row.get("odds_6_4"),
            "score_a_odds": row.get("odds_6_3"),
            "score_b_odds": row.get("odds_6_4"),
            "score_c_odds": row.get("odds_7_5"),
            "cluster_win": first_score in P1_CLUSTER,
            "first_set_side_bucket": side_bucket("P1", base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
            "match_side_bucket": side_bucket("P1", base["match_favorite_side"], base["match_favorite_bucket"]),
        })
    if row.get("p2_cluster_odds") and row.get("odds_4_6"):
        out.append({
            **base,
            "side_selected": "P2",
            "cluster_scores": "3:6/4:6/5:7",
            "cluster_odds": row.get("p2_cluster_odds"),
            "middle_score": "4:6",
            "middle_score_odds": row.get("odds_4_6"),
            "score_a_odds": row.get("odds_3_6"),
            "score_b_odds": row.get("odds_4_6"),
            "score_c_odds": row.get("odds_5_7"),
            "cluster_win": first_score in P2_CLUSTER,
            "first_set_side_bucket": side_bucket("P2", base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
            "match_side_bucket": side_bucket("P2", base["match_favorite_side"], base["match_favorite_bucket"]),
        })
    return out


def simulate(rows, start=5000.0, risk=0.02):
    bankroll = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""), x.get("side_selected", ""))):
        odds = r.get("cluster_odds")
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk
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
    return bankroll, bankroll - start, ((bankroll / start) - 1) * 100, max_dd * 100, worst_losing


def metrics(rows, label, start, risk, **group):
    rows = [r for r in rows if r.get("cluster_odds") and r["cluster_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("cluster_win"))
    avg_odds = sum(r["cluster_odds"] for r in rows) / bets if bets else None
    units = sum((r["cluster_odds"] - 1) if r.get("cluster_win") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    final, profit, ret, dd, streak = simulate(rows, start, risk)
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
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": final,
        "compound_profit": profit,
        "compound_return_pct": ret,
        "max_drawdown_pct": dd,
        "worst_losing_streak": streak,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-moneyline-aware-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    wide_rows = [normalize_wide(r) for r in read_csv(Path(args.first_set_wide))]
    ml_raw = read_csv(Path(args.moneyline))
    first_set_ml, match_ml, ml_markets = build_moneyline_maps(ml_raw)

    side_rows = []
    for r in wide_rows:
        side_rows.extend(side_rows_from_wide(r, first_set_ml, match_ml))

    books = sorted({r["bookmaker"] for r in side_rows if r.get("bookmaker")})
    buckets = sorted({r["first_set_side_bucket"] for r in side_rows})
    match_buckets = sorted({r["match_side_bucket"] for r in side_rows})
    groups = sorted({r["tournament_group"] for r in side_rows})

    filters: List[Tuple[str, Callable[[Dict], bool]]] = [
        ("ALL_SIDE_CLUSTER", lambda r: True),
        ("CLUSTER_280_330", lambda r: 2.8 <= r["cluster_odds"] < 3.3),
        ("CLUSTER_300_350", lambda r: 3.0 <= r["cluster_odds"] < 3.5),
        ("CLUSTER_300_375", lambda r: 3.0 <= r["cluster_odds"] < 3.75),
        ("CLUSTER_330_400", lambda r: 3.3 <= r["cluster_odds"] < 4.0),
        ("MIDDLE_650_850", lambda r: 6.5 <= r["middle_score_odds"] <= 8.5),
        ("MIDDLE_700_900", lambda r: 7.0 <= r["middle_score_odds"] <= 9.0),
        ("CLUSTER_300_350_MIDDLE_700_900", lambda r: 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_1SET_FAV_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["first_set_side_bucket"] in {"near_even", "slight_favorite", "favorite", "strong_favorite"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_1SET_SLIGHT_OR_EVEN_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["first_set_side_bucket"] in {"near_even", "slight_favorite"} and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("ATP_1SET_SLIGHT_UNDERDOG_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["first_set_side_bucket"] == "slight_underdog" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        ("WTA_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "WTA" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
    ]

    result_fields = ["label", "bookmaker", "tour", "tournament_group", "side_selected", "first_set_side_bucket", "match_side_bucket", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]

    fixed = []
    for book in books:
        br = [r for r in side_rows if r["bookmaker"] == book]
        for name, fn in filters:
            fixed.append(metrics([r for r in br if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book))
        for side in ["P1", "P2"]:
            sr = [r for r in br if r["side_selected"] == side]
            for name, fn in filters:
                fixed.append(metrics([r for r in sr if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book, side_selected=side))
        for bucket in buckets:
            fr = [r for r in br if r["first_set_side_bucket"] == bucket]
            for name, fn in filters:
                fixed.append(metrics([r for r in fr if fn(r)], name, args.start_bankroll, args.risk_pct, bookmaker=book, first_set_side_bucket=bucket))

    group_results = []
    for group in groups:
        gr = [r for r in side_rows if r["tournament_group"] == group]
        for name, fn in filters:
            group_results.append(metrics([r for r in gr if fn(r)], name, args.start_bankroll, args.risk_pct, tournament_group=group))
        for book in books:
            gbr = [r for r in gr if r["bookmaker"] == book]
            for name, fn in filters:
                group_results.append(metrics([r for r in gbr if fn(r)], name, args.start_bankroll, args.risk_pct, tournament_group=group, bookmaker=book))

    favorite_results = []
    for bucket in buckets:
        fr = [r for r in side_rows if r["first_set_side_bucket"] == bucket]
        for name, fn in filters:
            favorite_results.append(metrics([r for r in fr if fn(r)], name, args.start_bankroll, args.risk_pct, first_set_side_bucket=bucket))
        for book in books:
            fbr = [r for r in fr if r["bookmaker"] == book]
            for name, fn in filters:
                favorite_results.append(metrics([r for r in fbr if fn(r)], name, args.start_bankroll, args.risk_pct, first_set_side_bucket=bucket, bookmaker=book))

    side_fields = ["event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "tournament_group", "tournament_name", "first_set_score", "side_selected", "cluster_scores", "cluster_odds", "middle_score", "middle_score_odds", "cluster_win", "score_a_odds", "score_b_odds", "score_c_odds", "first_set_favorite_side", "first_set_favorite_odds", "first_set_favorite_bucket", "first_set_side_bucket", "moneyline_p1_1st_set", "moneyline_p2_1st_set", "match_favorite_side", "match_favorite_odds", "match_favorite_bucket", "match_side_bucket", "moneyline_p1_match", "moneyline_p2_match"]
    with (out / "moneyline_side_cluster_rows.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=side_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(side_rows)

    for name, rows in [("fixed_book_moneyline_results.csv", fixed), ("tournament_moneyline_results.csv", group_results), ("favorite_bucket_moneyline_results.csv", favorite_results)]:
        with (out / name).open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)

    leaderboard = sorted([m for m in fixed + group_results + favorite_results if m["bets"] >= 50 and m["flat_roi"] is not None], key=lambda x: (x["flat_roi"], x["bets"]), reverse=True)[:300]
    with (out / "moneyline_filter_leaderboard.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=result_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(leaderboard)

    top_fixed = sorted([m for m in fixed if m["bets"] >= 50], key=lambda x: x["flat_roi"] or -999, reverse=True)[:30]
    top_fav = sorted([m for m in favorite_results if m["bets"] >= 50], key=lambda x: x["flat_roi"] or -999, reverse=True)[:30]
    top_group = sorted([m for m in group_results if m["bets"] >= 50], key=lambda x: x["flat_roi"] or -999, reverse=True)[:30]

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "wide_rows": len(wide_rows),
        "moneyline_rows": len(ml_raw),
        "first_set_moneyline_pairs": len(first_set_ml),
        "match_moneyline_pairs": len(match_ml),
        "side_cluster_rows": len(side_rows),
        "bookmakers": books,
        "first_set_side_buckets": buckets,
        "match_side_buckets": match_buckets,
        "moneyline_markets": dict(sorted(ml_markets.items(), key=lambda kv: kv[1], reverse=True)),
        "top_fixed_results": top_fixed,
        "top_favorite_results": top_fav,
        "top_tournament_results": top_group,
    }
    (out / "optimizer_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# API Tennis Moneyline-Aware First Set Optimizer",
        "",
        f"First-set wide rows: {len(wide_rows)}",
        f"Moneyline rows: {len(ml_raw)}",
        f"First-set moneyline pairs: {len(first_set_ml)}",
        f"Match moneyline pairs: {len(match_ml)}",
        f"Side cluster rows: {len(side_rows)}",
        f"Books: {', '.join(books)}",
        "",
        "## Moneyline markets",
    ]
    for market, count in summary["moneyline_markets"].items():
        lines.append(f"- {market}: {count}")
    lines += ["", "## Top fixed-book results, min 50 bets"]
    for i, m in enumerate(top_fixed, 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('bookmaker','')} {m.get('side_selected','')} {m.get('first_set_side_bucket','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top first-set favorite bucket results, min 50 bets"]
    for i, m in enumerate(top_fav, 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('first_set_side_bucket','')} {m.get('bookmaker','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top tournament results, min 50 bets"]
    for i, m in enumerate(top_group, 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. {m.get('tournament_group','')} {m.get('bookmaker','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    (out / "optimizer_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
