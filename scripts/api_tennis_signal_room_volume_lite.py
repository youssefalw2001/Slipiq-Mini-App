#!/usr/bin/env python3
"""Signal Room Volume Lite for SlipIQ First Set Lab.

Focused historical test for the exact Core/VIP live scanner lanes.
Invalid/incomplete first-set scores such as 0:0, 0:5, 2:5, 3:5, 5:6 are excluded.
"""
from __future__ import annotations

import argparse, csv, json, math
from collections import defaultdict
from datetime import datetime
from pathlib import Path

VALID_FIRST_SET_SCORES = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6","0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
SCORE_COLS = {
    "6:3": "odds_6_3", "6:4": "odds_6_4", "7:5": "odds_7_5",
    "3:6": "odds_3_6", "4:6": "odds_4_6", "5:7": "odds_5_7",
}
TOUR_MAP = {"265": "ATP", "266": "WTA"}
LANES = [
    dict(lane="CORE_P1_ATP_GS_BET365", access="CORE_AND_VIP", books={"bet365"}, scores=["6:3","6:4"], trigger="6:4", trig_min=5.00, trig_max=6.25, min_grouped=2.50, tour="ATP", group="GRAND_SLAM"),
    dict(lane="CORE_P1_MIRROR_WTA_OTHER", access="CORE_AND_VIP", books={"bet365","1xBet"}, scores=["6:3","6:4","7:5"], trigger="6:4", trig_min=5.00, trig_max=8.00, min_grouped=2.30, tour="WTA", group="OTHER_TOUR"),
    dict(lane="VIP_P1_ATP_GS_MULTI", access="VIP_ONLY", books={"bet365","1xBet","10Bet"}, scores=["6:3","6:4"], trigger="6:4", trig_min=5.00, trig_max=6.25, min_grouped=2.60, tour="ATP", group="GRAND_SLAM"),
    dict(lane="VIP_P2_V3_SHAPE", access="VIP_ONLY", books={"bet365","1xBet","10Bet"}, scores=["3:6","4:6","5:7"], trigger="4:6", trig_min=6.25, trig_max=6.99, min_grouped=3.05, tour="ANY", group="ANY"),
]
PORTFOLIOS = {"CORE_ROOM": {"CORE_AND_VIP"}, "VIP_ROOM_ALL": {"CORE_AND_VIP","VIP_ONLY"}, "VIP_EXTRA_ONLY": {"VIP_ONLY"}}

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

def read_csv(p):
    with open(p, newline="", encoding="utf-8") as f: return list(csv.DictReader(f))
def write_csv(p, rows, fields):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", newline="", encoding="utf-8") as f:
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

def norm(r):
    out={k:clean(r.get(k)) for k in ["event_key","event_date","event_time","player1","player2","match_name","bookmaker","tournament_name","first_set_score","event_type_key","event_type_type"]}
    for c in set(SCORE_COLS.values()): out[c]=fnum(r.get(c))
    out["tour"]=tour(out); out["tournament_group"]=tgroup(out); out["ts"]=ts(out)
    return out

def build(rows):
    out=[]
    invalid_score_counts=defaultdict(int)
    for r in rows:
        if not r.get("first_set_score"):
            continue
        if r["first_set_score"] not in VALID_FIRST_SET_SCORES:
            invalid_score_counts[r["first_set_score"]] += 1
            continue
        for lane in LANES:
            if r["bookmaker"] not in lane["books"]: continue
            if lane["tour"]!="ANY" and r["tour"]!=lane["tour"]: continue
            if lane["group"]!="ANY" and r["tournament_group"]!=lane["group"]: continue
            odds=[r.get(SCORE_COLS[s]) for s in lane["scores"]]
            go=grouped(odds)
            trig=r.get(SCORE_COLS[lane["trigger"]])
            if go is None or go < lane["min_grouped"]: continue
            if trig is None or trig < lane["trig_min"] or trig > lane["trig_max"]: continue
            out.append({
                "event_key":r["event_key"],"event_date":r["event_date"],"event_time":r["event_time"],"ts":r["ts"],"match_name":r["match_name"],
                "bookmaker":r["bookmaker"],"tour":r["tour"],"tournament_group":r["tournament_group"],"tournament_name":r["tournament_name"],
                "lane":lane["lane"],"access":lane["access"],"scores":"/".join(lane["scores"]),"trigger_score":lane["trigger"],"trigger_odds":trig,
                "grouped_odds":go,"first_set_score":r["first_set_score"],"won":r["first_set_score"] in set(lane["scores"])
            })
    return out, dict(sorted(invalid_score_counts.items()))

def dedupe(rows):
    g=defaultdict(list)
    for r in rows: g[(r["event_key"],r["lane"],r["access"],r["scores"])].append(r)
    return [max(v, key=lambda x:(x["grouped_odds"], x["trigger_odds"])) for v in g.values()]

def split_dates(rows, ratio):
    ds=sorted({r["event_date"] for r in rows if r.get("event_date")})
    if len(ds)<3: return set(ds), set(), ds[-1] if ds else ""
    cutoff=ds[max(1,min(len(ds)-1,int(len(ds)*ratio)))]
    return {d for d in ds if d<cutoff}, {d for d in ds if d>=cutoff}, cutoff

def metrics(rows, start, risk):
    rows=[r for r in rows if r.get("grouped_odds") and r["grouped_odds"]>1]
    bets=len(rows); wins=sum(1 for r in rows if r["won"])
    avg=sum(r["grouped_odds"] for r in rows)/bets if bets else None
    units=sum((r["grouped_odds"]-1) if r["won"] else -1 for r in rows)
    months={r["event_date"][:7] for r in rows if r.get("event_date")}; days={r["event_date"] for r in rows if r.get("event_date")}
    mpl=defaultdict(float); lm=defaultdict(int); bm=defaultdict(int)
    for r in rows:
        m=r["event_date"][:7]; mpl[m]+= (r["grouped_odds"]-1) if r["won"] else -1; lm[r["lane"]]+=1; bm[r["bookmaker"]]+=1
    bank=start; peak=start; dd=0; lose=0; worst=0
    for r in sorted(rows, key=lambda x:(x["ts"],x["event_key"],x["lane"])):
        stake=bank*risk
        if r["won"]: bank += stake*(r["grouped_odds"]-1); lose=0
        else: bank -= stake; lose+=1; worst=max(worst,lose)
        peak=max(peak,bank); dd=max(dd,(peak-bank)/peak if peak else 0)
    hit=wins/bets if bets else None; be=1/avg if avg else None
    return {"bets":bets,"wins":wins,"losses":bets-wins,"hit_rate":hit,"avg_odds":avg,"breakeven_hit_rate":be,"edge_vs_breakeven":hit-be if hit is not None and be is not None else None,"flat_profit_units":units,"flat_roi":units/bets if bets else None,"months":len(months),"active_days":len(days),"positive_months":sum(1 for v in mpl.values() if v>0),"positive_month_ratio":sum(1 for v in mpl.values() if v>0)/len(months) if months else None,"bets_per_month":bets/len(months) if months else None,"bets_per_active_day":bets/len(days) if days else None,"final_bankroll":bank,"compound_profit":bank-start,"compound_return_pct":(bank/start-1)*100 if start else None,"max_drawdown_pct":dd*100,"worst_losing_streak":worst,"lane_mix":json.dumps(dict(sorted(lm.items()))),"book_mix":json.dumps(dict(sorted(bm.items())))}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--first-set-wide", required=True); ap.add_argument("--out", default="artifacts/output/api-tennis-signal-room-volume-lite"); ap.add_argument("--start-bankroll", type=float, default=5000); ap.add_argument("--risk-pct", type=float, default=.02); ap.add_argument("--dream-risk-pct", type=float, default=.04); ap.add_argument("--train-ratio", type=float, default=.70)
    a=ap.parse_args(); out=Path(a.out); out.mkdir(parents=True, exist_ok=True)
    wide=[norm(r) for r in read_csv(a.first_set_wide)]; raw,invalid_counts=build(wide); sig=dedupe(raw); tr,te,cut=split_dates(sig,a.train_ratio)
    signal_fields=["event_key","event_date","event_time","match_name","bookmaker","tour","tournament_group","tournament_name","lane","access","scores","trigger_score","trigger_odds","grouped_odds","first_set_score","won"]
    write_csv(out/"signal_room_volume_lite_signals.csv", sig, signal_fields)
    results=[]; tt=[]
    for pf,acc in PORTFOLIOS.items():
        rows=[r for r in sig if r["access"] in acc]
        for risk in [a.risk_pct,a.dream_risk_pct]: results.append({"portfolio":pf,"risk_pct":risk,"split_cutoff_date":cut,**metrics(rows,a.start_bankroll,risk)})
        tt.append({"portfolio":pf,"split":"TRAIN","split_cutoff_date":cut,**metrics([r for r in rows if r["event_date"] in tr],a.start_bankroll,a.risk_pct)})
        tt.append({"portfolio":pf,"split":"TEST","split_cutoff_date":cut,**metrics([r for r in rows if r["event_date"] in te],a.start_bankroll,a.risk_pct)})
    fields=["portfolio","risk_pct","split_cutoff_date","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_profit","compound_return_pct","max_drawdown_pct","worst_losing_streak","lane_mix","book_mix"]
    write_csv(out/"signal_room_volume_lite_results.csv", results, fields)
    write_csv(out/"signal_room_volume_lite_train_test.csv", tt, ["portfolio","split","split_cutoff_date"]+[f for f in fields if f not in {"portfolio","risk_pct","split_cutoff_date"}])
    cards={"generated_at":datetime.utcnow().isoformat()+"Z","wide_rows":len(wide),"invalid_first_set_score_counts":invalid_counts,"raw_candidate_rows":len(raw),"deduped_signals":len(sig),"split_cutoff_date":cut,"results":results,"train_test":tt}
    (out/"signal_room_volume_lite_cards.json").write_text(json.dumps(cards,indent=2),encoding="utf-8")
    def pc(v): return "n/a" if v is None else f"{v*100:.2f}%"
    def mo(v): return "n/a" if v is None else f"${v:,.0f}"
    lines=["# Signal Room Volume Lite","",f"Wide rows: {len(wide)}",f"Invalid first-set score counts excluded: {json.dumps(invalid_counts, sort_keys=True)}",f"Raw candidate rows: {len(raw)}",f"Deduped signals: {len(sig)}",f"Train/test cutoff: {cut}","","## Results"]
    for r in results:
        avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        bpm="n/a" if r["bets_per_month"] is None else f"{r['bets_per_month']:.1f}"
        lines.append(f"- {r['portfolio']} {r['risk_pct']*100:.0f}%: bets={r['bets']}, wins={r['wins']}, hit={pc(r['hit_rate'])}, avg_odds={avg}, ROI={pc(r['flat_roi'])}, final={mo(r['final_bankroll'])}, DD={r['max_drawdown_pct']:.1f}%, worst_L={r['worst_losing_streak']}, bets/month={bpm}")
    lines.append("\nInterpretation: Core is widened but still filtered. VIP gets Core plus premium lanes. Live paper tracking still required before paid proof claims.")
    (out/"signal_room_volume_lite_report.md").write_text("\n".join(lines), encoding="utf-8")
if __name__=="__main__": main()
