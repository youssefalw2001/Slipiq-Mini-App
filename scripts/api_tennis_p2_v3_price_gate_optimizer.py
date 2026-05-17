#!/usr/bin/env python3
"""SlipIQ P2-only V3 Price Gate Optimizer.

Keeps the original P2-only V3 trigger and tests the minimum REAL grouped odds
needed for the strategy to be bettable.

Trigger: P2 4:6 odds between trigger_min and trigger_max, default 6.25-6.99.
Bet: P2 grouped 9-12 cluster = 3:6 / 4:6 / 5:7.
Win: first_set_score in 3:6 / 4:6 / 5:7.
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
    implied = sum(1.0 / v for v in nums)
    return 1.0 / implied if implied else None


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


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def normalize(raw: Dict) -> Dict:
    r = dict(raw)
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
    r["has_all_p2_scores"] = r["odds_3_6"] is not None and r["odds_4_6"] is not None and r["odds_5_7"] is not None
    try:
        dt = f"{r['event_date']}T{r['event_time'] if len(r['event_time']) != 5 else r['event_time'] + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


def dedupe_unique_match(rows: List[Dict]) -> List[Dict]:
    groups = defaultdict(list)
    for r in rows:
        groups[r.get("event_key")].append(r)
    return [max(arr, key=lambda x: x.get("p2_grouped_real") or 0) for arr in groups.values()]


def dedupe_match_book(rows: List[Dict]) -> List[Dict]:
    seen = set()
    out = []
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))):
        key = (r.get("event_key"), r.get("bookmaker"))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def simulate(rows: List[Dict], start: float, risk: float):
    bank = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    curve = []
    for i, r in enumerate(sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))), 1):
        odds = r.get("p2_grouped_real")
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
        curve.append({"bet_index": i, "event_date": r.get("event_date", ""), "event_key": r.get("event_key", ""), "bookmaker": r.get("bookmaker", ""), "p2_grouped_real": odds, "won": str(bool(r["p2_cluster_win"])).lower(), "stake": stake, "pnl": pnl, "bankroll": bank, "drawdown_pct": dd * 100})
    return {"final_bankroll": bank, "compound_profit": bank - start, "compound_return_pct": ((bank / start) - 1) * 100 if start else None, "max_drawdown_pct": max_dd * 100, "worst_losing_streak": worst_losing}, curve


def metrics(rows: List[Dict], label: str, start: float, risk: float, **group):
    rows = [r for r in rows if r.get("p2_grouped_real") and r["p2_grouped_real"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r["p2_cluster_win"])
    avg_odds = sum(r["p2_grouped_real"] for r in rows) / bets if bets else None
    units = sum((r["p2_grouped_real"] - 1) if r["p2_cluster_win"] else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    for r in rows:
        m = r.get("event_date", "")[:7]
        if m:
            month_pl[m] += (r["p2_grouped_real"] - 1) if r["p2_cluster_win"] else -1
    sim, _ = simulate(rows, start, risk)
    return {"label": label, **group, "bets": bets, "wins": wins, "losses": bets - wins, "hit_rate": wins / bets if bets else None, "avg_odds": avg_odds, "breakeven_hit_rate": 1 / avg_odds if avg_odds else None, "edge_vs_breakeven": (wins / bets - 1 / avg_odds) if bets and avg_odds else None, "flat_profit_units": units, "flat_roi": units / bets if bets else None, "months": len(months), "positive_months": sum(1 for v in month_pl.values() if v > 0), "bets_per_month": bets / len(months) if months else None, **sim}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-p2-v3-price-gate-optimizer")
    ap.add_argument("--trigger-min", type=float, default=6.25)
    ap.add_argument("--trigger-max", type=float, default=6.99)
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    all_rows = [normalize(r) for r in read_csv(Path(args.first_set_wide))]
    triggered_all = [r for r in all_rows if r.get("odds_4_6") is not None and args.trigger_min <= r["odds_4_6"] <= args.trigger_max]
    triggered_settled = [r for r in triggered_all if r["is_settled"]]
    real_available = [r for r in triggered_settled if r["has_all_p2_scores"] and r.get("p2_grouped_real")]

    gates = [2.50, 2.60, 2.70, 2.80, 2.90, 3.00, 3.05, 3.10, 3.15, 3.20, 3.25, 3.30, 3.40, 3.50, 3.75, 4.00]
    books = sorted({r["bookmaker"] for r in real_available if r.get("bookmaker")})
    tours = sorted({r["tour"] for r in real_available if r.get("tour")})
    groups = sorted({r["tournament_group"] for r in real_available if r.get("tournament_group")})

    results = []
    modes = [("bookmaker_rows", lambda rows: dedupe_match_book(rows)), ("unique_match_best_available", lambda rows: dedupe_unique_match(rows))]
    for mode_name, mode_fn in modes:
        base = mode_fn(real_available)
        for gate in gates:
            results.append(metrics([r for r in base if r["p2_grouped_real"] >= gate], f"P2_V3_REAL_GROUPED_GE_{gate:.2f}", args.start_bankroll, args.risk_pct, mode=mode_name, min_grouped_odds=gate))
        for book in books:
            book_base = mode_fn([r for r in real_available if r["bookmaker"] == book])
            for gate in gates:
                results.append(metrics([r for r in book_base if r["p2_grouped_real"] >= gate], f"P2_V3_REAL_GROUPED_GE_{gate:.2f}", args.start_bankroll, args.risk_pct, mode=mode_name, bookmaker=book, min_grouped_odds=gate))
        for t in tours:
            tour_base = mode_fn([r for r in real_available if r["tour"] == t])
            for gate in gates:
                results.append(metrics([r for r in tour_base if r["p2_grouped_real"] >= gate], f"P2_V3_REAL_GROUPED_GE_{gate:.2f}", args.start_bankroll, args.risk_pct, mode=mode_name, tour=t, min_grouped_odds=gate))
        for g in groups:
            group_base = mode_fn([r for r in real_available if r["tournament_group"] == g])
            for gate in gates:
                results.append(metrics([r for r in group_base if r["p2_grouped_real"] >= gate], f"P2_V3_REAL_GROUPED_GE_{gate:.2f}", args.start_bankroll, args.risk_pct, mode=mode_name, tournament_group=g, min_grouped_odds=gate))

    # Focus combos most likely to matter. Includes requested 1xBet + bet365 focus.
    combos = [
        ("ATP_bet365", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365"),
        ("ATP_1xBet", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "1xBet"),
        ("ATP_1xBet_bet365", lambda r: r["tour"] == "ATP" and r["bookmaker"] in {"1xBet", "bet365"}),
        ("ATP_10Bet", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "10Bet"),
        ("ATP_bet365_10Bet", lambda r: r["tour"] == "ATP" and r["bookmaker"] in {"bet365", "10Bet"}),
        ("ATP_all_books", lambda r: r["tour"] == "ATP"),
        ("WTA_1xBet_bet365", lambda r: r["tour"] == "WTA" and r["bookmaker"] in {"1xBet", "bet365"}),
        ("ALL_1xBet_bet365", lambda r: r["bookmaker"] in {"1xBet", "bet365"}),
        ("WTA_all_books", lambda r: r["tour"] == "WTA"),
    ]
    for combo_name, fn in combos:
        combo_rows = [r for r in real_available if fn(r)]
        for mode_name, mode_fn in modes:
            base = mode_fn(combo_rows)
            for gate in gates:
                results.append(metrics([r for r in base if r["p2_grouped_real"] >= gate], f"P2_V3_{combo_name}_GE_{gate:.2f}", args.start_bankroll, args.risk_pct, mode=mode_name, combo=combo_name, min_grouped_odds=gate))

    fields = ["mode", "label", "combo", "bookmaker", "tour", "tournament_group", "min_grouped_odds", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]
    write_csv(out / "price_gate_results.csv", results, fields)
    leaderboard = sorted([r for r in results if r.get("bets", 0) >= 50 and r.get("flat_roi") is not None], key=lambda r: (r["flat_roi"], r["bets"]), reverse=True)[:300]
    write_csv(out / "price_gate_leaderboard.csv", leaderboard, fields)

    candidate_fields = ["event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "tournament_group", "tournament_name", "first_set_score", "odds_3_6", "odds_4_6", "odds_5_7", "p2_grouped_real", "p2_cluster_win"]
    write_csv(out / "p2_v3_real_available_candidates.csv", real_available, candidate_fields)

    curve_rows = []
    for label, rows in [
        ("bookmaker_rows_ge_3_00", [r for r in dedupe_match_book(real_available) if r["p2_grouped_real"] >= 3.00]),
        ("bookmaker_rows_ge_3_20", [r for r in dedupe_match_book(real_available) if r["p2_grouped_real"] >= 3.20]),
        ("bookmaker_rows_ge_3_50", [r for r in dedupe_match_book(real_available) if r["p2_grouped_real"] >= 3.50]),
        ("unique_match_ge_3_00", [r for r in dedupe_unique_match(real_available) if r["p2_grouped_real"] >= 3.00]),
        ("unique_match_ge_3_20", [r for r in dedupe_unique_match(real_available) if r["p2_grouped_real"] >= 3.20]),
        ("unique_match_ge_3_50", [r for r in dedupe_unique_match(real_available) if r["p2_grouped_real"] >= 3.50]),
    ]:
        _, curve = simulate(rows, args.start_bankroll, args.risk_pct)
        for c in curve:
            c["curve_label"] = label
        curve_rows.extend(curve)
    curve_fields = ["curve_label", "bet_index", "event_date", "event_key", "bookmaker", "p2_grouped_real", "won", "stake", "pnl", "bankroll", "drawdown_pct"]
    write_csv(out / "price_gate_bankroll_curves.csv", curve_rows, curve_fields)

    def count_by(rows, key):
        d = defaultdict(int)
        for r in rows:
            d[clean(r.get(key)) or "missing"] += 1
        return dict(sorted(d.items(), key=lambda kv: (-kv[1], kv[0])))

    book_rows = dedupe_match_book(real_available)
    unique_rows = dedupe_unique_match(real_available)
    funnel = {
        "wide_rows_total": len(all_rows),
        "wide_rows_settled": sum(1 for r in all_rows if r["is_settled"]),
        "p2_v3_triggered_all": len(triggered_all),
        "p2_v3_triggered_settled": len(triggered_settled),
        "p2_v3_real_available": len(real_available),
        "p2_v3_wins_real_available": sum(1 for r in real_available if r["p2_cluster_win"]),
        "p2_v3_hit_rate_real_available": (sum(1 for r in real_available if r["p2_cluster_win"]) / len(real_available)) if real_available else None,
        "real_available_by_bookmaker": count_by(real_available, "bookmaker"),
        "real_available_by_tour": count_by(real_available, "tour"),
        "real_available_by_tournament_group": count_by(real_available, "tournament_group"),
        "gate_counts_bookmaker_rows": {str(g): sum(1 for r in book_rows if r["p2_grouped_real"] >= g) for g in gates},
        "gate_counts_unique_match_best_available": {str(g): sum(1 for r in unique_rows if r["p2_grouped_real"] >= g) for g in gates},
        "gate_counts_1xBet_bet365": {str(g): sum(1 for r in book_rows if r["bookmaker"] in {"1xBet", "bet365"} and r["p2_grouped_real"] >= g) for g in gates},
    }
    (out / "price_gate_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")
    summary = {"generated_at": datetime.utcnow().isoformat() + "Z", "trigger_min": args.trigger_min, "trigger_max": args.trigger_max, "funnel": funnel, "top_results": leaderboard[:50]}
    (out / "price_gate_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# P2 V3 Price Gate Optimizer",
        "",
        f"Trigger: P2 4:6 odds {args.trigger_min}-{args.trigger_max}",
        "Bet: P2 grouped 3:6 / 4:6 / 5:7 using REAL reconstructed grouped odds.",
        "Requested focus combo added: 1xBet + bet365.",
        "",
        "## Funnel",
        f"Wide rows total: {funnel['wide_rows_total']}",
        f"Wide rows settled: {funnel['wide_rows_settled']}",
        f"P2 V3 triggered settled: {funnel['p2_v3_triggered_settled']}",
        f"P2 V3 real available: {funnel['p2_v3_real_available']}",
        f"P2 V3 real hit rate: {pct(funnel['p2_v3_hit_rate_real_available'])}",
        "",
        "## Gate counts, bookmaker rows",
    ]
    for g, c in funnel["gate_counts_bookmaker_rows"].items():
        lines.append(f"- >= {g}: {c}")
    lines += ["", "## Gate counts, 1xBet + bet365"]
    for g, c in funnel["gate_counts_1xBet_bet365"].items():
        lines.append(f"- >= {g}: {c}")
    lines += ["", "## Top price-gated results, min 50 bets"]
    for i, r in enumerate(leaderboard[:30], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r.get('mode','')} {r.get('combo','')} {r.get('bookmaker','')} {r.get('tour','')} gate>={r.get('min_grouped_odds')}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r.get('edge_vs_breakeven'))}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
    lines.append("\nInterpretation: the original P2 V3 hit-rate pattern only becomes bettable if real grouped odds clear the breakeven gate. At ~33% hit rate, minimum practical grouped odds must be above ~3.05, preferably 3.20+.")
    (out / "price_gate_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
