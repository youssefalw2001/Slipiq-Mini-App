#!/usr/bin/env python3
"""SlipIQ Signal Room Risk Optimizer.

Takes the current First Set Lab Core/VIP lanes and searches safer launch settings:
- daily caps
- stricter grouped-odds gates
- Core vs VIP portfolios
- 0.25%, 0.5%, 1%, 2%, 4% bankroll risk simulations
- train/test stability

Goal: keep useful volume and ROI while reducing drawdown and losing streaks.
"""
from __future__ import annotations

import argparse, csv, json, math
from collections import defaultdict
from datetime import datetime
from pathlib import Path

VALID_SCORES = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6","0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
SCORE_COLS = {"6:3":"odds_6_3","6:4":"odds_6_4","7:5":"odds_7_5","3:6":"odds_3_6","4:6":"odds_4_6","5:7":"odds_5_7"}
TOUR_MAP = {"265":"ATP", "266":"WTA"}
RISK_LEVELS = [0.0025, 0.005, 0.01, 0.02, 0.04]

LANE_TEMPLATES = [
    dict(lane="CORE_P1_ATP_GS_BET365", access="CORE_AND_VIP", books={"bet365"}, scores=["6:3","6:4"], trigger="6:4", trig_min=5.00, trig_max=6.25, tour="ATP", group="GRAND_SLAM", gates=[2.50,2.60,2.75,3.00], quality=4),
    dict(lane="CORE_P1_MIRROR_WTA_OTHER", access="CORE_AND_VIP", books={"bet365","1xBet"}, scores=["6:3","6:4","7:5"], trigger="6:4", trig_min=5.00, trig_max=8.00, tour="WTA", group="OTHER_TOUR", gates=[2.30,2.40,2.50,2.60], quality=2),
    dict(lane="VIP_P1_ATP_GS_MULTI", access="VIP_ONLY", books={"bet365","1xBet","10Bet"}, scores=["6:3","6:4"], trigger="6:4", trig_min=5.00, trig_max=6.25, tour="ATP", group="GRAND_SLAM", gates=[2.60,2.75,3.00], quality=3),
    dict(lane="VIP_P2_V3_SHAPE", access="VIP_ONLY", books={"bet365","1xBet","10Bet"}, scores=["3:6","4:6","5:7"], trigger="4:6", trig_min=6.25, trig_max=6.99, tour="ANY", group="ANY", gates=[3.05,3.20,3.30,3.50], quality=2),
]
PORTFOLIOS = {"CORE_ROOM":{"CORE_AND_VIP"}, "VIP_ROOM_ALL":{"CORE_AND_VIP","VIP_ONLY"}, "VIP_EXTRA_ONLY":{"VIP_ONLY"}}
DAILY_CAPS = [0, 2, 3, 4, 5, 7, 10]


def clean(x): return str(x or "").strip()
def fnum(x):
    try:
        if x is None or clean(x)=="": return None
        v=float(x); return v if math.isfinite(v) else None
    except Exception: return None

def grouped(vals):
    nums=[fnum(v) for v in vals]
    if any(v is None or v<=1 for v in nums): return None
    s=sum(1/v for v in nums)
    return 1/s if s else None

def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f: return list(csv.DictReader(f))
def write_csv(path, rows, fields):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path,"w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(rows)

def tour(row):
    k=clean(row.get("event_type_key"))
    if k in TOUR_MAP: return TOUR_MAP[k]
    s=f"{row.get('event_type_type','')} {row.get('tournament_name','')}".lower()
    if "wta" in s or "women" in s: return "WTA"
    if "atp" in s or "men" in s: return "ATP"
    return "UNKNOWN"

def tgroup(row):
    t=clean(row.get("tournament_name")).lower()
    if any(k in t for k in ["australian open","roland garros","french open","wimbledon","us open"]): return "GRAND_SLAM"
    if any(k in t for k in ["indian wells","miami","monte carlo","madrid","rome","italian open","canada","canadian open","toronto","montreal","cincinnati","shanghai","paris","beijing","wuhan","doha","dubai","qatar open"]): return "MASTERS_1000"
    if any(k in t for k in ["barcelona","halle","queen","queens","london","stuttgart","charleston","washington","hamburg","tokyo","acapulco","eastbourne","rotterdam","basel","vienna","adelaide","brisbane","bad homburg","berlin","strasbourg","antwerp","dallas","rio","astana","chengdu","zhuhai","seoul"]): return "STRONG_500_250"
    if any(k in t for k in ["challenger","itf","m25","m15","w15","w25","w35","w50","w75","w100","w125"]): return "LOWER_TIER"
    return "OTHER_TOUR"

def ts(row):
    try:
        tm=clean(row.get("event_time")) or "00:00"
        return datetime.fromisoformat(f"{clean(row.get('event_date'))}T{tm if len(tm)!=5 else tm+':00'}").timestamp()
    except Exception: return 0

def norm(raw):
    r={k:clean(raw.get(k)) for k in ["event_key","event_date","event_time","match_name","bookmaker","tournament_name","first_set_score","event_type_key","event_type_type"]}
    for c in set(SCORE_COLS.values()): r[c]=fnum(raw.get(c))
    r["tour"]=tour(r); r["tournament_group"]=tgroup(r); r["ts"]=ts(r)
    return r

def precompute(rows):
    out=[]; invalid=defaultdict(int)
    for r in rows:
        if not r.get("first_set_score"): continue
        if r["first_set_score"] not in VALID_SCORES:
            invalid[r["first_set_score"]]+=1; continue
        for lane in LANE_TEMPLATES:
            if r["bookmaker"] not in lane["books"]: continue
            if lane["tour"]!="ANY" and r["tour"]!=lane["tour"]: continue
            if lane["group"]!="ANY" and r["tournament_group"]!=lane["group"]: continue
            odds=[r.get(SCORE_COLS[s]) for s in lane["scores"]]
            go=grouped(odds); trig=r.get(SCORE_COLS[lane["trigger"]])
            if go is None or trig is None: continue
            if trig < lane["trig_min"] or trig > lane["trig_max"]: continue
            out.append({"event_key":r["event_key"],"event_date":r["event_date"],"event_time":r["event_time"],"ts":r["ts"],"bookmaker":r["bookmaker"],"tour":r["tour"],"tournament_group":r["tournament_group"],"tournament_name":r["tournament_name"],"lane":lane["lane"],"access":lane["access"],"scores":"/".join(lane["scores"]),"trigger_odds":trig,"grouped_odds":go,"quality":lane["quality"],"won":r["first_set_score"] in set(lane["scores"])})
    return out, dict(sorted(invalid.items()))

def split_dates(rows, ratio):
    ds=sorted({r["event_date"] for r in rows if r.get("event_date")})
    if len(ds)<3: return set(ds), set(), ds[-1] if ds else ""
    cutoff=ds[max(1,min(len(ds)-1,int(len(ds)*ratio)))]
    return {d for d in ds if d<cutoff}, {d for d in ds if d>=cutoff}, cutoff

def dedupe(rows):
    g=defaultdict(list)
    for r in rows: g[(r["event_key"],r["lane"],r["access"],r["scores"])].append(r)
    return [max(v, key=lambda x:(x["quality"], x["grouped_odds"], x["trigger_odds"])) for v in g.values()]

def cap_rows(rows, cap):
    rows=dedupe(rows)
    if cap<=0: return sorted(rows, key=lambda x:(x["ts"],x["event_key"],x["lane"]))
    by=defaultdict(list)
    for r in rows: by[r["event_date"]].append(r)
    out=[]
    for d, arr in sorted(by.items()):
        ranked=sorted(arr, key=lambda x:(x["quality"],x["grouped_odds"],x["trigger_odds"]), reverse=True)
        used=set(); keep=[]
        for r in ranked:
            if r["event_key"] in used: continue
            used.add(r["event_key"]); keep.append(r)
            if len(keep)>=cap: break
        out.extend(keep)
    return sorted(out, key=lambda x:(x["ts"],x["event_key"],x["lane"]))

def metrics(rows, start, risk):
    rows=[r for r in rows if r.get("grouped_odds") and r["grouped_odds"]>1]
    bets=len(rows); wins=sum(1 for r in rows if r["won"])
    avg=sum(r["grouped_odds"] for r in rows)/bets if bets else None
    units=sum((r["grouped_odds"]-1) if r["won"] else -1 for r in rows)
    months={r["event_date"][:7] for r in rows if r.get("event_date")}; days={r["event_date"] for r in rows if r.get("event_date")}
    mpl=defaultdict(float); lm=defaultdict(int); bm=defaultdict(int)
    for r in rows:
        mpl[r["event_date"][:7]] += (r["grouped_odds"]-1) if r["won"] else -1; lm[r["lane"]]+=1; bm[r["bookmaker"]]+=1
    bank=start; peak=start; maxdd=0; lose=0; worst=0
    for r in sorted(rows, key=lambda x:(x["ts"],x["event_key"],x["lane"])):
        stake=bank*risk
        if r["won"]: bank += stake*(r["grouped_odds"]-1); lose=0
        else: bank -= stake; lose+=1; worst=max(worst,lose)
        peak=max(peak,bank); maxdd=max(maxdd,(peak-bank)/peak if peak else 0)
    hit=wins/bets if bets else None; be=1/avg if avg else None
    return {"bets":bets,"wins":wins,"losses":bets-wins,"hit_rate":hit,"avg_odds":avg,"breakeven_hit_rate":be,"edge_vs_breakeven":hit-be if hit is not None and be is not None else None,"flat_profit_units":units,"flat_roi":units/bets if bets else None,"months":len(months),"active_days":len(days),"positive_months":sum(1 for v in mpl.values() if v>0),"positive_month_ratio":sum(1 for v in mpl.values() if v>0)/len(months) if months else None,"bets_per_month":bets/len(months) if months else None,"bets_per_active_day":bets/len(days) if days else None,"final_bankroll":bank,"compound_return_pct":(bank/start-1)*100 if start else None,"max_drawdown_pct":maxdd*100,"worst_losing_streak":worst,"lane_mix":json.dumps(dict(sorted(lm.items()))),"book_mix":json.dumps(dict(sorted(bm.items())))}

def strategy_score(m):
    if m["bets"] < 150: return -999
    roi=m["flat_roi"] or 0; hit=m["hit_rate"] or 0; dd=m["max_drawdown_pct"] or 0; pm=m["positive_month_ratio"] or 0
    volume=min(45, math.log10(max(m["bets"],1))*18)
    return volume + roi*140 + hit*25 + pm*25 - max(0,dd-25)*1.1 - max(0,m["worst_losing_streak"]-10)*2.0

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--first-set-wide", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-signal-room-risk-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000)
    ap.add_argument("--train-ratio", type=float, default=.70)
    args=ap.parse_args()
    out=Path(args.out); out.mkdir(parents=True, exist_ok=True)
    wide=[norm(r) for r in read_csv(args.first_set_wide)]
    base,invalid=precompute(wide)
    train_dates,test_dates,cutoff=split_dates(base,args.train_ratio)

    # gate combinations: keep ATP core fixed in most cases but allow tightening all lanes.
    combos=[]
    for g0 in [2.50,2.60,2.75,3.00]:
      for g1 in [2.30,2.40,2.50,2.60]:
       for g2 in [2.60,2.75,3.00]:
        for g3 in [3.05,3.20,3.30,3.50]:
          combos.append({"CORE_P1_ATP_GS_BET365":g0,"CORE_P1_MIRROR_WTA_OTHER":g1,"VIP_P1_ATP_GS_MULTI":g2,"VIP_P2_V3_SHAPE":g3})

    results=[]; train_test=[]; best_rows={}
    for ci,gates in enumerate(combos,1):
        gated=[r for r in base if r["grouped_odds"] >= gates[r["lane"]]]
        for portfolio, access_set in PORTFOLIOS.items():
            pbase=[r for r in gated if r["access"] in access_set]
            for cap in DAILY_CAPS:
                rows=cap_rows(pbase, cap)
                m1=metrics(rows,args.start_bankroll,0.01)
                score=strategy_score(m1)
                row={"combo_id":ci,"portfolio":portfolio,"daily_cap":cap,"score":score,"core_gs_gate":gates["CORE_P1_ATP_GS_BET365"],"core_wta_gate":gates["CORE_P1_MIRROR_WTA_OTHER"],"vip_core_gate":gates["VIP_P1_ATP_GS_MULTI"],"vip_p2_gate":gates["VIP_P2_V3_SHAPE"],"risk_pct":0.01,"split_cutoff_date":cutoff,**m1}
                results.append(row)
                train_test.append({"combo_id":ci,"portfolio":portfolio,"daily_cap":cap,"split":"TRAIN",**metrics([r for r in rows if r["event_date"] in train_dates],args.start_bankroll,0.01)})
                train_test.append({"combo_id":ci,"portfolio":portfolio,"daily_cap":cap,"split":"TEST",**metrics([r for r in rows if r["event_date"] in test_dates],args.start_bankroll,0.01)})
                key=(portfolio,cap,ci)
                if row["bets"]>=150 and len(best_rows)<20 and score>70: best_rows[key]=rows

    fields=["combo_id","portfolio","daily_cap","score","core_gs_gate","core_wta_gate","vip_core_gate","vip_p2_gate","risk_pct","split_cutoff_date","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","lane_mix","book_mix"]
    ranked=sorted(results,key=lambda r:(r["score"], r["flat_roi"] or -9, r["bets"]), reverse=True)
    safe=sorted([r for r in results if r["bets"]>=300 and (r["flat_roi"] or 0)>0 and (r["max_drawdown_pct"] or 999)<=30], key=lambda r:(r["score"], r["bets"]), reverse=True)
    write_csv(out/"signal_room_risk_optimizer_results.csv", ranked, fields)
    write_csv(out/"signal_room_risk_optimizer_safe.csv", safe, fields)
    write_csv(out/"signal_room_risk_optimizer_train_test.csv", train_test, ["combo_id","portfolio","daily_cap","split","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","lane_mix","book_mix"])

    # risk simulations for top 10 ranked strategies.
    sim=[]
    for r in ranked[:10]:
        gates={"CORE_P1_ATP_GS_BET365":r["core_gs_gate"],"CORE_P1_MIRROR_WTA_OTHER":r["core_wta_gate"],"VIP_P1_ATP_GS_MULTI":r["vip_core_gate"],"VIP_P2_V3_SHAPE":r["vip_p2_gate"]}
        rows=cap_rows([x for x in base if x["access"] in PORTFOLIOS[r["portfolio"]] and x["grouped_odds"]>=gates[x["lane"]]], r["daily_cap"])
        for risk in RISK_LEVELS:
            sim.append({"combo_id":r["combo_id"],"portfolio":r["portfolio"],"daily_cap":r["daily_cap"],"risk_pct":risk,**metrics(rows,args.start_bankroll,risk)})
    write_csv(out/"signal_room_risk_optimizer_risk_sims.csv", sim, ["combo_id","portfolio","daily_cap","risk_pct","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","lane_mix","book_mix"])

    cards={"generated_at":datetime.utcnow().isoformat()+"Z","wide_rows":len(wide),"base_candidate_rows":len(base),"invalid_first_set_score_counts":invalid,"rules_tested":len(results),"best_overall":ranked[0] if ranked else None,"best_safe":safe[0] if safe else None,"best_core":next((r for r in ranked if r["portfolio"]=="CORE_ROOM"),None),"best_vip_all":next((r for r in ranked if r["portfolio"]=="VIP_ROOM_ALL"),None),"top_25":ranked[:25],"top_safe_25":safe[:25]}
    (out/"signal_room_risk_optimizer_cards.json").write_text(json.dumps(cards,indent=2),encoding="utf-8")

    def pc(v): return "n/a" if v is None else f"{v*100:.2f}%"
    def money(v): return "n/a" if v is None else f"${v:,.0f}"
    lines=["# Signal Room Risk Optimizer","",f"Base candidate rows: {len(base)}",f"Rules tested: {len(results)}",f"Invalid first-set scores excluded: {json.dumps(invalid, sort_keys=True)}","","## Top ranked settings"]
    for i,r in enumerate(ranked[:30],1):
        avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. combo={r['combo_id']} {r['portfolio']} cap={r['daily_cap']} score={r['score']:.1f} bets={r['bets']} hit={pc(r['hit_rate'])} avg={avg} ROI={pc(r['flat_roi'])} final@1%={money(r['final_bankroll'])} DD={r['max_drawdown_pct']:.1f}% L={r['worst_losing_streak']} gates coreGS={r['core_gs_gate']} coreWTA={r['core_wta_gate']} vipCore={r['vip_core_gate']} vipP2={r['vip_p2_gate']}")
    lines.append("\n## Safe candidates: bets>=300, ROI>0, max DD<=30% at 1% risk")
    for i,r in enumerate(safe[:20],1):
        avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. combo={r['combo_id']} {r['portfolio']} cap={r['daily_cap']} bets={r['bets']} hit={pc(r['hit_rate'])} avg={avg} ROI={pc(r['flat_roi'])} DD={r['max_drawdown_pct']:.1f}% L={r['worst_losing_streak']}")
    lines.append("\nInterpretation: choose Core launch settings from safe candidates, not highest ROI only. VIP can accept more variance, but label it clearly.")
    (out/"signal_room_risk_optimizer_report.md").write_text("\n".join(lines),encoding="utf-8")

if __name__=="__main__": main()
