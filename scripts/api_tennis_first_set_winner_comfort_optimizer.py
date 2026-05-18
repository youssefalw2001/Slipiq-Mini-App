#!/usr/bin/env python3
"""SlipIQ / First Set Lab - First Set Winner Comfort Optimizer.

Diagnostic-first optimizer for a smoother psychological comfort layer.

This workflow looks for true first-set winner / Home-Away 1st Set markets in the
API Tennis warehouse. It does NOT mix full-match Home/Away with first-set winner
odds. If a first-set winner market is missing, it writes a clear market audit so
we know exactly what data needs to be collected next.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

VALID_FIRST_SET_SCORES = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6","0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
P1_WIN_SCORES = {"6:0","6:1","6:2","6:3","6:4","7:5","7:6"}
P2_WIN_SCORES = {"0:6","1:6","2:6","3:6","4:6","5:7","6:7"}
TOUR_MAP = {"265": "ATP", "266": "WTA"}

RISK_LEVELS = [0.0025, 0.005, 0.01, 0.02]
DAILY_CAPS = [1, 2, 3, 5, 0]
ODDS_GATES = [1.20, 1.30, 1.40, 1.50, 1.60, 1.70, 1.80, 1.90, 2.00, 2.10, 2.20]

BOOK_GROUPS = {
    "bet365": {"bet365"},
    "1xBet": {"1xBet"},
    "10Bet": {"10Bet"},
    "bet365_1xBet": {"bet365", "1xBet"},
    "bet365_1xBet_10Bet": {"bet365", "1xBet", "10Bet"},
    "all_major": {"bet365", "1xBet", "10Bet", "Betano", "WilliamHill", "Unibet", "Betfair", "Betway"},
    "all_books": None,
}
TOUR_FILTERS = ["ATP", "WTA", "ALL"]
GROUP_FILTERS = ["GRAND_SLAM", "MASTERS_1000", "STRONG_500_250", "OTHER_TOUR", "LOWER_TIER", "ALL"]

EVENT_KEY_COLS = ["event_key", "event_id", "match_key", "match_id", "fixture_id"]
DATE_COLS = ["event_date", "date", "match_date"]
TIME_COLS = ["event_time", "time", "match_time"]
MATCH_COLS = ["match_name", "event_name", "name"]
P1_COLS = ["player1", "event_first_player", "home", "home_team", "first_player"]
P2_COLS = ["player2", "event_second_player", "away", "away_team", "second_player"]
BOOK_COLS = ["bookmaker", "bookmaker_name", "book", "site"]
MARKET_COLS = ["market_name", "market", "odd_market", "odds_market", "market_label"]
OUTCOME_COLS = ["odd_name", "outcome", "selection", "selection_name", "label", "name", "value", "bet_name", "odd_label"]
ODDS_COLS = ["odd_value", "odds", "odd", "price", "coefficient", "decimal_odds", "value_odd"]
FIRST_SET_SCORE_COLS = ["first_set_score", "set1_score", "first_set", "event_first_set_score"]

FIRST_SET_WINNER_PATTERNS = [
    "home/away (1st set)", "home/away 1st set", "home away 1st set",
    "1st set winner", "first set winner", "set 1 winner", "winner 1st set",
    "winner first set", "home/away first set", "home away first set",
    "1st set - winner", "set winner 1st set", "to win 1st set", "to win first set",
]
FULL_MATCH_MARKETS = {"home/away", "match winner", "winner", "moneyline", "1x2"}
EXCLUDE_WINNER_TERMS = ["correct score", "handicap", "total", "over/under", "over under", "odd/even", "odd even", "games", "game"]

FAMILIES = [
    "P1_FIRST_SET_WINNER",
    "P2_FIRST_SET_WINNER",
    "FIRST_SET_FAVORITE",
    "FIRST_SET_UNDERDOG",
    "STRONG_FAVORITE",
    "FAVORITE",
    "SLIGHT_FAVORITE",
    "NEAR_EVEN",
    "SLIGHT_UNDERDOG",
    "UNDERDOG",
]


def clean(x) -> str:
    return str(x or "").replace("\ufeff", "").strip()


def norm_text(x) -> str:
    return re.sub(r"\s+", " ", clean(x).lower().replace("_", " ").replace("-", " ")).strip()


def fnum(x) -> Optional[float]:
    try:
        s = clean(x)
        if not s:
            return None
        v = float(s)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def col_lookup(headers: Iterable[str]) -> Dict[str, str]:
    return {norm_text(h): h for h in headers}


def first_existing(headers: Iterable[str], aliases: Iterable[str]) -> Optional[str]:
    lookup = col_lookup(headers)
    for alias in aliases:
        if norm_text(alias) in lookup:
            return lookup[norm_text(alias)]
    return None


def read_header(path: Path) -> List[str]:
    try:
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            return next(reader, [])
    except Exception:
        return []


def iter_csv(path: Path):
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            yield row


def write_csv(path: Path, rows: List[Dict], fields: List[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader(); w.writerows(rows)


def money(v):
    return "n/a" if v is None else f"${v:,.0f}"


def pct(v):
    return "n/a" if v is None else f"{v*100:.2f}%"


def tournament_group(name: str) -> str:
    t = norm_text(name)
    if any(k in t for k in ["australian open", "roland garros", "french open", "wimbledon", "us open"]): return "GRAND_SLAM"
    if any(k in t for k in ["indian wells", "miami", "monte carlo", "madrid", "rome", "italian open", "canada", "canadian open", "toronto", "montreal", "cincinnati", "shanghai", "paris", "beijing", "wuhan", "doha", "dubai", "qatar open"]): return "MASTERS_1000"
    if any(k in t for k in ["barcelona", "halle", "queen", "queens", "london", "stuttgart", "charleston", "washington", "hamburg", "tokyo", "acapulco", "eastbourne", "rotterdam", "basel", "vienna", "adelaide", "brisbane", "bad homburg", "berlin", "strasbourg", "antwerp", "dallas", "rio", "astana", "chengdu", "zhuhai", "seoul"]): return "STRONG_500_250"
    if any(k in t for k in ["challenger", "itf", "m25", "m15", "w15", "w25", "w35", "w50", "w75", "w100", "w125"]): return "LOWER_TIER"
    return "OTHER_TOUR"


def tour_from_values(event_type_key: str, event_type_type: str, tournament_name: str) -> str:
    k = clean(event_type_key)
    if k in TOUR_MAP: return TOUR_MAP[k]
    s = norm_text(f"{event_type_type} {tournament_name}")
    if "wta" in s or "women" in s: return "WTA"
    if "atp" in s or "men" in s: return "ATP"
    return "UNKNOWN"


def ts_from(date: str, time: str) -> float:
    try:
        tm = clean(time) or "00:00"
        return datetime.fromisoformat(f"{clean(date)}T{tm if len(tm) != 5 else tm + ':00'}").timestamp()
    except Exception:
        return 0.0


def normalize_first_set_score(score: str) -> Optional[str]:
    s = clean(score).replace("-", ":")
    if s in VALID_FIRST_SET_SCORES:
        return s
    m = re.search(r"([0-7])(?:\.[0-9]+)?\s*[:/]\s*([0-7])(?:\.[0-9]+)?", s)
    if not m:
        return None
    normalized = f"{m.group(1)}:{m.group(2)}"
    return normalized if normalized in VALID_FIRST_SET_SCORES else None


def first_set_winner(score: str) -> Optional[str]:
    s = normalize_first_set_score(score)
    if s in P1_WIN_SCORES: return "P1"
    if s in P2_WIN_SCORES: return "P2"
    return None


def is_first_set_winner_market(market: str) -> bool:
    m = norm_text(market)
    if any(term in m for term in EXCLUDE_WINNER_TERMS):
        return False
    return any(p in m for p in FIRST_SET_WINNER_PATTERNS)


def is_full_match_homeaway_market(market: str) -> bool:
    m = norm_text(market)
    if "1st" in m or "first set" in m or "set 1" in m:
        return False
    return m in FULL_MATCH_MARKETS or m == "home away"


def is_other_first_set_market(market: str) -> bool:
    m = norm_text(market)
    return ("1st set" in m or "first set" in m or "set 1" in m) and not is_first_set_winner_market(market)


def bucket_for_odds(odds: float) -> str:
    if odds < 1.40: return "STRONG_FAVORITE"
    if odds < 1.65: return "FAVORITE"
    if odds < 1.90: return "SLIGHT_FAVORITE"
    if odds <= 2.10: return "NEAR_EVEN"
    if odds <= 2.50: return "SLIGHT_UNDERDOG"
    return "UNDERDOG"


def outcome_side(outcome: str, player1: str = "", player2: str = "") -> Optional[str]:
    o = norm_text(outcome)
    p1 = norm_text(player1)
    p2 = norm_text(player2)
    if o in {"1", "home", "player 1", "player1", "p1", "team 1", "first player"}: return "P1"
    if o in {"2", "away", "player 2", "player2", "p2", "team 2", "second player"}: return "P2"
    if p1 and (o == p1 or p1 in o or o in p1): return "P1"
    if p2 and (o == p2 or p2 in o or o in p2): return "P2"
    # Common API Tennis labels are sometimes "Home" and "Away" embedded in longer strings.
    if re.search(r"\bhome\b", o): return "P1"
    if re.search(r"\baway\b", o): return "P2"
    return None


def load_result_map(warehouse_dir: Path) -> Tuple[Dict[str, Dict], List[str]]:
    result_map: Dict[str, Dict] = {}
    diagnostics = []
    preferred = warehouse_dir / "first_set_correct_score_wide_combined.csv"
    candidates = [preferred] if preferred.exists() else []
    if not candidates:
        candidates = sorted(warehouse_dir.glob("*.csv"))
    for path in candidates:
        headers = read_header(path)
        if not headers: continue
        event_col = first_existing(headers, EVENT_KEY_COLS)
        score_col = first_existing(headers, FIRST_SET_SCORE_COLS)
        if not event_col or not score_col:
            if path == preferred:
                diagnostics.append(f"Preferred result file missing event/first_set_score columns: {path.name}")
            continue
        date_col = first_existing(headers, DATE_COLS)
        time_col = first_existing(headers, TIME_COLS)
        match_col = first_existing(headers, MATCH_COLS)
        p1_col = first_existing(headers, P1_COLS)
        p2_col = first_existing(headers, P2_COLS)
        tour_col = first_existing(headers, ["tour"])
        group_col = first_existing(headers, ["tournament_group"])
        tournament_col = first_existing(headers, ["tournament_name"])
        event_type_col = first_existing(headers, ["event_type_key"])
        event_type_type_col = first_existing(headers, ["event_type_type"])
        count = 0
        for r in iter_csv(path):
            event_key = clean(r.get(event_col))
            score = normalize_first_set_score(r.get(score_col, ""))
            if not event_key or not score: continue
            if event_key not in result_map:
                tournament = clean(r.get(tournament_col, "")) if tournament_col else ""
                tour = clean(r.get(tour_col, "")) if tour_col else tour_from_values(r.get(event_type_col, "") if event_type_col else "", r.get(event_type_type_col, "") if event_type_type_col else "", tournament)
                group = clean(r.get(group_col, "")) if group_col else tournament_group(tournament)
                result_map[event_key] = {
                    "event_key": event_key,
                    "event_date": clean(r.get(date_col, "")) if date_col else "",
                    "event_time": clean(r.get(time_col, "")) if time_col else "",
                    "match_name": clean(r.get(match_col, "")) if match_col else "",
                    "player1": clean(r.get(p1_col, "")) if p1_col else "",
                    "player2": clean(r.get(p2_col, "")) if p2_col else "",
                    "tour": tour or "UNKNOWN",
                    "tournament_group": group or "OTHER_TOUR",
                    "tournament_name": tournament,
                    "first_set_score": score,
                    "first_set_winner": first_set_winner(score),
                }
                count += 1
        diagnostics.append(f"Loaded {count} settled first-set results from {path.name}")
        if result_map:
            break
    return result_map, diagnostics


def audit_and_build_candidates(warehouse_dir: Path, result_map: Dict[str, Dict]) -> Tuple[Dict, List[Dict]]:
    csv_files = sorted(warehouse_dir.glob("*.csv"))
    market_counts = Counter()
    first_set_market_counts = Counter()
    first_set_winner_market_counts = Counter()
    full_match_homeaway_counts = Counter()
    other_first_set_market_counts = Counter()
    bookmakers = Counter()
    file_summaries = []
    pair_rows: Dict[Tuple[str, str, str], Dict] = {}

    for path in csv_files:
        headers = read_header(path)
        summary = {"file": path.name, "headers": headers[:80], "usable_long_odds_shape": False, "rows_seen": 0, "markets_seen": 0}
        if not headers:
            file_summaries.append(summary); continue
        event_col = first_existing(headers, EVENT_KEY_COLS)
        book_col = first_existing(headers, BOOK_COLS)
        market_col = first_existing(headers, MARKET_COLS)
        outcome_col = first_existing(headers, OUTCOME_COLS)
        odds_col = first_existing(headers, ODDS_COLS)
        if event_col and book_col and market_col:
            summary["usable_long_odds_shape"] = bool(outcome_col and odds_col)
            for r in iter_csv(path):
                summary["rows_seen"] += 1
                market = clean(r.get(market_col))
                if not market: continue
                market_counts[market] += 1
                if is_other_first_set_market(market) or is_first_set_winner_market(market):
                    first_set_market_counts[market] += 1
                if is_first_set_winner_market(market):
                    first_set_winner_market_counts[market] += 1
                elif is_full_match_homeaway_market(market):
                    full_match_homeaway_counts[market] += 1
                elif is_other_first_set_market(market):
                    other_first_set_market_counts[market] += 1
                if summary["usable_long_odds_shape"] and is_first_set_winner_market(market):
                    event_key = clean(r.get(event_col))
                    if event_key not in result_map:
                        continue
                    book = clean(r.get(book_col))
                    odds = fnum(r.get(odds_col))
                    if not book or not odds or odds <= 1:
                        continue
                    meta = result_map[event_key]
                    side = outcome_side(r.get(outcome_col), meta.get("player1", ""), meta.get("player2", ""))
                    if side not in {"P1", "P2"}:
                        continue
                    key = (event_key, book, market)
                    base = pair_rows.setdefault(key, {
                        **meta,
                        "bookmaker": book,
                        "market_name": market,
                        "p1_first_set_odds": None,
                        "p2_first_set_odds": None,
                        "p1_outcome_label": "",
                        "p2_outcome_label": "",
                    })
                    if side == "P1":
                        base["p1_first_set_odds"] = odds
                        base["p1_outcome_label"] = clean(r.get(outcome_col))
                    else:
                        base["p2_first_set_odds"] = odds
                        base["p2_outcome_label"] = clean(r.get(outcome_col))
                    bookmakers[book] += 1
        else:
            # Header-only note: some wide files may still contain market data, but not in long shape.
            pass
        summary["markets_seen"] = sum(1 for _ in [])
        file_summaries.append(summary)

    candidates: List[Dict] = []
    for row in pair_rows.values():
        p1 = row.get("p1_first_set_odds")
        p2 = row.get("p2_first_set_odds")
        if not p1 or not p2:
            continue
        fav_side = "P1" if p1 <= p2 else "P2"
        dog_side = "P2" if fav_side == "P1" else "P1"
        for side, odds in [("P1", p1), ("P2", p2)]:
            win = row.get("first_set_winner") == side
            bucket = bucket_for_odds(odds)
            candidates.append({
                "event_key": row["event_key"],
                "event_date": row.get("event_date", ""),
                "event_time": row.get("event_time", ""),
                "ts": ts_from(row.get("event_date", ""), row.get("event_time", "")),
                "match_name": row.get("match_name", ""),
                "player1": row.get("player1", ""),
                "player2": row.get("player2", ""),
                "tour": row.get("tour", "UNKNOWN"),
                "tournament_group": row.get("tournament_group", "OTHER_TOUR"),
                "tournament_name": row.get("tournament_name", ""),
                "bookmaker": row.get("bookmaker", ""),
                "market_name": row.get("market_name", ""),
                "p1_first_set_odds": p1,
                "p2_first_set_odds": p2,
                "first_set_score": row.get("first_set_score", ""),
                "first_set_winner": row.get("first_set_winner", ""),
                "side": side,
                "side_odds": odds,
                "side_win": win,
                "favorite_side": fav_side,
                "selected_is_favorite": side == fav_side,
                "selected_is_underdog": side == dog_side,
                "favorite_bucket": bucket,
                "odds_bucket": bucket,
            })

    audit = {
        "files_inspected": file_summaries,
        "market_names_found_top_200": dict(market_counts.most_common(200)),
        "row_counts_by_first_set_market": dict(first_set_market_counts.most_common()),
        "candidate_first_set_winner_markets": dict(first_set_winner_market_counts.most_common()),
        "other_first_set_markets_found": dict(other_first_set_market_counts.most_common(100)),
        "full_match_homeaway_markets_found": dict(full_match_homeaway_counts.most_common(50)),
        "bookmakers_found_for_first_set_winner": dict(bookmakers.most_common()),
        "home_away_1st_set_exists": any("home/away" in norm_text(m) and ("1st" in norm_text(m) or "first set" in norm_text(m)) for m in first_set_winner_market_counts),
        "first_set_winner_market_exists": bool(first_set_winner_market_counts),
        "only_full_match_home_away_exists": bool(full_match_homeaway_counts) and not bool(first_set_winner_market_counts),
        "candidate_rows_built": len(candidates),
        "diagnostic": "First-set winner market found and optimizer can run." if candidates else "No usable first-set winner odds were reconstructed. Do not use full-match Home/Away as comfort. Collect Home/Away (1st Set), 1st Set Winner, or Set 1 Winner odds from API Tennis.",
    }
    return audit, candidates


def family_ok(row: Dict, family: str) -> bool:
    if family == "P1_FIRST_SET_WINNER": return row["side"] == "P1"
    if family == "P2_FIRST_SET_WINNER": return row["side"] == "P2"
    if family == "FIRST_SET_FAVORITE": return bool(row["selected_is_favorite"])
    if family == "FIRST_SET_UNDERDOG": return bool(row["selected_is_underdog"])
    return row["odds_bucket"] == family


def dedupe(rows: List[Dict]) -> List[Dict]:
    groups = defaultdict(list)
    for r in rows:
        groups[(r["event_key"], r["side"], r["market_name"])].append(r)
    return [max(v, key=lambda x: (x["side_odds"], -abs(x["side_odds"] - 1.95))) for v in groups.values()]


def cap_rows(rows: List[Dict], cap: int) -> List[Dict]:
    rows = dedupe(rows)
    if cap <= 0:
        return sorted(rows, key=lambda x: (x["ts"], x["event_key"], x["side"]))
    by_day = defaultdict(list)
    for r in rows:
        by_day[r.get("event_date") or "unknown"].append(r)
    out = []
    for day, arr in sorted(by_day.items()):
        ranked = sorted(arr, key=lambda x: (x["selected_is_favorite"], x["side_odds"], -abs(x["side_odds"] - 1.90)), reverse=True)
        used_events = set()
        keep = []
        for r in ranked:
            if r["event_key"] in used_events:
                continue
            used_events.add(r["event_key"])
            keep.append(r)
            if len(keep) >= cap:
                break
        out.extend(keep)
    return sorted(out, key=lambda x: (x["ts"], x["event_key"], x["side"]))


def split_dates(rows: List[Dict], ratio: float):
    dates = sorted({r.get("event_date") for r in rows if r.get("event_date")})
    if len(dates) < 3:
        return set(dates), set(), dates[-1] if dates else ""
    cutoff = dates[max(1, min(len(dates)-1, int(len(dates)*ratio)))]
    return {d for d in dates if d < cutoff}, {d for d in dates if d >= cutoff}, cutoff


def metrics(rows: List[Dict], start: float, risk: float) -> Dict:
    rows = [r for r in rows if r.get("side_odds") and r["side_odds"] > 1]
    bets = len(rows)
    wins = sum(1 for r in rows if r.get("side_win"))
    avg = sum(r["side_odds"] for r in rows) / bets if bets else None
    units = sum((r["side_odds"] - 1) if r.get("side_win") else -1 for r in rows)
    months = {r.get("event_date", "")[:7] for r in rows if r.get("event_date")}
    days = {r.get("event_date") for r in rows if r.get("event_date")}
    mpl = defaultdict(float); fam = defaultdict(int); books = defaultdict(int); buckets = defaultdict(int)
    for r in rows:
        month = r.get("event_date", "")[:7]
        if month:
            mpl[month] += (r["side_odds"] - 1) if r.get("side_win") else -1
        fam[r.get("family", "missing")] += 1
        books[r.get("bookmaker", "missing")] += 1
        buckets[r.get("odds_bucket", "missing")] += 1
    bank = start; peak = start; maxdd = 0.0; losing = 0; worst = 0
    for r in sorted(rows, key=lambda x: (x["ts"], x["event_key"], x["side"])):
        stake = bank * risk
        if r.get("side_win"):
            bank += stake * (r["side_odds"] - 1)
            losing = 0
        else:
            bank -= stake
            losing += 1
            worst = max(worst, losing)
        peak = max(peak, bank)
        maxdd = max(maxdd, (peak - bank) / peak if peak else 0)
    hit = wins / bets if bets else None
    be = 1 / avg if avg else None
    return {
        "bets": bets, "wins": wins, "losses": bets - wins,
        "hit_rate": hit, "avg_odds": avg, "breakeven_hit_rate": be,
        "edge_vs_breakeven": hit - be if hit is not None and be is not None else None,
        "flat_profit_units": units, "flat_roi": units / bets if bets else None,
        "months": len(months), "active_days": len(days),
        "positive_months": sum(1 for v in mpl.values() if v > 0),
        "positive_month_ratio": sum(1 for v in mpl.values() if v > 0) / len(months) if months else None,
        "bets_per_month": bets / len(months) if months else None,
        "bets_per_active_day": bets / len(days) if days else None,
        "final_bankroll": bank, "compound_return_pct": (bank / start - 1) * 100 if start else None,
        "max_drawdown_pct": maxdd * 100, "worst_losing_streak": worst,
        "family_mix": json.dumps(dict(sorted(fam.items()))),
        "book_mix": json.dumps(dict(sorted(books.items()))),
        "bucket_mix": json.dumps(dict(sorted(buckets.items()))),
    }


def overfit_flags(m_train: Dict, m_test: Dict) -> str:
    flags = []
    if m_train["bets"] < 30 or m_test["bets"] < 30:
        flags.append("low_train_or_test_volume")
    if (m_train.get("flat_roi") or 0) > 0 and (m_test.get("flat_roi") or 0) < 0:
        flags.append("train_positive_test_negative")
    if abs((m_train.get("flat_roi") or 0) - (m_test.get("flat_roi") or 0)) > 0.25:
        flags.append("unstable_train_test_roi")
    if (m_test.get("hit_rate") or 0) + 0.08 < (m_train.get("hit_rate") or 0):
        flags.append("test_hit_rate_drop")
    return ";".join(flags)


def comfort_score(m: Dict, m_train: Dict, m_test: Dict, flags: str) -> float:
    if m["bets"] < 80:
        return -999
    hit = m.get("hit_rate") or 0
    roi = m.get("flat_roi") or 0
    edge = m.get("edge_vs_breakeven") or 0
    dd = m.get("max_drawdown_pct") or 0
    worst = m.get("worst_losing_streak") or 0
    pm = m.get("positive_month_ratio") or 0
    volume = min(25, math.log10(max(m["bets"], 1)) * 10)
    score = hit * 120 + roi * 150 + edge * 180 + pm * 25 + volume
    score -= max(0, dd - 12) * 2.0
    score -= max(0, worst - 6) * 3.0
    if (m_test.get("flat_roi") or 0) <= 0: score -= 20
    if flags: score -= 15
    return score


def run_optimizer(candidates: List[Dict], out: Path, start_bankroll: float, train_ratio: float, audit: Dict):
    train_dates, test_dates, cutoff = split_dates(candidates, train_ratio)
    results = []
    train_test = []
    combo_id = 0

    for family in FAMILIES:
        fam_rows = [dict(r, family=family) for r in candidates if family_ok(r, family)]
        if not fam_rows: continue
        for book_group, books in BOOK_GROUPS.items():
            book_rows = fam_rows if books is None else [r for r in fam_rows if r.get("bookmaker") in books]
            if not book_rows: continue
            for tour_filter in TOUR_FILTERS:
                tour_rows = book_rows if tour_filter == "ALL" else [r for r in book_rows if r.get("tour") == tour_filter]
                if not tour_rows: continue
                for group_filter in GROUP_FILTERS:
                    group_rows = tour_rows if group_filter == "ALL" else [r for r in tour_rows if r.get("tournament_group") == group_filter]
                    if not group_rows: continue
                    for gate in ODDS_GATES:
                        gated = [r for r in group_rows if r["side_odds"] >= gate]
                        if len(gated) < 50: continue
                        for cap in DAILY_CAPS:
                            combo_id += 1
                            rows = cap_rows(gated, cap)
                            m = metrics(rows, start_bankroll, 0.005)
                            train_rows = [r for r in rows if r.get("event_date") in train_dates]
                            test_rows = [r for r in rows if r.get("event_date") in test_dates]
                            mt = metrics(train_rows, start_bankroll, 0.005)
                            ms = metrics(test_rows, start_bankroll, 0.005)
                            flags = overfit_flags(mt, ms)
                            score = comfort_score(m, mt, ms, flags)
                            base = {"combo_id": combo_id, "family": family, "book_group": book_group, "tour_filter": tour_filter, "tournament_group_filter": group_filter, "min_side_odds": gate, "daily_cap": cap, "score": score, "risk_pct": 0.005, "split_cutoff_date": cutoff, "overfit_flags": flags}
                            results.append({**base, **m})
                            train_test.append({"combo_id": combo_id, "split": "TRAIN", **mt})
                            train_test.append({"combo_id": combo_id, "split": "TEST", **ms})

    fields = ["combo_id","family","book_group","tour_filter","tournament_group_filter","min_side_odds","daily_cap","score","risk_pct","split_cutoff_date","overfit_flags","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"]
    ranked = sorted(results, key=lambda r: (r["score"], r.get("hit_rate") or 0, r.get("flat_roi") or -9), reverse=True)
    high_hit = [r for r in ranked if r["bets"] >= 100 and (r.get("hit_rate") or 0) >= 0.55 and (r.get("flat_roi") or 0) > 0 and (r.get("max_drawdown_pct") or 999) <= 20 and not r.get("overfit_flags")]
    write_csv(out / "first_set_winner_comfort_results.csv", ranked, fields)
    write_csv(out / "first_set_winner_comfort_high_hit_positive_roi.csv", high_hit, fields)
    write_csv(out / "first_set_winner_comfort_train_test.csv", train_test, ["combo_id","split","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"])

    risk_sims = []
    for r in ranked[:10]:
        rows = [dict(x, family=r["family"]) for x in candidates if family_ok(x, r["family"])]
        if BOOK_GROUPS[r["book_group"]] is not None:
            rows = [x for x in rows if x.get("bookmaker") in BOOK_GROUPS[r["book_group"]]]
        if r["tour_filter"] != "ALL": rows = [x for x in rows if x.get("tour") == r["tour_filter"]]
        if r["tournament_group_filter"] != "ALL": rows = [x for x in rows if x.get("tournament_group") == r["tournament_group_filter"]]
        rows = cap_rows([x for x in rows if x["side_odds"] >= r["min_side_odds"]], int(r["daily_cap"]))
        for risk in RISK_LEVELS:
            risk_sims.append({"combo_id": r["combo_id"], "family": r["family"], "daily_cap": r["daily_cap"], "risk_pct": risk, **metrics(rows, start_bankroll, risk)})
    write_csv(out / "first_set_winner_comfort_risk_sims.csv", risk_sims, ["combo_id","family","daily_cap","risk_pct","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"])

    cards = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "candidate_rows": len(candidates),
        "rules_tested": len(results),
        "split_cutoff_date": cutoff,
        "best_comfort_score": ranked[0] if ranked else None,
        "best_high_hit_positive_roi": high_hit[0] if high_hit else None,
        "top_25": ranked[:25],
        "high_hit_positive_top_25": high_hit[:25],
        "market_audit_digest": {
            "first_set_winner_market_exists": audit.get("first_set_winner_market_exists"),
            "home_away_1st_set_exists": audit.get("home_away_1st_set_exists"),
            "only_full_match_home_away_exists": audit.get("only_full_match_home_away_exists"),
            "candidate_rows_built": audit.get("candidate_rows_built"),
            "candidate_first_set_winner_markets": audit.get("candidate_first_set_winner_markets", {}),
        },
    }
    (out / "first_set_winner_comfort_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")

    lines = [
        "# First Set Winner Comfort Optimizer",
        "",
        "This optimizer tests true first-set winner / Home-Away 1st Set markets only. Full-match Home/Away is audited as fallback data but not mixed into the main comfort model.",
        "",
        "## Market audit",
        f"First-set winner market exists: {audit.get('first_set_winner_market_exists')}",
        f"Home/Away 1st Set exists: {audit.get('home_away_1st_set_exists')}",
        f"Only full-match Home/Away exists: {audit.get('only_full_match_home_away_exists')}",
        f"Candidate rows built: {len(candidates)}",
        "",
        "## Top comfort-score models",
    ]
    if ranked:
        for i, r in enumerate(ranked[:25], 1):
            avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
            lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} cap={r['daily_cap']} min_odds={r['min_side_odds']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg={avg}, ROI={pct(r['flat_roi'])}, DD@0.5%={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}, +months={r['positive_months']}/{r['months']}, flags={r['overfit_flags']}")
    else:
        lines.append("No optimizer results were produced.")
    lines.append("\n## High-hit positive ROI candidates: bets>=100, hit>=55%, ROI>0, DD<=20% at 0.5%, no overfit flags")
    if high_hit:
        for i, r in enumerate(high_hit[:20], 1):
            avg = "n/a" if r.get("avg_odds") is None else f"{r['avg_odds']:.2f}"
            lines.append(f"{i}. combo={r['combo_id']} {r['family']} {r['book_group']} {r['tour_filter']} {r['tournament_group_filter']} cap={r['daily_cap']} min_odds={r['min_side_odds']}: bets={r['bets']}, hit={pct(r['hit_rate'])}, avg={avg}, ROI={pct(r['flat_roi'])}, DD={r['max_drawdown_pct']:.1f}%, L={r['worst_losing_streak']}")
    else:
        lines.append("None found under the strict comfort criteria. If first-set winner odds exist, this likely means the market is efficient or needs a sharper price/favorite filter. If first-set winner odds do not exist, collect Home/Away (1st Set) / 1st Set Winner odds first.")
    lines.append("\nInterpretation: Comfort models are for psychological smoothness and proof-channel stability. Do not replace Core/VIP unless live tracking, train/test, and ROI support it.")
    (out / "first_set_winner_comfort_report.md").write_text("\n".join(lines), encoding="utf-8")


def write_diagnostic_report(out: Path, audit: Dict, result_diagnostics: List[str], candidates: List[Dict]):
    lines = [
        "# First Set Winner Comfort Optimizer",
        "",
        "No usable true first-set winner market was reconstructed, so the optimizer did not run.",
        "",
        "## Result diagnostics",
        *[f"- {d}" for d in result_diagnostics],
        "",
        "## Market audit summary",
        f"First-set winner market exists: {audit.get('first_set_winner_market_exists')}",
        f"Home/Away 1st Set exists: {audit.get('home_away_1st_set_exists')}",
        f"Only full-match Home/Away exists: {audit.get('only_full_match_home_away_exists')}",
        f"Candidate rows built: {len(candidates)}",
        "",
        "## Candidate first-set winner markets found",
        "```json",
        json.dumps(audit.get("candidate_first_set_winner_markets", {}), indent=2),
        "```",
        "",
        "## Other first-set markets found",
        "```json",
        json.dumps(audit.get("other_first_set_markets_found", {}), indent=2),
        "```",
        "",
        "## Full-match Home/Away markets found",
        "```json",
        json.dumps(audit.get("full_match_homeaway_markets_found", {}), indent=2),
        "```",
        "",
        "## What data is needed",
        "Collect API Tennis odds for a market clearly labeled Home/Away (1st Set), 1st Set Winner, Set 1 Winner, or equivalent. Do not use full-match Home/Away for this comfort layer unless it is explicitly run as a separate fallback experiment.",
    ]
    (out / "first_set_winner_comfort_report.md").write_text("\n".join(lines), encoding="utf-8")
    empty_fields = ["combo_id","family","book_group","tour_filter","tournament_group_filter","min_side_odds","daily_cap","score","risk_pct","split_cutoff_date","overfit_flags","bets","wins","losses","hit_rate","avg_odds","breakeven_hit_rate","edge_vs_breakeven","flat_profit_units","flat_roi","months","active_days","positive_months","positive_month_ratio","bets_per_month","bets_per_active_day","final_bankroll","compound_return_pct","max_drawdown_pct","worst_losing_streak","family_mix","book_mix","bucket_mix"]
    write_csv(out / "first_set_winner_comfort_results.csv", [], empty_fields)
    write_csv(out / "first_set_winner_comfort_high_hit_positive_roi.csv", [], empty_fields)
    write_csv(out / "first_set_winner_comfort_train_test.csv", [], ["combo_id","split"] + empty_fields[11:])
    write_csv(out / "first_set_winner_comfort_risk_sims.csv", [], ["combo_id","family","daily_cap","risk_pct"] + empty_fields[11:])
    cards = {"generated_at": datetime.utcnow().isoformat() + "Z", "diagnostic": audit.get("diagnostic"), "market_audit_digest": audit, "best_comfort_score": None, "best_high_hit_positive_roi": None}
    (out / "first_set_winner_comfort_cards.json").write_text(json.dumps(cards, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--warehouse-dir", required=True)
    ap.add_argument("--out", default="artifacts/output/api-tennis-first-set-winner-comfort-optimizer")
    ap.add_argument("--start-bankroll", type=float, default=5000.0)
    ap.add_argument("--train-ratio", type=float, default=0.70)
    args = ap.parse_args()

    warehouse_dir = Path(args.warehouse_dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    result_map, result_diagnostics = load_result_map(warehouse_dir)
    audit, candidates = audit_and_build_candidates(warehouse_dir, result_map)
    audit["result_diagnostics"] = result_diagnostics
    (out / "first_set_winner_market_audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")

    candidate_fields = ["event_key","event_date","event_time","match_name","player1","player2","tour","tournament_group","tournament_name","bookmaker","market_name","p1_first_set_odds","p2_first_set_odds","first_set_score","first_set_winner","side","side_odds","side_win","favorite_side","selected_is_favorite","selected_is_underdog","favorite_bucket","odds_bucket"]
    write_csv(out / "first_set_winner_comfort_candidates.csv", candidates, candidate_fields)

    if not candidates:
        write_diagnostic_report(out, audit, result_diagnostics, candidates)
        return

    run_optimizer(candidates, out, args.start_bankroll, args.train_ratio, audit)


if __name__ == "__main__":
    main()
