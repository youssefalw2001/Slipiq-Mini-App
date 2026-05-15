#!/usr/bin/env python3
"""
SlipIQ fast filtered OddsPortal bet365 V3 scraper.

Read-only. No sportsbook login. No betting. No captcha bypass.

What this does:
1. Uses an OddsPortal account session, either via username/password secrets or a saved
   Playwright storage state secret.
2. Applies/checks the OddsPortal bookmaker filter for bet365.
3. Smoke-tests the proven Sinner/Ofner first-set correct-score URL.
4. If the visible rows match confirmed bet365 prices, scrapes visible first-set
   correct-score rows from exact URLs or tournament result pages.
5. Saves a CSV compatible with scripts/backtest_bet365_v3_from_csv.py.

Required for login option:
  ODDSPORTAL_USERNAME
  ODDSPORTAL_PASSWORD

Preferred fallback if login/captcha is an issue:
  ODDSPORTAL_STORAGE_STATE_B64

The storage state should be a base64-encoded Playwright storage_state JSON from a
manually logged-in OddsPortal session with bookmaker filter available.
"""
from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urldefrag

from playwright.sync_api import Browser, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright

ODDSPORTAL_HOME = "https://www.oddsportal.com/"
PROOF_URL = "https://www.oddsportal.com/tennis/h2h/ofner-sebastian-h6vs3iR2/sinner-jannik-6HdC3z4H/#xhTpdK0l:cs;12"

TARGET_P2 = {
    "3:6": {"american": "+6600", "decimal": 67.00},
    "4:6": {"american": "+1800", "decimal": 19.00},
    "5:7": {"american": "+5000", "decimal": 51.00},
}

P2_SCORES = ["3:6", "4:6", "5:7"]
P1_SCORES = ["6:3", "6:4", "7:5"]
ALL_SCORES = P2_SCORES + P1_SCORES


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


def safe_filename(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)[:160].strip("_") or "item"


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def american_to_decimal(value: str) -> float | None:
    s = str(value).strip().replace("−", "-")
    m = re.fullmatch(r"([+-])(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    sign, raw = m.groups()
    n = float(raw)
    if sign == "+":
        return round(n / 100.0 + 1.0, 6)
    if n == 0:
        return None
    return round(100.0 / n + 1.0, 6)


def odds_to_decimal(token: str) -> float | None:
    if token is None:
        return None
    s = str(token).strip().replace("−", "-").replace(",", "")
    if not s:
        return None
    am = american_to_decimal(s)
    if am is not None:
        return am
    try:
        value = float(s)
        if 1.01 <= value <= 1000:
            return value
    except Exception:
        return None
    return None


def decimal_close(a: float | None, b: float, tol: float = 0.06) -> bool:
    return a is not None and abs(float(a) - float(b)) <= tol


def grouped_odds(values: list[float | None]) -> float | None:
    if any(v is None or v <= 1 for v in values):
        return None
    denom = sum(1.0 / float(v) for v in values if v is not None)
    if denom <= 0:
        return None
    return round(1.0 / denom, 6)


def bool_text(value: bool) -> str:
    return "true" if value else "false"


def score_variants(score: str) -> list[str]:
    a, b = score.split(":")
    return [f"{a}:{b}", f"{a}-{b}", f"{a} : {b}", f"{a} - {b}"]


def normalize_score(score: str) -> str:
    return str(score).strip().replace("-", ":").replace(" ", "")


def read_urls_file(path: str | None) -> list[str]:
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        return []
    urls: list[str] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        urls.append(line)
    return urls


def decode_storage_state(out_dir: Path) -> Path | None:
    raw = os.getenv("ODDSPORTAL_STORAGE_STATE_B64", "").strip()
    if not raw:
        return None
    state_path = out_dir / "oddspapi_storage_state.json"
    try:
        decoded = base64.b64decode(raw)
        parsed = json.loads(decoded.decode("utf-8"))
        state_path.write_text(json.dumps(parsed), encoding="utf-8")
        log("Decoded ODDSPORTAL_STORAGE_STATE_B64 into Playwright storage state.")
        return state_path
    except Exception as exc:
        log(f"Could not decode ODDSPORTAL_STORAGE_STATE_B64: {exc}")
        return None


def create_context(browser: Browser, out_dir: Path, headless_debug: bool = False) -> BrowserContext:
    storage_state = decode_storage_state(out_dir)
    kwargs: dict[str, Any] = {
        "viewport": {"width": 1440, "height": 1200},
        "locale": "en-US",
        "timezone_id": "UTC",
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    }
    if storage_state:
        kwargs["storage_state"] = str(storage_state)
    return browser.new_context(**kwargs)


def save_debug(page: Page, out_dir: Path, name: str) -> None:
    debug_dir = out_dir / "debug"
    ensure_dir(debug_dir)
    try:
        page.screenshot(path=str(debug_dir / f"{safe_filename(name)}.png"), full_page=True, timeout=15000)
    except Exception:
        pass
    try:
        (debug_dir / f"{safe_filename(name)}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass


def accept_privacy(page: Page) -> None:
    labels = [
        "Accept all", "Accept All", "I Accept", "I agree", "Agree", "Accept", "Got it", "OK", "Okay",
        "Allow all", "Consent",
    ]
    for label in labels:
        try:
            locator = page.get_by_role("button", name=re.compile(re.escape(label), re.I))
            if locator.count() > 0:
                locator.first.click(timeout=1200)
                page.wait_for_timeout(600)
                return
        except Exception:
            continue
    for label in labels:
        try:
            locator = page.locator(f"text={label}")
            if locator.count() > 0:
                locator.first.click(timeout=1200)
                page.wait_for_timeout(600)
                return
        except Exception:
            continue


def goto(page: Page, url: str, wait_ms: int) -> None:
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    accept_privacy(page)
    page.wait_for_timeout(wait_ms)


def logged_in_hint(page: Page) -> bool:
    text = ""
    try:
        text = page.locator("body").inner_text(timeout=5000).lower()
    except Exception:
        return False
    if "logout" in text or "my profile" in text or "account settings" in text or "bookmaker filter" in text:
        return True
    if "login" in text and "password" in text:
        return False
    return bool(os.getenv("ODDSPORTAL_STORAGE_STATE_B64", "").strip())


def login_if_needed(page: Page, out_dir: Path, wait_ms: int) -> bool:
    if os.getenv("ODDSPORTAL_STORAGE_STATE_B64", "").strip():
        log("Using storage state session; skipping username/password login.")
        goto(page, ODDSPORTAL_HOME, wait_ms)
        return True

    username = os.getenv("ODDSPORTAL_USERNAME", "").strip()
    password = os.getenv("ODDSPORTAL_PASSWORD", "").strip()
    if not username or not password:
        log("No OddsPortal credentials found. Set ODDSPORTAL_USERNAME/ODDSPORTAL_PASSWORD or ODDSPORTAL_STORAGE_STATE_B64.")
        return False

    goto(page, ODDSPORTAL_HOME, wait_ms)
    if logged_in_hint(page):
        log("Already appears logged in.")
        return True

    log("Attempting OddsPortal login with repository secrets.")
    clicked = False
    for pattern in [r"Log in", r"Login", r"Sign in", r"Sign In"]:
        try:
            btn = page.get_by_text(re.compile(pattern, re.I)).first
            btn.click(timeout=3000)
            clicked = True
            break
        except Exception:
            continue
    if not clicked:
        try:
            page.goto(urljoin(ODDSPORTAL_HOME, "login/"), wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass
    page.wait_for_timeout(wait_ms)
    accept_privacy(page)

    # Try common login inputs. OddsPortal changes UI often, so keep this flexible.
    user_selectors = [
        "input[name='login-username']", "input[name='username']", "input[name='email']", "input[type='email']",
        "input[autocomplete='username']", "input[placeholder*='Username' i]", "input[placeholder*='Email' i]",
    ]
    pass_selectors = [
        "input[name='login-password']", "input[name='password']", "input[type='password']", "input[autocomplete='current-password']",
    ]

    filled_user = False
    for sel in user_selectors:
        try:
            loc = page.locator(sel).first
            loc.wait_for(state="visible", timeout=4000)
            loc.fill(username, timeout=3000)
            filled_user = True
            break
        except Exception:
            continue

    filled_pass = False
    for sel in pass_selectors:
        try:
            loc = page.locator(sel).first
            loc.wait_for(state="visible", timeout=4000)
            loc.fill(password, timeout=3000)
            filled_pass = True
            break
        except Exception:
            continue

    if not (filled_user and filled_pass):
        save_debug(page, out_dir, "login_inputs_not_found")
        log("Could not find login inputs. Use ODDSPORTAL_STORAGE_STATE_B64 if captcha/new login UI blocks automation.")
        return False

    submitted = False
    for pattern in [r"Log in", r"Login", r"Sign in", r"Sign In"]:
        try:
            page.get_by_role("button", name=re.compile(pattern, re.I)).first.click(timeout=3000)
            submitted = True
            break
        except Exception:
            continue
    if not submitted:
        try:
            page.keyboard.press("Enter")
        except Exception:
            pass

    page.wait_for_timeout(max(wait_ms * 2, 7000))
    accept_privacy(page)
    body = page.locator("body").inner_text(timeout=8000).lower()
    if "captcha" in body or "verify" in body and "human" in body:
        save_debug(page, out_dir, "login_captcha_or_verification")
        log("OddsPortal login appears to require captcha/verification. No bypass attempted. Use storage state secret.")
        return False
    ok = logged_in_hint(page)
    if ok:
        log("OddsPortal login appears successful.")
    else:
        save_debug(page, out_dir, "login_not_confirmed")
        log("Could not confirm OddsPortal login. Smoke test will be the real filter check.")
    return True


def maybe_click_text(page: Page, patterns: list[str], timeout: int = 2000) -> bool:
    for pat in patterns:
        try:
            loc = page.get_by_text(re.compile(pat, re.I)).first
            loc.click(timeout=timeout)
            page.wait_for_timeout(600)
            return True
        except Exception:
            continue
    return False


def apply_bet365_filter(page: Page, out_dir: Path, wait_ms: int) -> bool:
    """Best-effort OddsPortal bookmaker filter.

    The smoke test is the source of truth. If this function cannot find the UI, the script
    continues to smoke test because a saved account/session may already have bet365 filter applied.
    """
    log("Applying/checking OddsPortal bookmaker filter = bet365.")
    try:
        goto(page, ODDSPORTAL_HOME, wait_ms)
    except Exception:
        pass

    # Try direct settings-ish pages first. Some accounts persist the filter globally.
    candidate_paths = [
        "account/settings/", "settings/", "my-account/", "profile/", "bookmakers/",
    ]
    for path in candidate_paths:
        try:
            page.goto(urljoin(ODDSPORTAL_HOME, path), wait_until="domcontentloaded", timeout=25000)
            accept_privacy(page)
            page.wait_for_timeout(1500)
            text = page.locator("body").inner_text(timeout=5000).lower()
            if "bet365" in text and ("bookmaker" in text or "filter" in text or "settings" in text):
                break
        except Exception:
            continue

    # Try opening bookmaker/filter controls on whatever page we reached.
    maybe_click_text(page, ["Bookmaker", "Bookmakers", "Odds format", "Settings", "Customize", "Filter"])

    # Try search field inside filter UI.
    for sel in ["input[type='search']", "input[placeholder*='Search' i]", "input[placeholder*='Bookmaker' i]", "input"]:
        try:
            inp = page.locator(sel).first
            if inp.is_visible(timeout=1000):
                inp.fill("bet365", timeout=1500)
                page.wait_for_timeout(800)
                break
        except Exception:
            continue

    # Select bet365 text or checkbox if exposed.
    selected = maybe_click_text(page, [r"^bet365$", r"bet365"])
    # Apply/save controls, if any.
    maybe_click_text(page, ["Apply", "Save", "Done", "OK", "Show odds"])
    page.wait_for_timeout(wait_ms)

    # Do not fail here. Smoke test decides.
    if selected:
        log("Clicked a bet365 filter/control. Smoke test will verify exact prices.")
    else:
        log("Could not positively click a bet365 filter. Continuing; session may already be filtered.")
    return True


def ensure_first_set_correct_score(page: Page, wait_ms: int) -> None:
    """Navigate/click into Correct Score 1st Set if hash didn't open it."""
    page.wait_for_timeout(wait_ms)
    body = ""
    try:
        body = page.locator("body").inner_text(timeout=8000)
    except Exception:
        pass
    if "3:6" in body and "4:6" in body and "5:7" in body:
        return
    maybe_click_text(page, ["Correct Score"])
    page.wait_for_timeout(1200)
    maybe_click_text(page, ["1st Set", "1st set", "First Set", "Set 1"])
    page.wait_for_timeout(wait_ms)


def visible_elements_text(page: Page) -> list[dict[str, str]]:
    script = r"""
    () => {
      const out = [];
      const nodes = Array.from(document.querySelectorAll('body *'));
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 300) continue;
        out.push({tag: el.tagName, cls: el.className ? String(el.className).slice(0,120) : '', text});
      }
      return out;
    }
    """
    try:
        return page.evaluate(script)
    except Exception:
        return []


def body_lines(page: Page) -> list[str]:
    try:
        text = page.locator("body").inner_text(timeout=8000)
    except Exception:
        return []
    lines = []
    for line in text.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if clean:
            lines.append(clean)
    return lines


def parse_odds_from_text_near_score(text: str, score: str) -> tuple[str | None, float | None]:
    """Extract first plausible odds token after a score in a text chunk."""
    variants = score_variants(score)
    pos = -1
    used_variant = None
    for v in variants:
        pos = text.find(v)
        if pos >= 0:
            used_variant = v
            break
    if pos < 0:
        return None, None
    tail = text[pos + len(used_variant or score): pos + 220]
    # Remove obvious ranking/page counters but keep +6600, 19.00 etc.
    tokens = re.findall(r"[+-]\d{3,5}|\b\d{1,3}\.\d{1,3}\b|\b\d{2,3}\b", tail)
    for token in tokens:
        dec = odds_to_decimal(token)
        if dec and dec > 1.01:
            return token, dec
    return None, None


def extract_score_odds(page: Page, scores: list[str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {s: {"raw": None, "decimal": None, "source": None} for s in scores}
    lines = body_lines(page)

    # Best case: score and odds are on same row/nearby body line.
    for score in scores:
        for line in lines:
            if any(v in line for v in score_variants(score)):
                raw, dec = parse_odds_from_text_near_score(line, score)
                if dec:
                    result[score] = {"raw": raw, "decimal": dec, "source": line[:240]}
                    break

    # Fallback: visible element text sometimes gives score and odds in sibling containers.
    elems = visible_elements_text(page)
    compact = [e["text"] for e in elems]
    for score in scores:
        if result[score]["decimal"] is not None:
            continue
        for idx, text in enumerate(compact):
            if any(v == text or v in text for v in score_variants(score)):
                window = " ".join(compact[idx: idx + 10])
                raw, dec = parse_odds_from_text_near_score(window, score)
                if dec:
                    result[score] = {"raw": raw, "decimal": dec, "source": window[:240]}
                    break

    return result


def extract_match_name(page: Page, url: str) -> str:
    for sel in ["h1", "[data-testid*='heading' i]", "title"]:
        try:
            if sel == "title":
                title = page.title(timeout=5000)
            else:
                title = page.locator(sel).first.inner_text(timeout=3000)
            title = re.sub(r"\s+", " ", title).strip()
            if title:
                return title[:200]
        except Exception:
            continue
    return urldefrag(url)[0].rstrip("/").split("/")[-1]


def extract_first_set_score_from_text(lines: list[str]) -> str:
    text = "\n".join(lines[:120])
    # Look for common tennis score chunks. Keep conservative; unknown is acceptable and can be settled later.
    patterns = [
        r"(?:1st Set|1st set|First Set|first set)\s*[:\-]?\s*([0-7])\s*[:\-]\s*([0-7])",
        r"Set 1\s*[:\-]?\s*([0-7])\s*[:\-]\s*([0-7])",
        r"\b([0-7])\s*[:\-]\s*([0-7])\b",
    ]
    for pat in patterns:
        for m in re.finditer(pat, text, re.I):
            a, b = m.group(1), m.group(2)
            if {a, b} & {"6", "7"}:
                return f"{a}:{b}"
    return ""


def scrape_market_page(page: Page, url: str, out_dir: Path, wait_ms: int) -> dict[str, str]:
    goto(page, url, wait_ms)
    ensure_first_set_correct_score(page, wait_ms)
    match_name = extract_match_name(page, url)
    odds = extract_score_odds(page, ALL_SCORES)
    lines = body_lines(page)
    first_set_score = extract_first_set_score_from_text(lines)

    p2_values = [odds[s]["decimal"] for s in P2_SCORES]
    p1_values = [odds[s]["decimal"] for s in P1_SCORES]
    p2_grouped = grouped_odds(p2_values)
    p1_grouped = grouped_odds(p1_values)
    confirmed_p2 = sum(1 for v in p2_values if v is not None)
    confirmed_all = sum(1 for s in ALL_SCORES if odds[s]["decimal"] is not None)

    score_norm = normalize_score(first_set_score)
    p2_hit = score_norm in P2_SCORES
    p1_hit = score_norm in P1_SCORES
    status = "ok" if confirmed_p2 == 3 else "partial" if confirmed_p2 > 0 else "missing"

    return {
        "scraped_at": now_iso(),
        "input_url": url,
        "market_url": page.url,
        "match_name": match_name,
        "title": match_name,
        "first_set_score": first_set_score,
        "p2_3_6": str(odds["3:6"]["decimal"] or ""),
        "p2_4_6": str(odds["4:6"]["decimal"] or ""),
        "p2_5_7": str(odds["5:7"]["decimal"] or ""),
        "p2_3_6_raw": str(odds["3:6"]["raw"] or ""),
        "p2_4_6_raw": str(odds["4:6"]["raw"] or ""),
        "p2_5_7_raw": str(odds["5:7"]["raw"] or ""),
        "p2_grouped_9_12": str(p2_grouped or ""),
        "p2_v3_hit": bool_text(p2_hit),
        "p1_6_3": str(odds["6:3"]["decimal"] or ""),
        "p1_6_4": str(odds["6:4"]["decimal"] or ""),
        "p1_7_5": str(odds["7:5"]["decimal"] or ""),
        "p1_grouped_9_12": str(p1_grouped or ""),
        "p1_hit": bool_text(p1_hit),
        "bet365_confirmed_count": str(confirmed_p2),
        "bet365_all_score_count": str(confirmed_all),
        "status": status,
    }


def smoke_test(page: Page, out_dir: Path, wait_ms: int) -> bool:
    log("Running filtered bet365 smoke test on Sinner/Ofner proof URL.")
    row = scrape_market_page(page, PROOF_URL, out_dir, wait_ms)
    smoke_path = out_dir / "smoke_row.json"
    smoke_path.write_text(json.dumps(row, indent=2), encoding="utf-8")
    save_debug(page, out_dir, "smoke_filtered_bet365")

    checks = []
    for score, expected in TARGET_P2.items():
        key = {"3:6": "p2_3_6", "4:6": "p2_4_6", "5:7": "p2_5_7"}[score]
        actual = odds_to_decimal(row.get(key, ""))
        raw_key = key + "_raw"
        raw = row.get(raw_key, "")
        ok = decimal_close(actual, expected["decimal"]) or str(raw).strip() == expected["american"]
        checks.append({"score": score, "expected_decimal": expected["decimal"], "expected_american": expected["american"], "actual_decimal": actual, "actual_raw": raw, "ok": ok})

    result = {"ok": all(c["ok"] for c in checks), "checks": checks, "row": row}
    (out_dir / "smoke_result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    log(json.dumps({"smoke_ok": result["ok"], "checks": checks}, indent=2))
    if not result["ok"]:
        log("Smoke failed. This means OddsPortal visible odds are not confirmed bet365-filtered prices. Stopping.")
    return bool(result["ok"])


def discover_match_urls(page: Page, results_url: str, max_matches: int, wait_ms: int) -> list[str]:
    log(f"Discovering match URLs from {results_url}")
    goto(page, results_url, wait_ms)
    links = page.eval_on_selector_all(
        "a[href]",
        "els => els.map(a => ({href: a.href, text: (a.innerText || a.textContent || '').trim()}))",
    )
    urls: list[str] = []
    seen: set[str] = set()
    for item in links:
        href = item.get("href") or ""
        if "/tennis/" not in href:
            continue
        # Match pages usually contain an h2h segment or a match slug and are not standings/results category pages.
        if "/h2h/" not in href and "#" not in href:
            continue
        base = urldefrag(href)[0].rstrip("/") + "/#cs;12"
        if base in seen:
            continue
        seen.add(base)
        urls.append(base)
        if len(urls) >= max_matches:
            break
    log(f"Discovered {len(urls)} match URLs from results page.")
    return urls


def write_rows_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fields = [
        "scraped_at", "input_url", "market_url", "match_name", "title", "first_set_score",
        "p2_3_6", "p2_4_6", "p2_5_7", "p2_3_6_raw", "p2_4_6_raw", "p2_5_7_raw", "p2_grouped_9_12", "p2_v3_hit",
        "p1_6_3", "p1_6_4", "p1_7_5", "p1_grouped_9_12", "p1_hit",
        "bet365_confirmed_count", "bet365_all_score_count", "status",
    ]
    ensure_dir(path.parent)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fields})


def append_row_csv(path: Path, row: dict[str, str]) -> None:
    exists = path.exists()
    fields = [
        "scraped_at", "input_url", "market_url", "match_name", "title", "first_set_score",
        "p2_3_6", "p2_4_6", "p2_5_7", "p2_3_6_raw", "p2_4_6_raw", "p2_5_7_raw", "p2_grouped_9_12", "p2_v3_hit",
        "p1_6_3", "p1_6_4", "p1_7_5", "p1_grouped_9_12", "p1_hit",
        "bet365_confirmed_count", "bet365_all_score_count", "status",
    ]
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerow({k: row.get(k, "") for k in fields})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exact-urls-file", default="")
    parser.add_argument("--results-urls-file", default="")
    parser.add_argument("--out", default="artifacts/output/oddsportal-login-filtered-bet365")
    parser.add_argument("--limit-total", type=int, default=40)
    parser.add_argument("--max-matches-per-results", type=int, default=10)
    parser.add_argument("--wait-ms", type=int, default=4500)
    parser.add_argument("--pause-seconds", type=float, default=1.5)
    parser.add_argument("--smoke-only", action="store_true")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    ensure_dir(out_dir)
    csv_path = out_dir / "bet365_master_odds_db.csv"
    meta = {"generated_at": now_iso(), "args": vars(args), "rows": 0, "smoke_ok": False}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed, args=["--disable-dev-shm-usage"])
        context = create_context(browser, out_dir)
        page = context.new_page()
        try:
            login_if_needed(page, out_dir, args.wait_ms)
            apply_bet365_filter(page, out_dir, args.wait_ms)
            if not smoke_test(page, out_dir, args.wait_ms):
                meta["smoke_ok"] = False
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 2
            meta["smoke_ok"] = True
            if args.smoke_only:
                log("Smoke-only mode complete.")
                (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
                return 0

            exact_urls = read_urls_file(args.exact_urls_file)
            results_urls = read_urls_file(args.results_urls_file)
            market_urls: list[str] = []
            for u in exact_urls:
                market_urls.append(u)
            for results_url in results_urls:
                if len(market_urls) >= args.limit_total:
                    break
                discovered = discover_match_urls(page, results_url, args.max_matches_per_results, args.wait_ms)
                market_urls.extend(discovered)
            # De-dupe while preserving order.
            deduped = []
            seen = set()
            for u in market_urls:
                if u not in seen:
                    seen.add(u)
                    deduped.append(u)
            market_urls = deduped[: args.limit_total]
            (out_dir / "market_urls.json").write_text(json.dumps(market_urls, indent=2), encoding="utf-8")
            log(f"Total market URLs to scrape: {len(market_urls)}")

            rows: list[dict[str, str]] = []
            for idx, url in enumerate(market_urls, start=1):
                log(f"[{idx}/{len(market_urls)}] Scraping {url}")
                try:
                    row = scrape_market_page(page, url, out_dir, args.wait_ms)
                    rows.append(row)
                    append_row_csv(csv_path, row)
                    log(f"[{idx}/{len(market_urls)}] status={row.get('status')} p2_grouped={row.get('p2_grouped_9_12')} match={row.get('match_name')}")
                except Exception as exc:
                    log(f"[{idx}/{len(market_urls)}] ERROR {exc}")
                    save_debug(page, out_dir, f"error_{idx}")
                    row = {
                        "scraped_at": now_iso(),
                        "input_url": url,
                        "market_url": page.url if page else url,
                        "match_name": "",
                        "title": "",
                        "first_set_score": "",
                        "bet365_confirmed_count": "0",
                        "bet365_all_score_count": "0",
                        "status": "error",
                    }
                    rows.append(row)
                    append_row_csv(csv_path, row)
                time.sleep(args.pause_seconds)

            meta["rows"] = len(rows)
            meta["status_counts"] = {s: sum(1 for r in rows if r.get("status") == s) for s in sorted({r.get("status") for r in rows})}
            (out_dir / "run_summary.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            log("Filtered bet365 scrape complete.")
            return 0
        finally:
            try:
                context.storage_state(path=str(out_dir / "last_storage_state.json"))
            except Exception:
                pass
            context.close()
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
