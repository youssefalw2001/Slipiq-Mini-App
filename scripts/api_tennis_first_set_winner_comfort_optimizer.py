#!/usr/bin/env python3
"""SlipIQ / First Set Lab - First Set Winner Comfort Optimizer.

Builds a true comfort-layer optimizer from API Tennis Home/Away (1st Set)
rows in odds_full_long_combined.csv.

Important: this does NOT mix full-match Home/Away with first-set winner odds.
The API Tennis warehouse long odds shape is:
  market_name, option_name, odds_decimal
"""
from __future__ import annotations

import argparse, csv, json, math, re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Iterable

VALID = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6","0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
P1_WIN = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6"}
P2_WIN = {"0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
TOUR_MAP = {"265":"ATP", "266":"WTA"}
RISK_LEVELS = [0.0025, 0.005, 0.01, 0.02]
DAILY_CAPS = [1,2,3,5,0]
ODDS_GATES = [1.20,1.30,1.40,1.50,1.60,1.70,1.80,1.90,2.00,2.10,2.20]
BOOK_GROUPS = {
    "bet365":{"bet365"}, "1xBet":{"1xBet"}, "10Bet":{"10Bet"},
    "bet365_1xBet":{"bet365","1xBet"},
    "bet365_1xBet_10Bet":{"bet365","1xBet","10Bet"},
    "all_major":{"bet365","1xBet","10Bet","Betano","WilliamHill","Unibet","Betfair","Betway"},
    "all_books": None,
}
TOUR_FILTERS = ["ATP","WTA","ALL"]
GROUP_FILTERS = ["GRAND_SLAM","MASTERS_1000","STRONG_500_250","OTHER_TOUR","LOWER_TIER","ALL"]
FAMILIES = [
    "P1_FIRST_SET_WINNER", "P2_FIRST_SET_WINNER", "FIRST_SET_FAVORITE", "FIRST_SET_UNDERDOG",
    "STRONG_FAVORITE", "FAVORITE", "SLIGHT_FAVORITE", "NEAR_EVEN", "SLIGHT_UNDERDOG", "UNDERDOG",
]
FIRST_SET_WINNER_NAMES = {"home/away (1st set)", "home away (1st set)", "home/away 1st set", "home away 1st set", "1st set winner", "first set winner", "set 1 winner"}


def clean(x) -> str:
    return str(x or "").replace("\ufeff", "").strip()

def norm(x) -> str:
    return re.sub(r"\s+", " ", clean(x).lower().replace("_", " ").replace("-", " ")).strip()

def fnum(x) -> Optional[float]:
    try:
        s=clean(x)
        if not s: return None
        v=float(s)
        return v if math.isfinite(v) else None
    except Exception:
        return None

def read_csv(path: Path):
    with path.open(newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)

def header(path: Path) -> List[str]:
    try:
        with path.open(newline="", encoding="utf-8") as f: return next(csv.reader(f), [])
    except Exception: return []

def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w=csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader(); w.writerows(rows)

def score_norm(x) -> Optional[str]:
    s=clean(x).replace("-", ":")
    if s in VALID: return s
    m=re.search(r"([0-7])(?:\.[0-9]+)?\s*[:/]\s*([0-7])(?:\.[0-9]+)?", s)
    if not m: return None
    z=f"{m.group(1)}:{m.group(2)}"
    return z if z in VALID else None

def set_winner(score: str) -> Optional[str]:
    s=score_norm(score)
    if s in P1_WIN: return "P1"
    if s in P2_WIN: return "P2"
    return None

def tour(row: Dict) -> str:
    k=clean(row.get("event_type_key"))
    if k in TOUR_MAP: return TOUR_MAP[k]
    s=norm(f"{row.get('event_type_type','')} {row.get('tournament_name','')}")
    if "wta" in s or "women" in s: return "WTA"
    if "atp" in s or "men" in s: return "ATP"
    return "UNKNOWN"

def tgroup(name: str) -> str:
    t=norm(name)
    if any(k in t for k in ["australian open","roland garros","french open","wimbledon","us open"]): return "GRAND_SLAM"
    if any(k in t for k in ["indian wells","miami","monte carlo","madrid","rome","italian open","canada","canadian open","toronto","montreal","cincinnati","shanghai","paris","beijing","wuhan","doha","dubai","qatar open"]): return "MASTERS_1000"
    if any(k in t for k in ["barcelona","halle","queen","queens","london","stuttgart","charleston","washington","hamburg","tokyo","acapulco","eastbourne","rotterdam","basel","vienna","adelaide","brisbane","bad homburg","berlin","strasbourg","antwerp","dallas","rio","astana","chengdu","zhuhai","seoul"]): return "STRONG_500_250"
    if any(k in t for k in ["challenger","itf","m25","m15","w15","w25","w35","w50","w75","w100","w125"]): return "LOWER_TIER"
    return "OTHER_TOUR"

def ts(date: str, time: str) -> float:
    try:
        tm=clean(time) or "00:00"
        return datetime.fromisoformat(f"{clean(date)}T{tm if len(tm)!=5 else tm+':00'}").timestamp()
    except Exception: return 0.0

def market_is_first_set_winner(market: str) -> bool:
    m=norm(market)
    return m in FIRST_SET_WINNER_NAMES or ("home/away" in m and ("1st set" in m or "first set" in m)) or "first set winner" in m or "1st set winner" in m or "set 1 winner" in m

def market_is_full_match_homeaway(market: str) -> bool:
    m=norm(market)
    return m in {"home/away","home away","match winner","winner","moneyline","1x2"}

def bucket(odds: float) -> str:
    if odds < 1.40: return "STRONG_FAVORITE"
    if odds < 1.65: return "FAVORITE"
    if odds < 1.90: return "SLIGHT_FAVORITE"
    if odds <= 2.10: return "NEAR_EVEN"
    if odds <= 2.50: return "SLIGHT_UNDERDOG"
    return "UNDERDOG"

def side_from_option(option: str, p1: str = "", p2: str = "") -> Optional[str]:
    o=norm(option); a=norm(p1); b=norm(p2)
    if o in {"1","home","player 1","player1","p1","team 1","first player"}: return "P1"
    if o in {"2","away","player 2","player2","p2","team 2","second player"}: return "P2"
    if a and (o == a or a in o or o in a): return "P1"
    if b and (o == b or b in o or o in b): return "P2"
    if re.search(r"\bhome\b", o): return "P1"
    if re.search(r"\baway\b", o): return "P2"
    return None

def load_results(warehouse: Path):
    path=warehouse/"first_set_correct_score_wide_combined.csv"
    results={}; diagnostics=[]; invalid=Counter()
    if not path.exists(): return results, ["Missing first_set_correct_score_wide_combined.csv"], dict(invalid)
    seen=0
    for r in read_csv(path):
        ek=clean(r.get("event_key")); sc=score_norm(r.get("first_set_score"))
        if not ek: continue
        if not sc:
            if clean(r.get("first_set_score")): invalid[clean(r.get("first_set_score"))]+=1
            continue
        if ek not in results:
            results[ek]={
                "event_key":ek, "event_date":clean(r.get("event_date")), "event_time":clean(r.get("event_time")),
                "match_name":clean(r.get("match_name")), "player1":clean(r.get("player1")), "player2":clean(r.get("player2")),
                "tour":tour(r), "tournament_group":tgroup(clean(r.get("tournament_name"))), "tournament_name":clean(r.get("tournament_name")),
                "first_set_score":sc, "first_set_winner":set_winner(sc),
            }
            seen+=1
    diagnostics.append(f"Loaded {seen} settled first-set results from {path.name}")
    return results, diagnostics, dict(sorted(invalid.items()))

def build_candidates(warehouse: Path, results: Dict[str, Dict]):
    audit={"files_inspected":[], "market_names_found_top_200":{}, "row_counts_by_first_set_market":{}, "candidate_first_set_winner_markets":{}, "other_first_set_markets_found":{}, "full_match_homeaway_markets_found":{}, "bookmakers_found_for_first_set_winner":{}, "unmapped_first_set_outcomes_top_50":{}, "home_away_1st_set_exists":False, "first_set_winner_market_exists":False, "only_full_match_home_away_exists":False, "candidate_rows_built":0, "diagnostic":""}
    market_counts=Counter(); fs_counts=Counter(); cand_markets=Counter(); other_fs=Counter(); full_home=Counter(); books=Counter(); unmapped=Counter()
    pair={}
    for p in sorted(warehouse.glob("*.csv")):
        h=header(p); audit["files_inspected"].append({"file":p.name,"headers":h[:80],"usable_long_odds_shape": {"event_key","bookmaker","market_name","option_name","odds_decimal"}.issubset(set(h)), "rows_seen":0, "markets_seen":0})
        idx=len(audit["files_inspected"])-1
        if not {"event_key","bookmaker","market_name"}.issubset(set(h)): continue
        usable={"option_name","odds_decimal"}.issubset(set(h))
        for r in read_csv(p):
            audit["files_inspected"][idx]["rows_seen"] += 1
            m=clean(r.get("market_name")); ek=clean(r.get("event_key"))
            if not m: continue
            market_counts[m]+=1
            isfs = "1st set" in norm(m) or "first set" in norm(m) or "set 1" in norm(m)
            if isfs: fs_counts[m]+=1
            if market_is_first_set_winner(m): cand_markets[m]+=1
            elif market_is_full_match_homeaway(m): full_home[m]+=1
            elif isfs: other_fs[m]+=1
            if not usable or not market_is_first_set_winner(m) or ek not in results: continue
            meta=results[ek]
            side=side_from_option(r.get("option_name"), meta.get("player1",""), meta.get("player2",""))
            odds=fnum(r.get("odds_decimal")); book=clean(r.get("bookmaker"))
            if side not in {"P1","P2"}:
                unmapped[clean(r.get("option_name"))]+=1; continue
            if not odds or odds <= 1 or not book: continue
            key=(ek,book,m)
            row=pair.setdefault(key,{**meta,"bookmaker":book,"market_name":m,"p1_first_set_odds":None,"p2_first_set_odds":None,"p1_outcome_label":"","p2_outcome_label":""})
            if side=="P1": row["p1_first_set_odds"]=odds; row["p1_outcome_label"]=clean(r.get("option_name"))
            else: row["p2_first_set_odds"]=odds; row["p2_outcome_label"]=clean(r.get("option_name"))
            books[book]+=1
    out=[]
    for row in pair.values():
        p1=row.get("p1_first_set_odds"); p2=row.get("p2_first_set_odds")
        if not p1 or not p2: continue
        fav="P1" if p1<=p2 else "P2"
        for side,odds in [("P1",p1),("P2",p2)]:
            b=bucket(odds)
            out.append({
                "event_key":row["event_key"],"event_date":row["event_date"],"event_time":row["event_time"],"ts":ts(row["event_date"],row["event_time"]),"match_name":row["match_name"],"player1":row["player1"],"player2":row["player2"],"tour":row["tour"],"tournament_group":row["tournament_group"],"tournament_name":row["tournament_name"],"bookmaker":row["bookmaker"],"market_name":row["market_name"],"p1_first_set_odds":p1,"p2_first_set_odds":p2,"first_set_score":row["first_set_score"],"first_set_winner":row["first_set_winner"],"side":side,"side_odds":odds,"side_win":row["first_set_winner"]==side,"favorite_side":fav,"selected_is_favorite":side==fav,"selected_is_underdog":side!=fav,"favorite_bucket":b,"odds_bucket":b,
            })
    audit.update({"market_names_found_top_200":dict(market_counts.most_common(200)),"row_counts_by_first_set_market":dict(fs_counts.most_common()),"candidate_first_set_winner_markets":dict(cand_markets.most_common()),"other_first_set_markets_found":dict(other_fs.most_common(100)),"full_match_homeaway_markets_found":dict(full_home.most_common(50)),"bookmakers_found_for_first_set_winner":dict(books.most_common()),"unmapped_first_set_outcomes_top_50":dict(unmapped.most_common(50)),"home_away_1st_set_exists":any("home/away" in norm(k) and "1st set" in norm(k) for k in cand_markets),"first_set_winner_market_exists":bool(cand_markets),"only_full_match_home_away_exists":bool(full_home) and not bool(cand_markets),"candidate_rows_built":len(out)})
    audit["diagnostic"] = "First-set winner market found and candidates reconstructed." if out else "No usable first-set winner candidates reconstructed. Check option_name labels and odds_decimal fields. Do not use full-match Home/Away as first-set comfort."
    return audit,out

def family_ok(r: Dict, fam: str) -> bool:
    if fam=="P1_FIRST_SET_WINNER": return r["side"]=="P1"
    if fam=="P2_FIRST_SET_WINNER": return r["side"]=="P2"
    if fam=="FIRST_SET_FAVORITE": return r["selected_is_favorite"]
    if fam=="FIRST_SET_UNDERDOG": return r["selected_is_underdog"]
    return r["odds_bucket"]==fam

def dedupe(rows: List[Dict]) -> List[Dict]:
    g=defaultdict(list)
    for r in rows: g[(r["event_key"],r["side"],r["market_name"])].append(r)
    return [max(v,key=lambda x:(x["side_odds"],-abs(x["side_odds"]-1.9))) for v in g.values()]

def cap_rows(rows: List[Dict], cap: int) -> List[Dict]:
    rows=dedupe(rows)
    if cap<=0: return sorted(rows,key=lambda x:(x["ts"],x["event_key"],x["side"]))
    by=defaultdict(list)
    for r in rows: by[r["event_date"]].append(r)
    out=[]
    for day,arr in sorted(by.items()):
        ranked=sorted(arr,key=lambda x:(x["selected_is_favorite"],x["side_odds"],-abs(x["side_odds"]-1.9)), reverse=True)
        used=set(); keep=[]
        for r in ranked:
            if r["event_key"] in used: continue
            used.add(r["event_key"]); keep.append(r)
            if len(keep)>=cap: break
        out.extend(keep)
    return sorted(out,key=lambda x:(x["ts"],x["event_key"],x["side"]))

def split_dates(rows: List[Dict], ratio: float):
    ds=sorted({r["event_date"] for r in rows if r.get("event_date")})
    if len(ds)<3: return set(ds), set(), ds[-1] if ds else ""
    cutoff=ds[max(1,min(len(ds)-1,int(len(ds)*ratio)))]
    return {d for d in ds if d<cutoff},{d for d in ds if d>=cutoff},cutoff

def metrics(rows: List[Dict], start: float, risk: float):
    rows=[r for r in rows if r.get("side_odds") and r["side_odds"]>1]
    bets=len(rows); wins=sum(1 for r in rows if r["side_win"]); avg=sum(r["side_odds"] for r in rows)/bets if bets else None
    units=sum((r["side_odds"]-1) if r["side_win"] else -1 for r in rows)
    months={r["event_date"][:7] for r in rows if r.get("event_date")}; days={r["event_date"] for r in rows if r.get("event_date")}
    mpl=defaultdict(float); fam=defaultdict(int); books=defaultdict(int); buckets=defaultdict(int)
    for r in rows:
        mpl[r["event_date"][:7]] += (r["side_odds"]-1) if r["side_win"] else -1
        fam[r.get("family","missing")]+=1; books[r["bookmaker"]]+=1; buckets[r["odds_bucket"]]+=1
    bank=start; peak=start; dd=0; lose=0; worst=0
    for r in sorted(rows,key=lambda x:(x["ts"],x["event_key"],x["side"])):
        stake=bank*risk
        if r["side_win"]: bank+=stake*(r["side_odds"]-1); lose=0
        else: bank-=stake; lose+=1; worst=max(worst,lose)
        peak=max(peak,bank); dd=max(dd,(peak-bank)/peak if peak else 0)
    hit=wins/bets if bets else None; be=1/avg if avg else None
    return {"bets":bets,"wins":wins,"losses":bets-wins,"hit_rate":hit,"avg_odds":avg,"breakeven_hit_rate":be,"edge_vs_breakeven":hit-be if hit is not None and be is not None else None,"flat_profit_units":units,"flat_roi":units/bets if bets else None,"months":len(months),"active_days":len(days),"positive_months":sum(1 for v in mpl.values() if v>0),"positive_month_ratio":sum(1 for v in mpl.values() if v>0)/len(months) if months else None,"bets_per_month":bets/len(months) if months else None,"bets_per_active_day":bets/len(days) if days else None,"final_bankroll":bank,"compound_return_pct":(bank/start-1)*100 if start else None,"max_drawdown_pct":dd*100,"worst_losing_streak":worst,"family_mix":json.dumps(dict(sorted(fam.items()))),"book_mix":json.dumps(dict(sorted(books.items()))),"bucket_mix":json.dumps(dict(sorted(buckets.items())))}

def flags(train: Dict, test: Dict) -> str:
    f=[]
    if train["bets"]<30 or test["bets"]<30: f.append("low_train_or_test_volume")
    if (train.get("flat_roi") or 0)>0 and (test.get("flat_roi") or 0)<0: f.append("train_positive_test_negative")
    if abs((train.get("flat_roi") or 0)-(test.get("flat_roi") or 0))>0.25: f.append("unstable_train_test_roi")
    if (test.get("hit_rate") or 0)+0.08 < (train.get("hit_rate") or 0): f.append("test_hit_rate_drop")
    return ";".join(f)

def score(m: Dict, tr: Dict, te: Dict, fl: str) -> float:
    if m["bets"]<80: return -999
    hit=m["hit_rate"] or 0; roi=m["flat_roi"] or 0; edge=m["edge_vs_breakeven"] or 0; dd=m["max_drawdown_pct"] or 0; worst=m["worst_losing_streak"] or 0; pm=m["positive_month_ratio"] or 0
    s=hit*120+roi*150+edge*180+pm*25+min(25,math.log10(max(m["bets"],1))*10)
    s-=max(0,dd-12)*2; s-=max(0,worst-6)*3
    if (te.get("flat_roi") or 0)<=0: s-=20
    if fl: s-=15
    return s

def run_optimizer(candidates: List[Dict], out: Path, start: float, ratio: float, audit: Dict, diagnostics: List[str], invalid: Dict[str,int]):
    tr_dates,te_dates,cutoff=split_dates(candidates,ratio)
    results=[]; train_test=[]; combo=0
    for fam in FAMILIES:
        fam_rows=[dict(r,family=fam) for r in candidates if family_ok(r,fam)]
        if not fam_rows: continue
        for bg,books in BOOK_GROUPS.items():
            b_rows=fam_rows if books is None else [r for r in fam_rows if r["bookmaker"] in books]
            if not b_rows: continue
            for tf in TOUR_FILTERS:
                t_rows=b_rows if tf=="ALL" else [r for r in b_rows if r["tour"]==tf]
                if not t_rows: continue
                for gf in GROUP_FILTERS:
                    g_rows=t_rows if gf=="ALL" else [r for r in t_rows if r["tournament_group"]==gf]
                    if not g_rows: continue
                    for gate in ODDS_GATES:
                        gated=[r for r in g_rows if r["side_odds"]>=gate]
                        if len(gated)<50: continue
                        for cap in DAILY_CAPS:
                            combo+=1; rows=cap_rows(gated,cap)
                            m=metrics(rows,start,0.005); mt=metrics([r for r in rows if r["event_date"] in tr_dates],start,0.005); ms=metrics([r for r in rows if r["event_date"] in te_dates],start,0.005)
                            fl=flags(mt,ms); sc=score(m,mt,ms,fl)
                            base={"combo_id":combo,"family":fam,"book_group":bg,"tour_filter":tf,"tournament_group_filter":gf,"min_side_odds":gate,"daily_cap":cap,"score":sc,"risk_pct":0.005,"split_cutoff_date":cutoff,"overfit_flags":fl}
                            results.append({**base,**m}); train_test.append({"combo_id":combo,"split":"TRAIN",**mt}); train_test.append({"combo_id":combo,"split":"TEST",**ms})
    fields=["combo_id","family","book_group","tour_filter","tournament_group_filter","min_side_odds","daily_cap","score","risk_pct","split_cutoff_date","overfit_flags","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"]
    ranked=sorted(results,key=lambda r:(r["score"],r.get("hit_rate") or 0,r.get("flat_roi") or -9),reverse=True)
    high=[r for r in ranked if r["bets"]>=100 and (r["hit_rate"] or 0)>=0.55 and (r["flat_roi"] or 0)>0 and (r["max_drawdown_pct"] or 999)<=20 and not r["overfit_flags"]]
    pos=[r for r in ranked if r["bets"]>=100 and (r["flat_roi"] or 0)>0]
    write_csv(out/"first_set_winner_comfort_results.csv",ranked,fields)
    write_csv(out/"first_set_winner_comfort_high_hit_positive_roi.csv",high,fields)
    write_csv(out/"first_set_winner_comfort_train_test.csv",train_test,["combo_id","split"]+[x for x in fields if x not in {"combo_id","family","book_group","tour_filter","tournament_group_filter","min_side_odds","daily_cap","score","risk_pct","split_cutoff_date","overfit_flags"}])
    cand_fields=["event_key","event_date","event_time","match_name","player1","player2","tour","tournament_group","tournament_name","bookmaker","market_name","p1_first_set_odds","p2_first_set_odds","first_set_score","first_set_winner","side","side_odds","side_win","favorite_side","selected_is_favorite","selected_is_underdog","favorite_bucket","odds_bucket"]
    write_csv(out/"first_set_winner_comfort_candidates.csv", candidates, cand_fields)
    sims=[]
    for r in ranked[:10]:
        rows=[dict(x,family=r["family"]) for x in candidates if family_ok(x,r["family"])]
        if BOOK_GROUPS[r["book_group"]] is not None: rows=[x for x in rows if x["bookmaker"] in BOOK_GROUPS[r["book_group"]]]
        if r["tour_filter"]!="ALL": rows=[x for x in rows if x["tour"]==r["tour_filter"]]
        if r["tournament_group_filter"]!="ALL": rows=[x for x in rows if x["tournament_group"]==r["tournament_group_filter"]]
        rows=cap_rows([x for x in rows if x["side_odds"]>=r["min_side_odds"]],int(r["daily_cap"]))
        for risk in RISK_LEVELS: sims.append({"combo_id":r["combo_id"],"family":r["family"],"daily_cap":r["daily_cap"],"risk_pct":risk,**metrics(rows,start,risk)})
    write_csv(out/"first_set_winner_comfort_risk_sims.csv",sims,["combo_id","family","daily_cap","risk_pct","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"])
    cards={"generated_at":datetime.utcnow().isoformat()+"Z","diagnostic":audit["diagnostic"],"result_diagnostics":diagnostics,"invalid_first_set_score_counts":invalid,"candidate_rows_built":len(candidates),"rules_tested":len(results),"best_comfort_score":ranked[0] if ranked else None,"best_high_hit_positive_roi":high[0] if high else None,"highest_hit_positive_roi":max(pos,key=lambda r:r["hit_rate"] or 0) if pos else None,"top_25":ranked[:25],"high_hit_positive_top_25":high[:25]}
    (out/"first_set_winner_comfort_cards.json").write_text(json.dumps(cards,indent=2),encoding="utf-8")
    def pc(v): return "n/a" if v is None else f"{v*100:.2f}%"
    lines=["# First Set Winner Comfort Optimizer","",f"Diagnostic: {audit['diagnostic']}",f"Candidate rows built: {len(candidates)}",f"Rules tested: {len(results)}",f"Result diagnostics: {json.dumps(diagnostics)}","","## Top models"]
    for i,r in enumerate(ranked[:25],1):
        avg="n/a" if r["avg_odds"] is None else f"{r['avg_odds']:.2f}"
        lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} cap={r['daily_cap']} min_odds={r['min_side_odds']} bets={r['bets']} hit={pc(r['hit_rate'])} avg={avg} ROI={pc(r['flat_roi'])} DD={r['max_drawdown_pct']:.1f}% L={r['worst_losing_streak']} flags={r['overfit_flags'] or 'none'}")
    lines.append("\n## High-hit positive ROI candidates: bets>=100, hit>=55%, ROI>0, DD<=20%, no overfit flags")
    if high:
        for i,r in enumerate(high[:20],1): lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} bets={r['bets']} hit={pc(r['hit_rate'])} ROI={pc(r['flat_roi'])} DD={r['max_drawdown_pct']:.1f}%")
    else: lines.append("None found under strict criteria.")
    (out/"first_set_winner_comfort_report.md").write_text("\n".join(lines),encoding="utf-8")

def write_empty(out: Path, audit: Dict, diagnostics: List[str], invalid: Dict[str,int]):
    fields=["combo_id","family","book_group","tour_filter","tournament_group_filter","min_side_odds","daily_cap","score","risk_pct","split_cutoff_date","overfit_flags","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"]
    for name in ["first_set_winner_comfort_results.csv","first_set_winner_comfort_high_hit_positive_roi.csv"]: write_csv(out/name,[],fields)
    write_csv(out/"first_set_winner_comfort_train_test.csv",[],["combo_id","split"]+[x for x in fields if x!="combo_id"])
    write_csv(out/"first_set_winner_comfort_risk_sims.csv",[],["combo_id","family","daily_cap","risk_pct","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"])
    write_csv(out/"first_set_winner_comfort_candidates.csv",[],["event_key","event_date","event_time","match_name","player1","player2","tour","tournament_group","tournament_name","bookmaker","market_name","p1_first_set_odds","p2_first_set_odds","first_set_score","first_set_winner","side","side_odds","side_win","favorite_side","selected_is_favorite","selected_is_underdog","favorite_bucket","odds_bucket"])
    cards={"generated_at":datetime.utcnow().isoformat()+"Z","diagnostic":audit["diagnostic"],"result_diagnostics":diagnostics,"invalid_first_set_score_counts":invalid,"candidate_rows_built":0,"rules_tested":0,"best_comfort_score":None,"best_high_hit_positive_roi":None,"highest_hit_positive_roi":None,"top_25":[],"high_hit_positive_top_25":[]}
    (out/"first_set_winner_comfort_cards.json").write_text(json.dumps(cards,indent=2),encoding="utf-8")
    (out/"first_set_winner_comfort_report.md").write_text(f"# First Set Winner Comfort Optimizer\n\nNo usable candidates reconstructed.\n\nDiagnostic: {audit['diagnostic']}\n\nResult diagnostics: {json.dumps(diagnostics)}\n",encoding="utf-8")

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--warehouse-dir",required=True); ap.add_argument("--out",default="artifacts/output/api-tennis-first-set-winner-comfort-optimizer"); ap.add_argument("--start-bankroll",type=float,default=5000); ap.add_argument("--train-ratio",type=float,default=.70)
    a=ap.parse_args(); warehouse=Path(a.warehouse_dir); out=Path(a.out); out.mkdir(parents=True,exist_ok=True)
    results, diagnostics, invalid = load_results(warehouse)
    audit, candidates = build_candidates(warehouse, results)
    audit["result_diagnostics"] = diagnostics
    (out/"first_set_winner_market_audit.json").write_text(json.dumps(audit,indent=2),encoding="utf-8")
    if not candidates: write_empty(out,audit,diagnostics,invalid)
    else: run_optimizer(candidates,out,a.start_bankroll,a.train_ratio,audit,diagnostics,invalid)
if __name__=="__main__": main()
