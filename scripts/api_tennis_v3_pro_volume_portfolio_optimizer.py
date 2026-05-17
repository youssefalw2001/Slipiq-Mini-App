#!/usr/bin/env python3
"""SlipIQ V3 Pro Volume Portfolio Optimizer.

Consumes v3_pro_signal_candidates.csv from the V3 Pro artifact and searches for
higher-volume portfolios by mixing:
- P1 mirror and P2 V3
- bet365 only, bet365 + 1xBet, bet365 + 10Bet, 1xBet + bet365 + 10Bet
- ATP/WTA/all tours
- tournament groups
- score thresholds
- daily caps
- bookmaker rows vs one pick per match

This does NOT change production filters. It tests candidate filters/portfolios.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BOOK_GROUPS = {
    "bet365_only": {"bet365"},
    "bet365_1xBet": {"bet365", "1xBet"},
    "bet365_10Bet": {"bet365", "10Bet"},
    "bet365_1xBet_10Bet": {"bet365", "1xBet", "10Bet"},
    "10Bet_only": {"10Bet"},
    "1xBet_only": {"1xBet"},
    "all_books": None,
}

FAMILY_GROUPS = {
    "P1_ONLY": {"P1_MIRROR_9_12"},
    "P2_ONLY": {"P2_V3_9_12"},
    "P1_PLUS_P2": {"P1_MIRROR_9_12", "P2_V3_9_12"},
}

DAILY_CAPS = [0, 3, 5, 10, 15]
DEFAULT_THRESHOLDS = [35, 40, 41.48, 45, 50, 55, 60, 66, 70, 75, 80, 85, 90]


def clean(x) -> str:
    return str(x or "").strip()


def fnum(x) -> Optional[float]:
    try:
        if x is None or clean(x) == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def bval(x) -> bool:
    return clean(x).lower() in {"true", "1", "yes", "y"}


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def parse_candidate(raw: Dict) -> Dict:
    r = dict(raw)
    for k in ["event_key", "event_date", "bookmaker", "family", "side", "scores", "tour", "tournament_group", "surface", "first_set_score"]:
        r[k] = clean(r.get(k))
    r["bet_odds"] = fnum(r.get("bet_odds"))
    r["v3_pro_score"] = fnum(r.get("v3_pro_score")) or 0.0
    r["won"] = bval(r.get("won"))
    try:
        r["ts"] = datetime.fromisoformat((r.get("event_date") or "1900-01-01") + "T00:00:00").timestamp()
    except Exception:
        r["ts"] = 0
    return r


def split_train_test(rows: List[Dict], train_ratio: float) -> Tuple[set, set, str]:
    dates = sorted({r.get("event_date") for r in rows if r.get("event_date")})
    if len(dates) < 3:
        return set(dates), set(), dates[-1] if dates else ""
    idx = max(1, min(len(dates) - 1, int(len(dates) * train_ratio)))
    cutoff = dates[idx]
    train = {d for d in dates if d < cutoff}
    test = {d for d in dates if d >= cutoff}
    return train, test, cutoff


def dedupe_mode(rows: List[Dict], mode: str) -> List[Dict]:
    if mode == "BOOKMAKER_ROWS":
        seen = set()
        out = []
        for r in sorted(rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""), x.get("family", ""))):
            key = (r.get("event_key"), r.get("bookmaker"), r.get("family"))
            if key in seen:
                continue
            seen.add(key)
            out.append(r)
        return out
    if mode == "ONE_PICK_PER_MATCH":
        groups = defaultdict(list)
        for r in rows:
            groups[r.get("event_key")].append(r)
        return [max(v, key=lambda x: (x.get("v3_pro_score") or 0, x.get("bet_odds") or 0)) for v in groups.values()]
    if mode == "ONE_PICK_PER_MATCH_PER_SIDE":
        groups = defaultdict(list)
        for r in rows:
            groups[(r.get("event_key"), r.get("family"))].append(r)
        return [max(v, key=lambda x: (x.get("v3_pro_score") or 0, x.get("bet_odds") or 0)) for v in groups.values()]
    return rows


def apply_daily_cap(rows: List[Dict], cap: int) -> List[Dict]:
    if cap <= 0:
        return rows
    by_day = defaultdict(list)
    for r in rows:
        by_day[r.get("event_date")].append(r)
    out = []
    for day in sorted(by_day):
        ranked = sorted(by_day[day], key=lambda x: (x.get("v3_pro_score") or 0, x.get("bet_odds") or 0), reverse=True)
        used_event_side = set()
        keep = []
        for r in ranked:
            # Avoid duplicate rows from same event/family when daily capped.
            key = (r.get("event_key"), r.get("family"))
            if key in used_event_side:
                continue
            used_event_side.add(key)
            keep.append(r)
            if len(keep) >= cap:
                break
        out.extend(keep)
    return out


def metrics(rows: List[Dict], start_bankroll: float, risk_pct: float) -> Dict:
    rows = [r for r in rows if r.get("bet_odds") and r["bet_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    avg_odds = sum(r["bet_odds"] for r in rows) / bets if bets else None
    units = sum((r["bet_odds"] - 1) if r.get("won") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    month_pl = defaultdict(float)
    family_counts = defaultdict(int)
    book_counts = defaultdict(int)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            month_pl[month] += (r["bet_odds"] - 1) if r.get("won") else -1
        family_counts[r.get("family") or "missing"] += 1
        book_counts[r.get("bookmaker") or "missing"] += 1

    bank = start_bankroll
    peak = bank
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""))):
        stake = bank * risk_pct
        if r.get("won"):
            bank += stake * (r["bet_odds"] - 1)
            losing = 0
        else:
            bank -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bank)
        max_dd = max(max_dd, (peak - bank) / peak if peak else 0)

    hit = wins / bets if bets else None
    be = 1 / avg_odds if avg_odds else None
    return {
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": hit,
        "avg_odds": avg_odds,
        "breakeven_hit_rate": be,
        "edge_vs_breakeven": hit - be if hit is not None and be is not None else None,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "positive_months": sum(1 for v in month_pl.values() if v > 0),
        "positive_month_ratio": (sum(1 for v in month_pl.values() if v > 0) / len(months)) if months else None,
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": bank,
        "compound_profit": bank - start_bankroll,
        "compound_return_pct": ((bank / start_bankroll) - 1) * 100 if start_bankroll else None,
        "max_drawdown_pct": max_dd * 100,
        "worst_losing_streak": worst_losing,
        "family_mix": json.dumps(dict(sorted(family_counts.items()))),
        "book_mix": json.dumps(dict(sorted(book_counts.items()))),
    }


def portfolio_score(m_all: Dict, m_train: Dict, m_test: Dict, min_test_bets: int, min_volume_target: int) -> Tuple[float, str]:
    flags = []
    penalty = 0.0
    if m_all["bets"] < min_volume_target:
        penalty += 12
        flags.append("below_volume_target")
    if m_train["bets"] < min_test_bets or m_test["bets"] < min_test_bets:
        penalty += 50
        flags.append("low_train_or_test_volume")
    if (m_train.get("flat_roi") or 0) > 0 and (m_test.get("flat_roi") or 0) < 0:
        penalty += 40
        flags.append("train_positive_test_negative")
    if abs((m_train.get("flat_roi") or 0) - (m_test.get("flat_roi") or 0)) > 0.35:
        penalty += 12
        flags.append("unstable_train_test_roi")

    roi = m_all.get("flat_roi") or 0
    edge = m_all.get("edge_vs_breakeven") or 0
    volume = min(70, math.log10(max(m_all["bets"], 1)) * 25)
    hit_component = (m_all.get("hit_rate") or 0) * 30
    roi_component = roi * 110
    edge_component = edge * 220
    month_component = (m_all.get("positive_month_ratio") or 0) * 30
    dd_penalty = max(0, (m_all.get("max_drawdown_pct") or 0) - 25) * 0.50
    streak_penalty = max(0, (m_all.get("worst_losing_streak") or 0) - 12) * 0.80
    score = volume + hit_component + roi_component + edge_component + month_component - dd_penalty - streak_penalty - penalty
    return score, ";".join(flags)


def monthly_rows(rows: List[Dict], rule_id: str) -> List[Dict]:
    by = defaultdict(list)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            by[month].append(r)
    out = []
    for month, arr in sorted(by.items()):
        m = metrics(arr, 5000, 0.02)
        out.append({"rule_id": rule_id, "month": month, "bets": m["bets"], "wins": m["wins"], "hit_rate": m["hit_rate"], "avg_odds": m["avg_odds"], "flat_roi": m["flat_roi"], "flat_profit_units": m["flat_profit_units"]})
    return out


def daily_rows(rows: List[Dict], rule_id: str) -> List[Dict]:
    by = defaultdict(list)
    for r in rows:
        by[r.get("event_date")].append(r)
    out = []
    for day, arr in sorted(by.items()):
        out.append({"rule_id": rule_id, "event_date": day, "signals": len(arr), "wins": sum(1 for r in arr if r.get("won")), "avg_score": sum(r.get("v3_pro_score", 0) for r in arr) / len(arr) if arr else None, "avg_odds": sum(r.get("bet_odds", 0) for r in arr) / len(arr) if arr else None})
    return out


def bankroll_curve(rows: List[Dict], rule_id: str, start_bankroll: float, risk_pct: float) -> List[Dict]:
    bank = start_bankroll
    peak = bank
    out = []
    for idx, r in enumerate(sorted(rows, key=lambda x: (x.get("event_date", ""), x.get("event_key", ""), x.get("bookmaker", ""))), 1):
        stake = bank * risk_pct
        if r.get("won"):
            pnl = stake * (r["bet_odds"] - 1)
            bank += pnl
        else:
            pnl = -stake
            bank += pnl
        peak = max(peak, bank)
        out.append({"rule_id": rule_id, "risk_pct": risk_pct, "bet_index": idx, "event_date": r.get("event_date"), "event_key": r.get("event_key"), "bookmaker": r.get("bookmaker"), "family": r.get("family"), "bet_odds": r.get("bet_odds"), "v3_pro_score": r.get("v3_pro_score"), "won": str(bool(r.get("won"))).lower(), "stake": stake, "pnl": pnl, "bankroll": bank, "drawdown_pct": ((peak - bank) / peak * 100 if peak else 0)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-v3-pro-volume-portfolio-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--dream-risk-pct", type=float, default=0.04)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    ap.add_argument("--min-bets", type=int, default=100)
    ap.add_argument("--min-test-bets", type=int, default=20)
    ap.add_argument("--min-volume-target", type=int, default=300)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    candidates = [parse_candidate(r) for r in read_csv(Path(args.candidates))]
    candidates = [r for r in candidates if r.get("bet_odds") and r.get("v3_pro_score") is not None and r.get("family") in {"P1_MIRROR_9_12", "P2_V3_9_12"}]
    train_dates, test_dates, cutoff = split_train_test(candidates, args.train_ratio)

    thresholds = sorted(set(DEFAULT_THRESHOLDS + [round(r["v3_pro_score"], 2) for r in candidates if r["v3_pro_score"] >= 35]))
    thresholds = [t for t in thresholds if t >= 35]
    tours = ["ALL", "ATP", "WTA"]
    tournament_groups = ["ALL"] + sorted({r.get("tournament_group") for r in candidates if r.get("tournament_group")})
    modes = ["BOOKMAKER_ROWS", "ONE_PICK_PER_MATCH", "ONE_PICK_PER_MATCH_PER_SIDE"]

    results = []
    train_test = []
    monthly = []
    daily = []
    rules = []
    curves = []
    signal_mix = []
    rule_n = 0

    for family_group, allowed_families in FAMILY_GROUPS.items():
        fam_rows = [r for r in candidates if r.get("family") in allowed_families]
        if not fam_rows:
            continue
        for book_group, allowed_books in BOOK_GROUPS.items():
            book_rows = fam_rows if allowed_books is None else [r for r in fam_rows if r.get("bookmaker") in allowed_books]
            if not book_rows:
                continue
            for tour_name in tours:
                tour_rows = book_rows if tour_name == "ALL" else [r for r in book_rows if r.get("tour") == tour_name]
                if not tour_rows:
                    continue
                for tg in tournament_groups:
                    group_rows = tour_rows if tg == "ALL" else [r for r in tour_rows if r.get("tournament_group") == tg]
                    if not group_rows:
                        continue
                    for threshold in thresholds:
                        thresh_rows = [r for r in group_rows if (r.get("v3_pro_score") or 0) >= threshold]
                        if len(thresh_rows) < args.min_test_bets:
                            continue
                        for mode in modes:
                            mode_rows = dedupe_mode(thresh_rows, mode)
                            if len(mode_rows) < args.min_test_bets:
                                continue
                            for cap in DAILY_CAPS:
                                rows = apply_daily_cap(mode_rows, cap)
                                if len(rows) < args.min_test_bets:
                                    continue
                                rule_n += 1
                                rule_id = f"VOL{rule_n:06d}"
                                train_rows = [r for r in rows if r.get("event_date") in train_dates]
                                test_rows = [r for r in rows if r.get("event_date") in test_dates]
                                m_all = metrics(rows, args.start_bankroll, args.risk_pct)
                                m_train = metrics(train_rows, args.start_bankroll, args.risk_pct)
                                m_test = metrics(test_rows, args.start_bankroll, args.risk_pct)
                                score, flags = portfolio_score(m_all, m_train, m_test, args.min_test_bets, args.min_volume_target)
                                base = {"rule_id": rule_id, "family_group": family_group, "book_group": book_group, "tour": tour_name, "tournament_group": tg, "mode": mode, "score_threshold": threshold, "daily_cap": cap, "strategy_score": score, "overfit_flags": flags, "split_cutoff_date": cutoff}
                                result = {**base, **m_all}
                                results.append(result)
                                train_test.append({**base, "split": "ALL", **m_all})
                                train_test.append({**base, "split": "TRAIN", **m_train})
                                train_test.append({**base, "split": "TEST", **m_test})
                                rules.append({**base, "rule_description": f"{family_group} | {book_group} | {tour_name} | {tg} | {mode} | score>={threshold} | cap={cap}"})
                                if m_all["bets"] >= args.min_bets:
                                    monthly.extend(monthly_rows(rows, rule_id))
                                    daily.extend(daily_rows(rows, rule_id))
                                    signal_mix.append({"rule_id": rule_id, "family_mix": m_all["family_mix"], "book_mix": m_all["book_mix"]})
                                if len(curves) < 6000 and m_all["bets"] >= args.min_bets and score > 85:
                                    curves.extend(bankroll_curve(rows, rule_id, args.start_bankroll, args.risk_pct)[:500])
                                    curves.extend(bankroll_curve(rows, rule_id, args.start_bankroll, args.dream_risk_pct)[:500])

    fields = ["rule_id", "strategy_score", "overfit_flags", "family_group", "book_group", "tour", "tournament_group", "mode", "score_threshold", "daily_cap", "bets", "wins", "losses", "hit_rate", "avg_odds", "breakeven_hit_rate", "edge_vs_breakeven", "flat_profit_units", "flat_roi", "months", "positive_months", "positive_month_ratio", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak", "family_mix", "book_mix", "split_cutoff_date"]
    write_csv(out / "volume_portfolio_all_results.csv", results, fields)
    valid = [r for r in results if r.get("bets", 0) >= args.min_bets]
    leaderboard = sorted(valid, key=lambda r: (r.get("strategy_score") or -9999, r.get("bets") or 0, r.get("flat_roi") or -999), reverse=True)
    scalable = sorted([r for r in valid if r.get("bets", 0) >= args.min_volume_target], key=lambda r: (r.get("strategy_score") or -9999, r.get("flat_roi") or -999), reverse=True)
    high_volume = sorted(valid, key=lambda r: (r.get("bets") or 0, r.get("flat_roi") or -999), reverse=True)
    high_roi = sorted(valid, key=lambda r: (r.get("flat_roi") or -999, r.get("bets") or 0), reverse=True)

    write_csv(out / "volume_portfolio_leaderboard.csv", leaderboard[:1000], fields)
    write_csv(out / "volume_portfolio_scalable.csv", scalable[:1000], fields)
    write_csv(out / "volume_portfolio_high_volume.csv", high_volume[:1000], fields)
    write_csv(out / "volume_portfolio_high_roi.csv", high_roi[:1000], fields)
    write_csv(out / "volume_portfolio_train_test.csv", train_test, ["split"] + fields)
    write_csv(out / "volume_portfolio_monthly.csv", monthly, ["rule_id", "month", "bets", "wins", "hit_rate", "avg_odds", "flat_roi", "flat_profit_units"])
    write_csv(out / "volume_portfolio_daily_counts.csv", daily, ["rule_id", "event_date", "signals", "wins", "avg_score", "avg_odds"])
    write_csv(out / "volume_portfolio_signal_mix.csv", signal_mix, ["rule_id", "family_mix", "book_mix"])
    write_csv(out / "volume_portfolio_candidate_rules.csv", rules, ["rule_id", "family_group", "book_group", "tour", "tournament_group", "mode", "score_threshold", "daily_cap", "strategy_score", "overfit_flags", "split_cutoff_date", "rule_description"])
    write_csv(out / "volume_portfolio_bankroll_curves.csv", curves, ["rule_id", "risk_pct", "bet_index", "event_date", "event_key", "bookmaker", "family", "bet_odds", "v3_pro_score", "won", "stake", "pnl", "bankroll", "drawdown_pct"])

    cards = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "split_cutoff_date": cutoff,
        "candidate_rows": len(candidates),
        "rules_tested": len(results),
        "min_bets": args.min_bets,
        "min_volume_target": args.min_volume_target,
        "best_overall": leaderboard[0] if leaderboard else None,
        "best_scalable": scalable[0] if scalable else None,
        "highest_volume_positive": next((r for r in high_volume if (r.get("flat_roi") or 0) > 0 and not r.get("overfit_flags")), None),
        "best_bet365_only": next((r for r in leaderboard if r["book_group"] == "bet365_only"), None),
        "best_bet365_1xBet": next((r for r in leaderboard if r["book_group"] == "bet365_1xBet"), None),
        "best_bet365_10Bet": next((r for r in leaderboard if r["book_group"] == "bet365_10Bet"), None),
        "best_three_book": next((r for r in leaderboard if r["book_group"] == "bet365_1xBet_10Bet"), None),
        "best_p1_plus_p2": next((r for r in leaderboard if r["family_group"] == "P1_PLUS_P2"), None),
        "top_25": leaderboard[:25],
    }
    (out / "volume_portfolio_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")

    funnel = {
        "candidate_rows": len(candidates),
        "p1_candidates": sum(1 for r in candidates if r.get("family") == "P1_MIRROR_9_12"),
        "p2_candidates": sum(1 for r in candidates if r.get("family") == "P2_V3_9_12"),
        "rules_tested": len(results),
        "leaderboard_min_bets": args.min_bets,
        "min_volume_target": args.min_volume_target,
        "split_cutoff_date": cutoff,
    }
    (out / "volume_portfolio_funnel.json").write_text(json.dumps(funnel, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"

    lines = [
        "# V3 Pro Volume Portfolio Optimizer",
        "",
        "This workflow does not change production filters. It tests portfolio filters that mix P1 mirror and P2 V3 for higher volume.",
        "",
        "## Funnel",
        f"Candidate rows: {funnel['candidate_rows']}",
        f"P1 mirror candidates: {funnel['p1_candidates']}",
        f"P2 V3 candidates: {funnel['p2_candidates']}",
        f"Rules tested: {funnel['rules_tested']}",
        f"Train/test cutoff: {cutoff}",
        "",
        f"## Top volume portfolio strategies, min {args.min_bets} bets",
    ]
    for i, r in enumerate(leaderboard[:40], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} score={r['strategy_score']:.1f} {r['family_group']} {r['book_group']} {r['tour']} {r['tournament_group']} {r['mode']} score>={r['score_threshold']} cap={r['daily_cap']}: bets={r['bets']}, wins={r['wins']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, edge={pct(r['edge_vs_breakeven'])}, final={money(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}, flags={r['overfit_flags']}")
    lines += ["", f"## Best scalable strategies, min {args.min_volume_target} bets"]
    for i, r in enumerate(scalable[:25], 1):
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. {r['rule_id']} {r['family_group']} {r['book_group']} {r['tour']} {r['tournament_group']} score>={r['score_threshold']} cap={r['daily_cap']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, score={r['strategy_score']:.1f}, flags={r['overfit_flags']}")
    lines += ["", "## Highest-volume positive/no-flag candidates"]
    count = 0
    for r in high_volume:
        if (r.get("flat_roi") or 0) <= 0 or r.get("overfit_flags"):
            continue
        count += 1
        avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{count}. {r['rule_id']} {r['family_group']} {r['book_group']} {r['tour']} {r['tournament_group']} cap={r['daily_cap']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={avg}, ROI={pct(r['flat_roi'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
        if count >= 25:
            break
    lines.append("\nInterpretation: use this to choose the production filter later. A good volume model should have high bets, positive train/test, decent positive-month ratio, and no overfit flags.")
    (out / "volume_portfolio_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
