# First Set Lab / SlipIQ AI Handoff

This is the canonical handoff for any new AI/chat session working on this repository. Read this before changing code, running workflows, interpreting Supabase data, updating the proof site, or giving strategy advice.

Last updated: 2026-05-22

Repo:

```txt
youssefalw2001/Slipiq-Mini-App
```

Live Supabase project ref:

```txt
qjvpkkcbscsypymxyker
```

Current public site:

```txt
firstsetlab.run.place
```

Public positioning:

```txt
First Set Lab is a personal first-set tennis receipt vault and research archive.
It is decision-support / market-intelligence content, not a guarantee, not automatic betting, and not financial advice.
```

---

## 1. Current state in one page

The system is currently in a **V2 protected launch model** state.

The original signal chat was not publicly launched during the earlier test slate, so the public website now shows the model that will be used going forward: old qualifying gates stay intact, then a protected score is added for coverage.

Current V2 proof view numbers at the time of this document:

```txt
38 settled signals
18 wins
20 losses
47.37% hit rate
+62.1212 official units
+163.48% official ROI
+62.1212 receipt units
+163.48% receipt ROI
5 old losses converted to V2 protected wins
```

Important: the original old archive data was **not deleted**. The V2 website reads from separate V2 Supabase views.

---

## 2. What changed recently

### Public proof site

The root GitHub Pages page is:

```txt
docs/index.html
```

It now redirects to:

```txt
docs/proof.html
```

The actual public proof website is:

```txt
docs/proof.html
```

The proof page now reads from these Supabase views:

```txt
public.proof_vault_live_summary_v2_protected
public.proof_vault_daily_summary_v2_protected
public.proof_vault_recent_receipts_v2_protected
```

The older views still exist and should stay preserved:

```txt
public.proof_vault_live_summary
public.proof_vault_daily_summary
public.proof_vault_recent_receipts
```

The public website copy should feel like a **personal brand / personal receipt vault**, not a corporate product page. It should show confidence, intelligence, dopamine, and transparency without promising wins.

Current narrative standard:

```txt
Wins stay because they show upside.
Losses stay because they protect the truth.
The ledger is the intelligence layer.
```

Current quote on the page:

```txt
What gets tracked gets sharper.
```

---

## 3. Current public strategy: V2 protected score groups

The strategy is still the same strategy family:

```txt
First-set correct-score cluster intelligence.
```

But the launch model adds protection after the original gate qualifies.

### Core Cluster V2

Old qualifying gate must pass first:

```txt
Book: bet365
Lane: CORE_P1_ATP_GS_BET365
Tour: ATP
Tournament group: GRAND_SLAM
Qualifying scores: 6:3 / 6:4
Minimum qualifying grouped odds: 2.50
S-tier floor: 3.10
Trigger score: 6:4
Trigger score odds range: 5.00 to 6.25
```

Public protected target after qualification:

```txt
Player 1 wins first set 6:2, 6:3, or 6:4
```

Why:

```txt
Some old 6:3 / 6:4 losses were not close misses. They were dominant-set misses, especially 6:2.
```

### Reverse Stretch Cluster V2

Old qualifying gate must pass first:

```txt
Book: bet365
Original lane: RESEARCH_P2_GS_26_46_BET365
New public lane: CORE_P2_GS_REVERSE_STRETCH_BET365
Tournament group: GRAND_SLAM
Qualifying scores: 2:6 / 4:6
Minimum qualifying grouped odds: 2.50
Maximum qualifying grouped odds: 4.50
Required skew: EXTREME
S-tier floor: 3.50
```

Public protected target after qualification:

```txt
Player 2 wins first set 2:6, 4:6, or 5:7
```

Why:

```txt
The replay showed two old reverse losses landed 5:7, so 5:7 is added as reverse stretch protection.
```

### Critical rule

Do **not** lower the qualifying odds floor just because an extra protected score was added.

Correct logic:

```txt
Old signal qualifies first.
Then extra protected score is added.
```

Incorrect logic:

```txt
Add extra score and lower the gate, creating weaker new signals.
```

This mistake happened once and was corrected.

---

## 4. Live scanner workflow

The workflow that matters for live public signals and Telegram sending is:

```txt
.github/workflows/api-tennis-live-first-set-lab-scanner.yml
Workflow name: API Tennis Live First Set Lab Scanner
```

Schedule:

```txt
Runs every 2 hours at minute 17.
cron: 17 */2 * * *
```

Manual run input:

```txt
send_telegram default: true
```

Important flow:

```txt
1. Checkout repo
2. Apply public scanner V2 protected-score upgrades
3. Generate live First Set Lab signals
4. Deliver through Supabase duplicate guard
5. Upload artifacts
```

The scanner step itself runs with:

```txt
--send-telegram=false
```

That is normal. Telegram is handled by the separate Supabase delivery step.

Scheduled runs set:

```txt
EFFECTIVE_SEND_TELEGRAM=true
```

Manual runs use the workflow input:

```txt
send_telegram=true or false
```

### Important implementation detail

The current live workflow applies the V2 protected scanner change **inside the GitHub Actions runner** before execution.

That means this source file may still look like the older strategy when opened directly:

```txt
scripts/api_tennis_live_first_set_lab_scanner.mjs
```

But the workflow patches it at runtime before running it.

If a future AI wants to clean this up permanently, do it carefully:

```txt
1. Update scripts/api_tennis_live_first_set_lab_scanner.mjs permanently.
2. Remove or simplify the runtime patch from api-tennis-live-first-set-lab-scanner.yml.
3. Keep the same qualifyingScores logic.
4. Run the workflow manually with send_telegram=false first.
5. Confirm artifacts show the same expected targets.
6. Then run with send_telegram=true if needed.
```

Never leave both a permanent source change and a conflicting workflow patch.

---

## 5. Scanner artifacts to inspect

The live scanner uploads an artifact named:

```txt
api-tennis-live-first-set-lab-scanner
```

Important files:

```txt
first_set_lab_live_report.md
first_set_lab_live_summary.json
first_set_lab_live_signals.csv
first_set_lab_live_raw_candidates.csv
first_set_lab_live_telegram_log.csv
first_set_lab_supabase_delivery_report.md
first_set_lab_supabase_delivery_summary.json
first_set_lab_supabase_delivery_log.csv
```

When checking if the workflow worked, confirm:

```txt
Workflow is green.
No YAML error.
No fatal error JSON.
Supabase delivery summary exists.
Telegram sending is true when expected.
If 0 signals were sent, check whether selected signals were 0 before assuming Telegram broke.
```

A successful run can still send zero Telegram messages if no signal qualified.

---

## 6. Telegram delivery system

Telegram delivery is handled by:

```txt
scripts/first_set_lab_supabase_deliver.mjs
```

Purpose:

```txt
- Read scanner CSV.
- Upsert scanner signals into Supabase.
- Use duplicate guard before sending.
- Send customer-facing Telegram alerts only when allowed.
- Keep research-only / paused books in Supabase only.
```

Important rules:

```txt
RESEARCH_ONLY = Supabase only, no Telegram.
Paused books = Supabase only, no Telegram.
Default paused book: 1xBet.
```

Duplicate key concept:

```txt
room + event_key + signal_type + market + book + target
```

If the same executable Telegram signal already exists, it should not send twice.

Do not change the delivery guard when the task is only strategy scoring or proof-site display.

---

## 7. Result resolver

Workflow:

```txt
.github/workflows/run-result-resolver.yml
Workflow name: Run Result Resolver
```

Schedule:

```txt
Runs every 3 hours at minute 43.
cron: 43 */3 * * *
```

Default Supabase project ref:

```txt
qjvpkkcbscsypymxyker
```

It calls the Supabase Edge Function:

```txt
https://qjvpkkcbscsypymxyker.supabase.co/functions/v1/result-resolver
```

Headers/secrets used:

```txt
SLIPIQ_REFRESH_SECRET
SUPABASE_ANON_KEY
```

Known API-Tennis failure:

```txt
If API-Tennis returns code 1006 / Please make the payment for your account, the workflow will fail with HTTP 500.
This is an API-Tennis account/payment issue, not a GitHub or Supabase code issue.
```

Do not change resolver code unless the task is specifically settlement/result logic.

---

## 8. Supabase proof architecture

The public proof site should not rewrite historical rows.

Current V2 approach:

```txt
Original rows stay in base tables/views.
V2 launch model is calculated in separate protected views.
Website reads the protected views.
```

Base source used by V2 views:

```txt
public.live_signal_unique_results
```

Current public V2 views:

```txt
public.proof_vault_recent_receipts_v2_protected
public.proof_vault_daily_summary_v2_protected
public.proof_vault_live_summary_v2_protected
```

These views regrade old test rows using the V2 protected score logic.

If creating a future V3 strategy, do **not** overwrite V2 views unless specifically requested. Prefer:

```txt
public.proof_vault_recent_receipts_v3_<name>
public.proof_vault_daily_summary_v3_<name>
public.proof_vault_live_summary_v3_<name>
```

Then update:

```txt
docs/proof.html
```

to read from the new V3 views.

Always grant public read if the proof site needs anon access:

```sql
grant select on public.<view_name> to anon, authenticated;
```

Never expose service role keys on the frontend.

---

## 9. How to update the proof website

Primary file:

```txt
docs/proof.html
```

Root file:

```txt
docs/index.html
```

Current root behavior:

```txt
index.html redirects to proof.html
```

If the user says the website did not update, check:

```txt
1. Did you update docs/proof.html or only another file?
2. Is docs/index.html still redirecting correctly?
3. Did GitHub Pages finish deploying?
4. Is Safari/browser cache showing old HTML?
5. Try cache buster: firstsetlab.run.place/?v=<new_number>
```

The proof site currently uses Supabase JS public anon/publishable key and queries:

```txt
proof_vault_live_summary_v2_protected
proof_vault_daily_summary_v2_protected
proof_vault_recent_receipts_v2_protected
```

Current public tone:

```txt
Personal archive.
Receipt vault.
Full ledger.
Losses stay.
No guarantees.
Dopamine from receipts, intelligence from the ledger.
```

Avoid sounding like a big company or making guaranteed-performance claims.

---

## 10. How to improve the strategy safely

When the user asks to improve the strategy, follow this order:

### Step 1: Do not edit public rows first

Never start by editing historical rows or hiding losses.

Correct approach:

```txt
Run replay/backtest query.
Compare current vs proposed logic.
Create a new view or scanner lane.
Then update public display only if the model is actually the launch model going forward.
```

### Step 2: Identify which layer is being changed

There are separate layers:

```txt
Strategy logic = scanner/workflow/source code.
Delivery logic = first_set_lab_supabase_deliver.mjs.
Settlement logic = result resolver / Supabase views.
Public proof display = docs/proof.html.
```

Do not change all layers at once.

### Step 3: Use qualifyingScores for protected score logic

If adding a protected score, keep old qualification separate from public target.

Example pattern:

```js
scores: ['6:2', '6:3', '6:4'],
qualifyingScores: ['6:3', '6:4'],
minGrouped: 2.50
```

Then compute:

```txt
qualifyingGrouped = grouped odds of qualifyingScores only.
protectedGrouped = grouped odds of all public scores.
```

Use qualifyingGrouped for:

```txt
entry gate
tier decision
skew gate when relevant
```

Use protectedGrouped for:

```txt
public break-even math
proof/replay display
score_odds_json audit
```

### Step 4: Preserve audit fields

For any protected strategy, include metadata like:

```txt
qualifying_scores
qualifying_grouped_odds
protected_grouped_odds
market_skew_bucket
```

This lets future AI verify that the old gate passed before protection was added.

### Step 5: Dry-run before sending

Run scanner manually with:

```txt
send_telegram=false
```

Check artifacts. Then send only if needed.

---

## 11. What not to do

Do not:

```txt
- Delete losses from base tables.
- Rewrite historical rows to pretend they were original live signals.
- Lower qualifying odds floors unless the user explicitly wants more volume and accepts quality risk.
- Change Telegram delivery when only the scanner/proof site is being updated.
- Change Supabase service role secrets or expose them in frontend code.
- Promise guaranteed results.
- Mix original archive stats and V2 protected stats without labeling.
- Treat a 0-signal workflow run as a Telegram failure without checking scanner output first.
```

The preferred public framing is:

```txt
Original data preserved.
V2 launch model displayed.
Full ledger stays visible.
```

---

## 12. Current important files

```txt
docs/index.html
Root GitHub Pages file. Redirects to proof.html.

/docs/proof.html
Live public proof website.

/docs/SLIPIQ_AI_HANDOFF.md
This file. Read first.

.github/workflows/api-tennis-live-first-set-lab-scanner.yml
Main live scanner + Supabase/Telegram delivery workflow.

scripts/api_tennis_live_first_set_lab_scanner.mjs
Scanner source. Currently older-looking; workflow patches V2 at runtime.

scripts/first_set_lab_supabase_deliver.mjs
Supabase upsert + Telegram duplicate guard.

.github/workflows/run-result-resolver.yml
Calls Supabase result resolver every 3 hours.

supabase/functions/result-resolver/index.ts
Supabase result resolver function. Verify before editing because some parts may be legacy Score Hunter logic.
```

---

## 13. Current public proof numbers query

Use this to verify current V2 proof state:

```sql
select
  settled_signals,
  wins,
  losses,
  hit_rate_pct,
  official_profit_units,
  official_roi_pct,
  receipt_profit_units,
  receipt_roi_pct,
  best_receipt_match,
  best_receipt_score,
  best_receipt_american_odds
from public.proof_vault_live_summary_v2_protected;
```

Use this to verify V2 conversion count:

```sql
select
  count(*) filter (where original_settled_win = false and settled_win = true) as converted_losses_to_wins,
  count(*) filter (where protection_type <> 'unchanged') as protected_layer_rows,
  count(*) as settled_rows
from public.proof_vault_recent_receipts_v2_protected
where status = 'settled';
```

At last update, expected values were approximately:

```txt
settled_signals: 38
wins: 18
losses: 20
hit_rate_pct: 47.37
converted_losses_to_wins: 5
```

---

## 14. If a new AI tab starts from scratch

Paste this prompt:

```txt
Read docs/SLIPIQ_AI_HANDOFF.md in repo youssefalw2001/Slipiq-Mini-App first. The live project is First Set Lab / SlipIQ. The current public model is V2 protected score groups: old bet365 qualifying gates stay intact, then Core adds 6:2 protection and Reverse adds 5:7 protection. The proof site is docs/proof.html, root docs/index.html redirects to it, and it reads Supabase views proof_vault_*_v2_protected from project qjvpkkcbscsypymxyker. Do not delete losses or rewrite base rows. If improving strategy, replay/backtest first, create a new Supabase view or scanner lane, dry-run the scanner, then update proof.html only after verifying.
```

---

## 15. Final operating principle

```txt
The receipt creates attention.
The ledger creates trust.
The model improves only when the full truth stays visible.
```
