#!/usr/bin/env python3
"""
First Set Lab Exposure Scenario Lab.

Research-only utility for comparing exposure plans and drawdown controls.
It reads already-settled proof data when available, filters to selected public
price sources, and runs simple Monte Carlo outcome distributions.

This tool does not connect to any sportsbook, place wagers, automate account
actions, or promise outcomes. It is only for risk and scenario analysis.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import statistics
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_SOURCES = ["bet365", "1xBet"]

DEFAULT_ASSUMPTIONS = {
    "comfort": {"p": 0.7517, "price": 1.595, "monthly_count": 12.0},
    "core": {"p": 0.3934, "price": 3.04, "monthly_count": 30.0},
    "vip": {"p": 0.3853, "price": 3.04, "monthly_count": 6.0},
    "research": {"p": 0.3824, "price": 3.77, "monthly_count": 3.0},
}

DEFAULT_PLAN = {
    "comfort_single": 0.06,
    "core_single": 0.0125,
    "vip_single": 0.0075,
    "research_single": 0.0025,
    "comfort_two_leg": 0.015,
    "edge_two_leg": 0.0075,
    "max_daily_exposure": 0.15,
    "cut_exposure_at_dd": 0.20,
    "comfort_only_at_dd": 0.35,
    "floor_level": 600.0,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Research-only exposure scenario lab")
    parser.add_argument("--out", default="artifacts/output/first-set-lab-exposure-scenario-lab")
    parser.add_argument("--starting-balance", type=float, default=1000.0)
    parser.add_argument("--days", type=int, default=365)
    parser.add_argument("--runs", type=int, default=2500)
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--sources", default=",".join(DEFAULT_SOURCES))
    parser.add_argument("--use-supabase", default="true")
    return parser.parse_args()


def truthy(value: Any) -> bool:
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def ensure_dir(path: str) -> Path:
    out = Path(path)
    out.mkdir(parents=True, exist_ok=True)
    return out


def safe_num(value: Any) -> Optional[float]:
    try:
        if value in (None, ""):
            return None
        out = float(value)
        return out if math.isfinite(out) else None
    except Exception:
        return None


def rest_get(path: str) -> Any:
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not base or not key:
        raise RuntimeError("Supabase env not configured")
    req = urllib.request.Request(
        f"{base}/rest/v1/{path}",
        headers={"apikey": key, "authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def lane(row: Dict[str, Any]) -> str:
    signal_type = str(row.get("signal_type") or "")
    access = str(row.get("access") or "")
    strategy = str(row.get("strategy_lane") or "")
    if signal_type == "first_set_winner":
        return "comfort"
    if access == "RESEARCH_ONLY" or strategy.startswith("RESEARCH_"):
        return "research"
    if access == "VIP_ONLY" or strategy.startswith("VIP_"):
        return "vip"
    return "core"


def load_parameters(sources: List[str]) -> Dict[str, Dict[str, float]]:
    selected = ",".join([
        "settled_win",
        "signal_type",
        "access",
        "strategy_lane",
        "internal_bookmaker",
        "selected_side_odds",
        "grouped_odds",
    ])
    path = "live_signal_unique_results?select=" + urllib.parse.quote(selected, safe=",") + "&status=eq.settled&limit=5000"
    rows = rest_get(path)
    source_set = {s.lower() for s in sources}
    grouped: Dict[str, List[Dict[str, Any]]] = {key: [] for key in DEFAULT_ASSUMPTIONS}
    for row in rows or []:
        source = str(row.get("internal_bookmaker") or "").lower()
        if source and source not in source_set:
            continue
        price = safe_num(row.get("selected_side_odds")) or safe_num(row.get("grouped_odds"))
        if not price or price <= 1:
            continue
        grouped[lane(row)].append({"success": row.get("settled_win") is True, "price": price})

    params: Dict[str, Dict[str, float]] = {}
    for key, prior in DEFAULT_ASSUMPTIONS.items():
        sample = grouped[key]
        threshold = 20 if key != "comfort" else 8
        if len(sample) >= threshold:
            params[key] = {
                "p": sum(1 for item in sample if item["success"]) / len(sample),
                "price": statistics.mean(item["price"] for item in sample),
                "monthly_count": prior["monthly_count"],
                "sample": float(len(sample)),
                "empirical": 1.0,
            }
        else:
            params[key] = {**prior, "sample": float(len(sample)), "empirical": 0.0}
    return params


def poisson(lam: float, rng: random.Random) -> int:
    if lam <= 0:
        return 0
    limit = math.exp(-lam)
    count = 0
    prod = 1.0
    while prod > limit:
        count += 1
        prod *= rng.random()
    return count - 1


def apply(balance: float, fraction: float, p_success: float, price: float, remaining: float, rng: random.Random) -> Dict[str, Any]:
    exposure = min(balance * fraction, remaining)
    if exposure <= 0:
        return {"played": False, "balance": balance, "success": False, "exposure": 0.0}
    success = rng.random() < p_success
    change = exposure * (price - 1.0) if success else -exposure
    return {"played": True, "balance": max(0.0, balance + change), "success": success, "exposure": exposure}


def simulate_once(start: float, days: int, params: Dict[str, Dict[str, float]], rng: random.Random) -> Dict[str, Any]:
    balance = start
    peak = start
    max_dd = 0.0
    trials = 0
    successes = 0
    streak = 0
    worst_streak = 0
    floor_seen = False
    combo_trials = 0

    for _ in range(days):
        peak = max(peak, balance)
        dd = 1.0 - balance / peak if peak else 1.0
        max_dd = max(max_dd, dd)
        cut = dd >= DEFAULT_PLAN["cut_exposure_at_dd"]
        comfort_only = dd >= DEFAULT_PLAN["comfort_only_at_dd"] or balance <= DEFAULT_PLAN["floor_level"]
        if balance <= DEFAULT_PLAN["floor_level"]:
            floor_seen = True
        multiplier = 0.5 if cut else 1.0
        if balance <= DEFAULT_PLAN["floor_level"]:
            multiplier = 0.25
        daily_cap = balance * DEFAULT_PLAN["max_daily_exposure"] * multiplier
        used = 0.0

        counts = {key: poisson(params[key]["monthly_count"] / 30.0, rng) for key in params}
        if comfort_only:
            counts["core"] = 0
            counts["vip"] = 0
            counts["research"] = 0

        single_fractions = {
            "comfort": DEFAULT_PLAN["comfort_single"],
            "core": DEFAULT_PLAN["core_single"],
            "vip": DEFAULT_PLAN["vip_single"],
            "research": DEFAULT_PLAN["research_single"],
        }
        for key in ["comfort", "core", "vip", "research"]:
            for _ in range(counts[key]):
                out = apply(balance, single_fractions[key] * multiplier, params[key]["p"], params[key]["price"], daily_cap - used, rng)
                if not out["played"]:
                    break
                balance = out["balance"]
                used += out["exposure"]
                trials += 1
                successes += int(out["success"])
                streak = 0 if out["success"] else streak + 1
                worst_streak = max(worst_streak, streak)

        if not comfort_only and counts["comfort"] >= 2:
            out = apply(balance, DEFAULT_PLAN["comfort_two_leg"] * multiplier, params["comfort"]["p"] ** 2, params["comfort"]["price"] ** 2, daily_cap - used, rng)
            if out["played"]:
                balance = out["balance"]
                used += out["exposure"]
                trials += 1
                successes += int(out["success"])
                combo_trials += 1
                streak = 0 if out["success"] else streak + 1
                worst_streak = max(worst_streak, streak)

        if not comfort_only and not cut and counts["core"] >= 2:
            out = apply(balance, DEFAULT_PLAN["edge_two_leg"], params["core"]["p"] ** 2, params["core"]["price"] ** 2, daily_cap - used, rng)
            if out["played"]:
                balance = out["balance"]
                trials += 1
                successes += int(out["success"])
                combo_trials += 1
                streak = 0 if out["success"] else streak + 1
                worst_streak = max(worst_streak, streak)

    return {
        "ending_balance": balance,
        "return_pct": (balance / start - 1.0) * 100.0,
        "max_drawdown_pct": max_dd * 100.0,
        "trials": trials,
        "success_rate_pct": (successes / trials * 100.0) if trials else 0.0,
        "worst_streak": worst_streak,
        "floor_seen": floor_seen,
        "combo_trials": combo_trials,
    }


def summary(results: List[Dict[str, Any]], start: float) -> Dict[str, float]:
    endings = sorted(item["ending_balance"] for item in results)
    dds = sorted(item["max_drawdown_pct"] for item in results)
    def q(values: List[float], p: float) -> float:
        return values[min(len(values) - 1, max(0, int((len(values) - 1) * p)))]
    return {
        "runs": float(len(results)),
        "median_end": statistics.median(endings),
        "mean_end": statistics.mean(endings),
        "p10_end": q(endings, 0.10),
        "p90_end": q(endings, 0.90),
        "best_end": max(endings),
        "median_drawdown_pct": statistics.median(dds),
        "p90_drawdown_pct": q(dds, 0.90),
        "above_start_pct": 100.0 * sum(1 for item in results if item["ending_balance"] > start) / len(results),
        "two_x_pct": 100.0 * sum(1 for item in results if item["ending_balance"] >= start * 2) / len(results),
        "five_x_pct": 100.0 * sum(1 for item in results if item["ending_balance"] >= start * 5) / len(results),
        "ten_x_pct": 100.0 * sum(1 for item in results if item["ending_balance"] >= start * 10) / len(results),
        "floor_seen_pct": 100.0 * sum(1 for item in results if item["floor_seen"]) / len(results),
        "worst_streak_max": float(max(item["worst_streak"] for item in results)),
    }


def write_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    out = ensure_dir(args.out)
    sources = [item.strip() for item in args.sources.split(",") if item.strip()]
    params = DEFAULT_ASSUMPTIONS
    data_note = "default_assumptions"
    if truthy(args.use_supabase):
        try:
            params = load_parameters(sources)
            data_note = "supabase_unique_results_when_sample_sufficient_else_defaults"
        except Exception as exc:
            data_note = f"default_assumptions_due_to_supabase_error: {exc}"
            params = {key: {**value, "sample": 0.0, "empirical": 0.0} for key, value in DEFAULT_ASSUMPTIONS.items()}

    rng = random.Random(args.seed)
    results = [simulate_once(args.starting_balance, args.days, params, rng) for _ in range(args.runs)]
    stats = summary(results, args.starting_balance)
    audit = {
        "starting_balance": args.starting_balance,
        "days": args.days,
        "runs": args.runs,
        "sources": sources,
        "data_note": data_note,
        "plan": DEFAULT_PLAN,
        "parameters": params,
        "summary": stats,
        "disclaimer": "Research-only scenario analysis. No guarantees. Does not connect to accounts or execute actions.",
    }
    (out / "exposure_scenario_audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    write_csv(out / "exposure_scenario_runs.csv", results)

    lines = [
        "# First Set Lab Exposure Scenario Lab",
        "",
        f"Starting balance: ${args.starting_balance:,.0f}",
        f"Runs: {args.runs:,}",
        f"Sources filtered: {', '.join(sources)}",
        f"Data mode: {data_note}",
        "",
        "## Output Summary",
        "",
        f"Median ending balance: ${stats['median_end']:,.0f}",
        f"Mean ending balance: ${stats['mean_end']:,.0f}",
        f"P10 ending balance: ${stats['p10_end']:,.0f}",
        f"P90 ending balance: ${stats['p90_end']:,.0f}",
        f"Best run ending balance: ${stats['best_end']:,.0f}",
        "",
        f"Chance above start: {stats['above_start_pct']:.1f}%",
        f"Chance 2x: {stats['two_x_pct']:.1f}%",
        f"Chance 5x: {stats['five_x_pct']:.1f}%",
        f"Chance 10x: {stats['ten_x_pct']:.1f}%",
        f"Chance floor touched: {stats['floor_seen_pct']:.1f}%",
        "",
        f"Median max drawdown: {stats['median_drawdown_pct']:.1f}%",
        f"P90 max drawdown: {stats['p90_drawdown_pct']:.1f}%",
        f"Worst streak observed: {stats['worst_streak_max']:.0f}",
        "",
        "Research-only scenario analysis. No guarantees. Does not connect to accounts or execute actions.",
    ]
    (out / "exposure_scenario_report.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
