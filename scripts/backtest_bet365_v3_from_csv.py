#!/usr/bin/env python3
"""Backtest SlipIQ V3 from confirmed bet365 OddsPortal scraper CSV."""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import time
from pathlib import Path
from typing import Any


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


def to_bool(value: Any) -> bool:
    return str(value).strip().lower() in ("true", "1", "yes", "y")


def calc_drawdown(equity_points: list[float]) -> float:
    peak = 0.0
    max_dd = 0.0
    for equity in equity_points:
        peak = max(peak, equity)
        max_dd = min(max_dd, equity - peak)
    return round(max_dd, 2)


def trade_rows(rows: list[dict[str, str]], side: str, stake: float, min_confirmed: int) -> list[dict[str, Any]]:
    if side == "p2":
        odds_key = "p2_grouped_9_12"
        hit_key = "p2_v3_hit"
    elif side == "p1":
        odds_key = "p1_grouped_9_12"
        hit_key = "p1_hit"
    else:
        raise ValueError("side must be p1 or p2")

    trades: list[dict[str, Any]] = []
    equity = 0.0
    for i, row in enumerate(rows, start=1):
        confirmed = int(to_float(row.get("bet365_confirmed_count")) or 0)
        odds = to_float(row.get(odds_key))
        if confirmed < min_confirmed or odds is None or odds <= 1:
            continue
        hit = to_bool(row.get(hit_key))
        profit = round(stake * (odds - 1), 2) if hit else -stake
        equity = round(equity + profit, 2)
        trades.append(
            {
                "trade_id": len(trades) + 1,
                "side": side,
                "match_name": row.get("match_name") or row.get("title") or "",
                "market_url": row.get("market_url") or row.get("input_url") or "",
                "first_set_score": row.get("first_set_score") or "",
                "odds": odds,
                "stake": stake,
                "hit": hit,
                "profit": profit,
                "equity": equity,
                "bet365_confirmed_count": confirmed,
                "status": row.get("status") or "",
            }
        )
    return trades


def summarize(trades: list[dict[str, Any]], stake: float) -> dict[str, Any]:
    if not trades:
        return {
            "bets": 0,
            "wins": 0,
            "losses": 0,
            "hit_rate": None,
            "avg_odds": None,
            "total_staked": 0,
            "profit": 0,
            "roi": None,
            "max_drawdown": 0,
        }
    bets = len(trades)
    wins = sum(1 for t in trades if t["hit"])
    profit = round(sum(float(t["profit"]) for t in trades), 2)
    total_staked = round(bets * stake, 2)
    equity_points = [float(t["equity"]) for t in trades]
    return {
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": round(wins / bets, 4),
        "avg_odds": round(statistics.mean(float(t["odds"]) for t in trades), 4),
        "total_staked": total_staked,
        "profit": profit,
        "roi": round(profit / total_staked, 4) if total_staked else None,
        "max_drawdown": calc_drawdown(equity_points),
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

    rows: list[dict[str, str]] = []
    with in_path.open("r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    p2_trades = trade_rows(rows, "p2", args.stake, args.min_confirmed_p2)
    p1_trades = trade_rows(rows, "p1", args.stake, args.min_confirmed_p1)
    all_trades = p2_trades + p1_trades

    summary = {
        "generated_at": now_iso(),
        "input_csv": str(in_path),
        "stake": args.stake,
        "source_rows": len(rows),
        "p2": summarize(p2_trades, args.stake),
        "p1": summarize(p1_trades, args.stake),
        "notes": [
            "P2 uses 3:6, 4:6, 5:7 grouped odds and requires min-confirmed-p2 score rows.",
            "P1 uses 6:3, 6:4, 7:5 grouped odds and defaults to all 6 scores confirmed.",
            "This is a historical-pricing backtest, not betting advice.",
        ],
    }

    trades_path = out_dir / "backtest_trades.csv"
    if all_trades:
        with trades_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(all_trades[0].keys()))
            writer.writeheader()
            writer.writerows(all_trades)
    else:
        with trades_path.open("w", newline="", encoding="utf-8") as f:
            f.write("trade_id,side,match_name,market_url,first_set_score,odds,stake,hit,profit,equity,bet365_confirmed_count,status\n")

    summary_path = out_dir / "backtest_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
