#!/usr/bin/env python3
"""SlipIQ P2 V3 Deep Grid Optimizer.

Focus:
- Original P2-only V3 signal.
- Real reconstructed grouped odds only.
- Deep split by bookmaker + tournament group + surface + price gate.

Trigger:
- odds_4_6 between trigger_min and trigger_max, default 6.25-6.99.

Bet:
- P2 grouped first-set 9-12 cluster: 3:6 / 4:6 / 5:7.

Win:
- first_set_score in 3:6 / 4:6 / 5:7.

Inputs:
- first_set_correct_score_wide_combined.csv
- fixtures_full_combined.csv optional, for surface/round enrichment

Outputs:
- p2_v3_deep_grid_candidates.csv
- p2_v3_deep_grid_results.csv
- p2_v3_deep_grid_leaderboard.csv
- p2_v3_deep_grid_monthly.csv
- p2_v3_deep_grid_funnel.json
- p2_v3_deep_grid_report.md
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


def grouped(vals: Iterable[Optional[float]]) -> Optional[float]:
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums):
        return None
    implied = sum(1.0 / v for v in nums)
    return 1.0 / implied if implied else None


def tour(row: Dict) -> str:
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
        if not key:
            continue
        # Prefer the first useful fixture row. Duplicates across chunks/date should have same context.
        if key not in out:
            out[key] = r
    return out


def normalize_wide(raw: Dict, fixture_map: Dict[str, Dict]) -> Dict:
    r = dict(raw)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tournament_name", "event_type_type", "first_set_score", "surface", "round"]:
        r[k] = clean(r.get(k))
    fixture = fixture_map.get(r["event_key"], {})
    if not r.get("surface"):
        r["surface"] = clean(fixture.get("surface") or fixture.get("event_surface"))
    if not r.get("round"):
        r["round"] = clean(fixture.get("round") or fixture.get("event_round") or fixture.get("tournament_round"))
    if not r.get("event_type_key"):
        r["event_type_key"] = clean(fixture.get("event_type_key"))
    if not r.get("event_type_type"):
        r["event_type_type"] = clean(fixture.get("event_type_type"))
    if not r.get("tournament_name"):
        r["tournament_name"] = clean(fixture.get("tournament_name"))
    for k in ["odds_3_6", "odds_4_6", "odds_5_7"]:
        r[k] = fnum(r.get(k))
    r["p2_grouped_real"] = fnum(r.get("p2_cluster_odds")) or fnum(r.get("p2_grouped_9_12")) or grouped([r.get("odds_3_6"), r.get("odds_4_6"), r.get("odds_5_7")])
    r["tour"] = tour(r)
    r["tournament_group"] = tournament_group(r)
    r["surface_norm"] = norm_surface(r.get("surface"))
    r["is_settled"] = bool(r.get("first_set_score"))
    r["p2_cluster_win"] = r.get("first_set_score") in P2_WIN_SCORES
    r["has_all_p2_scores"] = r.get("odds_3_6") is not None and r.get("odds_4_6") is not None and r.get("odds_5_7") is not None
    try:
        time = r.get("event_time") or "00:00"
        dt = f"{r['event_date']}T{time if len(time) != 5 else time + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


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


def dedupe_unique_match_best_available(rows: List[Dict]) -> List[Dict]:
    groups = defaultdict(list)
    for r in rows:
        groups[r.get("event_key")].append(r)
    return [max(arr, key=lambda x: x.get("p2_grouped_real") or 0) for arr in groups.values()]


def simulate(rows: List[Dict], start: float, risk: float):
    bank = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""))):
        odds = r.get("p2_grouped_real")
        if not odds or odds <= 1:
            continue
        stake = bank * risk
        if r.get("p2_cluster_win"):
            bank += stake * (odds - 1)
            losing = 0
        else:
            bank -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bank)
        if peak:
            max_dd = max(max_dd, (peak - bank) / peak)
    return {
        "final_bankroll": bank,
        "compound_profit": bank - start,
        "compound_return_pct": ((bank / start) - 1) * 100 if start else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
    }


def metrics(rows: List[Dict], label: str, start: float, risk: float, **group):
    rows = [r for r in rows if r.get("p2_grouped_real") and r["p2_grouped_real"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("p2_cluster_win"))
    avg_odds = sum(r["p2_grouped_real"] for r in rows) / bets if bets else None
    units = sum((r["p2_grouped_real"] - 1) if r.get("p2_cluster_win") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            month_pl[month] += (r["p2_grouped_real"] - 1) if r.get("p2_cluster_win") else -1
    return {
        "label": label,
        **group,
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg_odds,
        "breakeven_hit_rate": 1 / avg_odds if avg_odds else None,
        "edge_vs_breakeven": (wins / bets - 1 / avg_odds) if bets and avg_odds else None,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "positive_months": sum(1 for v in month_pl.values() if v > 0),
        "bets_per_month": bets / len(months) if months else None,
        **simulate(rows, start, risk),
    }


def monthly_rows(rows: List[Dict], label: str, group: Dict) -> List[Dict]:
    by_month = defaultdict(list)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            by_month[month].append(r)
    out = []
    for month, arr in sorted(by_month.items()):
        bets = len(arr)
        wins = sum(1 for r in arr if r.get("p2_cluster_win"))
        avg_odds = sum(r["p2_grouped_real"] for r in arr) / bets if bets else None
        units = sum((r["p2_grouped_real"] - 1) if r.get("p2_cluster_win") else -1 for r in arr)
        out.append({
            "label": label,
            **group,
            "month": month,
            "bets": bets,
            "wins": wins,
            "hit_rate": wins / bets if bets else None,
            "avg_odds": avg_odds,
            "flat_profit_units": units,
            "flat_roi": units / bets if bets else None,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--fixtures", default="")
    ap.add_argument("--out", default="artifacts/output/api-tennis-p2-v3-deep-grid-optimizer")
    ap.add_argument("--trigger-min", type=float, default=6.25)
    ap.add_argument("--trigger-max", type=float, default=6.99)
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--min-bets-leaderboard", type=int, default=25)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fixture_map = build_fixture_map(Path(args.fixtures)) if args.fixtures else {}

    all_rows = [normalize_wide(r, fixture_map) for r in read_csv(Path(args.first_set_wide))]
    triggered_all = [r for r in all_rows if r.get("odds_4_6") is not None and args.trigger_min <= r["odds_4_6"] <= args.trigger_max]
    triggered_settled = [r for r in triggered_all if r["is_settled"]]
    candidates = [r for r in triggered_settled if r["has_all_p2_scores"] and r.get("p2_grouped_real")]

    gates = [2.50, 2.60, 2.70, 2.80, 2.90, 3.00, 3.05, 3.10, 3.15, 3.20, 3.25, 3.30, 3.40, 3.50, 3.75, 4.00]
    modes = [
        ("bookmaker_rows", dedupe_match_book),
        ("unique_match_best_available", dedupe_unique_match_best_available),
    ]
    book_groups = {
        "ALL_BOOKS": None,
        "1xBet": {"1xBet"},
        "bet365": {"bet365"},
        "10Bet": {"10Bet"},
        "1xBet_bet365": {"1xBet", "bet365"},
        "bet365_10Bet": {"bet365", "10Bet"},
        "1xBet_bet365_10Bet": {"1xBet", "bet365", "10Bet"},
    }
    tours = ["ALL"] + sorted({r["tour"] for r in candidates if r.get("tour")})
    tgroups = ["ALL"] + sorted({r["tournament_group"] for r in candidates if r.get("tournament_group")})
    surfaces = ["ALL"] + sorted({r["surface_norm"] for r in candidates if r.get("surface_norm")})

    results = []
    monthly = []

    def base_filter(rows: List[Dict], book_group: str, tour_name: str, tgroup_name: str, surface_name: str) -> List[Dict]:
        allowed_books = book_groups[book_group]
        out_rows = rows
        if allowed_books is not None:
            out_rows = [r for r in out_rows if r["bookmaker"] in allowed_books]
        if tour_name != "ALL":
            out_rows = [r for r in out_rows if r["tour"] == tour_name]
        if tgroup_name != "ALL":
            out_rows = [r for r in out_rows if r["tournament_group"] == tgroup_name]
        if surface_name != "ALL":
            out_rows = [r for r in out_rows if r["surface_norm"] == surface_name]
        return out_rows

    for mode_name, mode_fn in modes:
        # Focused grids: not every possible cross-product, but enough to find the real pocket.
        grid_specs = []
        for bg in book_groups:
            for tr in tours:
                grid_specs.append((bg, tr, "ALL", "ALL"))
            for tg in tgroups:
                grid_specs.append((bg, "ALL", tg, "ALL"))
            for sf in surfaces:
                grid_specs.append((bg, "ALL", "ALL", sf))
            for tr in ["ATP", "WTA"]:
                if tr in tours:
                    for tg in tgroups:
                        grid_specs.append((bg, tr, tg, "ALL"))
                    for sf in surfaces:
                        grid_specs.append((bg, tr, "ALL", sf))
                    for tg in tgroups:
                        for sf in surfaces:
                            if tg != "ALL" and sf != "ALL":
                                grid_specs.append((bg, tr, tg, sf))
        seen_specs = set()
        for bg, tr, tg, sf in grid_specs:
            spec = (bg, tr, tg, sf)
            if spec in seen_specs:
                continue
            seen_specs.add(spec)
            base = mode_fn(base_filter(candidates, bg, tr, tg, sf))
            if not base:
                continue
            for gate in gates:
                rows = [r for r in base if r["p2_grouped_real"] >= gate]
                if not rows:
                    continue
                label = f"P2_V3_{bg}_{tr}_{tg}_{sf}_GE_{gate:.2f}"
                group = {"mode": mode_name, "book_group": bg, "tour": tr, "tournament_group": tg, "surface": sf, "min_grouped_odds": gate}
                m = metrics(rows, label, args.start_bankroll, args.risk_pct, **group)
                results.append(m)
                if m["bets"] >= args.min_bets_leaderboard and m["flat_roi"] is not None:
                    monthly.extend(monthly_rows(rows, label, group))

    result_fields = ["mode", "label", "book_group", "tour", "tournament_group", "surface", "min_grouped_odds", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]
    write_csv(out / "p2_v3_deep_grid_results.csv", results, result_fields)
    leaderboard = sorted(
        [r for r in results if r.get("bets", 0) >= args.min_bets_leaderboard and r.get("flat_roi") is not None],
        key=lambda r: (r["flat_roi"], r["bets"]),
        reverse=True,
    )[:500]
    write_csv(out / "p2_v3_deep_grid_leaderboard.csv", leaderboard, result_fields)

    candidate_fields = ["event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "event_type_key", "tournament_group", "tournament_name", "surface_norm", "surface", "round", "first_set_score", "odds_3_6", "odds_4_6", "odds_5_7", "p2_grouped_real", "p2_cluster_win"]
    write_csv(out / "p2_v3_deep_grid_candidates.csv", candidates, candidate_fields)

    monthly_fields = ["label", "mode", "book_group", "tour", "tournament_group", "surface", "min_grouped_odds", "month", "bets", "wins", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi"]
    write_csv(out / "p2_v3_deep_grid_monthly.csv", monthly, monthly_fields)

    def count_by(rows: List[Dict], key: str) -> Dict[str, int]:
        d = defaultdict(int)
        for r in rows:
            d[clean(r.get(key)) or "missing"] += 1
        return dict(sorted(d.items(), key=lambda kv: (-kv[1], kv[0])))

    funnel = {
        "wide_rows_total": len(all_rows),
        "wide_rows_settled": sum(1 for r in all_rows if r["is_settled"]),
        "p2_v3_triggered_all": len(triggered_all),
        "p2_v3_triggered_settled": len(triggered_settled),
        "p2_v3_candidates_real_grouped_available": len(candidates),
        "candidate_hit_rate": (sum(1 for r in candidates if r["p2_cluster_win"]) / len(candidates)) if candidates else None,
        "surface_counts_all_candidates": count_by(candidates, "surface_norm"),
        "surface_raw_counts_all_candidates": count_by(candidates, "surface"),
        "tournament_group_counts": count_by(candidates, "tournament_group"),
        "bookmaker_counts": count_by(candidates, "bookmaker"),
        "tour_counts": count_by(candidates, "tour"),
        "fixture_map_rows": len(fixture_map),
        "surface_known_candidates": sum(1 for r in candidates if r.get("surface_norm") and r["surface_norm"] != "UNKNOWN"),
        "surface_unknown_candidates": sum(1 for r in candidates if not r.get("surface_norm") or r["surface_norm"] == "UNKNOWN"),
    }
    (out / "p2_v3_deep_grid_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")
    summary = {"generated_at": datetime.utcnow().isoformat() + "Z", "trigger_min": args.trigger_min, "trigger_max": args.trigger_max, "min_bets_leaderboard": args.min_bets_leaderboard, "funnel": funnel, "top_results": leaderboard[:50]}
    (out / "p2_v3_deep_grid_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# P2 V3 Deep Grid Optimizer",
        "",
        f"Trigger: P2 4:6 odds {args.trigger_min}-{args.trigger_max}",
        "Bet: P2 grouped 3:6 / 4:6 / 5:7 using real reconstructed grouped odds.",
        "Grid: bookmaker group + tour + tournament group + surface + price gate.",
        "",
        "## Funnel",
        f"P2 V3 triggered settled: {funnel['p2_v3_triggered_settled']}",
        f"P2 V3 real grouped candidates: {funnel['p2_v3_candidates_real_grouped_available']}",
        f"Candidate hit rate: {pct(funnel['candidate_hit_rate'])}",
        f"Fixture map rows joined: {funnel['fixture_map_rows']}",
        f"Surface known candidates: {funnel['surface_known_candidates']}",
        f"Surface unknown candidates: {funnel['surface_unknown_candidates']}",
        "",
        "## Surface counts",
    ]
    for k, v in funnel["surface_counts_all_candidates"].items():
        lines.append(f"- {k}: {v}")
    lines += ["", f"## Top results, min {args.min_bets_leaderboard} bets"]
    for i, r in enumerate(leaderboard[:40], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r.get('mode')} {r.get('book_group')} {r.get('tour')} {r.get('tournament_group')} {r.get('surface')} gate>={r.get('min_grouped_odds')}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r.get('edge_vs_breakeven'))}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}")
    lines.append("\nInterpretation: prioritize pockets with enough bets, positive ROI, positive edge over breakeven, and decent month stability. If surface_unknown is huge, surface is not reliable yet from API Tennis.")
    (out / "p2_v3_deep_grid_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
