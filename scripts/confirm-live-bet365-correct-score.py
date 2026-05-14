#!/usr/bin/env python3
"""
Confirm live/upcoming OddsPortal 1st Set Correct Score prices from the bet365 expanded row.

Input:
  artifacts/output/oddsportal-upcoming-firstset/upcoming_firstset_summary.json

Output:
  Rewrites/creates a verified summary JSON where actionable_candidates contains ONLY
  rows with confirmed bet365 prices for P2 3:6, 4:6, and 5:7.

Safety:
  Read-only browser automation. No login. No betting. No captcha bypass.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

TARGETS = [
    {"score": "3:6", "field": "odds_3_6"},
    {"score": "4:6", "field": "odds_4_6"},
    {"score": "5:7", "field": "odds_5_7"},
]

DECIMAL_RE = re.compile(r"(?<!\d)(?:[1-9]\d?|\d)\.\d{2}(?!\d)")
AMERICAN_RE = re.compile(r"(?<![\w.])([+-](?:[1-9]\d{2,5}))(?![\w.])")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def american_to_decimal(raw: str) -> float | None:
    try:
        n = int(str(raw).replace("+", "").replace(",", ""))
    except Exception:
        return None
    if n > 0:
        return round(1 + n / 100, 4)
    if n < 0:
        return round(1 + 100 / abs(n), 4)
    return None


def odds_tokens(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in DECIMAL_RE.finditer(text or ""):
        dec = float(m.group(0))
        if 1.01 <= dec <= 1000:
            out.append({"raw": m.group(0), "decimal": dec, "kind": "decimal", "pos": m.start()})
    for m in AMERICAN_RE.finditer(text or ""):
        dec = american_to_decimal(m.group(1))
        if dec and 1.01 <= dec <= 1000:
            out.append({"raw": m.group(1), "decimal": dec, "kind": "american", "pos": m.start()})
    return sorted(out, key=lambda x: x["pos"])


def grouped(values: list[float | None]) -> float | None:
    if any(v is None or v <= 1 for v in values):
        return None
    return round(1 / sum(1 / float(v) for v in values if v), 4)


def normalize_score_text(score: str) -> list[str]:
    a, b = score.split(":")
    return [f"{a}:{b}", f"{a}-{b}", f"{a} : {b}", f"{a} - {b}"]


def normalize_url(raw_url: str) -> str:
    if not raw_url:
        return ""
    raw_url = raw_url.strip()
    if raw_url.startswith("http"):
        return raw_url
    return urljoin("https://www.oddsportal.com", raw_url)


def csv_escape(value: Any) -> str:
    s = "" if value is None else str(value)
    return '"' + s.replace('"', '""') + '"' if any(ch in s for ch in [",", '"', "\n", "\r"]) else s


def write_candidates_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = [
        "match_date",
        "league_name",
        "home_team",
        "away_team",
        "price_source",
        "live_bet365_confirmed",
        "odds_3_6_decimal",
        "odds_4_6_decimal",
        "odds_5_7_decimal",
        "estimated_player2_9_12_odds",
        "player2_match_odds",
        "synthetic_signal_tier",
        "play_status",
        "match_link",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(csv_escape(row.get(h, "")) for h in headers))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


async def accept_cookies(page) -> None:
    for selector in [
        "#onetrust-accept-btn-handler",
        "#onetrust-reject-all-handler",
        "button:has-text('Accept All')",
        "button:has-text('Reject All')",
        "button:has-text('Accept')",
    ]:
        try:
            loc = page.locator(selector).first
            if await loc.count() > 0:
                await loc.click(timeout=1800)
                await page.wait_for_timeout(900)
                return
        except Exception:
            pass


async def click_market_tabs(page) -> None:
    # Click top-level Correct Score then 1st Set, if both are available.
    for label in ["Correct Score", "1st Set"]:
        try:
            loc = page.get_by_text(label, exact=True)
            count = await loc.count()
            for i in range(min(count, 4)):
                try:
                    item = loc.nth(i)
                    if await item.is_visible(timeout=1000):
                        await item.click(timeout=2500)
                        await page.wait_for_timeout(1200)
                        break
                except Exception:
                    pass
        except Exception:
            pass


async def load_correct_score_market(page, url: str, wait_ms: int) -> tuple[str, str, str]:
    await page.goto(url, wait_until="networkidle", timeout=90000)
    await page.wait_for_timeout(wait_ms)
    await accept_cookies(page)
    await click_market_tabs(page)
    await page.wait_for_timeout(1800)
    title = await page.title()
    text = await page.locator("body").inner_text(timeout=15000)
    final_url = page.url
    return title, text, final_url


async def find_visible_price_for_score(page, score: str) -> dict[str, Any] | None:
    text = await page.locator("body").inner_text(timeout=15000)
    for alias in normalize_score_text(score):
        # OddsPortal row text usually looks like: 4:6 3 +3000
        m = re.search(rf"\b{re.escape(alias)}\s+\d+\s+([+-]\d+|\d+\.\d{{2}})\b", text)
        if m:
            raw = m.group(1)
            dec = american_to_decimal(raw) if raw.startswith(("+", "-")) else float(raw)
            return {"score_alias": alias, "raw": raw, "decimal": dec}
    return None


async def find_and_click_exact_score_row(page, score: str, visible_raw: str) -> dict[str, Any] | None:
    aliases = normalize_score_text(score)
    candidates = await page.evaluate(
        """
        ({aliases, visibleRaw}) => {
          const out = [];
          const els = [...document.querySelectorAll('*')];
          function visible(el) {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
          }
          for (const el of els) {
            if (!visible(el)) continue;
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!text || !text.includes(visibleRaw)) continue;
            if (!aliases.some(score => text.includes(score))) continue;
            const r = el.getBoundingClientRect();
            out.push({ tag: el.tagName, text, x: r.x, y: r.y, w: r.width, h: r.height, len: text.length });
          }
          return out
            .filter(x => x.w > 250 && x.h >= 18 && x.h < 140 && x.len < 400)
            .sort((a,b) => a.len - b.len || a.y - b.y)
            .slice(0, 20);
        }
        """,
        {"aliases": aliases, "visibleRaw": visible_raw},
    )
    if not candidates:
        return None
    row = candidates[0]
    click_x = max(8, row["x"] + 20)
    click_y = row["y"] + row["h"] / 2
    await page.mouse.click(click_x, click_y)
    await page.wait_for_timeout(2600)
    return row


async def extract_bookmaker_near_y(page, row_y: float, bookmaker: str) -> dict[str, Any] | None:
    result = await page.evaluate(
        """
        ({rowY, bookmaker}) => {
          const out = [];
          const bookieRe = new RegExp(bookmaker, 'i');
          function meta(el) {
            const imgs = [...el.querySelectorAll('img')].map(img => [img.alt || '', img.title || '', img.src || ''].join(' ')).join(' ');
            return [el.innerText || '', imgs, el.getAttribute('alt') || '', el.getAttribute('title') || '', el.getAttribute('src') || '', el.outerHTML || ''].join(' ');
          }
          function visible(el) {
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
          }
          for (const el of [...document.querySelectorAll('*')]) {
            if (!visible(el)) continue;
            const raw = meta(el);
            if (!bookieRe.test(raw)) continue;
            const r = el.getBoundingClientRect();
            if (r.y < rowY - 30 || r.y > rowY + 700) continue;
            let cur = el;
            for (let depth = 0; depth < 8 && cur; depth++, cur = cur.parentElement) {
              if (!visible(cur)) continue;
              const cr = cur.getBoundingClientRect();
              const text = (cur.innerText || '').replace(/\s+/g, ' ').trim();
              const html = (cur.outerHTML || '').slice(0, 9000);
              const all = (text + ' ' + html).replace(/\s+/g, ' ').trim();
              if (cr.y < rowY - 30 || cr.y > rowY + 700) continue;
              if (cr.width < 80 || cr.height < 8 || cr.height > 190) continue;
              if (!bookieRe.test(all)) continue;
              out.push({ tag: cur.tagName, y: cr.y, h: cr.height, text, html, all: all.slice(0, 3500), size: all.length });
            }
          }
          return out.sort((a,b) => a.size - b.size || Math.abs(a.y - rowY) - Math.abs(b.y - rowY)).slice(0, 50);
        }
        """,
        {"rowY": row_y, "bookmaker": bookmaker},
    )
    best = None
    for c in result:
        html_text = BeautifulSoup(c.get("html", ""), "html.parser").get_text(" ")
        merged = (c.get("text", "") + " " + html_text).replace("\n", " ")
        tokens = odds_tokens(merged)
        decimal_tokens = [t for t in tokens if t["kind"] == "decimal"]
        selected = decimal_tokens[0] if decimal_tokens else (tokens[0] if tokens else None)
        if not selected:
            continue
        candidate = {
            "raw": selected["raw"],
            "decimal": selected["decimal"],
            "kind": selected["kind"],
            "candidate_text": re.sub(r"\s+", " ", merged).strip()[:1200],
            "candidate_size": c.get("size", 999999),
        }
        if best is None or candidate["candidate_size"] < best["candidate_size"]:
            best = candidate
    return best


async def confirm_candidate(browser, row: dict[str, Any], idx: int, args) -> dict[str, Any]:
    url = normalize_url(row.get("match_link") or row.get("market_url") or row.get("input_url") or "")
    result = dict(row)
    result["live_bet365_confirmed"] = False
    result["live_bet365_confirmed_count"] = 0
    result["live_bet365_confirmed_at"] = ""
    result["live_bet365_note"] = ""
    result["price_source"] = args.bookmaker
    if not url:
        result["live_bet365_note"] = "missing_match_link"
        return result

    context = await browser.new_context(
        viewport={"width": 1500, "height": 1200},
        locale="en-US",
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    )
    page = await context.new_page()
    try:
        title, text, final_url = await load_correct_score_market(page, url, args.wait_ms)
        if args.debug_every > 0 and idx % args.debug_every == 0:
            await page.screenshot(path=str(Path(args.out_dir) / f"live_confirm_{idx:04d}.png"), full_page=True)

        confirmed: dict[str, dict[str, Any]] = {}
        notes: list[str] = []
        for target in TARGETS:
            score = target["score"]
            field = target["field"]
            visible = await find_visible_price_for_score(page, score)
            if not visible:
                notes.append(f"{score}:visible_missing")
                confirmed[field] = {"raw": "", "decimal": None, "ok": False}
                continue

            # Reload per score to avoid expanded-row state leaking between rows.
            await load_correct_score_market(page, url, args.wait_ms)
            await page.wait_for_timeout(800)
            score_row = await find_and_click_exact_score_row(page, score, visible["raw"])
            if not score_row:
                notes.append(f"{score}:row_missing")
                confirmed[field] = {"raw": "", "decimal": None, "ok": False}
                continue
            book = await extract_bookmaker_near_y(page, score_row["y"], args.bookmaker)
            if not book:
                notes.append(f"{score}:bookmaker_missing")
                confirmed[field] = {"raw": "", "decimal": None, "ok": False}
                continue
            confirmed[field] = {"raw": book["raw"], "decimal": book["decimal"], "ok": True}

        count = sum(1 for v in confirmed.values() if v.get("ok"))
        p2_group = grouped([confirmed.get("odds_3_6", {}).get("decimal"), confirmed.get("odds_4_6", {}).get("decimal"), confirmed.get("odds_5_7", {}).get("decimal")])

        result.update(
            {
                "match_link": url,
                "final_url": final_url,
                "live_bet365_title": title,
                "live_bet365_confirmed": count == 3 and p2_group is not None,
                "live_bet365_confirmed_count": count,
                "live_bet365_confirmed_at": now_iso() if count else "",
                "live_bet365_note": ";".join(notes),
                "odds_3_6_decimal": confirmed.get("odds_3_6", {}).get("decimal"),
                "odds_4_6_decimal": confirmed.get("odds_4_6", {}).get("decimal"),
                "odds_5_7_decimal": confirmed.get("odds_5_7", {}).get("decimal"),
                "odds_3_6_american": confirmed.get("odds_3_6", {}).get("raw", ""),
                "odds_4_6_american": confirmed.get("odds_4_6", {}).get("raw", ""),
                "odds_5_7_american": confirmed.get("odds_5_7", {}).get("raw", ""),
                "bookmaker_3_6": args.bookmaker if confirmed.get("odds_3_6", {}).get("ok") else "",
                "bookmaker_4_6": args.bookmaker if confirmed.get("odds_4_6", {}).get("ok") else "",
                "bookmaker_5_7": args.bookmaker if confirmed.get("odds_5_7", {}).get("ok") else "",
                "estimated_player2_9_12_odds": p2_group,
                "verified_grouped_odds": p2_group,
                "price_verification_source": "oddsportal_row_arrow_live",
                "auto_price_confirmed": count == 3 and p2_group is not None,
                "auto_price_confirmed_at": now_iso() if count == 3 and p2_group is not None else "",
                "price_source": args.bookmaker,
            }
        )
        await context.close()
        return result
    except PlaywrightTimeoutError as e:
        result["live_bet365_note"] = f"timeout:{str(e)[:250]}"
    except Exception as e:
        result["live_bet365_note"] = f"error:{str(e)[:250]}"
    await context.close()
    return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", required=True)
    parser.add_argument("--out-summary", default="")
    parser.add_argument("--out-dir", default="artifacts/output/oddsportal-upcoming-firstset")
    parser.add_argument("--bookmaker", default="bet365")
    parser.add_argument("--max-candidates", type=int, default=12)
    parser.add_argument("--threshold", type=float, default=3.3)
    parser.add_argument("--wait-ms", type=int, default=3500)
    parser.add_argument("--pause-seconds", type=float, default=1.0)
    parser.add_argument("--debug-every", type=int, default=5)
    args = parser.parse_args()

    summary_path = Path(args.summary)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_summary = Path(args.out_summary) if args.out_summary else summary_path

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    raw_rows = summary.get("actionable_candidates") or summary.get("candidates") or []
    candidates = [row for row in raw_rows if (row.get("match_link") or row.get("market_url") or row.get("input_url"))]
    candidates = candidates[: args.max_candidates]

    verified: list[dict[str, Any]] = []
    attempted: list[dict[str, Any]] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        for idx, row in enumerate(candidates, start=1):
            print(f"[{idx}/{len(candidates)}] confirming {row.get('home_team') or row.get('player1')} vs {row.get('away_team') or row.get('player2')}", flush=True)
            confirmed = await confirm_candidate(browser, row, idx, args)
            attempted.append(confirmed)
            ok = bool(confirmed.get("live_bet365_confirmed")) and (confirmed.get("estimated_player2_9_12_odds") or 0) >= args.threshold
            print("   confirmed:", confirmed.get("live_bet365_confirmed"), "count:", confirmed.get("live_bet365_confirmed_count"), "group:", confirmed.get("estimated_player2_9_12_odds"), flush=True)
            if ok:
                verified.append(confirmed)
            await asyncio.sleep(args.pause_seconds)
        await browser.close()

    # Preserve original rows, but make actionable_candidates strict-confirmed only.
    summary["live_bet365_confirmation"] = {
        "generated_at": now_iso(),
        "bookmaker": args.bookmaker,
        "source_summary": str(summary_path),
        "candidates_input": len(raw_rows),
        "candidates_attempted": len(attempted),
        "verified_count": len(verified),
        "threshold": args.threshold,
        "rule": "actionable_candidates contains only rows with confirmed bet365 P2 3:6/4:6/5:7 expanded-row prices",
    }
    summary["live_bet365_confirmation_attempted"] = attempted
    summary["actionable_candidates"] = verified
    summary["actionable_candidates_count"] = len(verified)
    summary["target_bookmaker_candidates_count"] = len(verified)
    summary["target_bookmaker_rows_with_reconstructed_odds"] = len(verified)
    summary["target_bookmaker_rows_top_50"] = verified[:50]
    summary["warning"] = "Strict live mode: actionable candidates require row-arrow expanded bet365 confirmation for 3:6, 4:6, and 5:7. No bet is placed automatically."

    out_summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    write_candidates_csv(out_dir / "bet365_live_confirmed_actionable_candidates.csv", verified)
    write_candidates_csv(out_dir / "bet365_live_confirmation_attempted.csv", attempted)

    print(json.dumps(summary["live_bet365_confirmation"], indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
