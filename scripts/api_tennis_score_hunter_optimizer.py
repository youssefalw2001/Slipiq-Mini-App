#!/usr/bin/env python3
"""SlipIQ Score Hunter Exact-Score Optimizer.

Runs inside GitHub Actions against the full API Tennis warehouse artifact.

Inputs:
- first_set_correct_score_wide_combined.csv
- moneyline_favorite_combined.csv

Purpose:
- Stop grouping scores first.
- Test individual first-set exact scores like 4:6, 6:4, 3:6, 6:3, 5:7, 7:5.
- Join real first-set and match moneyline favorite data.
- Test fixed-book, score, side, tour, tournament group, odds band, favorite bucket.
- Test daily cap simulations: no cap, max 1, 3, and 5 plays/day.
- No best-book selection.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

SCORE_COLUMNS = {
    "6:0": "odds_6_0",
    "6:1": "odds_6_1",
    "6:2": "odds_6_2",
    "6:3": "odds_6_3",
    "6:4": "odds_6_4",
    "7:5": "odds_7_5",
    "7:6": "odds_7_6",
    "0:6": "odds_0_6",
    "1:6": "odds_1_6",
    "2:6": "odds_2_6",
    "3:6": "odds_3_6",
    "4:6": "odds_4_6",
    "5:7": "odds_5_7",
    "6:7": "odds_6_7",
}
CORE_SCORES = {"6:4", "4:6", "6:3", "3:6", "7:5", "5:7"}
MIDDLE_SCORES = {"6:4", "4:6"}


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


def score_side(score: str) -> str:
    a, b = score.split(":")
    return "P1" if int(a) > int(b) else "P2"


def score_family(score: str) -> str:
    if score in {"6:4", "4:6"}:
        return "MIDDLE_64_46"
    if score in {"6:3", "3:6"}:
        return "MEDIUM_63_36"
    if score in {"7:5", "5:7"}:
        return "LATE_BREAK_75_57"
    if score in {"7:6", "6:7"}:
        return "TIEBREAK_76_67"
    if score in {"6:2", "2:6"}:
        return "DOMINANT_62_26"
    if score in {"6:1", "1:6", "6:0", "0:6"}:
        return "BLOWOUT"
    return "OTHER"


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


def bucket_from_fav_odds(odds: Optional[float]) -> str:
    if odds is None:
        return "unknown"
    if odds < 1.35:
        return "strong_favorite"
    if odds < 1.65:
        return "favorite"
    if odds < 1.95:
        return "slight_favorite"
    return "near_even"


def side_bucket(side: str, favorite_side: str, fav_bucket: str) -> str:
    if favorite_side in {"", "unknown"} or fav_bucket == "unknown":
        return "unknown"
    if favorite_side == "EVEN":
        return "near_even"
    if side == favorite_side:
        return fav_bucket
    if fav_bucket == "near_even":
        return "near_even"
    if fav_bucket == "slight_favorite":
        return "slight_underdog"
    if fav_bucket == "favorite":
        return "underdog"
    if fav_bucket == "strong_favorite":
        return "strong_underdog"
    return "unknown"


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def normalize_wide(row):
    row = dict(row)
    row["event_key"] = clean(row.get("event_key"))
    row["bookmaker"] = clean(row.get("bookmaker"))
    row["event_date"] = clean(row.get("event_date"))
    row["event_time"] = clean(row.get("event_time") or "00:00")
    row["player1"] = clean(row.get("player1"))
    row["player2"] = clean(row.get("player2"))
    row["match_name"] = clean(row.get("match_name"))
    row["tournament_name"] = clean(row.get("tournament_name"))
    row["event_type_type"] = clean(row.get("event_type_type"))
    row["first_set_score"] = clean(row.get("first_set_score"))
    row["tour"] = tour(row)
    row["tournament_group"] = tournament_group(row)
    for col in SCORE_COLUMNS.values():
        row[col] = fnum(row.get(col))
    try:
        dt = f"{row['event_date']}T{row['event_time'] if len(row['event_time']) != 5 else row['event_time'] + ':00'}"
        row["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception:
        row["ts"] = 0
    return row


def normalize_ml(row):
    row = dict(row)
    row["event_key"] = clean(row.get("event_key"))
    row["bookmaker"] = clean(row.get("bookmaker"))
    row["market_name"] = clean(row.get("market_name"))
    row["moneyline_p1"] = fnum(row.get("moneyline_p1"))
    row["moneyline_p2"] = fnum(row.get("moneyline_p2"))
    fav_side = clean(row.get("favorite_side"))
    if row["moneyline_p1"] and row["moneyline_p2"]:
        if row["moneyline_p1"] < row["moneyline_p2"]:
            fav_side = "P1"
            fav_odds = row["moneyline_p1"]
        elif row["moneyline_p2"] < row["moneyline_p1"]:
            fav_side = "P2"
            fav_odds = row["moneyline_p2"]
        else:
            fav_side = "EVEN"
            fav_odds = row["moneyline_p1"]
    else:
        fav_odds = fnum(row.get("favorite_odds"))
    row["favorite_side"] = fav_side
    row["favorite_odds"] = fav_odds
    row["favorite_bucket"] = clean(row.get("favorite_bucket")) or bucket_from_fav_odds(fav_odds)
    row["market_type"] = "first_set" if "1st Set" in row["market_name"] or "First Set" in row["market_name"] else "match"
    return row


def build_moneyline_maps(rows):
    first_set = {}
    match = {}
    markets = defaultdict(int)
    for raw in rows:
        r = normalize_ml(raw)
        if not r["event_key"] or not r["bookmaker"]:
            continue
        key = (r["event_key"], r["bookmaker"])
        markets[r["market_name"]] += 1
        if r["market_type"] == "first_set":
            existing = first_set.get(key)
            if existing is None or r["market_name"].lower() == "home/away (1st set)":
                first_set[key] = r
        else:
            existing = match.get(key)
            if existing is None or r["market_name"].lower() == "home/away":
                match[key] = r
    return first_set, match, markets


def candidates_from_wide(row, first_set_ml, match_ml):
    key = (row["event_key"], row["bookmaker"])
    fs = first_set_ml.get(key, {})
    mt = match_ml.get(key, {})
    base = {
        "event_key": row["event_key"],
        "event_date": row["event_date"],
        "event_time": row["event_time"],
        "player1": row["player1"],
        "player2": row["player2"],
        "match_name": row["match_name"],
        "bookmaker": row["bookmaker"],
        "tour": row["tour"],
        "tournament_group": row["tournament_group"],
        "tournament_name": row["tournament_name"],
        "first_set_score": row["first_set_score"],
        "first_set_favorite_side": fs.get("favorite_side", "unknown"),
        "first_set_favorite_odds": fs.get("favorite_odds"),
        "first_set_favorite_bucket": fs.get("favorite_bucket", "unknown"),
        "moneyline_p1_1st_set": fs.get("moneyline_p1"),
        "moneyline_p2_1st_set": fs.get("moneyline_p2"),
        "match_favorite_side": mt.get("favorite_side", "unknown"),
        "match_favorite_odds": mt.get("favorite_odds"),
        "match_favorite_bucket": mt.get("favorite_bucket", "unknown"),
        "moneyline_p1_match": mt.get("moneyline_p1"),
        "moneyline_p2_match": mt.get("moneyline_p2"),
        "ts": row.get("ts", 0),
    }
    out = []
    for score, col in SCORE_COLUMNS.items():
        odds = row.get(col)
        if not odds or odds <= 1:
            continue
        side = score_side(score)
        out.append({
            **base,
            "score": score,
            "score_side": side,
            "score_family": score_family(score),
            "odds_decimal": odds,
            "won": row.get("first_set_score") == score,
            "is_core_score": score in CORE_SCORES,
            "is_middle_score": score in MIDDLE_SCORES,
            "first_set_side_bucket": side_bucket(side, base["first_set_favorite_side"], base["first_set_favorite_bucket"]),
            "match_side_bucket": side_bucket(side, base["match_favorite_side"], base["match_favorite_bucket"]),
        })
    return out


def rank_candidate(r):
    # Conservative ranking for daily caps. Lower odds first within accepted filters,
    # then first-set favorite/slight/near-even preference, then core 6:4/4:6 scores.
    bucket_rank = {
        "near_even": 0,
        "slight_favorite": 1,
        "slight_underdog": 2,
        "favorite": 3,
        "underdog": 4,
        "strong_favorite": 5,
        "strong_underdog": 6,
        "unknown": 9,
    }
    core_rank = 0 if r.get("score") in {"6:4", "4:6"} else 1
    return (r.get("event_date", ""), bucket_rank.get(r.get("first_set_side_bucket"), 9), core_rank, r.get("odds_decimal") or 999, r.get("bookmaker", ""), r.get("event_key", ""))


def apply_daily_cap(rows, cap: int) -> List[Dict]:
    if cap <= 0:
        return rows
    by_day = defaultdict(list)
    for r in rows:
        by_day[r.get("event_date", "")].append(r)
    selected = []
    for day in sorted(by_day):
        day_rows = sorted(by_day[day], key=rank_candidate)
        # one exact score candidate per match/book/side at most within day-ranked list
        seen_match = set()
        kept = []
        for r in day_rows:
            match_key = (r.get("event_key"), r.get("bookmaker"))
            if match_key in seen_match:
                continue
            seen_match.add(match_key)
            kept.append(r)
            if len(kept) >= cap:
                break
        selected.extend(kept)
    return selected


def simulate(rows, start=5000.0, risk=0.02):
    bankroll = start
    peak = start
    max_dd = 0.0
    losing = 0
    worst_losing = 0
    for r in sorted(rows, key=lambda x: (x.get("ts", 0), x.get("event_key", ""), x.get("bookmaker", ""), x.get("score", ""))):
        odds = r.get("odds_decimal")
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk
        if r.get("won"):
            bankroll += stake * (odds - 1)
            losing = 0
        else:
            bankroll -= stake
            losing += 1
            worst_losing = max(worst_losing, losing)
        peak = max(peak, bankroll)
        if peak > 0:
            max_dd = max(max_dd, (peak - bankroll) / peak)
    return bankroll, bankroll - start, ((bankroll / start) - 1) * 100, max_dd * 100, worst_losing


def metrics(rows, label, start, risk, daily_cap=0, **group):
    rows = [r for r in rows if r.get("odds_decimal") and r["odds_decimal"] > 1]
    if daily_cap > 0:
        rows = apply_daily_cap(rows, daily_cap)
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("won"))
    avg_odds = sum(r["odds_decimal"] for r in rows) / bets if bets else None
    units = sum((r["odds_decimal"] - 1) if r.get("won") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    # positive months flat unit P/L
    month_pl = defaultdict(float)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            month_pl[month] += (r["odds_decimal"] - 1) if r.get("won") else -1
    positive_months = sum(1 for v in month_pl.values() if v > 0)
    final, profit, ret, dd, streak = simulate(rows, start, risk)
    return {
        "label": label,
        **group,
        "daily_cap": daily_cap,
        "bets": bets,
        "wins": wins,
        "losses": bets - wins,
        "hit_rate": wins / bets if bets else None,
        "avg_odds": avg_odds,
        "flat_profit_units": units,
        "flat_roi": units / bets if bets else None,
        "months": len(months),
        "positive_months": positive_months,
        "bets_per_month": bets / len(months) if months else None,
        "final_bankroll": final,
        "compound_profit": profit,
        "compound_return_pct": ret,
        "max_drawdown_pct": dd,
        "worst_losing_streak": streak,
    }


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--moneyline", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-score-hunter-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--risk-pct", type=float, default=0.02)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    wide_rows = [normalize_wide(r) for r in read_csv(Path(args.first_set_wide))]
    ml_rows = read_csv(Path(args.moneyline))
    first_set_ml, match_ml, ml_markets = build_moneyline_maps(ml_rows)

    candidates = []
    for row in wide_rows:
        candidates.extend(candidates_from_wide(row, first_set_ml, match_ml))

    books = sorted({r["bookmaker"] for r in candidates if r.get("bookmaker")})
    scores = sorted({r["score"] for r in candidates})
    families = sorted({r["score_family"] for r in candidates})
    fs_buckets = sorted({r["first_set_side_bucket"] for r in candidates})
    groups = sorted({r["tournament_group"] for r in candidates})

    filters: List[Tuple[str, Callable[[Dict], bool]]] = [
        ("ALL_EXACT_SCORES", lambda r: True),
        ("CORE_63_64_75_BOTH_SIDES", lambda r: r["score"] in CORE_SCORES),
        ("MIDDLE_64_46_ONLY", lambda r: r["score"] in {"6:4", "4:6"}),
        ("ODDS_500_800", lambda r: 5.0 <= r["odds_decimal"] < 8.0),
        ("ODDS_600_900", lambda r: 6.0 <= r["odds_decimal"] < 9.0),
        ("ODDS_700_1000", lambda r: 7.0 <= r["odds_decimal"] < 10.0),
        ("ODDS_800_1200", lambda r: 8.0 <= r["odds_decimal"] < 12.0),
        ("ODDS_1200_1800", lambda r: 12.0 <= r["odds_decimal"] < 18.0),
        ("CORE_ODDS_500_800", lambda r: r["score"] in CORE_SCORES and 5.0 <= r["odds_decimal"] < 8.0),
        ("MIDDLE_ODDS_500_800", lambda r: r["score"] in {"6:4", "4:6"} and 5.0 <= r["odds_decimal"] < 8.0),
        ("MIDDLE_ODDS_600_900", lambda r: r["score"] in {"6:4", "4:6"} and 6.0 <= r["odds_decimal"] < 9.0),
        ("ATP_MIDDLE_ODDS_500_800", lambda r: r["tour"] == "ATP" and r["score"] in {"6:4", "4:6"} and 5.0 <= r["odds_decimal"] < 8.0),
        ("ATP_CORE_ODDS_500_800", lambda r: r["tour"] == "ATP" and r["score"] in CORE_SCORES and 5.0 <= r["odds_decimal"] < 8.0),
        ("ATP_1SET_SLIGHT_OR_EVEN_MIDDLE_500_800", lambda r: r["tour"] == "ATP" and r["score"] in {"6:4", "4:6"} and r["first_set_side_bucket"] in {"near_even", "slight_favorite", "slight_underdog"} and 5.0 <= r["odds_decimal"] < 8.0),
        ("ATP_1SET_FAV_MIDDLE_500_800", lambda r: r["tour"] == "ATP" and r["score"] in {"6:4", "4:6"} and r["first_set_side_bucket"] in {"near_even", "slight_favorite", "favorite", "strong_favorite"} and 5.0 <= r["odds_decimal"] < 8.0),
        ("WTA_MIDDLE_ODDS_500_800", lambda r: r["tour"] == "WTA" and r["score"] in {"6:4", "4:6"} and 5.0 <= r["odds_decimal"] < 8.0),
    ]

    result_fields = [
        "label", "bookmaker", "score", "score_family", "tour", "tournament_group", "first_set_side_bucket", "match_side_bucket",
        "daily_cap", "bets", "wins", "losses", "hit_rate", "avg_odds", "flat_profit_units", "flat_roi", "months", "positive_months", "bets_per_month", "final_bankroll", "compound_profit", "compound_return_pct", "max_drawdown_pct", "worst_losing_streak",
    ]

    results = []
    caps = [0, 1, 3, 5]
    for cap in caps:
        for name, fn in filters:
            results.append(metrics([r for r in candidates if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap))
        for book in books:
            br = [r for r in candidates if r["bookmaker"] == book]
            for name, fn in filters:
                results.append(metrics([r for r in br if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, bookmaker=book))
        for score in scores:
            sr = [r for r in candidates if r["score"] == score]
            for name, fn in filters:
                results.append(metrics([r for r in sr if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, score=score))
            for book in books:
                sbr = [r for r in sr if r["bookmaker"] == book]
                for name, fn in filters:
                    results.append(metrics([r for r in sbr if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, score=score, bookmaker=book))
        for bucket in fs_buckets:
            fr = [r for r in candidates if r["first_set_side_bucket"] == bucket]
            for name, fn in filters:
                results.append(metrics([r for r in fr if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, first_set_side_bucket=bucket))
            for book in books:
                fbr = [r for r in fr if r["bookmaker"] == book]
                for name, fn in filters:
                    results.append(metrics([r for r in fbr if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, first_set_side_bucket=bucket, bookmaker=book))
        for group in groups:
            gr = [r for r in candidates if r["tournament_group"] == group]
            for name, fn in filters:
                results.append(metrics([r for r in gr if fn(r)], name, args.start_bankroll, args.risk_pct, daily_cap=cap, tournament_group=group))

    candidate_fields = [
        "event_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tour", "tournament_group", "tournament_name", "first_set_score", "score", "score_side", "score_family", "odds_decimal", "won", "is_core_score", "is_middle_score", "first_set_favorite_side", "first_set_favorite_odds", "first_set_favorite_bucket", "first_set_side_bucket", "moneyline_p1_1st_set", "moneyline_p2_1st_set", "match_favorite_side", "match_favorite_odds", "match_favorite_bucket", "match_side_bucket", "moneyline_p1_match", "moneyline_p2_match"
    ]
    write_csv(out / "score_hunter_candidate_rows.csv", candidates, candidate_fields)
    write_csv(out / "score_hunter_results.csv", results, result_fields)

    leaderboard = sorted(
        [m for m in results if m["bets"] >= 50 and m["flat_roi"] is not None],
        key=lambda m: (m["flat_roi"], m["bets"]),
        reverse=True,
    )[:500]
    write_csv(out / "score_hunter_leaderboard.csv", leaderboard, result_fields)

    top_no_cap = [m for m in leaderboard if m["daily_cap"] == 0][:50]
    top_cap_3 = [m for m in leaderboard if m["daily_cap"] == 3][:50]
    top_cap_5 = [m for m in leaderboard if m["daily_cap"] == 5][:50]
    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "wide_rows": len(wide_rows),
        "moneyline_rows": len(ml_rows),
        "first_set_moneyline_pairs": len(first_set_ml),
        "match_moneyline_pairs": len(match_ml),
        "candidate_rows": len(candidates),
        "bookmakers": books,
        "scores": scores,
        "score_families": families,
        "first_set_side_buckets": fs_buckets,
        "tournament_groups": groups,
        "moneyline_markets": dict(sorted(ml_markets.items(), key=lambda kv: kv[1], reverse=True)),
        "top_no_cap": top_no_cap,
        "top_cap_3": top_cap_3,
        "top_cap_5": top_cap_5,
    }
    (out / "optimizer_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    def pct(v):
        return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v):
        return "n/a" if v is None else f"${v:,.0f}"
    lines = [
        "# API Tennis Score Hunter Exact-Score Optimizer",
        "",
        f"First-set wide rows: {len(wide_rows)}",
        f"Moneyline rows: {len(ml_rows)}",
        f"Candidate exact-score rows: {len(candidates)}",
        f"Books: {', '.join(books)}",
        "",
        "## Top results, no daily cap",
    ]
    for i, m in enumerate(top_no_cap[:30], 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. cap={m['daily_cap']} {m.get('bookmaker','')} {m.get('score','')} {m.get('first_set_side_bucket','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}, +months={m['positive_months']}/{m['months']}")
    lines += ["", "## Top results, max 3 plays/day"]
    for i, m in enumerate(top_cap_3[:30], 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. cap={m['daily_cap']} {m.get('bookmaker','')} {m.get('score','')} {m.get('first_set_side_bucket','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}, +months={m['positive_months']}/{m['months']}")
    lines += ["", "## Top results, max 5 plays/day"]
    for i, m in enumerate(top_cap_5[:30], 1):
        avg = "n/a" if m["avg_odds"] is None else f"{m['avg_odds']:.2f}"
        lines.append(f"{i}. cap={m['daily_cap']} {m.get('bookmaker','')} {m.get('score','')} {m.get('first_set_side_bucket','')} {m['label']}: bets={m['bets']}, hit={pct(m['hit_rate'])}, avg_odds={avg}, ROI={pct(m['flat_roi'])}, final={money(m['final_bankroll'])}, DD={m['max_drawdown_pct']:.1f}%, L={m['worst_losing_streak']}, +months={m['positive_months']}/{m['months']}")
    lines += ["", "Note: daily cap ranking is a simple deterministic market-structure ranking, not your old model probability. The next version can add true model probability/EV if available."]
    (out / "optimizer_report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
