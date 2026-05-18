#!/usr/bin/env python3
"""SlipIQ / First Set Lab Comfort Optimizer.

Searches for higher-hit-rate first-set models that can be used as a psychological
stabilizer for users alongside the main Core/VIP edge model.

This is NOT optimized for maximum ROI only. It tries to find models with:
- higher hit rate
- positive ROI
- lower drawdown
- shorter losing streaks
- useful but capped volume

Input:
- first_set_correct_score_wide_combined.csv from the API Tennis warehouse.

Output:
- comfort_optimizer_results.csv
- comfort_optimizer_high_hit_positive_roi.csv
- comfort_optimizer_risk_sims.csv
- comfort_optimizer_report.md
- comfort_optimizer_cards.json
"""
from __future__ import annotations

import argparse, csv, json, math
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

VALID_SCORES = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6","0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
P1_SCORES = ["6:0","6:1","6:2","6:3","6:4","7:5","7:6"]
P2_SCORES = ["0:6","1:6","2:6","3:6","4:6","5:7","6:7"]
SCORE_COLS = {
    "6:0":"odds_6_0", "6:1":"odds_6_1", "6:2":"odds_6_2", "6:3":"odds_6_3", "6:4":"odds_6_4", "7:5":"odds_7_5", "7:6":"odds_7_6",
    "0:6":"odds_0_6", "1:6":"odds_1_6", "2:6":"odds_2_6", "3:6":"odds_3_6", "4:6":"odds_4_6", "5:7":"odds_5_7", "6:7":"odds_6_7",
}
TOUR_MAP = {"265":"ATP", "266":"WTA"}
RISK_LEVELS = [0.0025, 0.005, 0.01, 0.02]
DAILY_CAPS = [1, 2, 3, 5, 0]
BOOK_GROUPS = {
    "bet365": {"bet365"},
    "1xBet": {"1xBet"},
    "10Bet": {"10Bet"},
    "bet365_1xBet": {"bet365", "1xBet"},
    "bet365_1xBet_10Bet": {"bet365", "1xBet", "10Bet"},
}
TOUR_FILTERS = ["ATP", "WTA", "ALL"]
GROUP_FILTERS = ["GRAND_SLAM", "MASTERS_1000", "STRONG_500_250", "OTHER_TOUR", "ALL"]

FAMILIES = [
    {"family":"P1_SET_WIN_PROXY", "side":"P1", "scores":P1_SCORES, "quality":5},
    {"family":"P2_SET_WIN_PROXY", "side":"P2", "scores":P2_SCORES, "quality":5},
    {"family":"P1_COMFORT_MID", "side":"P1", "scores":["6:2","6:3","6:4"], "quality":4},
    {"family":"P2_COMFORT_MID", "side":"P2", "scores":["2:6","3:6","4:6"], "quality":4},
    {"family":"P1_COMFORT_9_12", "side":"P1", "scores":["6:3","6:4","7:5"], "quality":3},
    {"family":"P2_COMFORT_9_12", "side":"P2", "scores":["3:6","4:6","5:7"], "quality":3},
    {"family":"P1_BROAD_NO_TB", "side":"P1", "scores":["6:1","6:2","6:3","6:4","7:5"], "quality":4},
    {"family":"P2_BROAD_NO_TB", "side":"P2", "scores":["1:6","2:6","3:6","4:6","5:7"], "quality":4},
    {"family":"P1_TIGHT_OR_MID", "side":"P1", "scores":["6:4","7:5","7:6"], "quality":2},
    {"family":"P2_TIGHT_OR_MID", "side":"P2", "scores":["4:6","5:7","6:7"], "quality":2},
]

GATES = [1.30, 1.40, 1.50, 1.60, 1.75, 1.90, 2.00, 2.20, 2.40, 2.60]


def clean(x) -> str:
    return str(x or "").strip()


def fnum(x) -> Optional[float]:
    try:
        if x is None or clean(x) == "": return None
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def grouped(vals) -> Optional[float]:
    nums = [fnum(v) for v in vals]
    if any(v is None or v <= 1 for v in nums): return None
    s = sum(1.0/v for v in nums)
    return 1.0/s if s else None


def read_csv(path: Path) -> List[Dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader(); w.writerows(rows)


def tour_from_row(row: Dict) -> str:
    k = clean(row.get("event_type_key"))
    if k in TOUR_MAP: return TOUR_MAP[k]
    s = f"{row.get('event_type_type','')} {row.get('tournament_name','')}".lower()
    if "wta" in s or "women" in s: return "WTA"
    if "atp" in s or "men" in s: return "ATP"
    return "UNKNOWN"


def tournament_group(row: Dict) -> str:
    t = clean(row.get("tournament_name")).lower()
    if any(k in t for k in ["australian open","roland garros","french open","wimbledon","us open"]): return "GRAND_SLAM"
    if any(k in t for k in ["indian wells","miami","monte carlo","madrid","rome","italian open","canada","canadian open","toronto","montreal","cincinnati","shanghai","paris","beijing","wuhan","doha","dubai","qatar open"]): return "MASTERS_1000"
    if any(k in t for k in ["barcelona","halle","queen","queens","london","stuttgart","charleston","washington","hamburg","tokyo","acapulco","eastbourne","rotterdam","basel","vienna","adelaide","brisbane","bad homburg","berlin","strasbourg","antwerp","dallas","rio","astana","chengdu","zhuhai","seoul"]): return "STRONG_500_250"
    if any(k in t for k in ["challenger","itf","m25","m15","w15","w25","w35","w50","w75","w100","w125"]): return "LOWER_TIER"
    return "OTHER_TOUR"


def ts(row: Dict) -> float:
    try:
        tm = clean(row.get("event_time")) or "00:00"
        return datetime.fromisoformat(f"{clean(row.get('event_date'))}T{tm if len(tm)!=5 else tm+':00'}").timestamp()
    except Exception:
        return 0.0


def norm(raw: Dict) -> Dict:
    r = {k: clean(raw.get(k)) for k in ["event_key","event_date","event_time","match_name","bookmaker","tournament_name","first_set_score","event_type_key","event_type_type"]}
    for col in SCORE_COLS.values(): r[col] = fnum(raw.get(col))
    r["tour"] = tour_from_row(r); r["tournament_group"] = tournament_group(r); r["ts"] = ts(r)
    return r


def precompute(rows: List[Dict]) -> tuple[List[Dict], Dict[str,int]]:
    out=[]; invalid=defaultdict(int)
    for r in rows:
        if not r.get("first_set_score"): continue
        if r["first_set_score"] not in VALID_SCORES:
            invalid[r["first_set_score"]] += 1; continue
        for fam in FAMILIES:
            odds = [r.get(SCORE_COLS[s]) for s in fam["scores"]]
            go = grouped(odds)
            if go is None: continue
            out.append({
                "event_key": r["event_key"], "event_date": r["event_date"], "event_time": r["event_time"], "ts": r["ts"],
                "match_name": r["match_name"], "bookmaker": r["bookmaker"], "tour": r["tour"], "tournament_group": r["tournament_group"],
                "tournament_name": r["tournament_name"], "family": fam["family"], "side": fam["side"], "scores": "/".join(fam["scores"]),
                "score_count": len(fam["scores"]), "quality": fam["quality"], "grouped_odds": go,
                "first_set_score": r["first_set_score"], "won": r["first_set_score"] in set(fam["scores"]),
            })
    return out, dict(sorted(invalid.items()))


def split_dates(rows: List[Dict], ratio: float):
    ds = sorted({r["event_date"] for r in rows if r.get("event_date")})
    if len(ds) < 3: return set(ds), set(), ds[-1] if ds else ""
    cutoff = ds[max(1, min(len(ds)-1, int(len(ds)*ratio)))]
    return {d for d in ds if d < cutoff}, {d for d in ds if d >= cutoff}, cutoff


def dedupe(rows: List[Dict]) -> List[Dict]:
    groups=defaultdict(list)
    for r in rows:
        groups[(r["event_key"], r["family"], r["scores"])].append(r)
    return [max(v, key=lambda x: (x["grouped_odds"], x["quality"])) for v in groups.values()]


def cap_rows(rows: List[Dict], cap: int) -> List[Dict]:
    rows = dedupe(rows)
    if cap <= 0: return sorted(rows, key=lambda x:(x["ts"],x["event_key"],x["family"]))
    by_day=defaultdict(list)
    for r in rows: by_day[r["event_date"]].append(r)
    out=[]
    for day, arr in sorted(by_day.items()):
        ranked = sorted(arr, key=lambda x:(x["quality"], x["grouped_odds"], -x["score_count"]), reverse=True)
        used_events=set(); keep=[]
        for r in ranked:
            if r["event_key"] in used_events: continue
            used_events.add(r["event_key"]); keep.append(r)
            if len(keep) >= cap: break
        out.extend(keep)
    return sorted(out, key=lambda x:(x["ts"],x["event_key"],x["family"]))


def metrics(rows: List[Dict], start: float, risk: float) -> Dict:
    rows=[r for r in rows if r.get("grouped_odds") and r["grouped_odds"]>1]
    bets=len(rows); wins=sum(1 for r in rows if r["won"])
    avg=sum(r["grouped_odds"] for r in rows)/bets if bets else None
    units=sum((r["grouped_odds"]-1) if r["won"] else -1 for r in rows)
    months={r["event_date"][:7] for r in rows if r.get("event_date")}; days={r["event_date"] for r in rows if r.get("event_date")}
    mpl=defaultdict(float); fam=defaultdict(int); books=defaultdict(int)
    for r in rows:
        mpl[r["event_date"][:7]] += (r["grouped_odds"]-1) if r["won"] else -1
        fam[r["family"]]+=1; books[r["bookmaker"]]+=1
    bank=start; peak=start; maxdd=0; lose=0; worst=0
    for r in sorted(rows, key=lambda x:(x["ts"],x["event_key"],x["family"])):
        stake=bank*risk
        if r["won"]: bank += stake*(r["grouped_odds"]-1); lose=0
        else: bank -= stake; lose += 1; worst=max(worst,lose)
        peak=max(peak,bank); maxdd=max(maxdd,(peak-bank)/peak if peak else 0)
    hit=wins/bets if bets else None; be=1/avg if avg else None
    return {"bets":bets,"wins":wins,"losses":bets-wins,"hit_rate":hit,"avg_odds":avg,"breakeven_hit_rate":be,"edge_vs_breakeven":hit-be if hit is not None and be is not None else None,"flat_profit_units":units,"flat_roi":units/bets if bets else None,"months":len(months),"active_days":len(days),"positive_months":sum(1 for v in mpl.values() if v>0),"positive_month_ratio":sum(1 for v in mpl.values() if v>0)/len(months) if months else None,"bets_per_month":bets/len(months) if months else None,"bets_per_active_day":bets/len(days) if days else None,"final_bankroll":bank,"compound_return_pct":(bank/start-1)*100 if start else None,"max_drawdown_pct":maxdd*100,"worst_losing_streak":worst,"family_mix":json.dumps(dict(sorted(fam.items()))),"book_mix":json.dumps(dict(sorted(books.items())))}


def comfort_score(m: Dict) -> float:
    if m["bets"] < 80: return -999
    hit=m["hit_rate"] or 0; roi=m["flat_roi"] or 0; dd=m["max_drawdown_pct"] or 0; worst=m["worst_losing_streak"] or 0; pm=m["positive_month_ratio"] or 0
    volume = min(25, math.log10(max(m["bets"],1))*10)
    # Comfort prioritizes hit rate and low drawdown while requiring positive ROI.
    return hit*90 + roi*120 + pm*25 + volume - max(0, dd-15)*1.8 - max(0, worst-7)*3.0


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-first-set-comfort-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    args=ap.parse_args()

    out=Path(args.out); out.mkdir(parents=True, exist_ok=True)
    wide=[norm(r) for r in read_csv(Path(args.first_set_wide))]
    base, invalid = precompute(wide)
    train_dates, test_dates, cutoff = split_dates(base, args.train_ratio)

    results=[]; train_test=[]
    combo_id=0
    for fam in FAMILIES:
        fam_rows=[r for r in base if r["family"]==fam["family"]]
        for book_group, books in BOOK_GROUPS.items():
            book_rows=[r for r in fam_rows if r["bookmaker"] in books]
            if not book_rows: continue
            for tour_filter in TOUR_FILTERS:
                tour_rows = book_rows if tour_filter == "ALL" else [r for r in book_rows if r["tour"] == tour_filter]
                if not tour_rows: continue
                for group_filter in GROUP_FILTERS:
                    group_rows = tour_rows if group_filter == "ALL" else [r for r in tour_rows if r["tournament_group"] == group_filter]
                    if not group_rows: continue
                    for gate in GATES:
                        gated=[r for r in group_rows if r["grouped_odds"] >= gate]
                        if len(gated) < 50: continue
                        for cap in DAILY_CAPS:
                            combo_id += 1
                            rows=cap_rows(gated, cap)
                            m=metrics(rows,args.start_bankroll,0.005)
                            score=comfort_score(m)
                            row={"combo_id":combo_id,"family":fam["family"],"side":fam["side"],"scores":"/".join(fam["scores"]),"book_group":book_group,"tour_filter":tour_filter,"tournament_group_filter":group_filter,"min_grouped_odds":gate,"daily_cap":cap,"score":score,"risk_pct":0.005,"split_cutoff_date":cutoff,**m}
                            results.append(row)
                            train_test.append({"combo_id":combo_id,"split":"TRAIN",**metrics([r for r in rows if r["event_date"] in train_dates],args.start_bankroll,0.005)})
                            train_test.append({"combo_id":combo_id,"split":"TEST",**metrics([r for r in rows if r["event_date"] in test_dates],args.start_bankroll,0.005)})

    fields=["combo_id","family","side","scores","book_group","tour_filter","tournament_group_filter","min_grouped_odds","daily_cap","score","risk_pct","split_cutoff_date","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix"]
    ranked=sorted(results, key=lambda r:(r["score"], r["hit_rate"] or 0, r["flat_roi"] or -9), reverse=True)
    high_hit_positive=[r for r in ranked if r["bets"]>=100 and (r["hit_rate"] or 0)>=0.52 and (r["flat_roi"] or 0)>0 and (r["max_drawdown_pct"] or 999)<=20]
    best_hit=[r for r in ranked if r["bets"]>=100 and (r["flat_roi"] or -9)>0]
    write_csv(out/"comfort_optimizer_results.csv", ranked, fields)
    write_csv(out/"comfort_optimizer_high_hit_positive_roi.csv", high_hit_positive, fields)
    write_csv(out/"comfort_optimizer_train_test.csv", train_test, ["combo_id","split","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix"])

    risk_sims=[]
    for r in ranked[:10]:
        fam_rows=[x for x in base if x["family"]==r["family"] and x["bookmaker"] in BOOK_GROUPS[r["book_group"]] and x["grouped_odds"]>=r["min_grouped_odds"]]
        if r["tour_filter"] != "ALL": fam_rows=[x for x in fam_rows if x["tour"]==r["tour_filter"]]
        if r["tournament_group_filter"] != "ALL": fam_rows=[x for x in fam_rows if x["tournament_group"]==r["tournament_group_filter"]]
        rows=cap_rows(fam_rows, int(r["daily_cap"]))
        for risk in RISK_LEVELS:
            risk_sims.append({"combo_id":r["combo_id"],"family":r["family"],"daily_cap":r["daily_cap"],"risk_pct":risk,**metrics(rows,args.start_bankroll,risk)})
    write_csv(out/"comfort_optimizer_risk_sims.csv", risk_sims, ["combo_id","family","daily_cap","risk_pct","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix"])

    cards={"generated_at":datetime.utcnow().isoformat()+"Z","wide_rows":len(wide),"base_candidate_rows":len(base),"invalid_first_set_score_counts":invalid,"rules_tested":len(results),"best_comfort_score":ranked[0] if ranked else None,"best_high_hit_positive_roi":high_hit_positive[0] if high_hit_positive else None,"highest_hit_positive_roi":max(best_hit, key=lambda r:r["hit_rate"] or 0) if best_hit else None,"top_25":ranked[:25],"high_hit_positive_top_25":high_hit_positive[:25]}
    (out/"comfort_optimizer_cards.json").write_text(json.dumps(cards,indent=2),encoding="utf-8")

    def pc(v): return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v): return "n/a" if v is None else f"${v:,.0f}"
    lines=["# First Set Lab Comfort Optimizer","",f"Wide rows: {len(wide)}",f"Base candidate rows: {len(base)}",f"Rules tested: {len(results)}",f"Invalid first-set scores excluded: {json.dumps(invalid, sort_keys=True)}","","## Top comfort-score models"]
    for i,r in enumerate(ranked[:25],1):
        avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} cap={r['daily_cap']} gate={r['min_grouped_odds']} bets={r['bets']} hit={pc(r['hit_rate'])} avg={avg} ROI={pc(r['flat_roi'])} DD@0.5%={r['max_drawdown_pct']:.1f}% L={r['worst_losing_streak']} final={money(r['final_bankroll'])}")
    lines.append("\n## High-hit positive ROI candidates: bets>=100, hit>=52%, ROI>0, DD<=20% at 0.5%")
    if high_hit_positive:
        for i,r in enumerate(high_hit_positive[:20],1):
            avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
            lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} cap={r['daily_cap']} gate={r['min_grouped_odds']} bets={r['bets']} hit={pc(r['hit_rate'])} avg={avg} ROI={pc(r['flat_roi'])} DD={r['max_drawdown_pct']:.1f}% L={r['worst_losing_streak']}")
    else:
        lines.append("None found under the strict comfort criteria. Relax criteria or test first-set moneyline markets next.")
    lines.append("\nInterpretation: Comfort models are for psychological smoothness. Do not replace Core/VIP unless ROI, train/test, and live tracking support it.")
    (out/"comfort_optimizer_report.md").write_text("\n".join(lines),encoding="utf-8")

if __name__ == "__main__":
    main()
