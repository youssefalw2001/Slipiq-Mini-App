#!/usr/bin/env python3
"""SlipIQ API-Tennis 9-12 confidence optimizer.

Runs on the same settled-only historical odds warehouse used by:
  scripts/api_tennis_9_12_cluster_settled_optimizer.py

Purpose:
- Build a pre-result confidence score for 9-12 clusters.
- Test whether 60+, 70+, 80+, and 90+ confidence filters improve ROI/drawdown.
- Keep the system auditable: confidence is a quality score, not a guarantee.

Strategy universe:
P1 9-12 cluster = 6:3 / 6:4 / 7:5
P2 9-12 cluster = 3:6 / 4:6 / 5:7
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from collections import defaultdict
from datetime import datetime
from pathlib import Path

P1_SCORES = {"6:3", "6:4", "7:5"}
P2_SCORES = {"3:6", "4:6", "5:7"}
EVENT_TYPE_TOUR = {"265": "ATP", "266": "WTA"}


def clean(x):
    return str(x or "").strip()


def fnum(x):
    try:
        if x is None or str(x).strip() == "":
            return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def grouped(vals):
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums):
        return None
    imp = sum(1 / v for v in nums)
    return 1 / imp if imp else None


def tour(row):
    k = clean(row.get("event_type_key"))
    if k in EVENT_TYPE_TOUR:
        return EVENT_TYPE_TOUR[k]
    s = f"{row.get('event_type_type','')} {row.get('tournament_name','')}".lower()
    if "wta" in s or "women" in s:
        return "WTA"
    if "atp" in s or "men" in s:
        return "ATP"
    return "UNKNOWN"


def tgroup(row):
    t = clean(row.get("tournament_name")).lower()
    if any(k in t for k in ["australian open", "roland garros", "french open", "wimbledon", "us open"]):
        return "GRAND_SLAM"
    if any(k in t for k in ["indian wells", "miami", "monte carlo", "madrid", "rome", "italian open", "canada", "canadian open", "toronto", "montreal", "cincinnati", "shanghai", "paris", "beijing", "wuhan", "doha", "dubai", "qatar open"]):
        return "MASTERS_1000"
    if any(k in t for k in ["barcelona", "halle", "queen", "queens", "london", "stuttgart", "charleston", "washington", "hamburg", "tokyo", "acapulco", "eastbourne", "rotterdam", "basel", "vienna", "adelaide", "brisbane", "bad homburg", "berlin", "strasbourg", "antwerp", "dallas", "rio", "astana", "chengdu", "zhuhai", "seoul"]):
        return "STRONG_500_250"
    return "OTHER_TOUR"


def read_csv(path):
    with Path(path).open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path, rows, fields):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def fav_bucket(odds):
    if odds is None:
        return "unknown"
    if odds < 1.35:
        return "strong_favorite"
    if odds < 1.65:
        return "favorite"
    if odds < 1.95:
        return "slight_favorite"
    return "near_even"


def side_bucket(side, fav_side, bucket):
    if fav_side in {"", "unknown", None} or bucket in {"", "unknown", None}:
        return "unknown"
    if fav_side == "EVEN":
        return "near_even"
    if side == fav_side:
        return bucket
    return {
        "near_even": "near_even",
        "slight_favorite": "slight_underdog",
        "favorite": "underdog",
        "strong_favorite": "strong_underdog",
    }.get(bucket, "unknown")


def norm_ml(raw):
    r = dict(raw)
    r["event_key"] = clean(r.get("event_key"))
    r["bookmaker"] = clean(r.get("bookmaker"))
    r["market_name"] = clean(r.get("market_name"))
    p1 = fnum(r.get("moneyline_p1"))
    p2 = fnum(r.get("moneyline_p2"))
    if p1 and p2:
        if p1 < p2:
            fs, fo = "P1", p1
        elif p2 < p1:
            fs, fo = "P2", p2
        else:
            fs, fo = "EVEN", p1
    else:
        fs, fo = clean(r.get("favorite_side")) or "unknown", fnum(r.get("favorite_odds"))
    r["moneyline_p1"] = p1
    r["moneyline_p2"] = p2
    r["favorite_side"] = fs
    r["favorite_odds"] = fo
    r["favorite_bucket"] = clean(r.get("favorite_bucket")) or fav_bucket(fo)
    r["kind"] = "first_set" if "1st Set" in r["market_name"] or "First Set" in r["market_name"] else "match"
    return r


def ml_maps(rows):
    first, match, markets = {}, {}, defaultdict(int)
    for raw in rows:
        r = norm_ml(raw)
        if not r["event_key"] or not r["bookmaker"]:
            continue
        key = (r["event_key"], r["bookmaker"])
        markets[r["market_name"]] += 1
        if r["kind"] == "first_set":
            if key not in first or r["market_name"].lower() == "home/away (1st set)":
                first[key] = r
        else:
            if key not in match or r["market_name"].lower() == "home/away":
                match[key] = r
    return first, match, dict(markets)


def normalize_wide(raw):
    r = dict(raw)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tournament_name", "event_type_type", "first_set_score"]:
        r[k] = clean(r.get(k))
    r["event_time"] = r["event_time"] or "00:00"
    for k in ["odds_6_3", "odds_6_4", "odds_7_5", "odds_3_6", "odds_4_6", "odds_5_7"]:
        r[k] = fnum(r.get(k))
    r["tour"] = tour(r)
    r["tournament_group"] = tgroup(r)
    r["p1_cluster_odds"] = fnum(r.get("p1_cluster_odds")) or grouped([r["odds_6_3"], r["odds_6_4"], r["odds_7_5"]])
    r["p2_cluster_odds"] = fnum(r.get("p2_cluster_odds")) or grouped([r["odds_3_6"], r["odds_4_6"], r["odds_5_7"]])
    try:
        dt = f"{r['event_date']}T{r['event_time'] if len(r['event_time']) != 5 else r['event_time'] + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        r["ts"] = 0
    return r


def confidence_bucket(score):
    if score >= 90:
        return "90_100_quant_grade"
    if score >= 80:
        return "80_89_s_confidence"
    if score >= 70:
        return "70_79_a_confidence"
    if score >= 60:
        return "60_69_watchlist"
    return "00_59_research_only"


def confidence_label(score):
    if score >= 90:
        return "Quant Grade"
    if score >= 80:
        return "S Confidence"
    if score >= 70:
        return "A Confidence"
    if score >= 60:
        return "Watchlist"
    return "Research Only"


def clip(v, lo, hi):
    return max(lo, min(hi, v))


def confidence_score(row):
    """Pre-result quality score. Uses market shape only, never the result."""
    score = 50.0

    # Book reliability: current production is Bet365-first.
    book = row.get("bookmaker", "")
    if book == "bet365":
        score += 12
    elif book == "10Bet":
        score += 4
    elif book == "1xBet":
        score -= 4
    else:
        score -= 2

    # Known 9-12 cluster sweet spot from current optimizer.
    cluster_odds = row.get("cluster_odds")
    middle_score_odds = row.get("middle_score_odds")
    if cluster_odds:
        if 3.0 <= cluster_odds < 3.5:
            score += 14
        elif 2.75 <= cluster_odds < 3.75:
            score += 8
        elif 2.4 <= cluster_odds < 4.25:
            score += 3
        else:
            score -= 8
    if middle_score_odds:
        if 7.0 <= middle_score_odds <= 9.0:
            score += 12
        elif 6.25 <= middle_score_odds < 7.0:
            score += 6
        elif 5.5 <= middle_score_odds <= 10.5:
            score += 2
        else:
            score -= 8

    # Tour/tournament context.
    if row.get("tour") == "ATP":
        score += 5
    elif row.get("tour") == "WTA":
        score += 1
    else:
        score -= 4

    tg = row.get("tournament_group")
    if tg == "GRAND_SLAM":
        score += 7
    elif tg == "MASTERS_1000":
        score += 5
    elif tg == "STRONG_500_250":
        score += 3
    elif tg == "OTHER_TOUR":
        score += 0
    else:
        score -= 3

    # Moneyline context. Unknown context is penalized because the setup is less explainable.
    fs_bucket = row.get("first_set_side_bucket", "unknown")
    match_bucket = row.get("match_side_bucket", "unknown")
    if fs_bucket == "favorite":
        score += 6
    elif fs_bucket == "slight_favorite":
        score += 5
    elif fs_bucket == "near_even":
        score += 3
    elif fs_bucket == "underdog":
        score -= 3
    elif fs_bucket == "strong_underdog":
        score -= 9
    elif fs_bucket == "unknown":
        score -= 6

    if match_bucket == "favorite":
        score += 3
    elif match_bucket == "slight_favorite":
        score += 3
    elif match_bucket == "near_even":
        score += 1
    elif match_bucket == "strong_underdog":
        score -= 6
    elif match_bucket == "unknown":
        score -= 4

    return int(round(clip(score, 0, 100)))


def candidates(wide, first_ml, match_ml):
    out = []
    for raw in wide:
        r = normalize_wide(raw)
        if not r["first_set_score"]:
            continue  # pending rows are excluded, not graded as losses
        key = (r["event_key"], r["bookmaker"])
        fs = first_ml.get(key, {})
        mt = match_ml.get(key, {})
        base = {
            "event_key": r["event_key"],
            "event_date": r["event_date"],
            "event_time": r["event_time"],
            "player1": r["player1"],
            "player2": r["player2"],
            "match_name": r["match_name"],
            "bookmaker": r["bookmaker"],
            "tour": r["tour"],
            "tournament_group": r["tournament_group"],
            "tournament_name": r["tournament_name"],
            "first_set_score": r["first_set_score"],
            "first_set_favorite_side": fs.get("favorite_side", "unknown"),
            "first_set_favorite_bucket": fs.get("favorite_bucket", "unknown"),
            "p1_first_set_moneyline": fs.get("moneyline_p1"),
            "p2_first_set_moneyline": fs.get("moneyline_p2"),
            "match_favorite_side": mt.get("favorite_side", "unknown"),
            "match_favorite_bucket": mt.get("favorite_bucket", "unknown"),
            "p1_match_moneyline": mt.get("moneyline_p1"),
            "p2_match_moneyline": mt.get("moneyline_p2"),
            "ts": r["ts"],
        }
        if r["p1_cluster_odds"] and r["odds_6_4"]:
            row = {
                **base,
                "side": "P1",
                "cluster_odds": r["p1_cluster_odds"],
                "middle_score": "6:4",
                "middle_score_odds": r["odds_6_4"],
                "side_cluster_win": r["first_set_score"] in P1_SCORES,
                "middle_score_win": r["first_set_score"] == "6:4",
                "first_set_side_bucket": side_bucket("P1", base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
                "match_side_bucket": side_bucket("P1", base["match_favorite_side"], base["match_favorite_bucket"]),
            }
            row["confidence_score"] = confidence_score(row)
            row["confidence_bucket"] = confidence_bucket(row["confidence_score"])
            row["confidence_label"] = confidence_label(row["confidence_score"])
            out.append(row)
        if r["p2_cluster_odds"] and r["odds_4_6"]:
            row = {
                **base,
                "side": "P2",
                "cluster_odds": r["p2_cluster_odds"],
                "middle_score": "4:6",
                "middle_score_odds": r["odds_4_6"],
                "side_cluster_win": r["first_set_score"] in P2_SCORES,
                "middle_score_win": r["first_set_score"] == "4:6",
                "first_set_side_bucket": side_bucket("P2", base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
                "match_side_bucket": side_bucket("P2", base["match_favorite_side"], base["match_favorite_bucket"]),
            }
            row["confidence_score"] = confidence_score(row)
            row["confidence_bucket"] = confidence_bucket(row["confidence_score"])
            row["confidence_label"] = confidence_label(row["confidence_score"])
            out.append(row)
    return out


def sim(rows, start, risk, profit_key="cluster"):
    bank = start
    peak = start
    maxdd = 0
    lose = 0
    worst = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""), x.get("side", ""))):
        stake = bank * risk
        if profit_key == "middle":
            won = r["middle_score_win"]
            odds = r["middle_score_odds"]
        else:
            won = r["side_cluster_win"]
            odds = r["cluster_odds"]
        if won:
            bank += stake * (odds - 1)
            lose = 0
        else:
            bank -= stake
            lose += 1
            worst = max(worst, lose)
        peak = max(peak, bank)
        maxdd = max(maxdd, (peak - bank) / peak if peak else 0)
    return bank, bank - start, ((bank / start) - 1) * 100 if start else None, maxdd * 100, worst


def units(rows, profit_key="cluster"):
    total = 0.0
    for r in rows:
        if profit_key == "middle":
            total += (r["middle_score_odds"] - 1) if r["middle_score_win"] else -1
        else:
            total += (r["cluster_odds"] - 1) if r["side_cluster_win"] else -1
    return total


def metrics(rows, label, start, risk, profit_key="cluster", **g):
    rows = [r for r in rows if r.get("cluster_odds") and r["cluster_odds"] > 1]
    bets = len(rows)
    if profit_key == "middle":
        wins = sum(1 for r in rows if r["middle_score_win"])
        avg = sum(r["middle_score_odds"] for r in rows) / bets if bets else None
    else:
        wins = sum(1 for r in rows if r["side_cluster_win"])
        avg = sum(r["cluster_odds"] for r in rows) / bets if bets else None
    profit_units = units(rows, profit_key)
    months = {r["event_date"][:7] for r in rows if r.get("event_date")}
    fb, cp, cr, dd, streak = sim(rows, start, risk, profit_key)
    return {
        "label": label,
        **g,
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg,
        "flat_profit_units": profit_units,
        "flat_roi": profit_units / bets if bets else None,
        "months": len(months),
        "bets_per_month": bets / len(months) if months else None,
        "avg_confidence_score": sum(r["confidence_score"] for r in rows) / bets if bets else None,
        "final_bankroll": fb,
        "compound_profit": cp,
        "compound_return_pct": cr,
        "max_drawdown_pct": dd,
        "worst_losing_streak": streak,
    }


def choose_best_per_event_side(rows):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["event_key"], r["side"])].append(r)
    return [max(v, key=lambda r: (r["confidence_score"], r["cluster_odds"])) for v in groups.values()]


def choose_random_per_event_side(rows, seed=20260517):
    rng = random.Random(seed)
    groups = defaultdict(list)
    for r in rows:
        groups[(r["event_key"], r["side"])].append(r)
    return [rng.choice(groups[k]) for k in sorted(groups)]


def pct(v):
    return "n/a" if v is None else f"{v * 100:.2f}%"


def money(v):
    return "n/a" if v is None else f"{v:.2f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-9-12-confidence-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    ap.add_argument("--random-seed", type=int, default=20260517)
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    wide = read_csv(a.first_set_wide)
    ml = read_csv(a.moneyline)
    first, match, markets = ml_maps(ml)
    cand = candidates(wide, first, match)

    def F(name, fn):
        return name, fn

    filters = [
        F("ALL_9_12_CLUSTER_CANDIDATES", lambda r: True),
        F("BET365_ONLY", lambda r: r["bookmaker"] == "bet365"),
        F("ATP_BET365", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365"),
        F("ATP_BET365_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and r["bookmaker"] == "bet365" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
        F("ATP_ALL_BOOKS_CLUSTER_300_350_MIDDLE_700_900", lambda r: r["tour"] == "ATP" and 3.0 <= r["cluster_odds"] < 3.5 and 7.0 <= r["middle_score_odds"] <= 9.0),
    ]
    thresholds = [0, 60, 70, 80, 90]

    results = []
    bets_out = []
    for name, fn in filters:
        base_rows = [r for r in cand if fn(r)]
        for threshold in thresholds:
            threshold_rows = [r for r in base_rows if r["confidence_score"] >= threshold]
            best_rows = choose_best_per_event_side(threshold_rows)
            random_rows = choose_random_per_event_side(threshold_rows, a.random_seed)
            for mode, rows in [("fixed", threshold_rows), ("best_confidence_per_event_side", best_rows), ("random_book_stress", random_rows)]:
                results.append({"mode": mode, "profit_model": "cluster", "threshold": threshold, **metrics(rows, name, a.start_bankroll, a.risk_pct, "cluster")})
                results.append({"mode": mode, "profit_model": "middle_score_sniper", "threshold": threshold, **metrics(rows, name, a.start_bankroll, a.risk_pct, "middle")})
            for r in best_rows:
                bets_out.append({**r, "filter_label": name, "threshold": threshold, "selection_mode": "best_confidence_per_event_side"})

    bucket_rows = []
    for name, fn in filters:
        base_rows = [r for r in cand if fn(r)]
        buckets = defaultdict(list)
        for r in base_rows:
            buckets[r["confidence_bucket"]].append(r)
        for bucket, rows in sorted(buckets.items()):
            bucket_rows.append({"filter_label": name, "confidence_bucket": bucket, **metrics(rows, name, a.start_bankroll, a.risk_pct, "cluster")})

    result_fields = ["mode", "profit_model", "threshold", "label", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "bets_per_month", "avg_confidence_score", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"]
    write_csv(out / "confidence_results.csv", results, result_fields)
    write_csv(out / "confidence_buckets.csv", bucket_rows, ["filter_label", "confidence_bucket", "label", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "bets_per_month", "avg_confidence_score", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak"])
    write_csv(out / "confidence_bets.csv", bets_out, ["filter_label", "threshold", "selection_mode", "confidence_score", "confidence_bucket", "confidence_label", "event_date", "event_time", "event_key", "match_name", "player1", "player2", "tour", "tournament_group", "tournament_name", "bookmaker", "side", "first_set_score", "middle_score", "cluster_odds", "middle_score_odds", "side_cluster_win", "middle_score_win", "first_set_side_bucket", "match_side_bucket", "p1_first_set_moneyline", "p2_first_set_moneyline", "p1_match_moneyline", "p2_match_moneyline"])

    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "wide_rows_total": len(wide),
        "wide_rows_settled": sum(1 for r in wide if clean(r.get("first_set_score"))),
        "candidate_rows_settled_only": len(cand),
        "p1_candidates": sum(1 for r in cand if r["side"] == "P1"),
        "p2_candidates": sum(1 for r in cand if r["side"] == "P2"),
        "confidence_formula": {
            "warning": "Confidence score is a pre-result quality score, not a win probability or guarantee.",
            "core_inputs": ["bookmaker", "cluster_odds", "middle_score_odds", "tour", "tournament_group", "first_set_side_bucket", "match_side_bucket"],
            "production_question": "Do confidence thresholds improve ROI, drawdown, and losing streak versus threshold 0?",
        },
        "target_results": results,
        "bucket_results": bucket_rows,
        "moneyline_markets": markets,
    }
    (out / "confidence_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    lines = [
        "# API Tennis 9-12 Confidence Optimizer",
        "",
        "Confidence is a pre-result quality score. It is not a probability guarantee.",
        "",
        f"Wide rows total: {len(wide)}",
        f"Wide rows settled: {summary['wide_rows_settled']}",
        f"Settled side candidates: {len(cand)}",
        "",
        "## Key Threshold Results",
    ]
    for r in results:
        if r["mode"] == "best_confidence_per_event_side" and r["profit_model"] == "cluster":
            lines.append(f"- {r['label']} conf>={r['threshold']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={money(r['avg_odds'])}, ROI={pct(r['flat_roi'])}, units={money(r['flat_profit_units'])}, final=${money(r['final_bankroll'])}, DD={money(r['max_drawdown_pct'])}%, L={r['worst_losing_streak']}")
    lines.extend([
        "",
        "## Sniper Middle-Score Overlay",
        "The middle-score overlay tests fixed pre-result sniper scores only: P1 uses 6:4, P2 uses 4:6.",
    ])
    for r in results:
        if r["mode"] == "best_confidence_per_event_side" and r["profit_model"] == "middle_score_sniper":
            lines.append(f"- {r['label']} conf>={r['threshold']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={money(r['avg_odds'])}, ROI={pct(r['flat_roi'])}, units={money(r['flat_profit_units'])}, final=${money(r['final_bankroll'])}, DD={money(r['max_drawdown_pct'])}%, L={r['worst_losing_streak']}")
    (out / "confidence_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
