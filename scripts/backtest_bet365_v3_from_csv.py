#!/usr/bin/env python3
"""Backtest SlipIQ V3 from confirmed bet365 OddsPortal scraper CSV.

Safety guards:
- only status=ok rows are eligible
- if odds_status/result_status columns exist, both must be ok
- duplicate market_url rows are ignored
- missing/non-standard first-set score rows are ignored
- missing grouped odds are ignored

This prevents route-memory or odds-only rows from producing fake results.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import time
from pathlib import Path
from typing import Any

VALID_V3_P2 = {"3:6", "4:6", "5:7"}
VALID_V3_P1 = {"6:3", "6:4", "7:5"}
VALID_SET_SCORES = {
    "6:0", "6:1", "6:2", "6:3", "6:4", "7:5", "7:6",
    "0:6", "1:6", "2:6", "3:6", "4:6", "5:7", "6:7",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def to_float(value: Any) -> float | None:
    try:
        if value in (None, "", "None", "nan"):
            return None
        v = float(value)
        if math.isnan(v):
            return None
        return v
    except Exception:
        return None


def normalize_score(value: Any) -> str:
    return str(value or "").strip().replace("-", ":").replace(" ", "")


def calc_drawdown(equity_points: list[float]) -> float:
    peak = 0.0
    max_dd = 0.0
    for equity in equity_points:
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return round(max_dd, 2)


def tier_for_odds(odds: float | None) -> str:
    if odds is None:
        return "NO_ODDS"
    if odds >= 4.0:
        return "S"
    if odds >= 3.5:
        return "A"
    if odds >= 3.3:
        return "B_WATCH"
    return "C_SKIP"


def is_row_eligible(row: dict[str, str], side: str, min_confirmed: int, seen_urls: set[str]) -> tuple[bool, str]:
    status = str(row.get("status") or "").strip().lower()
    if status != "ok":
        return False, f"bad_status:{status or 'missing'}"
    odds_status = str(row.get("odds_status") or "").strip().lower()
    result_status = str(row.get("result_status") or "").strip().lower()
    if odds_status and odds_status != "ok":
        return False, f"bad_odds_status:{odds_status}"
    if result_status and result_status != "ok":
        return False, f"bad_result_status:{result_status}"
    market_url = row.get("market_url") or row.get("input_url") or ""
    if not market_url:
        return False, "missing_market_url"
    if market_url in seen_urls:
        return False, "duplicate_market_url"
    first_set_score = normalize_score(row.get("first_set_score"))
    if first_set_score not in VALID_SET_SCORES:
        return False, "missing_or_nonstandard_first_set_score"
    confirmed = int(to_float(row.get("bet365_confirmed_count")) or 0)
    if confirmed < min_confirmed:
        return False, "not_enough_confirmed_prices"
    odds_key = "p2_grouped_9_12" if side == "p2" else "p1_grouped_9_12"
    odds = to_float(row.get(odds_key))
    if odds is None or odds <= 1:
        return False, "missing_grouped_odds"
    return True, "eligible"


def trade_rows(rows: list[dict[str, str]], side: str, stake: float, min_confirmed: int) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if side == "p2":
        odds_key = "p2_grouped_9_12"
        win_scores = VALID_V3_P2
    elif side == "p1":
        odds_key = "p1_grouped_9_12"
        win_scores = VALID_V3_P1
    else:
        raise ValueError("side must be p1 or p2")

    trades: list[dict[str, Any]] = []
    skip_counts: dict[str, int] = {}
    equity = 0.0
    seen_urls: set[str] = set()
    for row in rows:
        eligible, reason = is_row_eligible(row, side, min_confirmed, seen_urls)
        if not eligible:
            skip_counts[reason] = skip_counts.get(reason, 0) + 1
            continue
        market_url = row.get("market_url") or row.get("input_url") or ""
        seen_urls.add(market_url)
        odds = to_float(row.get(odds_key))
        first_set_score = normalize_score(row.get("first_set_score"))
        hit = first_set_score in win_scores
        profit = round(stake * (float(odds) - 1), 2) if hit else -stake
        equity = round(equity + profit, 2)
        trades.append(
            {
                "trade_id": len(trades) + 1,
                "side": side,
                "match_name": row.get("match_name") or row.get("title") or "",
                "market_url": market_url,
                "first_set_score": first_set_score,
                "odds": odds,
                "tier": tier_for_odds(odds),
                "stake": stake,
                "hit": hit,
                "profit": profit,
                "equity": equity,
                "bet365_confirmed_count": int(to_float(row.get("bet365_confirmed_count")) or 0),
                "status": row.get("status") or "",
                "odds_status": row.get("odds_status") or "",
                "result_status": row.get("result_status") or "",
            }
        )
    return trades, skip_counts


def summarize(trades: list[dict[str, Any]], stake: float) -> dict[str, Any]:
    if not trades:
        return {
            "bets": 0,
            "wins": 0,
            "losses": 0,
            "hit_rate": None,
            "avg_odds": None,
            "break_even_hit_rate": None,
            "total_staked": 0,
            "profit": 0,
            "roi": None,
            "max_drawdown": 0,
            "tier_counts": {},
        }
    bets = len(trades)
    wins = sum(1 for t in trades if t["hit"])
    profit = round(sum(float(t["profit"]) for t in trades), 2)
    total_staked = round(bets * stake, 2)
    avg_odds = statistics.mean(float(t["odds"]) for t in trades)
    equity_points = [float(t["equity"]) for t in trades]
    tier_counts: dict[str, int] = {}
    for t in trades:
        tier_counts[t["tier"]] = tier_counts.get(t["tier"], 0) + 1
    return {
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": round(wins / bets, 4),
        "avg_odds": round(avg_odds, 4),
        "break_even_hit_rate": round(1 / avg_odds, 4) if avg_odds > 0 else None,
        "total_staked": total_staked,
        "profit": profit,
        "roi": round(profit / total_staked, 4) if total_staked else None,
        "max_drawdown": calc_drawdown(equity_points),
        "tier_counts": tier_counts,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--out", default="artifacts/output/bet365-v3-backtest")
    parser.add_argument("--stake", type=float, default=100.0)
    parser.add_argument("--min-confirmed-p2", type=int, default=3)
    parser.add_argument("--min-confirmed-p1", type=int, default=6)
    args = parser.parse_args()

    in_path = Path(args.csv)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    with in_path.open("r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    p2_trades, p2_skips = trade_rows(rows, "p2", args.stake, args.min_confirmed_p2)
    p1_trades, p1_skips = trade_rows(rows, "p1", args.stake, args.min_confirmed_p1)
    all_trades = p2_trades + p1_trades

    summary = {
        "generated_at": now_iso(),
        "input_csv": str(in_path),
        "stake": args.stake,
        "source_rows": len(rows),
        "eligible_rows_note": "Eligibility requires status=ok, odds_status ok if present, result_status ok if present, unique market_url, standard first_set_score, confirmed prices, and grouped odds.",
        "p2": summarize(p2_trades, args.stake),
        "p2_skip_counts": p2_skips,
        "p1": summarize(p1_trades, args.stake),
        "p1_skip_counts": p1_skips,
        "notes": [
            "P2 uses 3:6, 4:6, 5:7 grouped odds and requires min-confirmed-p2 score rows.",
            "P1 uses 6:3, 6:4, 7:5 grouped odds and defaults to all 6 scores confirmed.",
            "Odds-only rows and result-needs rows are ignored to prevent fake settlement.",
            "This is a historical-pricing backtest, not betting advice.",
        ],
    }

    trades_path = out_dir / "backtest_trades.csv"
    fields = ["trade_id", "side", "match_name", "market_url", "first_set_score", "odds", "tier", "stake", "hit", "profit", "equity", "bet365_confirmed_count", "status", "odds_status", "result_status"]
    with trades_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for trade in all_trades:
            writer.writerow({k: trade.get(k, "") for k in fields})

    summary_path = out_dir / "backtest_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
