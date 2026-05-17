#!/usr/bin/env python3
"""SlipIQ fixed-book/random-book optimizer.

Reads the combined API Tennis 15-month historical CSV and tests strategy filters
without best-book selection. Outputs fixed-book, random-book, tournament-group,
and leaderboard reports with 2% compound bankroll simulation.
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
from typing import Callable, Dict, Iterable, List, Optional

P2_SCORES = {"3:6", "4:6", "5:7"}


def fnum(x):
    try:
        if x is None or str(x).strip() == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def bval(x):
    return str(x).strip().lower() == "true"


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
    row["bookmaker"] = row.get("bookmaker", "").strip()
    row["match_key"] = row.get("match_key", "").strip()
    row["event_date"] = row.get("event_date", "").strip()
    row["event_time"] = (row.get("event_time", "") or "00:00").strip()
    row["tournament_name"] = row.get("tournament_name", "").strip()
    row["event_type_type"] = row.get("event_type_type", "").strip()
    row["result_status"] = row.get("result_status", "").strip().lower()
    row["odds_p2_3_6"] = fnum(row.get("odds_p2_3_6"))
    row["odds_p2_4_6"] = fnum(row.get("odds_p2_4_6"))
    row["odds_p2_5_7"] = fnum(row.get("odds_p2_5_7"))
    row["p2_grouped_9_12"] = fnum(row.get("p2_grouped_9_12"))
    row["v3_exact_4_6_trigger"] = bval(row.get("v3_exact_4_6_trigger"))
    row["tour"] = tour(row)
    row["tournament_group"] = tournament_group(row)
    dt = f"{row['event_date']}T{row['event_time'] if len(row['event_time']) != 5 else row['event_time'] + ':00'}"
    try:
        row["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        row["ts"] = 0
    return row


def is_settled(r):
    return r.get("result_status") in {"won", "lost"}


def is_win(r):
    return r.get("result_status") == "won"


def dedupe(rows):
    seen, out = set(), []
    for r in rows:
        key = (r.get("match_key"), r.get("bookmaker"), r.get("event_type_key"))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def simulate(rows, start_bankroll=5000.0, risk_pct=0.02):
    bankroll = start_bankroll
    peak = start_bankroll
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("match_key", ""))):
        odds = r.get("p2_grouped_9_12")
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk_pct
        if is_win(r):
            bankroll += stake * (odds - 1)
            losing = 0
        else:
            bankroll -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bankroll)
        if peak > 0:
            max_dd = max(max_dd, (peak - bankroll) / peak)
    return bankroll, (bankroll - start_bankroll), ((bankroll / start_bankroll) - 1) * 100, max_dd * 100, worst_losing


def metrics(rows, label, start_bankroll, risk_pct, **group):
    settled = [r for r in rows if is_settled(r) and r.get("p2_grouped_9_12") and r.get("p2_grouped_9_12") > 1]
    bets = len(settled)
    wins = sum(1 for r in settled if is_win(r))
    losses = bets - wins
    avg_odds = sum(r["p2_grouped_9_12"] for r in settled) / bets if bets else None
    profit_units = sum((r["p2_grouped_9_12"] - 1) if is_win(r) else -1 for r in settled)
    months = {r.get("event_date", "")[:7] for r in settled if r.get("event_date")}
    final, profit, ret, dd, streak = simulate(settled, start_bankroll, risk_pct)
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


def random_book_rows(rows, rng):
    by_match = defaultdict(list)
    for r in rows:
        if is_settled(r) and r.get("match_key") and r.get("bookmaker"):
            by_match[r["match_key"]].append(r)
    return [rng.choice(v) for v in by_match.values() if v]


def pct(v):
    return "n/a" if v is None else f"{v*100:.2f}%"


def money(v):
    return "n/a" if v is None else f"${v:,.0f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-fixed-book-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--random-trials", type=int, default=250)
    ap.add_argument("--seed", type=int, default=20260517)
    ns = ap.parse_args()

    out = Path(ns.out)
    out.mkdir(parents=True, exist_ok=True)

    with open(ns.csv, newline="", encoding="utf-8") as f:
        raw = [normalize(r) for r in csv.DictReader(f)]
    rows = [r for r in dedupe(raw) if is_settled(r) and r.get("p2_grouped_9_12") and r.get("odds_p2_4_6")]
    books = sorted({r["bookmaker"] for r in rows if r.get("bookmaker")})
    groups = sorted({r["tournament_group"] for r in rows})

    filters: List[tuple[str, Callable[[Dict], bool]]] = [
        ("ALL_SETTLED", lambda r: True),
        ("STRICT_V3", lambda r: r["v3_exact_4_6_trigger"]),
        ("STRICT_V3_GROUPED_300_PLUS", lambda r: r["v3_exact_4_6_trigger"] and r["p2_grouped_9_12"] >= 3.0),
        ("STRICT_V3_GROUPED_330_PLUS", lambda r: r["v3_exact_4_6_trigger"] and r["p2_grouped_9_12"] >= 3.3),
        ("STRICT_V3_GROUPED_350_PLUS", lambda r: r["v3_exact_4_6_trigger"] and r["p2_grouped_9_12"] >= 3.5),
        ("GROUPED_300_350", lambda r: 3.0 <= r["p2_grouped_9_12"] < 3.5),
        ("GROUPED_330_400", lambda r: 3.3 <= r["p2_grouped_9_12"] < 4.0),
        ("GROUPED_350_450", lambda r: 3.5 <= r["p2_grouped_9_12"] < 4.5),
        ("GROUPED_400_PLUS", lambda r: r["p2_grouped_9_12"] >= 4.0),
        ("ATP_GROUPED_300_350_46_700_900", lambda r: r["tour"] == "ATP" and 3.0 <= r["p2_grouped_9_12"] < 3.5 and 7.0 <= r["odds_p2_4_6"] <= 9.0),
        ("ATP_GROUPED_300_375_46_700_950", lambda r: r["tour"] == "ATP" and 3.0 <= r["p2_grouped_9_12"] < 3.75 and 7.0 <= r["odds_p2_4_6"] <= 9.5),
        ("WTA_GROUPED_300_350_46_700_900", lambda r: r["tour"] == "WTA" and 3.0 <= r["p2_grouped_9_12"] < 3.5 and 7.0 <= r["odds_p2_4_6"] <= 9.0),
    ]

    fixed = []
    for book in books:
        br = [r for r in rows if r["bookmaker"] == book]
        for name, fn in filters:
            fixed.append(metrics([r for r in br if fn(r)], name, ns.start_bankroll, ns.risk_pct, bookmaker=book))
        for t in ["ATP", "WTA"]:
            bt = [r for r in br if r["tour"] == t]
            for name, fn in filters:
                fixed.append(metrics([r for r in bt if fn(r)], name, ns.start_bankroll, ns.risk_pct, bookmaker=book, tour=t))

    tourney = []
    for g in groups:
        gr = [r for r in rows if r["tournament_group"] == g]
        for name, fn in filters:
            tourney.append(metrics([r for r in gr if fn(r)], name, ns.start_bankroll, ns.risk_pct, tournament_group=g))
        for book in books:
            gb = [r for r in gr if r["bookmaker"] == book]
            for name, fn in filters[1:]:
                tourney.append(metrics([r for r in gb if fn(r)], name, ns.start_bankroll, ns.risk_pct, tournament_group=g, bookmaker=book))

    random_trials = defaultdict(list)
    for i in range(ns.random_trials):
        rng = random.Random(ns.seed + i)
        sample = random_book_rows(rows, rng)
        for name, fn in filters:
            random_trials[name].append(metrics([r for r in sample if fn(r)], name, ns.start_bankroll, ns.risk_pct))

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

    fields = ["label", "bookmaker", "tour", "tournament_group", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]
    with open(out / "fixed_book_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(fixed)
    with open(out / "tournament_group_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(tourney)
    with open(out / "random_book_results.csv", "w", newline="", encoding="utf-8") as f:
        rf = list(random_results[0].keys()) if random_results else ["label"]
        w = csv.DictWriter(f, fieldnames=rf); w.writeheader(); w.writerows(random_results)

    leaderboard = sorted([m for m in fixed + tourney if m["bets"] >= 25 and m["flat_roi"] is not None], key=lambda x: (x["flat_roi"], x["bets"]), reverse=True)[:250]
    with open(out / "filter_leaderboard.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(leaderboard)

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "input_csv": ns.csv,
        "raw_rows": len(raw),
        "usable_rows": len(rows),
        "unique_matches": len({r["match_key"] for r in rows}),
        "bookmakers": books,
        "tournament_groups": groups,
        "start_bankroll": ns.start_bankroll,
        "risk_pct": ns.risk_pct,
        "random_trials": ns.random_trials,
        "top_fixed_results": sorted([m for m in fixed if m["bets"] >= 25], key=lambda x: x["flat_roi"] or -999, reverse=True)[:25],
        "top_tournament_results": sorted([m for m in tourney if m["bets"] >= 20], key=lambda x: x["flat_roi"] or -999, reverse=True)[:25],
        "random_results": random_results,
    }
    (out / "optimizer_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    lines = [
        "# SlipIQ Fixed-Book / Random-Book Optimizer",
        "",
        f"Input rows: {len(raw)}",
        f"Usable settled bookmaker rows: {len(rows)}",
        f"Unique matches: {summary['unique_matches']}",
        f"Books tested: {', '.join(books)}",
        f"Start bankroll: ${ns.start_bankroll:,.0f}",
        f"Risk per bet: {ns.risk_pct*100:.2f}%",
        "",
        "## Top fixed-book filters, min 25 bets",
    ]
    for i, m in enumerate(summary["top_fixed_results"], 1):
        lines.append(f"{i}. {m.get('bookmaker','')} {m.get('tour','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={m['avg_odds']:.2f}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Top tournament/group filters, min 20 bets"]
    for i, m in enumerate(summary["top_tournament_results"], 1):
        lines.append(f"{i}. {m.get('tournament_group','')} {m.get('bookmaker','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={m['avg_odds']:.2f}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}")
    lines += ["", "## Random-book stress test"]
    for m in random_results:
        lines.append(f"- {m['label']}: avg_bets={m['avg_bets']:.1f}, avg_hit={pct(m['avg_hit_rate'])}, avg_ROI={pct(m['avg_flat_roi'])}, avg_final={money(m['avg_final_bankroll'])}, min_final={money(m['min_final_bankroll'])}, max_final={money(m['max_final_bankroll'])}")
    lines.append("\nInterpretation: fixed-book results are the realistic user baseline. Random-book is a stress test only.")
    (out / "optimizer_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
