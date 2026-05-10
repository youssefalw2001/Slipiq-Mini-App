#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = rows[0] ?? [];
  const records = rows.slice(1).filter(r => r.some(x => String(x).trim())).map(items => Object.fromEntries(headers.map((h, i) => [h, items[i] ?? ''])));
  return { headers, records };
}

function esc(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function writeCsv(headers, records) { return `${[headers.map(esc).join(','), ...records.map(r => headers.map(h => esc(r[h])).join(','))].join('\n')}\n`; }
function first(headers, names) { return names.find(n => headers.includes(n)) ?? null; }
function num(v) { const n = Number(String(v ?? '').replace(/[×x]/i, '').trim()); return Number.isFinite(n) ? n : null; }
function score(v) { const m = String(v ?? '').trim().match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/); if (!m) return ''; const a = +m[1], b = +m[2]; return a >= 0 && b >= 0 && a <= 7 && b <= 7 ? `${a}-${b}` : ''; }
function pct(v) { return Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : 'n/a'; }
function round(v, d = 4) { return Number.isFinite(v) ? Number(v.toFixed(d)) : null; }
function rate(a, b) { return b > 0 ? a / b : 0; }
function shrink(count, raw, priorWeight, prior) { return (count * raw + priorWeight * prior) / (count + priorWeight); }
function normName(v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

function splitMatch(v) {
  const parts = String(v || '').split(/\s+vs\s+|\s+v\s+/i).map(x => x.trim()).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join(' vs ')] : ['', ''];
}

function buildCols(headers) {
  const cols = {
    eventDate: first(headers, ['event_date','date','match_date','eventDate']),
    signalTs: first(headers, ['signal_timestamp','Signal_Timestamp','found_at','created_at']),
    matchStart: first(headers, ['match_start_time','Match_Start_Time','start_time']),
    eventKey: first(headers, ['event_key','match_id','fixture_id','id']),
    match: first(headers, ['match','match_name','event_name','Match']),
    p1: first(headers, ['player_1','player_one','p1','player1','Player1']),
    p2: first(headers, ['player_2','player_two','p2','player2','Player2']),
    tournamentLevel: first(headers, ['tournament_level','Tournament_Level']),
    matchType: first(headers, ['match_type','Match_Type']),
    selectedScore: first(headers, ['score','predicted_score','selected_score','Score']),
    odds: first(headers, ['bookmaker_odds','closing_odds','odds','Closing_Odds','Odds']),
    actualScore: first(headers, ['actual_first_set_score','Actual_First_Set_Score']),
    actualStatus: first(headers, ['actual_score_status','status','Status'])
  };
  const missing = [];
  if (!cols.eventDate && !cols.signalTs && !cols.matchStart) missing.push('event_date OR signal_timestamp OR match_start_time');
  if (!cols.match && (!cols.p1 || !cols.p2)) missing.push('match OR player_1/player_2');
  for (const k of ['selectedScore','odds','actualScore']) if (!cols[k]) missing.push(k);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}. Detected headers: ${headers.join(' | ')}`);
  return cols;
}

function dateOf(row, c) { return String((c.eventDate && row[c.eventDate]) || (c.signalTs && row[c.signalTs]) || (c.matchStart && row[c.matchStart]) || '').slice(0,10); }
function keyOf(row, c) { return String((c.eventKey && row[c.eventKey]) || '').trim(); }
function players(row, c) { const [m1,m2] = splitMatch(c.match ? row[c.match] : ''); return [String((c.p1 && row[c.p1]) || m1 || '').trim(), String((c.p2 && row[c.p2]) || m2 || '').trim()]; }
function resolved(row, c) { const st = c.actualStatus ? String(row[c.actualStatus] || '').toLowerCase() : 'resolved'; return score(row[c.actualScore]) && !/void|unknown|retired|cancel|walkover|abandon|postpone|ambiguous/.test(st); }
function playerScore(actual, side) { const [a,b] = actual.split('-').map(Number); return side === 'p1' ? `${a}-${b}` : `${b}-${a}`; }

function blank() { return { n:0, wins:0, losses:0, winScores:new Map(), lossScores:new Map() }; }
function inc(map, k) { map.set(k, (map.get(k) ?? 0) + 1); }
function updatePlayer(map, name, ps) {
  if (!name || !ps) return;
  const s = map.get(name) ?? blank();
  const [a,b] = ps.split('-').map(Number);
  s.n++;
  if (a > b) { s.wins++; inc(s.winScores, ps); }
  else if (b > a) { s.losses++; inc(s.lossScores, ps); }
  map.set(name, s);
}

function qtile(vals, q) {
  const a = vals.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  return a[Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * q)))];
}

function addFeatures(records, c, priorWeight) {
  const playerMap = new Map();
  const global = { n:0, wins:0, losses:0, winScores:new Map(), lossScores:new Map() };
  const dates = [...new Set(records.map(r => dateOf(r,c)).filter(Boolean))].sort();
  const byDate = new Map(dates.map(d => [d, []]));
  for (const r of records) if (byDate.has(dateOf(r,c))) byDate.get(dateOf(r,c)).push(r);

  for (const d of dates) {
    const day = byDate.get(d);
    for (const r of day) {
      const actual = score(r[c.actualScore]);
      const [p1,p2] = players(r,c).map(normName);
      const p1s = playerMap.get(p1) ?? blank();
      const p2s = playerMap.get(p2) ?? blank();

      const gpLoss46 = rate(global.lossScores.get('4-6') ?? 0, global.n);
      const gpLoss36 = rate(global.lossScores.get('3-6') ?? 0, global.n);
      const gpLossBoth = rate((global.lossScores.get('4-6') ?? 0) + (global.lossScores.get('3-6') ?? 0), global.n);
      const gpWin64 = rate(global.winScores.get('6-4') ?? 0, global.n);
      const gpWin63 = rate(global.winScores.get('6-3') ?? 0, global.n);
      const gpWinBoth = rate((global.winScores.get('6-4') ?? 0) + (global.winScores.get('6-3') ?? 0), global.n);

      const p1Loss46 = rate(p1s.lossScores.get('4-6') ?? 0, p1s.n);
      const p1Loss36 = rate(p1s.lossScores.get('3-6') ?? 0, p1s.n);
      const p1LossBoth = rate((p1s.lossScores.get('4-6') ?? 0) + (p1s.lossScores.get('3-6') ?? 0), p1s.n);
      const p2Win64 = rate(p2s.winScores.get('6-4') ?? 0, p2s.n);
      const p2Win63 = rate(p2s.winScores.get('6-3') ?? 0, p2s.n);
      const p2WinBoth = rate((p2s.winScores.get('6-4') ?? 0) + (p2s.winScores.get('6-3') ?? 0), p2s.n);

      const f46 = (shrink(p1s.n, p1Loss46, priorWeight, gpLoss46) + shrink(p2s.n, p2Win64, priorWeight, gpWin64)) / 2;
      const f36 = (shrink(p1s.n, p1Loss36, priorWeight, gpLoss36) + shrink(p2s.n, p2Win63, priorWeight, gpWin63)) / 2;
      const fBoth = (shrink(p1s.n, p1LossBoth, priorWeight, gpLossBoth) + shrink(p2s.n, p2WinBoth, priorWeight, gpWinBoth)) / 2;
      const pressure = (shrink(p1s.n, rate(p1s.losses, p1s.n), priorWeight, rate(global.losses, global.n)) + shrink(p2s.n, rate(p2s.wins, p2s.n), priorWeight, rate(global.wins, global.n))) / 2;
      const sample = Math.min(p1s.n, p2s.n);

      r.is_settled = resolved(r,c) ? 'true' : 'false';
      r.is_void_or_unknown = resolved(r,c) ? 'false' : 'true';
      r.is_actual_4_6 = actual === '4-6' ? 'true' : 'false';
      r.is_actual_3_6 = actual === '3-6' ? 'true' : 'false';
      r.is_actual_4_6_or_3_6 = actual === '4-6' || actual === '3-6' ? 'true' : 'false';
      r.p1_prior_rows = String(p1s.n);
      r.p2_prior_rows = String(p2s.n);
      r.p1_prior_first_set_loss_rate = String(round(rate(p1s.losses, p1s.n), 6));
      r.p2_prior_first_set_win_rate = String(round(rate(p2s.wins, p2s.n), 6));
      r.player_floor_4_6_score = String(round(f46, 6));
      r.player_floor_3_6_score = String(round(f36, 6));
      r.player_floor_4_6_or_3_6_score = String(round(fBoth, 6));
      r.p2_first_set_pressure_score = String(round(pressure, 6));
      r.companion_3_6_trigger_score = String(round(f36 - f46, 6));
      r.player_profile_sample_count = String(sample);
      r.player_profile_confidence = p1s.n >= 20 && p2s.n >= 20 ? 'high' : p1s.n >= 10 && p2s.n >= 10 ? 'medium' : 'low';
    }

    const unique = new Map();
    for (const r of day) unique.set(keyOf(r,c) || `${dateOf(r,c)}|${c.match ? r[c.match] : players(r,c).join(' vs ')}`, r);
    for (const r of unique.values()) {
      const actual = score(r[c.actualScore]);
      if (!actual || !resolved(r,c)) continue;
      const [p1,p2] = players(r,c).map(normName);
      const ps1 = playerScore(actual, 'p1');
      const ps2 = playerScore(actual, 'p2');
      updatePlayer(playerMap, p1, ps1);
      updatePlayer(playerMap, p2, ps2);
      updatePlayer({ get:k=>global, set:()=>{} }, 'global', ps1);
      updatePlayer({ get:k=>global, set:()=>{} }, 'global', ps2);
      global.n += 0; // updatePlayer already mutates global object through get fallback
    }
  }
}

function isOfficial(r,c) {
  const level = c.tournamentLevel ? String(r[c.tournamentLevel] || '').toLowerCase() : 'tour_other';
  const type = c.matchType ? String(r[c.matchType] || 'singles').toLowerCase() : 'singles';
  const o = num(r[c.odds]);
  return score(r[c.selectedScore]) === '4-6' && level === 'tour_other' && type === 'singles' && o >= 5.5 && o <= 7.5 && resolved(r,c);
}
function dedupeOfficial(records,c) {
  const out = [], seen = new Set();
  for (const r of records) {
    if (!isOfficial(r,c)) continue;
    const k = keyOf(r,c) || `${dateOf(r,c)}|${c.match ? r[c.match] : players(r,c).join(' vs ')}|4-6`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out.sort((a,b)=>dateOf(a,c).localeCompare(dateOf(b,c)));
}

function metrics(rows,c, companionShare=0) {
  let profit=0,w=0,l=0,eq=0,peak=0,dd=0,streak=0,worst=0;
  const monthly = new Map();
  for (const r of rows) {
    const actual = score(r[c.actualScore]);
    const o = num(r[c.odds]) ?? 0;
    let p = -1, hit = false;
    if (companionShare > 0) {
      const s36 = companionShare, s46 = 1 - s36;
      if (actual === '4-6') { p = s46 * (o - 1) - s36; hit = true; }
      else if (actual === '3-6') { p = s36 * (o - 1) - s46; hit = p > 0; }
    } else if (actual === '4-6') { p = o - 1; hit = true; }
    if (hit) w++; else l++;
    profit += p; eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (p <= 0) streak++; else streak = 0; worst = Math.max(worst, streak);
    const m = dateOf(r,c).slice(0,7); const cur = monthly.get(m) ?? { bets:0,wins:0,profit:0 }; cur.bets++; cur.profit += p; if (hit) cur.wins++; monthly.set(m,cur);
  }
  return { bets: rows.length, wins:w, losses:l, hit_rate: round(rate(w, rows.length),4), avg_odds: round(rate(rows.reduce((s,r)=>s+(num(r[c.odds])??0),0), rows.length),3), profit_units: round(profit,2), roi: round(rate(profit, rows.length),4), max_drawdown_units: round(dd,2), worst_losing_streak: worst, positive_months:[...monthly.values()].filter(x=>x.profit>0).length, total_months: monthly.size, monthly:Object.fromEntries([...monthly.entries()].map(([m,x])=>[m,{...x,roi:round(rate(x.profit,x.bets),4)}])) };
}
function filterTop(rows, field, frac) { const th = qtile(rows.map(r=>num(r[field])).filter(v=>v!==null), 1-frac); return th == null ? [] : rows.filter(r=>(num(r[field]) ?? -Infinity) >= th); }
function mdTable(rows) { if (!rows.length) return ''; const h=Object.keys(rows[0]); return [`| ${h.join(' | ')} |`,`| ${h.map(()=> '---').join(' | ')} |`,...rows.map(r=>`| ${h.map(k=>r[k]).join(' | ')} |`)].join('\n'); }

async function main() {
  const input = arg('input','artifacts/input/blind-sim-bets-enriched-first-set-scores.csv');
  const outDir = arg('output-dir','artifacts/output');
  const outName = arg('output-name','blind-sim-bets-player-floor-enriched.csv');
  const priorWeight = Number(arg('prior-weight','20')) || 20;
  const { headers, records } = parseCsv(await fs.readFile(input,'utf8'));
  const c = buildCols(headers);
  records.sort((a,b)=>dateOf(a,c).localeCompare(dateOf(b,c)) || keyOf(a,c).localeCompare(keyOf(b,c)));
  addFeatures(records,c,priorWeight);

  const official = dedupeOfficial(records,c);
  const ultra = official.filter(r => { const o=num(r[c.odds]); return o >= 6.5 && o <= 6.99; });
  const months = [...new Set(official.map(r=>dateOf(r,c).slice(0,7)))].filter(Boolean).sort();
  const discoverySet = new Set(months.slice(0,6));
  const discovery = official.filter(r=>discoverySet.has(dateOf(r,c).slice(0,7)));
  const blind = official.filter(r=>!discoverySet.has(dateOf(r,c).slice(0,7)));
  const q46 = qtile(official.map(r=>num(r.player_floor_4_6_score)).filter(v=>v!==null), .75);
  const q36 = qtile(official.map(r=>num(r.player_floor_3_6_score)).filter(v=>v!==null), .75);
  const low46 = qtile(official.map(r=>num(r.player_floor_4_6_score)).filter(v=>v!==null), .25);
  const lowPressure = qtile(official.map(r=>num(r.p2_first_set_pressure_score)).filter(v=>v!==null), .25);
  for (const r of records) {
    const f46=num(r.player_floor_4_6_score) ?? 0, f36=num(r.player_floor_3_6_score) ?? 0, pressure=num(r.p2_first_set_pressure_score) ?? 0;
    r.player_floor_46_high = q46 != null && f46 >= q46 ? 'true':'false';
    r.player_floor_36_high = q36 != null && f36 >= q36 ? 'true':'false';
    r.companion_36_recommended = q36 != null && f36 >= q36 && f36 > f46 ? 'true':'false';
    r.avoid_46_profile = (low46 != null && f46 <= low46) || (lowPressure != null && pressure <= lowPressure) ? 'true':'false';
  }
  const avoidRemoved = official.filter(r=>r.avoid_46_profile !== 'true');
  const floorFilters = [.5,.4,.33,.25,.2,.1].map(frac=>{ const m=metrics(filterTop(official,'player_floor_4_6_score',frac),c); return { filter:`top_${Math.round(frac*100)}pct_player_floor_4_6`, bets:m.bets, hit_rate:pct(m.hit_rate), roi:pct(m.roi), profit_units:m.profit_units, max_dd:m.max_drawdown_units, worst_streak:m.worst_losing_streak }; });
  const companion = [.1,.2,.3,.5].map(s=>{ const m=metrics(official,c,s); return { split:`${Math.round((1-s)*100)}/${Math.round(s*100)}`, bets:m.bets, hit_rate:pct(m.hit_rate), roi:pct(m.roi), profit_units:m.profit_units, max_dd:m.max_drawdown_units, worst_streak:m.worst_losing_streak }; });
  const summary = {
    audit_notes:[
      'V2: signalTs/matchStart/player1/player2 are optional. If absent, event_date and match name are used.',
      'No same-day leakage: rows receive features before that date updates player history.',
      'No duplicate inflation: player history updates once per unique event/match per day.',
      'Player 2 equivalents are player-centric: scoreboard 4-6 equals player2 6-4.',
      '3-6 companion is proxy only unless real 3-6 odds are logged.'
    ],
    column_mapping:c,
    prior_weight:priorWeight,
    data:{ total_rows:records.length, official_v2_rows:official.length, ultra_v1_rows:ultra.length, months },
    baseline_official_v2:metrics(official,c),
    ultra_v1:metrics(ultra,c),
    discovery_blind:{ discovery_months:months.slice(0,6), blind_months:months.slice(6), official_discovery:metrics(discovery,c), official_blind:metrics(blind,c) },
    player_floor_static_filters:floorFilters,
    avoid_filter_removed_low_floor:metrics(avoidRemoved,c),
    companion_3_6_proxy:companion,
    guardrails:['Accept player-floor only if blind ROI/drawdown improves, not just full sample.', 'Treat low-confidence profiles as shrinkage-only.', 'Do not use 3-6 companion with money until live 3-6 odds are tracked.']
  };
  await fs.mkdir(outDir,{recursive:true});
  const added = ['is_settled','is_void_or_unknown','is_actual_4_6','is_actual_3_6','is_actual_4_6_or_3_6','p1_prior_rows','p2_prior_rows','p1_prior_first_set_loss_rate','p2_prior_first_set_win_rate','player_floor_4_6_score','player_floor_3_6_score','player_floor_4_6_or_3_6_score','p2_first_set_pressure_score','companion_3_6_trigger_score','player_profile_sample_count','player_profile_confidence','player_floor_46_high','player_floor_36_high','companion_36_recommended','avoid_46_profile'];
  const outputHeaders = [...headers, ...added.filter(h=>!headers.includes(h))];
  await fs.writeFile(path.join(outDir,outName), writeCsv(outputHeaders,records));
  await fs.writeFile(path.join(outDir,'player-floor-analysis-summary.json'), `${JSON.stringify(summary,null,2)}\n`);
  const md = `# Player Floor First Set Analysis V2\n\n## Accuracy controls\n${summary.audit_notes.map(x=>`- ${x}`).join('\n')}\n\n## Baseline Official V2\n\n\`\`\`json\n${JSON.stringify(summary.baseline_official_v2,null,2)}\n\`\`\`\n\n## Ultra V1\n\n\`\`\`json\n${JSON.stringify(summary.ultra_v1,null,2)}\n\`\`\`\n\n## Discovery / blind\n\n\`\`\`json\n${JSON.stringify(summary.discovery_blind,null,2)}\n\`\`\`\n\n## Player-floor filters\n${mdTable(floorFilters)}\n\n## 3-6 companion proxy\n${mdTable(companion)}\n`;
  await fs.writeFile(path.join(outDir,'player-floor-analysis-summary.md'), md);
  console.log(JSON.stringify(summary,null,2));
}
main().catch(e=>{ console.error(e); process.exit(1); });
