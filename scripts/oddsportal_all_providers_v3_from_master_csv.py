#!/usr/bin/env python3
"""
SlipIQ OddsPortal all-provider V3 odds comparison from master CSV.

Reads data/first_set_results_master.csv, constructs the same Correct Score / 1st Set
OddsPortal endpoint, decodes the payload, and extracts every provider/bookmaker that
has all three Player 2 V3 scores:
  3:6, 4:6, 5:7

Outputs:
- v3_all_providers_long.csv: one row per match/provider with same-book grouped odds
- v3_best_provider_per_match.csv: best same-book grouped price per match
- v3_best_line_per_match.csv: best line shopping across providers per score
- v3_provider_summary.csv: provider coverage/profitability summaries
- v3_all_providers_report.md
- run_summary.json

Read-only. No betting. No sportsbook actions. No captcha bypass.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import BrowserContext, sync_playwright

import oddsportal_login_filtered_bet365_scraper as base
from oddsportal_constructed_v3_endpoint_probe import construct_v3_endpoint
from oddsportal_cookie_json_guarded import create_cookie_context, has_cookie_secret
from oddsportal_decoded_v3_probe import TARGET_P2, decode_oddsportal_dat, decimal_grouped, safe_float
from oddsportal_v3_odds_from_master_csv import discover_token_fast, read_csv_rows

BET365_PROVIDER_ID = "549"
P2_TARGET_SCORES = ["3:6", "4:6", "5:7"]
P2_HIT_SCORES = set(P2_TARGET_SCORES)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    vals = sorted(values)
    if len(vals) == 1:
        return vals[0]
    k = (len(vals) - 1) * pct
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return vals[int(k)]
    return vals[lo] * (hi - k) + vals[hi] * (k - lo)


def extract_provider_name_map(decoded: dict[str, Any]) -> dict[str, str]:
    """Best-effort provider/bookmaker id -> name extraction.

    OddsPortal payloads can vary. This intentionally avoids depending on one exact
    shape; if names are unavailable, provider_id remains the key identifier.
    """
    out: dict[str, str] = {}

    def visit(obj: Any) -> None:
        if isinstance(obj, dict):
            # Common shapes: {"549": {"name": "bet365"}} or {"id": 549, "name": "..."}
            for k, v in obj.items():
                if str(k).isdigit():
                    if isinstance(v, dict):
                        name = clean_text(v.get("name") or v.get("bookmakerName") or v.get("title") or v.get("label"))
                        if name:
                            out[str(k)] = name
                    elif isinstance(v, str) and v.strip():
                        out[str(k)] = clean_text(v)
                if isinstance(v, dict):
                    pid = clean_text(v.get("id") or v.get("bookmakerId") or v.get("providerId") or v.get("bid"))
                    name = clean_text(v.get("name") or v.get("bookmakerName") or v.get("title") or v.get("label"))
                    if pid.isdigit() and name:
                        out[pid] = name
                if isinstance(v, (dict, list)):
                    visit(v)
        elif isinstance(obj, list):
            for item in obj:
                visit(item)

    visit(decoded.get("d", decoded))
    if BET365_PROVIDER_ID not in out:
        out[BET365_PROVIDER_ID] = "bet365"
    return out


def all_score_provider_odds(decoded: dict[str, Any]) -> tuple[dict[str, dict[str, float]], dict[str, str]]:
    """Return score -> provider_id -> decimal odds for all score rows."""
    score_map: dict[str, dict[str, float]] = {}
    provider_names = extract_provider_name_map(decoded)
    back = decoded.get("d", {}).get("oddsdata", {}).get("back", {})
    if not isinstance(back, dict):
        return score_map, provider_names
    for score_row in back.values():
        if not isinstance(score_row, dict):
            continue
        score = clean_text(score_row.get("mixedParameterName") or score_row.get("name") or score_row.get("label"))
        if not score:
            continue
        odds_by_provider = score_row.get("odds") or {}
        if not isinstance(odds_by_provider, dict):
            continue
        for provider_id, raw_odds in odds_by_provider.items():
            decimal = None
            if isinstance(raw_odds, list) and raw_odds:
                decimal = safe_float(raw_odds[0])
            elif isinstance(raw_odds, (int, float, str)):
                decimal = safe_float(raw_odds)
            elif isinstance(raw_odds, dict):
                decimal = safe_float(raw_odds.get("odds") or raw_odds.get("price") or raw_odds.get("decimal"))
            if decimal and decimal > 1:
                score_map.setdefault(score, {})[str(provider_id)] = float(decimal)
    return score_map, provider_names


def grouped_for_provider(score_map: dict[str, dict[str, float]], provider_id: str) -> tuple[float | None, dict[str, float | None]]:
    score_odds = {score: score_map.get(score, {}).get(provider_id) for score in P2_TARGET_SCORES}
    grouped = decimal_grouped([score_odds[score] for score in P2_TARGET_SCORES])
    return grouped, score_odds


def best_line_grouped(score_map: dict[str, dict[str, float]], provider_names: dict[str, str]) -> dict[str, Any]:
    best: dict[str, Any] = {}
    vals: list[float | None] = []
    for score in P2_TARGET_SCORES:
        candidates = score_map.get(score, {})
        if not candidates:
            best[f"best_{score.replace(':', '_')}_decimal"] = ""
            best[f"best_{score.replace(':', '_')}_provider_id"] = ""
            best[f"best_{score.replace(':', '_')}_provider_name"] = ""
            vals.append(None)
            continue
        provider_id, odd = max(candidates.items(), key=lambda kv: float(kv[1]))
        vals.append(float(odd))
        best[f"best_{score.replace(':', '_')}_decimal"] = round(float(odd), 6)
        best[f"best_{score.replace(':', '_')}_provider_id"] = provider_id
        best[f"best_{score.replace(':', '_')}_provider_name"] = provider_names.get(provider_id, "")
    best["best_line_grouped_9_12"] = decimal_grouped(vals)
    return best


def simulate_bankroll(rows: list[dict[str, Any]], odds_key: str, hit_key: str = "p2_v3_hit", start_bankroll: float = 5000.0, risk_pct: float = 0.02) -> dict[str, Any]:
    bankroll = start_bankroll
    peak = start_bankroll
    max_dd = 0.0
    current_ls = 0
    worst_ls = 0
    for row in rows:
        odds = safe_float(row.get(odds_key))
        if not odds or odds <= 1:
            continue
        stake = bankroll * risk_pct
        hit = str(row.get(hit_key)).lower() == "true"
        if hit:
            bankroll += stake * (odds - 1.0)
            current_ls = 0
        else:
            bankroll -= stake
            current_ls += 1
            worst_ls = max(worst_ls, current_ls)
        peak = max(peak, bankroll)
        if peak > 0:
            max_dd = max(max_dd, (peak - bankroll) / peak)
    return {
        "final_bankroll": round(bankroll, 2),
        "profit": round(bankroll - start_bankroll, 2),
        "max_drawdown_pct": round(max_dd * 100.0, 2),
        "worst_losing_streak": worst_ls,
    }


def provider_summary(long_rows: list[dict[str, Any]], min_rows: int) -> list[dict[str, Any]]:
    by_provider: dict[str, list[dict[str, Any]]] = {}
    for row in long_rows:
        by_provider.setdefault(str(row.get("provider_id")), []).append(row)
    summaries: list[dict[str, Any]] = []
    for provider_id, rows in by_provider.items():
        if len(rows) < min_rows:
            continue
        rows_sorted = sorted(rows, key=lambda r: (str(r.get("match_date") or ""), str(r.get("event_id") or r.get("event_hash") or "")))
        odds_vals = [float(r["provider_grouped_9_12"]) for r in rows_sorted if safe_float(r.get("provider_grouped_9_12"))]
        wins = sum(1 for r in rows_sorted if str(r.get("p2_v3_hit")).lower() == "true")
        sim = simulate_bankroll(rows_sorted, "provider_grouped_9_12")
        count = len(rows_sorted)
        hit_rate = wins / count if count else 0
        summaries.append({
            "provider_id": provider_id,
            "provider_name": rows_sorted[0].get("provider_name", ""),
            "coverage_rows": count,
            "wins": wins,
            "hit_rate_pct": round(hit_rate * 100.0, 2),
            "break_even_odds": round(1 / hit_rate, 4) if hit_rate > 0 else "",
            "avg_grouped_odds": round(statistics.mean(odds_vals), 6) if odds_vals else "",
            "median_grouped_odds": round(statistics.median(odds_vals), 6) if odds_vals else "",
            "p25_grouped_odds": round(percentile(odds_vals, 0.25), 6) if odds_vals else "",
            "p75_grouped_odds": round(percentile(odds_vals, 0.75), 6) if odds_vals else "",
            **sim,
        })
    summaries.sort(key=lambda r: (float(r.get("profit") or 0), int(r.get("coverage_rows") or 0)), reverse=True)
    return summaries


def long_fields() -> list[str]:
    return [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "tournament", "match_url",
        "first_set_score", "p2_v3_hit", "result_status", "constructed_url", "http_status", "decode_status", "body_length",
        "market_bt", "market_scope", "provider_id", "provider_name", "provider_3_6_decimal", "provider_4_6_decimal", "provider_5_7_decimal",
        "provider_grouped_9_12", "is_bet365", "provider_count_with_all_scores", "all_score_count", "odds_status", "note",
    ]


def best_provider_fields() -> list[str]:
    return [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "tournament", "match_url",
        "first_set_score", "p2_v3_hit", "result_status", "constructed_url", "best_provider_id", "best_provider_name",
        "best_provider_3_6_decimal", "best_provider_4_6_decimal", "best_provider_5_7_decimal", "best_provider_grouped_9_12",
        "bet365_grouped_9_12", "best_vs_bet365_diff", "best_vs_bet365_pct", "provider_count_with_all_scores", "odds_status",
    ]


def best_line_fields() -> list[str]:
    return [
        "scraped_at", "event_id", "event_hash", "player1", "player2", "match_name", "match_date", "tournament", "match_url",
        "first_set_score", "p2_v3_hit", "result_status", "constructed_url",
        "best_3_6_decimal", "best_3_6_provider_id", "best_3_6_provider_name",
        "best_4_6_decimal", "best_4_6_provider_id", "best_4_6_provider_name",
        "best_5_7_decimal", "best_5_7_provider_id", "best_5_7_provider_name",
        "best_line_grouped_9_12", "bet365_grouped_9_12", "best_line_vs_bet365_diff", "best_line_vs_bet365_pct", "odds_status",
    ]


def fetch_all_provider_rows(context: BrowserContext, row: dict[str, Any], token: str) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    event_hash = clean_text(row.get("event_hash"))
    match_url = clean_text(row.get("match_url"))
    first_set_score = clean_text(row.get("first_set_score"))
    p2_v3_hit = first_set_score in P2_HIT_SCORES
    base_row = {
        "scraped_at": now_iso(),
        "event_id": row.get("event_id", ""),
        "event_hash": event_hash,
        "player1": row.get("player1", ""),
        "player2": row.get("player2", ""),
        "match_name": row.get("match_name", ""),
        "match_date": row.get("match_date", ""),
        "tournament": row.get("tournament", ""),
        "match_url": match_url,
        "first_set_score": first_set_score,
        "p2_v3_hit": bool_text(p2_v3_hit),
        "result_status": row.get("result_status", ""),
    }
    if not event_hash:
        empty_best = {**base_row, "odds_status": "missing_event_hash"}
        return [], empty_best, empty_best

    endpoint_url = construct_v3_endpoint(event_hash, token)
    common = {**base_row, "constructed_url": endpoint_url}
    try:
        resp = context.request.get(endpoint_url, headers={"referer": match_url or "https://www.oddsportal.com/", "accept": "*/*"}, timeout=30000)
        body = resp.text()
    except Exception as exc:
        empty_best = {**common, "odds_status": "request_error", "note": str(exc)[:500]}
        return [], empty_best, empty_best

    try:
        decoded = decode_oddsportal_dat(body)
        decode_status = "decoded"
    except Exception as exc:
        empty_best = {**common, "http_status": resp.status, "body_length": len(body), "decode_status": f"decode_failed:{exc}", "odds_status": "decode_failed"}
        return [], empty_best, empty_best

    score_map, provider_names = all_score_provider_odds(decoded)
    d = decoded.get("d", {}) if isinstance(decoded, dict) else {}
    all_provider_ids = sorted(set(score_map.get("3:6", {})) | set(score_map.get("4:6", {})) | set(score_map.get("5:7", {})))
    provider_rows: list[dict[str, Any]] = []
    for provider_id in all_provider_ids:
        grouped, score_odds = grouped_for_provider(score_map, provider_id)
        if not grouped:
            continue
        provider_rows.append({
            **common,
            "http_status": resp.status,
            "decode_status": decode_status,
            "body_length": len(body),
            "market_bt": d.get("bt") if isinstance(d, dict) else "",
            "market_scope": d.get("sc") if isinstance(d, dict) else "",
            "provider_id": provider_id,
            "provider_name": provider_names.get(provider_id, ""),
            "provider_3_6_decimal": score_odds.get("3:6"),
            "provider_4_6_decimal": score_odds.get("4:6"),
            "provider_5_7_decimal": score_odds.get("5:7"),
            "provider_grouped_9_12": grouped,
            "is_bet365": bool_text(provider_id == BET365_PROVIDER_ID),
            "provider_count_with_all_scores": "",
            "all_score_count": len([s for s, mp in score_map.items() if mp]),
            "odds_status": "ok",
            "note": "",
        })
    for r in provider_rows:
        r["provider_count_with_all_scores"] = len(provider_rows)

    bet365_grouped, bet365_scores = grouped_for_provider(score_map, BET365_PROVIDER_ID)
    if provider_rows:
        best_provider = max(provider_rows, key=lambda r: float(r.get("provider_grouped_9_12") or 0))
        best_diff = None
        best_pct = None
        if bet365_grouped:
            best_diff = float(best_provider["provider_grouped_9_12"]) - float(bet365_grouped)
            best_pct = best_diff / float(bet365_grouped) * 100.0
        best_provider_row = {
            **common,
            "first_set_score": first_set_score,
            "p2_v3_hit": bool_text(p2_v3_hit),
            "result_status": row.get("result_status", ""),
            "best_provider_id": best_provider.get("provider_id"),
            "best_provider_name": best_provider.get("provider_name"),
            "best_provider_3_6_decimal": best_provider.get("provider_3_6_decimal"),
            "best_provider_4_6_decimal": best_provider.get("provider_4_6_decimal"),
            "best_provider_5_7_decimal": best_provider.get("provider_5_7_decimal"),
            "best_provider_grouped_9_12": best_provider.get("provider_grouped_9_12"),
            "bet365_grouped_9_12": bet365_grouped or "",
            "best_vs_bet365_diff": round(best_diff, 6) if best_diff is not None else "",
            "best_vs_bet365_pct": round(best_pct, 2) if best_pct is not None else "",
            "provider_count_with_all_scores": len(provider_rows),
            "odds_status": "ok",
        }
    else:
        best_provider_row = {**common, "bet365_grouped_9_12": bet365_grouped or "", "provider_count_with_all_scores": 0, "odds_status": "missing_all_provider_v3_prices"}

    best_line = best_line_grouped(score_map, provider_names)
    best_line_grouped_value = safe_float(best_line.get("best_line_grouped_9_12"))
    best_line_diff = None
    best_line_pct = None
    if best_line_grouped_value and bet365_grouped:
        best_line_diff = best_line_grouped_value - float(bet365_grouped)
        best_line_pct = best_line_diff / float(bet365_grouped) * 100.0
    best_line_row = {
        **common,
        "first_set_score": first_set_score,
        "p2_v3_hit": bool_text(p2_v3_hit),
        "result_status": row.get("result_status", ""),
        **best_line,
        "bet365_grouped_9_12": bet365_grouped or "",
        "best_line_vs_bet365_diff": round(best_line_diff, 6) if best_line_diff is not None else "",
        "best_line_vs_bet365_pct": round(best_line_pct, 2) if best_line_pct is not None else "",
        "odds_status": "ok" if best_line_grouped_value else "missing_best_line_v3_prices",
    }
    return provider_rows, best_provider_row, best_line_row


def summary_fields() -> list[str]:
    return [
        "provider_id", "provider_name", "coverage_rows", "wins", "hit_rate_pct", "break_even_odds",
        "avg_grouped_odds", "median_grouped_odds", "p25_grouped_odds", "p75_grouped_odds",
        "final_bankroll", "profit", "max_drawdown_pct", "worst_losing_streak",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--master", default="data/first_set_results_master.csv")
    parser.add_argument("--out", default="artifacts/output/oddsportal-all-providers-v3")
    parser.add_argument("--start-index", type=int, default=0)
    parser.add_argument("--limit-total", type=int, default=25)
    parser.add_argument("--wait-ms", type=int, default=3500)
    parser.add_argument("--pause-seconds", type=float, default=0.25)
    parser.add_argument("--token-max-events", type=int, default=8)
    parser.add_argument("--min-provider-rows", type=int, default=5)
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    master_path = Path(args.master)
    rows = read_csv_rows(master_path)
    selected = rows[args.start_index: args.start_index + args.limit_total if args.limit_total and args.limit_total > 0 else None]
    meta: dict[str, Any] = {
        "generated_at": now_iso(),
        "args": vars(args),
        "master_exists": master_path.exists(),
        "master_size_bytes": master_path.stat().st_size if master_path.exists() else 0,
        "master_rows": len(rows),
        "selected_rows": len(selected),
        "cookie_secret_present": has_cookie_secret(),
        "login_ok": False,
        "session_token": "",
        "seed_endpoint_url": "",
        "rows_processed": 0,
        "provider_long_rows": 0,
        "best_provider_rows": 0,
        "best_line_rows": 0,
        "status_counts": {},
    }
    if len(rows) < 100:
        meta["stop_reason"] = f"MASTER_TOO_SMALL:{len(rows)}"
        (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return 2

    long_rows: list[dict[str, Any]] = []
    best_provider_rows: list[dict[str, Any]] = []
    best_line_rows: list[dict[str, Any]] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context: BrowserContext = create_cookie_context(browser, out_dir)
        page = context.new_page()
        try:
            if has_cookie_secret():
                base.log("Using cookie/storage secret for all-provider V3 test.")
                base.goto(page, base.ODDSPORTAL_HOME, args.wait_ms)
                meta["login_ok"] = True
            else:
                meta["login_ok"] = bool(base.login_if_needed(page, out_dir, args.wait_ms))
            if not meta["login_ok"]:
                meta["stop_reason"] = "LOGIN_SESSION_NOT_CONFIRMED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            token, seed = discover_token_fast(context, page, rows, args.wait_ms, args.token_max_events)
            meta["session_token"] = token
            meta["seed_endpoint_url"] = seed
            if not token:
                meta["stop_reason"] = "NO_SESSION_TOKEN_DISCOVERED"
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            for idx, row in enumerate(selected, start=args.start_index):
                base.log(f"[{idx}] all-provider V3 fetch: {row.get('match_name') or row.get('event_hash')}")
                provider_rows, best_provider, best_line = fetch_all_provider_rows(context, row, token)
                long_rows.extend(provider_rows)
                best_provider_rows.append(best_provider)
                best_line_rows.append(best_line)
                status = str(best_provider.get("odds_status") or "unknown")
                meta["status_counts"][status] = meta["status_counts"].get(status, 0) + 1
                meta["rows_processed"] += 1
                meta["provider_long_rows"] = len(long_rows)
                meta["best_provider_rows"] = len(best_provider_rows)
                meta["best_line_rows"] = len(best_line_rows)
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                time.sleep(args.pause_seconds)
        finally:
            context.close()
            browser.close()

    summaries = provider_summary(long_rows, args.min_provider_rows)
    write_csv(out_dir / "v3_all_providers_long.csv", long_rows, long_fields())
    write_csv(out_dir / "v3_best_provider_per_match.csv", best_provider_rows, best_provider_fields())
    write_csv(out_dir / "v3_best_line_per_match.csv", best_line_rows, best_line_fields())
    write_csv(out_dir / "v3_provider_summary.csv", summaries, summary_fields())

    best_provider_ok = [r for r in best_provider_rows if r.get("odds_status") == "ok"]
    best_line_ok = [r for r in best_line_rows if r.get("odds_status") == "ok"]
    best_provider_sim = simulate_bankroll(best_provider_ok, "best_provider_grouped_9_12")
    best_line_sim = simulate_bankroll(best_line_ok, "best_line_grouped_9_12")
    bet365_rows = [r for r in long_rows if str(r.get("provider_id")) == BET365_PROVIDER_ID]
    bet365_sim = simulate_bankroll(bet365_rows, "provider_grouped_9_12")

    meta.update({
        "summary_provider_count": len(summaries),
        "best_provider_ok_rows": len(best_provider_ok),
        "best_line_ok_rows": len(best_line_ok),
        "bet365_rows": len(bet365_rows),
        "bet365_simulation": bet365_sim,
        "best_provider_simulation": best_provider_sim,
        "best_line_simulation": best_line_sim,
        "stop_reason": "ALL_PROVIDERS_V3_COMPLETE",
    })
    (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    top_summary = summaries[:10]
    report = [
        "# OddsPortal All-Provider V3 Comparison",
        "",
        f"Generated: {meta['generated_at']}",
        f"Master rows: {meta['master_rows']}",
        f"Selected rows: {meta['selected_rows']}",
        f"Rows processed: {meta['rows_processed']}",
        f"Provider long rows: {meta['provider_long_rows']}",
        f"Best-provider ok rows: {len(best_provider_ok)}",
        f"Best-line ok rows: {len(best_line_ok)}",
        f"bet365 rows: {len(bet365_rows)}",
        "",
        "## 2% compound simulations from $5,000",
        f"bet365 same-book: {json.dumps(bet365_sim)}",
        f"Best same-book provider per match: {json.dumps(best_provider_sim)}",
        f"Best line shopping per score: {json.dumps(best_line_sim)}",
        "",
        "## Top providers by profit, min-provider-rows applied",
    ]
    for s in top_summary:
        report.append(
            f"- {s.get('provider_id')} {s.get('provider_name') or ''}: rows={s.get('coverage_rows')}, "
            f"hit={s.get('hit_rate_pct')}%, avg={s.get('avg_grouped_odds')}, final=${s.get('final_bankroll')}, profit=${s.get('profit')}"
        )
    (out_dir / "v3_all_providers_report.md").write_text("\n".join(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
