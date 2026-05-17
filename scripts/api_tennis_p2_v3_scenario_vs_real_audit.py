#!/usr/bin/env python3
"""SlipIQ P2-only V3 scenario vs real grouped odds audit.

This rebuilds the ORIGINAL strategy framing, not the both-side expansion.

Original P2 V3 idea:
- Trigger: P2 exact 4:6 odds around 6.25-6.99
- Bet: P2 grouped 9-12 first-set cluster
- Wins: 3:6 / 4:6 / 5:7
- Old compounding sim used scenario grouped odds, usually 3.50

This audit compares:
1) Scenario odds version: every settled P2 V3 signal gets assumed odds, default 3.50
2) Real reconstructed version: use actual API Tennis grouped odds from 3:6/4:6/5:7
3) Availability funnel: shows how many V3 signals actually had all P2 score odds and usable grouped prices
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

P2_WIN_SCORES = {"3:6", "4:6", "5:7"}
EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}


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


def grouped(vals) -> Optional[float]:
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums):
        return None
    imp = sum(1.0 / v for v in nums)
    return 1.0 / imp if imp else None


def tour(row: Dict) -> str:
    key = clean(row.get("event_type_key"))
    if key in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[key]
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


def odds_band(v: Optional[float]) -> str:
    if v is None:
        return "missing"
    bins = [(0, 3.0), (3.0, 3.25), (3.25, 3.50), (3.50, 3.75), (3.75, 4.0), (4.0, 4.5), (4.5, 5.0), (5.0, 6.0), (6.0, 999)]
    for a, b in bins:
        if a <= v < b:
            return f"{a:.2f}-{b:.2f}" if b < 999 else "6.00+"
    return "other"


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def normalize(row: Dict) -> Dict:
    r = dict(row)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tournament_name", "event_type_type", "first_set_score"]:
        r[k] = clean(r.get(k))
    r["event_time"] = r["event_time"] or "00:00"
    for k in ["odds_3_6", "odds_4_6", "odds_5_7"]:
        r[k] = fnum(r.get(k))
    r["p2_grouped_real"] = fnum(r.get("p2_cluster_odds")) or fnum(r.get("p2_grouped_9_12")) or grouped([r.get("odds_3_6"), r.get("odds_4_6"), r.get("odds_5_7")])
    r["tour"] = tour(r)
    r["tournament_group"] = tournament_group(r)
    r["is_settled"] = bool(r["first_set_score"])
    r["p2_cluster_win"] = r["first_set_score"] in P2_WIN_SCORES
    r["has_3_6"] = r.get("odds_3_6") is not None
    r["has_4_6"] = r.get("odds_4_6") is not None
    r["has_5_7"] = r.get("odds_5_7") is not None
    r["has_all_p2_scores"] = r["has_3_6"] and r["has_4_6"] and r["has_5_7"]
    r["real_grouped_band"] = odds_band(r["p2_grouped_real"])
    try:
        dt = f"{r['event_date']}T{r['event_time'] if len(r['event_time']) != 5 else r['event_time'] + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


def simulate(rows: List[Dict], odds_key: str, start: float, risk: float):
    bank = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    curve = []
    for i, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))), 1):
        odds = r.get(odds_key)
        if not odds or odds <= 1:
            continue
        stake = bank * risk
        if r["p2_cluster_win"]:
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
        curve.append({
            "bet_index": i,
            "event_date": r.get("event_date", ""),
            "event_key": r.get("event_key", ""),
            "bookmaker": r.get("bookmaker", ""),
            "odds_used": odds,
            "won": str(bool(r["p2_cluster_win"])).lower(),
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


def metrics(rows: List[Dict], label: str, odds_key: str, start: float, risk: float, **group):
    rows = [r for r in rows if r.get(odds_key) and r[odds_key] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r["p2_cluster_win"])
    avg_odds = sum(r[odds_key] for r in rows) / bets if bets else None
    units = sum((r[odds_key] - 1) if r["p2_cluster_win"] else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    sim, _ = simulate(rows, odds_key, start, risk)
    return {
        "label": label,
        **group,
        "odds_mode": odds_key,
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg_odds,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "bets_per_month": bets / len(months) if months else None,
        **sim,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-p2-v3-scenario-vs-real-audit")
    ap.add_argument("--trigger-min", type=float, default=6.25)
    ap.add_argument("--trigger-max", type=float, default=6.99)
    ap.add_argument("--scenario-odds", type=float, default=3.50)
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    all_rows = [normalize(r) for r in read_csv(Path(args.first_set_wide))]
    p2_v3_all = [r for r in all_rows if r.get("odds_4_6") is not None and args.trigger_min <= r["odds_4_6"] <= args.trigger_max]
    p2_v3_settled = [r for r in p2_v3_all if r["is_settled"]]
    p2_v3_real_available = [r for r in p2_v3_settled if r["has_all_p2_scores"] and r.get("p2_grouped_real")]

    for r in p2_v3_settled:
        r["scenario_grouped_odds"] = args.scenario_odds

    # availability funnel
    def count_by(rows, key):
        d = defaultdict(int)
        for r in rows:
            d[clean(r.get(key)) or "missing"] += 1
        return dict(sorted(d.items(), key=lambda kv: (-kv[1], kv[0])))

    funnel = {
        "wide_rows_total": len(all_rows),
        "wide_rows_settled": sum(1 for r in all_rows if r["is_settled"]),
        "p2_v3_triggers_all": len(p2_v3_all),
        "p2_v3_triggers_settled": len(p2_v3_settled),
        "p2_v3_settled_wins": sum(1 for r in p2_v3_settled if r["p2_cluster_win"]),
        "p2_v3_settled_hit_rate": (sum(1 for r in p2_v3_settled if r["p2_cluster_win"]) / len(p2_v3_settled)) if p2_v3_settled else None,
        "has_3_6_odds": sum(1 for r in p2_v3_settled if r["has_3_6"]),
        "has_4_6_odds": sum(1 for r in p2_v3_settled if r["has_4_6"]),
        "has_5_7_odds": sum(1 for r in p2_v3_settled if r["has_5_7"]),
        "has_all_p2_score_odds": sum(1 for r in p2_v3_settled if r["has_all_p2_scores"]),
        "has_real_grouped_odds": len(p2_v3_real_available),
        "real_grouped_ge_350": sum(1 for r in p2_v3_real_available if r["p2_grouped_real"] >= 3.50),
        "real_grouped_300_350": sum(1 for r in p2_v3_real_available if 3.00 <= r["p2_grouped_real"] < 3.50),
        "real_grouped_lt_300": sum(1 for r in p2_v3_real_available if r["p2_grouped_real"] < 3.00),
        "settled_by_bookmaker": count_by(p2_v3_settled, "bookmaker"),
        "settled_by_tour": count_by(p2_v3_settled, "tour"),
        "settled_by_tournament_group": count_by(p2_v3_settled, "tournament_group"),
        "real_grouped_band_counts": count_by(p2_v3_real_available, "real_grouped_band"),
    }

    results = []
    results.append(metrics(p2_v3_settled, "P2_V3_SCENARIO_ALL_SETTLED", "scenario_grouped_odds", args.start_bankroll, args.risk_pct))
    results.append(metrics(p2_v3_real_available, "P2_V3_REAL_GROUPED_ALL_AVAILABLE", "p2_grouped_real", args.start_bankroll, args.risk_pct))
    results.append(metrics([r for r in p2_v3_real_available if r["p2_grouped_real"] >= 3.50], "P2_V3_REAL_GROUPED_GE_350", "p2_grouped_real", args.start_bankroll, args.risk_pct))
    results.append(metrics([r for r in p2_v3_real_available if 3.00 <= r["p2_grouped_real"] < 3.50], "P2_V3_REAL_GROUPED_300_350", "p2_grouped_real", args.start_bankroll, args.risk_pct))

    for book in sorted({r["bookmaker"] for r in p2_v3_settled if r.get("bookmaker")}):
        rows = [r for r in p2_v3_settled if r["bookmaker"] == book]
        real_rows = [r for r in p2_v3_real_available if r["bookmaker"] == book]
        results.append(metrics(rows, "P2_V3_SCENARIO_BY_BOOK", "scenario_grouped_odds", args.start_bankroll, args.risk_pct, bookmaker=book))
        results.append(metrics(real_rows, "P2_V3_REAL_BY_BOOK", "p2_grouped_real", args.start_bankroll, args.risk_pct, bookmaker=book))

    for t in sorted({r["tour"] for r in p2_v3_settled}):
        rows = [r for r in p2_v3_settled if r["tour"] == t]
        real_rows = [r for r in p2_v3_real_available if r["tour"] == t]
        results.append(metrics(rows, "P2_V3_SCENARIO_BY_TOUR", "scenario_grouped_odds", args.start_bankroll, args.risk_pct, tour=t))
        results.append(metrics(real_rows, "P2_V3_REAL_BY_TOUR", "p2_grouped_real", args.start_bankroll, args.risk_pct, tour=t))

    # CSV outputs
    candidate_fields = ["event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "tournament_group", "tournament_name", "first_set_score", "odds_3_6", "odds_4_6", "odds_5_7", "p2_grouped_real", "scenario_grouped_odds", "real_grouped_band", "has_all_p2_scores", "p2_cluster_win"]
    write_csv(out / "p2_v3_candidates_settled.csv", p2_v3_settled, candidate_fields)

    result_fields = ["label", "bookmaker", "tour", "odds_mode", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]
    write_csv(out / "p2_v3_scenario_vs_real_results.csv", results, result_fields)

    # Bankroll curves for headline versions
    curve_rows = []
    sim_scenario, curve = simulate(p2_v3_settled, "scenario_grouped_odds", args.start_bankroll, args.risk_pct)
    for c in curve:
        c["curve_label"] = "scenario_350_all_settled"
    curve_rows.extend(curve)
    sim_real, curve = simulate(p2_v3_real_available, "p2_grouped_real", args.start_bankroll, args.risk_pct)
    for c in curve:
        c["curve_label"] = "real_grouped_all_available"
    curve_rows.extend(curve)
    curve_fields = ["curve_label", "bet_index", "event_date", "event_key", "bookmaker", "odds_used", "won", "stake", "pnl", "bankroll", "drawdown_pct"]
    write_csv(out / "p2_v3_bankroll_curves.csv", curve_rows, curve_fields)

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "trigger_min": args.trigger_min,
        "trigger_max": args.trigger_max,
        "scenario_odds": args.scenario_odds,
        "funnel": funnel,
        "headline_results": results[:4],
        "all_results": results,
    }
    (out / "p2_v3_audit_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"

    lines = [
        "# P2-only V3 Scenario vs Real Grouped Odds Audit",
        "",
        f"Trigger: P2 4:6 odds {args.trigger_min}-{args.trigger_max}",
        f"Scenario grouped odds assumption: {args.scenario_odds}",
        "",
        "## Availability funnel",
        f"Wide rows total: {funnel['wide_rows_total']}",
        f"Wide rows settled: {funnel['wide_rows_settled']}",
        f"P2 V3 triggers all: {funnel['p2_v3_triggers_all']}",
        f"P2 V3 triggers settled: {funnel['p2_v3_triggers_settled']}",
        f"P2 V3 wins: {funnel['p2_v3_settled_wins']}",
        f"P2 V3 hit rate: {pct(funnel['p2_v3_settled_hit_rate'])}",
        f"Has all P2 score odds: {funnel['has_all_p2_score_odds']}",
        f"Has real grouped odds: {funnel['has_real_grouped_odds']}",
        f"Real grouped >= 3.50: {funnel['real_grouped_ge_350']}",
        f"Real grouped 3.00-3.50: {funnel['real_grouped_300_350']}",
        f"Real grouped < 3.00: {funnel['real_grouped_lt_300']}",
        "",
        "## Headline comparison",
    ]
    for r in results[:4]:
        avg = "n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"- {r['label']}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
    lines += ["", "## By bookmaker"]
    for r in [x for x in results if x.get("bookmaker")]:
        avg = "n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"- {r['bookmaker']} {r['label']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, final={money(r['final_bankroll'])}")
    lines += ["", "Interpretation: if scenario odds are strong but real grouped odds are weaker, the old compounding run was inflated by assuming a constant grouped price rather than using actual available grouped odds."]
    (out / "p2_v3_audit_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
