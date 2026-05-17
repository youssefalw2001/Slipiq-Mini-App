#!/usr/bin/env python3
"""SlipIQ settled-only 9-12 winning-side cluster optimizer.

Hotfix for the audit workflow: rows without a parsed first_set_score are pending/ungraded
and MUST NOT be counted as losses.

Strategy only:
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
        w.writeheader(); w.writerows(rows)


def fav_bucket(odds):
    if odds is None: return "unknown"
    if odds < 1.35: return "strong_favorite"
    if odds < 1.65: return "favorite"
    if odds < 1.95: return "slight_favorite"
    return "near_even"


def side_bucket(side, fav_side, bucket):
    if fav_side in {"", "unknown", None} or bucket in {"", "unknown", None}: return "unknown"
    if fav_side == "EVEN": return "near_even"
    if side == fav_side: return bucket
    return {"near_even":"near_even", "slight_favorite":"slight_underdog", "favorite":"underdog", "strong_favorite":"strong_underdog"}.get(bucket, "unknown")


def norm_ml(raw):
    r = dict(raw)
    r["event_key"] = clean(r.get("event_key")); r["bookmaker"] = clean(r.get("bookmaker")); r["market_name"] = clean(r.get("market_name"))
    p1 = fnum(r.get("moneyline_p1")); p2 = fnum(r.get("moneyline_p2"))
    if p1 and p2:
        if p1 < p2: fs, fo = "P1", p1
        elif p2 < p1: fs, fo = "P2", p2
        else: fs, fo = "EVEN", p1
    else:
        fs, fo = clean(r.get("favorite_side")) or "unknown", fnum(r.get("favorite_odds"))
    r["moneyline_p1"] = p1; r["moneyline_p2"] = p2; r["favorite_side"] = fs; r["favorite_odds"] = fo; r["favorite_bucket"] = clean(r.get("favorite_bucket")) or fav_bucket(fo)
    r["kind"] = "first_set" if "1st Set" in r["market_name"] or "First Set" in r["market_name"] else "match"
    return r


def ml_maps(rows):
    first, match, markets = {}, {}, defaultdict(int)
    for raw in rows:
        r = norm_ml(raw)
        if not r["event_key"] or not r["bookmaker"]: continue
        key = (r["event_key"], r["bookmaker"]); markets[r["market_name"]] += 1
        if r["kind"] == "first_set":
            if key not in first or r["market_name"].lower() == "home/away (1st set)": first[key] = r
        else:
            if key not in match or r["market_name"].lower() == "home/away": match[key] = r
    return first, match, dict(markets)


def normalize_wide(raw):
    r = dict(raw)
    for k in ["event_key", "event_type_key", "event_date", "event_time", "player1", "player2", "match_name", "bookmaker", "tournament_name", "event_type_type", "first_set_score"]:
        r[k] = clean(r.get(k))
    r["event_time"] = r["event_time"] or "00:00"
    for k in ["odds_6_3", "odds_6_4", "odds_7_5", "odds_3_6", "odds_4_6", "odds_5_7"]: r[k] = fnum(r.get(k))
    r["tour"] = tour(r); r["tournament_group"] = tgroup(r)
    r["p1_cluster_odds"] = fnum(r.get("p1_cluster_odds")) or grouped([r["odds_6_3"], r["odds_6_4"], r["odds_7_5"]])
    r["p2_cluster_odds"] = fnum(r.get("p2_cluster_odds")) or grouped([r["odds_3_6"], r["odds_4_6"], r["odds_5_7"]])
    try:
        dt = f"{r['event_date']}T{r['event_time'] if len(r['event_time']) != 5 else r['event_time'] + ':00'}"
        r["ts"] = datetime.fromisoformat(dt).timestamp()
    except Exception: r["ts"] = 0
    return r


def candidates(wide, first_ml, match_ml):
    out = []
    for raw in wide:
        r = normalize_wide(raw)
        if not r["first_set_score"]:
            continue  # critical: pending/ungraded rows are excluded, not losses
        key = (r["event_key"], r["bookmaker"]); fs = first_ml.get(key, {}); mt = match_ml.get(key, {})
        base = {"event_key": r["event_key"], "event_date": r["event_date"], "event_time": r["event_time"], "player1": r["player1"], "player2": r["player2"], "match_name": r["match_name"], "bookmaker": r["bookmaker"], "tour": r["tour"], "tournament_group": r["tournament_group"], "tournament_name": r["tournament_name"], "first_set_score": r["first_set_score"], "first_set_favorite_side": fs.get("favorite_side", "unknown"), "first_set_favorite_bucket": fs.get("favorite_bucket", "unknown"), "p1_first_set_moneyline": fs.get("moneyline_p1"), "p2_first_set_moneyline": fs.get("moneyline_p2"), "match_favorite_side": mt.get("favorite_side", "unknown"), "match_favorite_bucket": mt.get("favorite_bucket", "unknown"), "p1_match_moneyline": mt.get("moneyline_p1"), "p2_match_moneyline": mt.get("moneyline_p2"), "ts": r["ts"]}
        if r["p1_cluster_odds"] and r["odds_6_4"]:
            out.append({**base, "side":"P1", "cluster_odds":r["p1_cluster_odds"], "middle_score_odds":r["odds_6_4"], "side_cluster_win": r["first_set_score"] in P1_SCORES, "first_set_side_bucket": side_bucket("P1", base["first_set_favorite_side"], base["first_set_favorite_bucket"]), "match_side_bucket": side_bucket("P1", base["match_favorite_side"], base["match_favorite_bucket"])})
        if r["p2_cluster_odds"] and r["odds_4_6"]:
            out.append({**base, "side":"P2", "cluster_odds":r["p2_cluster_odds"], "middle_score_odds":r["odds_4_6"], "side_cluster_win": r["first_set_score"] in P2_SCORES, "first_set_side_bucket": side_bucket("P2", base["first_set_favorite_side"], base["first_set_favorite_bucket"]), "match_side_bucket": side_bucket("P2", base["match_favorite_side"], base["match_favorite_bucket"])})
    return out


def sim(rows, start, risk):
    bank = start; peak = start; maxdd = 0; lose = 0; worst = 0
    for r in sorted(rows, key=lambda x:(x.get("ts",0), x.get("event_key",""), x.get("bookmaker",""), x.get("side",""))):
        stake = bank * risk
        if r["side_cluster_win"]:
            bank += stake * (r["cluster_odds"] - 1); lose = 0
        else:
            bank -= stake; lose += 1; worst = max(worst, lose)
        peak = max(peak, bank); maxdd = max(maxdd, (peak-bank)/peak if peak else 0)
    return bank, bank-start, ((bank/start)-1)*100 if start else None, maxdd*100, worst


def metrics(rows, label, start, risk, **g):
    rows = [r for r in rows if r.get("cluster_odds") and r["cluster_odds"] > 1]
    bets = len(rows); wins = sum(1 for r in rows if r["side_cluster_win"])
    avg = sum(r["cluster_odds"] for r in rows)/bets if bets else None
    units = sum((r["cluster_odds"]-1) if r["side_cluster_win"] else -1 for r in rows)
    months = {r["event_date"][:7] for r in rows if r.get("event_date")}
    fb, cp, cr, dd, streak = sim(rows, start, risk)
    return {"label":label, **g, "bets":bets, "wins":wins, "losses":bets-wins, "hit_rate":wins/bets if bets else None, "avg_odds":avg, "flat_profit_units":units, "flat_roi":units/bets if bets else None, "months":len(months), "bets_per_month":bets/len(months) if months else None, "final_bankroll":fb, "compound_profit":cp, "compound_return_pct":cr, "max_drawdown_pct":dd, "worst_losing_streak":streak}


def choose_random(rows, seed=20260517):
    rng = random.Random(seed); groups = defaultdict(list)
    for r in rows: groups[(r["event_key"], r["side"])].append(r)
    return [rng.choice(groups[k]) for k in sorted(groups)]


def choose_best(rows):
    groups = defaultdict(list)
    for r in rows: groups[(r["event_key"], r["side"])].append(r)
    return [max(v, key=lambda r:r["cluster_odds"]) for v in groups.values()]


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--first-set-wide", required=True); ap.add_argument("--moneyline", required=True); ap.add_argument("--out", default="artifacts/output/api-tennis-9-12-cluster-settled-optimizer"); ap.add_argument("--start-bankroll", type=float, default=5000); ap.add_argument("--risk-pct", type=float, default=0.02); ap.add_argument("--random-seed", type=int, default=20260517)
    a = ap.parse_args(); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    wide = read_csv(a.first_set_wide); ml = read_csv(a.moneyline); first, match, markets = ml_maps(ml); cand = candidates(wide, first, match)
    def F(name, fn): return name, fn
    filters = [
        F("ATP_BET365_CLUSTER_300_350_MIDDLE_700_900", lambda r:r["tour"]=="ATP" and r["bookmaker"]=="bet365" and 3.0<=r["cluster_odds"]<3.5 and 7.0<=r["middle_score_odds"]<=9.0),
        F("ATP_BET365_10BET_CLUSTER_300_350_MIDDLE_700_900", lambda r:r["tour"]=="ATP" and r["bookmaker"] in {"bet365","10Bet"} and 3.0<=r["cluster_odds"]<3.5 and 7.0<=r["middle_score_odds"]<=9.0),
        F("ATP_VOLUME_V3_BOTHSIDE_MIDDLE_700_900_CLUSTER_300_350", lambda r:r["tour"]=="ATP" and 7.0<=r["middle_score_odds"]<=9.0 and 3.0<=r["cluster_odds"]<3.5),
        F("ATP_STRICT_V3_BOTHSIDE_MIDDLE_625_699_CLUSTER_330_PLUS", lambda r:r["tour"]=="ATP" and 6.25<=r["middle_score_odds"]<=6.99 and r["cluster_odds"]>=3.30),
    ]
    results = []
    for name, fn in filters:
        rows = [r for r in cand if fn(r)]
        results.append({"mode":"fixed", **metrics(rows, name, a.start_bankroll, a.risk_pct)})
        results.append({"mode":"random_book_stress", **metrics(choose_random(rows, a.random_seed), name, a.start_bankroll, a.risk_pct)})
        results.append({"mode":"best_book_diagnostic", **metrics(choose_best(rows), name, a.start_bankroll, a.risk_pct)})
        for book in sorted({r["bookmaker"] for r in rows}):
            results.append({"mode":"fixed_book", **metrics([r for r in rows if r["bookmaker"]==book], name, a.start_bankroll, a.risk_pct, bookmaker=book)})
        for bucket in sorted({r["first_set_side_bucket"] for r in rows}):
            results.append({"mode":"first_set_bucket", **metrics([r for r in rows if r["first_set_side_bucket"]==bucket], name, a.start_bankroll, a.risk_pct, first_set_side_bucket=bucket)})
    fields = ["mode","label","bookmaker","first_set_side_bucket","bets","wins","losses","hit_rate","avg_odds","flat_profit_units","flat_roi","months","bets_per_month","final_bankroll","compound_profit","compound_return_pct","max_drawdown_pct","worst_losing_streak"]
    write_csv(out/"settled_only_results.csv", results, fields)
    summary = {"generated_at": datetime.utcnow().isoformat()+"Z", "wide_rows_total": len(wide), "wide_rows_settled": sum(1 for r in wide if clean(r.get("first_set_score"))), "candidate_rows_settled_only": len(cand), "p1_candidates": sum(1 for r in cand if r["side"]=="P1"), "p2_candidates": sum(1 for r in cand if r["side"]=="P2"), "target_results": results, "moneyline_markets": markets}
    (out/"settled_only_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    def pct(v): return "n/a" if v is None else f"{v*100:.2f}%"
    lines = ["# Settled-Only 9-12 Cluster Optimizer", "", f"Wide rows total: {len(wide)}", f"Wide rows settled: {summary['wide_rows_settled']}", f"Settled side candidates: {len(cand)}", "", "## Results"]
    for r in results:
        if r["mode"] in {"fixed","fixed_book","random_book_stress","best_book_diagnostic"}:
            lines.append(f"- {r['mode']} {r.get('bookmaker','')} {r['label']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg_odds={r['avg_odds']:.2f}, ROI={pct(r['flat_roi'])}, final=${r['final_bankroll']:.0f}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
    (out/"settled_only_report.md").write_text("\n".join(lines), encoding="utf-8")

if __name__ == "__main__": main()
