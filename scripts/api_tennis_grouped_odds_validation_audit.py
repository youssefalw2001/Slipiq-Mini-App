#!/usr/bin/env python3
"""SlipIQ grouped odds validation audit.

Purpose:
- Verify P2 grouped odds are calculated correctly from 3:6 / 4:6 / 5:7.
- Verify P1 mirror grouped odds are calculated correctly from 6:3 / 6:4 / 7:5.
- Confirm all scores are from the same row: match + bookmaker + first-set correct-score market.
- Produce a dutching stake/payout check for a $100 stake.
- Highlight rows where saved grouped odds differ from recalculated grouped odds.

This is a data/math audit, not a strategy optimizer.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from pathlib import Path
from typing import Dict, List, Optional

P2_SCORES = [("3:6", "odds_3_6"), ("4:6", "odds_4_6"), ("5:7", "odds_5_7")]
P1_SCORES = [("6:3", "odds_6_3"), ("6:4", "odds_6_4"), ("7:5", "odds_7_5")]
P2_WIN_SCORES = {"3:6", "4:6", "5:7"}
P1_WIN_SCORES = {"6:3", "6:4", "7:5"}


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


def grouped_odds(odds: List[Optional[float]]) -> Optional[float]:
    if any(v is None or v <= 1 for v in odds):
        return None
    implied = sum(1.0 / v for v in odds)
    return 1.0 / implied if implied else None


def stake_split(odds: List[Optional[float]], total_stake: float = 100.0):
    if any(v is None or v <= 1 for v in odds):
        return None
    implied = [1.0 / v for v in odds]
    total_implied = sum(implied)
    if total_implied <= 0:
        return None
    stakes = [(i / total_implied) * total_stake for i in implied]
    payouts = [stakes[i] * odds[i] for i in range(len(odds))]
    grouped = total_stake and (sum(payouts) / len(payouts) / total_stake)
    return {
        "stakes": stakes,
        "payouts": payouts,
        "avg_payout": sum(payouts) / len(payouts),
        "min_payout": min(payouts),
        "max_payout": max(payouts),
        "payout_spread": max(payouts) - min(payouts),
        "grouped_odds_from_payout": grouped,
    }


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
    for k in ["event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "market_name", "tournament_name", "event_type_key", "event_type_type", "first_set_score"]:
        r[k] = clean(r.get(k))
    for _, col in P1_SCORES + P2_SCORES:
        r[col] = fnum(r.get(col))
    r["saved_p1_cluster_odds"] = fnum(r.get("p1_cluster_odds"))
    r["saved_p2_cluster_odds"] = fnum(r.get("p2_cluster_odds"))
    r["recalc_p1_cluster_odds"] = grouped_odds([r[col] for _, col in P1_SCORES])
    r["recalc_p2_cluster_odds"] = grouped_odds([r[col] for _, col in P2_SCORES])
    r["p1_diff"] = abs(r["saved_p1_cluster_odds"] - r["recalc_p1_cluster_odds"]) if r["saved_p1_cluster_odds"] and r["recalc_p1_cluster_odds"] else None
    r["p2_diff"] = abs(r["saved_p2_cluster_odds"] - r["recalc_p2_cluster_odds"]) if r["saved_p2_cluster_odds"] and r["recalc_p2_cluster_odds"] else None
    return r


def audit_row(r: Dict, side: str, total_stake: float):
    scores = P2_SCORES if side == "P2" else P1_SCORES
    odds = [r[col] for _, col in scores]
    calc = grouped_odds(odds)
    saved = r["saved_p2_cluster_odds"] if side == "P2" else r["saved_p1_cluster_odds"]
    diff = abs(saved - calc) if saved and calc else None
    dutch = stake_split(odds, total_stake)
    first_set_score = r.get("first_set_score", "")
    win_scores = P2_WIN_SCORES if side == "P2" else P1_WIN_SCORES
    out = {
        "side": side,
        "event_key": r.get("event_key", ""),
        "event_date": r.get("event_date", ""),
        "event_time": r.get("event_time", ""),
        "player1": r.get("player1", ""),
        "player2": r.get("player2", ""),
        "match_name": r.get("match_name", ""),
        "bookmaker": r.get("bookmaker", ""),
        "market_name": r.get("market_name", ""),
        "tournament_name": r.get("tournament_name", ""),
        "event_type_key": r.get("event_type_key", ""),
        "first_set_score": first_set_score,
        "cluster_win": str(first_set_score in win_scores).lower(),
        "score_a": scores[0][0],
        "score_b": scores[1][0],
        "score_c": scores[2][0],
        "odds_a": odds[0],
        "odds_b": odds[1],
        "odds_c": odds[2],
        "saved_grouped_odds": saved,
        "recalculated_grouped_odds": calc,
        "absolute_difference": diff,
        "difference_ok_le_0_001": str(diff is not None and diff <= 0.001).lower(),
        "has_all_three_scores": str(all(v is not None and v > 1 for v in odds)).lower(),
    }
    if dutch:
        out.update({
            "total_stake": total_stake,
            "stake_a": dutch["stakes"][0],
            "stake_b": dutch["stakes"][1],
            "stake_c": dutch["stakes"][2],
            "payout_a": dutch["payouts"][0],
            "payout_b": dutch["payouts"][1],
            "payout_c": dutch["payouts"][2],
            "avg_payout": dutch["avg_payout"],
            "payout_spread": dutch["payout_spread"],
            "grouped_odds_from_100_stake": dutch["grouped_odds_from_payout"],
        })
    else:
        out.update({
            "total_stake": total_stake,
            "stake_a": "",
            "stake_b": "",
            "stake_c": "",
            "payout_a": "",
            "payout_b": "",
            "payout_c": "",
            "avg_payout": "",
            "payout_spread": "",
            "grouped_odds_from_100_stake": "",
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-grouped-odds-validation-audit")
    ap.add_argument("--sample-size", type=int, default=50)
    ap.add_argument("--seed", type=int, default=20260517)
    ap.add_argument("--stake", type=float, default=100.0)
    ap.add_argument("--trigger-min", type=float, default=6.25)
    ap.add_argument("--trigger-max", type=float, default=6.99)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rows = [normalize(r) for r in read_csv(Path(args.first_set_wide))]
    p2_valid = [r for r in rows if r.get("recalc_p2_cluster_odds")]
    p1_valid = [r for r in rows if r.get("recalc_p1_cluster_odds")]
    p2_v3 = [r for r in p2_valid if r.get("odds_4_6") and args.trigger_min <= r["odds_4_6"] <= args.trigger_max]
    p2_gate = [r for r in p2_v3 if r.get("recalc_p2_cluster_odds") and r["recalc_p2_cluster_odds"] >= 3.05]

    rng = random.Random(args.seed)
    sample_source = []
    for label, source, side in [
        ("random_p2_valid", p2_valid, "P2"),
        ("random_p1_valid", p1_valid, "P1"),
        ("p2_v3_trigger", p2_v3, "P2"),
        ("p2_v3_gate_305", p2_gate, "P2"),
    ]:
        source_copy = list(source)
        rng.shuffle(source_copy)
        for r in source_copy[: args.sample_size]:
            audited = audit_row(r, side, args.stake)
            audited["sample_group"] = label
            sample_source.append(audited)

    fields = [
        "sample_group", "side", "event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "market_name", "tournament_name", "event_type_key", "first_set_score", "cluster_win",
        "score_a", "score_b", "score_c", "odds_a", "odds_b", "odds_c", "saved_grouped_odds", "recalculated_grouped_odds", "absolute_difference", "difference_ok_le_0_001", "has_all_three_scores",
        "total_stake", "stake_a", "stake_b", "stake_c", "payout_a", "payout_b", "payout_c", "avg_payout", "payout_spread", "grouped_odds_from_100_stake",
    ]
    write_csv(out / "grouped_odds_math_audit.csv", sample_source, fields)

    # Full mismatch exports, capped to keep artifact useful.
    mismatch_rows = []
    for r in rows:
        if r.get("recalc_p2_cluster_odds") and r.get("saved_p2_cluster_odds") and r.get("p2_diff") is not None and r["p2_diff"] > 0.001:
            item = audit_row(r, "P2", args.stake)
            item["sample_group"] = "p2_mismatch"
            mismatch_rows.append(item)
        if r.get("recalc_p1_cluster_odds") and r.get("saved_p1_cluster_odds") and r.get("p1_diff") is not None and r["p1_diff"] > 0.001:
            item = audit_row(r, "P1", args.stake)
            item["sample_group"] = "p1_mismatch"
            mismatch_rows.append(item)
        if len(mismatch_rows) >= 1000:
            break
    write_csv(out / "grouped_odds_mismatches.csv", mismatch_rows, fields)

    def count_bad(valid_rows: List[Dict], side: str) -> int:
        key = "p2_diff" if side == "P2" else "p1_diff"
        return sum(1 for r in valid_rows if r.get(key) is not None and r[key] > 0.001)

    def avg(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None

    summary = {
        "wide_rows_total": len(rows),
        "p2_rows_with_all_three_scores": len(p2_valid),
        "p1_rows_with_all_three_scores": len(p1_valid),
        "p2_rows_with_saved_grouped_odds": sum(1 for r in p2_valid if r.get("saved_p2_cluster_odds")),
        "p1_rows_with_saved_grouped_odds": sum(1 for r in p1_valid if r.get("saved_p1_cluster_odds")),
        "p2_mismatches_gt_0_001": count_bad(p2_valid, "P2"),
        "p1_mismatches_gt_0_001": count_bad(p1_valid, "P1"),
        "p2_max_diff": max([r.get("p2_diff") or 0 for r in p2_valid], default=0),
        "p1_max_diff": max([r.get("p1_diff") or 0 for r in p1_valid], default=0),
        "p2_avg_diff": avg([r.get("p2_diff") for r in p2_valid]),
        "p1_avg_diff": avg([r.get("p1_diff") for r in p1_valid]),
        "p2_v3_trigger_rows": len(p2_v3),
        "p2_v3_gate_305_rows": len(p2_gate),
        "market_names_seen": sorted({clean(r.get("market_name")) for r in rows if clean(r.get("market_name"))})[:50],
        "sample_size_per_group": args.sample_size,
        "stake_used_for_dutching": args.stake,
    }
    (out / "grouped_odds_validation_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    verdict = "PASS" if summary["p2_mismatches_gt_0_001"] == 0 and summary["p1_mismatches_gt_0_001"] == 0 else "REVIEW"
    lines = [
        "# Grouped Odds Validation Audit",
        "",
        f"Verdict: {verdict}",
        "",
        "## Formula checked",
        "P2 grouped = 1 / (1/odds_3_6 + 1/odds_4_6 + 1/odds_5_7)",
        "P1 grouped = 1 / (1/odds_6_3 + 1/odds_6_4 + 1/odds_7_5)",
        "",
        "## Summary",
        f"Wide rows total: {summary['wide_rows_total']}",
        f"P2 rows with all three scores: {summary['p2_rows_with_all_three_scores']}",
        f"P1 rows with all three scores: {summary['p1_rows_with_all_three_scores']}",
        f"P2 mismatches > 0.001: {summary['p2_mismatches_gt_0_001']}",
        f"P1 mismatches > 0.001: {summary['p1_mismatches_gt_0_001']}",
        f"P2 max diff: {summary['p2_max_diff']}",
        f"P1 max diff: {summary['p1_max_diff']}",
        f"P2 V3 trigger rows: {summary['p2_v3_trigger_rows']}",
        f"P2 V3 gate >= 3.05 rows: {summary['p2_v3_gate_305_rows']}",
        "",
        "## What to inspect",
        "Open grouped_odds_math_audit.csv and confirm each sampled row uses the same event_key, bookmaker, market_name, and the exact three score odds for the side.",
        "The $100 dutching columns should show nearly equal payouts across all three outcomes.",
    ]
    (out / "grouped_odds_validation_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
