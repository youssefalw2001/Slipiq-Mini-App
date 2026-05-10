#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0];
  const records = rows
    .slice(1)
    .filter((items) => items.some((item) => item.trim() !== ''))
    .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ''])));
  return { headers, records };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(headers, records) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const record of records) lines.push(headers.map((header) => csvEscape(record[header])).join(','));
  return `${lines.join('\n')}\n`;
}

function firstExisting(headers, names) {
  for (const name of names) if (headers.includes(name)) return name;
  return null;
}

function toNum(value) {
  const n = Number(String(value ?? '').replace(/[×x]/i, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normScore(value) {
  const text = String(value ?? '').trim();
  const m = text.match(/^(\d{1,2})\s*[-:]\s*(\d{1,2})$/);
  if (!m) return '';
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a > 7 || b > 7) return '';
  return `${a}-${b}`;
}

function eventDate(row, cols) {
  const raw = String(row[cols.eventDate] || row[cols.signalTs] || row[cols.matchStart] || '').trim();
  return raw.slice(0, 10);
}

function eventKey(row, cols) {
  return String(row[cols.eventKey] || '').trim();
}

function splitMatchName(value) {
  const text = String(value || '').trim();
  const parts = text.split(/\s+vs\s+|\s+v\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' vs ')];
  return ['', ''];
}

function rowPlayers(row, cols) {
  const [fromMatch1, fromMatch2] = splitMatchName(row[cols.match]);
  const p1 = String((cols.player1 && row[cols.player1]) || fromMatch1 || '').trim();
  const p2 = String((cols.player2 && row[cols.player2]) || fromMatch2 || '').trim();
  return [p1, p2];
}

function normalizePlayer(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isResolved(row, cols) {
  const status = String(row[cols.actualStatus] || '').toLowerCase();
  const score = normScore(row[cols.actualScore]);
  return status === 'resolved' && Boolean(score);
}

function isVoidOrUnknown(row, cols) {
  const status = String(row[cols.actualStatus] || '').toLowerCase();
  return status !== 'resolved' || !normScore(row[cols.actualScore]);
}

function scoreWinner(score) {
  const [a, b] = score.split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 'unknown';
  return a > b ? 'player1' : 'player2';
}

function playerCentricScore(actualScore, playerSide) {
  const [a, b] = actualScore.split('-').map(Number);
  if (playerSide === 'p1') return `${a}-${b}`;
  return `${b}-${a}`;
}

function marginFamily(score) {
  const [a, b] = score.split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
  if (b > a) {
    if (score === '4-6' || score === '5-7' || score === '6-7') return 'p2_close_win';
    if (score === '3-6') return 'p2_break_win';
    if (score === '0-6' || score === '1-6' || score === '2-6') return 'p2_dominant_win';
    return 'p2_other_win';
  }
  if (a > b) {
    if (score === '6-4' || score === '7-5' || score === '7-6') return 'p1_close_win';
    if (score === '6-3') return 'p1_break_win';
    if (score === '6-0' || score === '6-1' || score === '6-2') return 'p1_dominant_win';
    return 'p1_other_win';
  }
  return 'unknown';
}

function blankStats() {
  return {
    appearances: 0,
    wins: 0,
    losses: 0,
    winScores: new Map(),
    lossScores: new Map(),
    closeWins: 0,
    breakWins: 0,
    dominantWins: 0,
    closeLosses: 0,
    breakLosses: 0,
    dominantLosses: 0,
  };
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

function updatePlayer(stats, playerKey, playerScore) {
  if (!playerKey || !playerScore) return;
  const s = stats.players.get(playerKey) ?? blankStats();
  const [forGames, againstGames] = playerScore.split('-').map(Number);
  s.appearances += 1;
  if (forGames > againstGames) {
    s.wins += 1;
    inc(s.winScores, playerScore);
    if (playerScore === '6-4' || playerScore === '7-5' || playerScore === '7-6') s.closeWins += 1;
    else if (playerScore === '6-3') s.breakWins += 1;
    else if (playerScore === '6-0' || playerScore === '6-1' || playerScore === '6-2') s.dominantWins += 1;
  } else if (againstGames > forGames) {
    s.losses += 1;
    inc(s.lossScores, playerScore);
    if (playerScore === '4-6' || playerScore === '5-7' || playerScore === '6-7') s.closeLosses += 1;
    else if (playerScore === '3-6') s.breakLosses += 1;
    else if (playerScore === '0-6' || playerScore === '1-6' || playerScore === '2-6') s.dominantLosses += 1;
  }
  stats.players.set(playerKey, s);
}

function updateGlobal(stats, p1Score, p2Score) {
  for (const playerScore of [p1Score, p2Score]) {
    const [forGames, againstGames] = playerScore.split('-').map(Number);
    stats.globalAppearances += 1;
    if (forGames > againstGames) {
      stats.globalWins += 1;
      inc(stats.globalWinScores, playerScore);
    } else if (againstGames > forGames) {
      stats.globalLosses += 1;
      inc(stats.globalLossScores, playerScore);
    }
  }
}

function makeHistory() {
  return {
    players: new Map(),
    globalAppearances: 0,
    globalWins: 0,
    globalLosses: 0,
    globalWinScores: new Map(),
    globalLossScores: new Map(),
  };
}

function rate(num, den) {
  return den > 0 ? num / den : 0;
}

function shrunk(count, rawRate, priorWeight, globalPrior) {
  return (count * rawRate + priorWeight * globalPrior) / (count + priorWeight);
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function addFloorFeatures(records, cols, priorWeight) {
  const history = makeHistory();
  const sortedDates = [...new Set(records.map((row) => eventDate(row, cols)).filter(Boolean))].sort();
  const rowsByDate = new Map(sortedDates.map((date) => [date, []]));
  for (const row of records) {
    const date = eventDate(row, cols);
    if (rowsByDate.has(date)) rowsByDate.get(date).push(row);
  }

  for (const date of sortedDates) {
    const dayRows = rowsByDate.get(date);

    // Feature step: use only histories from prior dates. Same-day rows are not allowed
    // to update the player profile until all rows for the day have received features.
    for (const row of dayRows) {
      const actual = normScore(row[cols.actualScore]);
      const [p1Name, p2Name] = rowPlayers(row, cols);
      const p1Key = normalizePlayer(p1Name);
      const p2Key = normalizePlayer(p2Name);
      const p1Stats = history.players.get(p1Key) ?? blankStats();
      const p2Stats = history.players.get(p2Key) ?? blankStats();

      const globalLoss46 = rate(history.globalLossScores.get('4-6') ?? 0, history.globalAppearances);
      const globalLoss36 = rate(history.globalLossScores.get('3-6') ?? 0, history.globalAppearances);
      const globalLoss46or36 = rate((history.globalLossScores.get('4-6') ?? 0) + (history.globalLossScores.get('3-6') ?? 0), history.globalAppearances);
      const globalWin64 = rate(history.globalWinScores.get('6-4') ?? 0, history.globalAppearances);
      const globalWin63 = rate(history.globalWinScores.get('6-3') ?? 0, history.globalAppearances);
      const globalWin64or63 = rate((history.globalWinScores.get('6-4') ?? 0) + (history.globalWinScores.get('6-3') ?? 0), history.globalAppearances);

      const p1Loss46 = rate(p1Stats.lossScores.get('4-6') ?? 0, p1Stats.appearances);
      const p1Loss36 = rate(p1Stats.lossScores.get('3-6') ?? 0, p1Stats.appearances);
      const p1LossBoth = rate((p1Stats.lossScores.get('4-6') ?? 0) + (p1Stats.lossScores.get('3-6') ?? 0), p1Stats.appearances);
      const p2Win64 = rate(p2Stats.winScores.get('6-4') ?? 0, p2Stats.appearances);
      const p2Win63 = rate(p2Stats.winScores.get('6-3') ?? 0, p2Stats.appearances);
      const p2WinBoth = rate((p2Stats.winScores.get('6-4') ?? 0) + (p2Stats.winScores.get('6-3') ?? 0), p2Stats.appearances);

      const p1Shrunk46 = shrunk(p1Stats.appearances, p1Loss46, priorWeight, globalLoss46);
      const p1Shrunk36 = shrunk(p1Stats.appearances, p1Loss36, priorWeight, globalLoss36);
      const p1ShrunkBoth = shrunk(p1Stats.appearances, p1LossBoth, priorWeight, globalLoss46or36);
      const p2Shrunk64 = shrunk(p2Stats.appearances, p2Win64, priorWeight, globalWin64);
      const p2Shrunk63 = shrunk(p2Stats.appearances, p2Win63, priorWeight, globalWin63);
      const p2ShrunkBoth = shrunk(p2Stats.appearances, p2WinBoth, priorWeight, globalWin64or63);

      const playerFloor46 = (p1Shrunk46 + p2Shrunk64) / 2;
      const playerFloor36 = (p1Shrunk36 + p2Shrunk63) / 2;
      const playerFloorCombo = (p1ShrunkBoth + p2ShrunkBoth) / 2;
      const p2Pressure = (shrunk(p1Stats.appearances, rate(p1Stats.losses, p1Stats.appearances), priorWeight, rate(history.globalLosses, history.globalAppearances)) +
        shrunk(p2Stats.appearances, rate(p2Stats.wins, p2Stats.appearances), priorWeight, rate(history.globalWins, history.globalAppearances))) / 2;

      const sampleCount = Math.min(p1Stats.appearances, p2Stats.appearances);
      const confidence = p1Stats.appearances >= 20 && p2Stats.appearances >= 20 ? 'high' : p1Stats.appearances >= 10 && p2Stats.appearances >= 10 ? 'medium' : 'low';

      row.is_void_or_unknown = isVoidOrUnknown(row, cols) ? 'true' : 'false';
      row.is_settled = isResolved(row, cols) ? 'true' : 'false';
      row.is_actual_4_6 = actual === '4-6' ? 'true' : 'false';
      row.is_actual_3_6 = actual === '3-6' ? 'true' : 'false';
      row.is_actual_4_6_or_3_6 = actual === '4-6' || actual === '3-6' ? 'true' : 'false';
      row.actual_winner_side_first_set = actual ? scoreWinner(actual) : 'unknown';
      row.actual_margin_family = actual ? marginFamily(actual) : 'unknown';
      row.p1_prior_rows = String(p1Stats.appearances);
      row.p2_prior_rows = String(p2Stats.appearances);
      row.p1_prior_first_set_loss_rate = String(round(rate(p1Stats.losses, p1Stats.appearances), 6));
      row.p2_prior_first_set_win_rate = String(round(rate(p2Stats.wins, p2Stats.appearances), 6));
      row.p1_prior_loss_4_6_rate = String(round(p1Loss46, 6));
      row.p1_prior_loss_3_6_rate = String(round(p1Loss36, 6));
      row.p1_prior_loss_4_6_or_3_6_rate = String(round(p1LossBoth, 6));
      row.p2_prior_win_6_4_equiv_for_4_6_rate = String(round(p2Win64, 6));
      row.p2_prior_win_6_3_equiv_for_3_6_rate = String(round(p2Win63, 6));
      row.p2_prior_win_6_4_or_6_3_equiv_rate = String(round(p2WinBoth, 6));
      row.p1_shrunk_loss_4_6_rate = String(round(p1Shrunk46, 6));
      row.p1_shrunk_loss_3_6_rate = String(round(p1Shrunk36, 6));
      row.p1_shrunk_loss_4_6_or_3_6_rate = String(round(p1ShrunkBoth, 6));
      row.p2_shrunk_win_6_4_equiv_for_4_6_rate = String(round(p2Shrunk64, 6));
      row.p2_shrunk_win_6_3_equiv_for_3_6_rate = String(round(p2Shrunk63, 6));
      row.p2_shrunk_win_6_4_or_6_3_equiv_rate = String(round(p2ShrunkBoth, 6));
      row.player_floor_4_6_score = String(round(playerFloor46, 6));
      row.player_floor_3_6_score = String(round(playerFloor36, 6));
      row.player_floor_4_6_or_3_6_score = String(round(playerFloorCombo, 6));
      row.p2_first_set_pressure_score = String(round(p2Pressure, 6));
      row.close_vs_break_indicator = String(round(playerFloor46 - playerFloor36, 6));
      row.companion_3_6_trigger_score = String(round(playerFloor36 - playerFloor46, 6));
      row.player_profile_sample_count = String(sampleCount);
      row.player_profile_confidence = confidence;
    }

    // Update step: use unique resolved matches from the day once, after features
    // are assigned. This avoids duplicate predicted-score rows inflating histories.
    const uniqueMatches = new Map();
    for (const row of dayRows) {
      const key = eventKey(row, cols) || `${eventDate(row, cols)}|${row[cols.match]}`;
      if (!uniqueMatches.has(key)) uniqueMatches.set(key, row);
    }

    for (const row of uniqueMatches.values()) {
      const actual = normScore(row[cols.actualScore]);
      if (!actual || !isResolved(row, cols)) continue;
      const [p1Name, p2Name] = rowPlayers(row, cols);
      const p1Key = normalizePlayer(p1Name);
      const p2Key = normalizePlayer(p2Name);
      const p1Score = playerCentricScore(actual, 'p1');
      const p2Score = playerCentricScore(actual, 'p2');
      updatePlayer(history, p1Key, p1Score);
      updatePlayer(history, p2Key, p2Score);
      updateGlobal(history, p1Score, p2Score);
    }
  }
}

function quantile(values, q) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const idx = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * q)));
  return clean[idx];
}

function officialRows(records, cols) {
  const seen = new Set();
  const out = [];
  for (const row of records) {
    const score = normScore(row[cols.score]);
    const actual = normScore(row[cols.actualScore]);
    const odds = toNum(row[cols.odds]);
    const level = String(row[cols.tournamentLevel] || '').toLowerCase();
    const type = String(row[cols.matchType] || 'singles').toLowerCase();
    const key = eventKey(row, cols) || `${eventDate(row, cols)}|${row[cols.match]}|${score}`;
    if (seen.has(key)) continue;
    if (score !== '4-6') continue;
    if (level !== 'tour_other') continue;
    if (type && type !== 'singles') continue;
    if (!odds || odds < 5.5 || odds > 7.5) continue;
    if (!actual || isVoidOrUnknown(row, cols)) continue;
    seen.add(key);
    out.push(row);
  }
  return out.sort((a, b) => eventDate(a, cols).localeCompare(eventDate(b, cols)));
}

function ultraRows(rows, cols) {
  return rows.filter((row) => {
    const odds = toNum(row[cols.odds]);
    return odds >= 6.5 && odds <= 6.99;
  });
}

function metrics(rows, cols, mode = 'single', split36 = 0) {
  let wins = 0;
  let losses = 0;
  let profit = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let worstStreak = 0;
  const monthly = new Map();

  for (const row of rows) {
    const actual = normScore(row[cols.actualScore]);
    const odds = toNum(row[cols.odds]) ?? 0;
    let p = -1;
    let hit = false;
    if (mode === 'companion') {
      const s36 = split36;
      const s46 = 1 - s36;
      if (actual === '4-6') {
        p = s46 * (odds - 1) - s36;
        hit = true;
      } else if (actual === '3-6') {
        p = s36 * (odds - 1) - s46;
        hit = p > 0;
      }
    } else {
      if (actual === '4-6') {
        p = odds - 1;
        hit = true;
      }
    }

    if (hit) wins += 1;
    else losses += 1;
    profit += p;
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (p <= 0) streak += 1;
    else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
    const month = eventDate(row, cols).slice(0, 7);
    const cur = monthly.get(month) ?? { bets: 0, wins: 0, profit: 0 };
    cur.bets += 1;
    cur.profit += p;
    if (hit) cur.wins += 1;
    monthly.set(month, cur);
  }

  const bets = rows.length;
  const avgOdds = bets ? rows.reduce((sum, row) => sum + (toNum(row[cols.odds]) ?? 0), 0) / bets : 0;
  const positiveMonths = [...monthly.values()].filter((m) => m.profit > 0).length;
  return {
    bets,
    wins,
    losses,
    hit_rate: round(rate(wins, bets), 4),
    avg_odds: round(avgOdds, 3),
    profit_units: round(profit, 2),
    roi: round(rate(profit, bets), 4),
    max_drawdown_units: round(maxDrawdown, 2),
    worst_losing_streak: worstStreak,
    positive_months: positiveMonths,
    total_months: monthly.size,
    monthly: Object.fromEntries([...monthly.entries()].map(([month, m]) => [month, { ...m, roi: round(rate(m.profit, m.bets), 4) }]))
  };
}

function filterTop(rows, field, topFraction) {
  const threshold = quantile(rows.map((row) => toNum(row[field])).filter((v) => v !== null), 1 - topFraction);
  if (threshold === null) return [];
  return rows.filter((row) => (toNum(row[field]) ?? -Infinity) >= threshold);
}

function splitDiscoveryBlind(rows, cols) {
  const months = [...new Set(rows.map((row) => eventDate(row, cols).slice(0, 7)).filter(Boolean))].sort();
  const discoveryMonths = new Set(months.slice(0, 6));
  return {
    months,
    discovery: rows.filter((row) => discoveryMonths.has(eventDate(row, cols).slice(0, 7))),
    blind: rows.filter((row) => !discoveryMonths.has(eventDate(row, cols).slice(0, 7))),
  };
}

function applyCandidateTags(records) {
  const official = records.filter((row) => normScore(row.score) === '4-6' && String(row.tournament_level).toLowerCase() === 'tour_other');
  const q46 = quantile(official.map((row) => toNum(row.player_floor_4_6_score)).filter((v) => v !== null), 0.75);
  const q36 = quantile(official.map((row) => toNum(row.player_floor_3_6_score)).filter((v) => v !== null), 0.75);
  const qCombo = quantile(official.map((row) => toNum(row.player_floor_4_6_or_3_6_score)).filter((v) => v !== null), 0.75);
  const low46 = quantile(official.map((row) => toNum(row.player_floor_4_6_score)).filter((v) => v !== null), 0.25);
  const lowPressure = quantile(official.map((row) => toNum(row.p2_first_set_pressure_score)).filter((v) => v !== null), 0.25);

  for (const row of records) {
    const f46 = toNum(row.player_floor_4_6_score) ?? 0;
    const f36 = toNum(row.player_floor_3_6_score) ?? 0;
    const combo = toNum(row.player_floor_4_6_or_3_6_score) ?? 0;
    const pressure = toNum(row.p2_first_set_pressure_score) ?? 0;
    row.player_floor_46_high = q46 !== null && f46 >= q46 ? 'true' : 'false';
    row.player_floor_36_high = q36 !== null && f36 >= q36 ? 'true' : 'false';
    row.player_floor_combo_high = qCombo !== null && combo >= qCombo ? 'true' : 'false';
    row.companion_36_recommended = f36 > f46 && q36 !== null && f36 >= q36 ? 'true' : 'false';
    row.avoid_46_profile = (low46 !== null && f46 <= low46) || (lowPressure !== null && pressure <= lowPressure) ? 'true' : 'false';
  }

  return { q46, q36, qCombo, low46, lowPressure };
}

function tableMd(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${headers.map((h) => row[h]).join(' | ')} |`)].join('\n');
}

function buildSummary(records, cols) {
  const official = officialRows(records, cols);
  const ultra = ultraRows(official, cols);
  const splits = splitDiscoveryBlind(official, cols);
  const staticTests = [0.5, 0.4, 0.33, 0.25, 0.2, 0.1].map((top) => {
    const rows = filterTop(official, 'player_floor_4_6_score', top);
    const m = metrics(rows, cols);
    return { filter: `top_${Math.round(top * 100)}pct_player_floor_4_6`, bets: m.bets, hit_rate: pct(m.hit_rate), roi: pct(m.roi), profit_units: m.profit_units, max_dd: m.max_drawdown_units, worst_streak: m.worst_losing_streak };
  });
  const avoidRemoved = official.filter((row) => row.avoid_46_profile !== 'true');
  const companionRows = [0.1, 0.2, 0.3, 0.5].map((share) => {
    const m = metrics(official, cols, 'companion', share);
    return { split: `${Math.round((1 - share) * 100)}/${Math.round(share * 100)}`, bets: m.bets, hit_rate: pct(m.hit_rate), roi: pct(m.roi), profit_units: m.profit_units, max_dd: m.max_drawdown_units, worst_streak: m.worst_losing_streak };
  });

  return {
    audit_notes: [
      'Player-floor features use prior dates only; same-day rows are not allowed to update features.',
      'Player history is updated once per unique match/event_key, not once per predicted-score row.',
      'Player 2 equivalent scores are player-centric: a 4-6 scoreboard means player2 won 6-4 from their perspective.',
      '3-6 companion uses same odds as 4-6 if no real 3-6 odds exist, so it is a proxy simulation only.'
    ],
    data: {
      total_rows: records.length,
      official_v2_rows: official.length,
      ultra_v1_rows: ultra.length,
      months: splits.months,
    },
    baseline_official_v2: metrics(official, cols),
    ultra_v1: metrics(ultra, cols),
    discovery_blind: {
      discovery_months: splits.months.slice(0, 6),
      blind_months: splits.months.slice(6),
      official_discovery: metrics(splits.discovery, cols),
      official_blind: metrics(splits.blind, cols),
    },
    player_floor_static_filters: staticTests,
    avoid_filter_removed_low_floor: metrics(avoidRemoved, cols),
    companion_3_6_proxy: companionRows,
    recommendation_guardrails: [
      'Do not accept a player-floor rule unless blind ROI and drawdown improve, not just full-sample ROI.',
      'Treat low-confidence player profiles as shrinkage-only, not real player edges.',
      'Do not use 3-6 companion as real execution proof until real 3-6 odds are logged live.'
    ]
  };
}

function buildMarkdown(summary) {
  return `# Player Floor First Set Analysis\n\n## Accuracy controls\n\n${summary.audit_notes.map((x) => `- ${x}`).join('\n')}\n\n## Baseline Official V2\n\n\`\`\`json\n${JSON.stringify(summary.baseline_official_v2, null, 2)}\n\`\`\`\n\n## Ultra V1\n\n\`\`\`json\n${JSON.stringify(summary.ultra_v1, null, 2)}\n\`\`\`\n\n## Discovery / blind split\n\n\`\`\`json\n${JSON.stringify(summary.discovery_blind, null, 2)}\n\`\`\`\n\n## Player-floor filters\n\n${tableMd(summary.player_floor_static_filters)}\n\n## 3-6 companion proxy\n\n${tableMd(summary.companion_3_6_proxy)}\n\n## Avoid-filter test\n\n\`\`\`json\n${JSON.stringify(summary.avoid_filter_removed_low_floor, null, 2)}\n\`\`\`\n\n## Guardrails\n\n${summary.recommendation_guardrails.map((x) => `- ${x}`).join('\n')}\n`;
}

async function main() {
  const inputPath = getArg('input', 'artifacts/input/blind-sim-bets-enriched-first-set-scores.csv');
  const outputDir = getArg('output-dir', 'artifacts/output');
  const outputName = getArg('output-name', 'blind-sim-bets-player-floor-enriched.csv');
  const priorWeight = Number(getArg('prior-weight', '20'));

  const text = await fs.readFile(inputPath, 'utf8');
  const { headers, records } = parseCsv(text);
  const cols = {
    eventDate: firstExisting(headers, ['event_date', 'date', 'match_date']),
    signalTs: firstExisting(headers, ['signal_timestamp', 'Signal_Timestamp', 'found_at']),
    matchStart: firstExisting(headers, ['match_start_time', 'Match_Start_Time']),
    eventKey: firstExisting(headers, ['event_key', 'match_id', 'fixture_id', 'id']),
    match: firstExisting(headers, ['match', 'match_name', 'event_name']),
    player1: firstExisting(headers, ['player_1', 'player_one', 'p1']),
    player2: firstExisting(headers, ['player_2', 'player_two', 'p2']),
    tournamentLevel: firstExisting(headers, ['tournament_level']),
    matchType: firstExisting(headers, ['match_type']),
    score: firstExisting(headers, ['score', 'predicted_score', 'selected_score']),
    odds: firstExisting(headers, ['bookmaker_odds', 'closing_odds', 'odds']),
    actualScore: firstExisting(headers, ['actual_first_set_score']),
    actualStatus: firstExisting(headers, ['actual_score_status']),
  };

  const missing = Object.entries(cols).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(', ')}`);

  records.sort((a, b) => {
    const da = eventDate(a, cols);
    const db = eventDate(b, cols);
    if (da !== db) return da.localeCompare(db);
    return eventKey(a, cols).localeCompare(eventKey(b, cols));
  });

  addFloorFeatures(records, cols, Number.isFinite(priorWeight) && priorWeight > 0 ? priorWeight : 20);
  const thresholds = applyCandidateTags(records);
  const summary = buildSummary(records, cols);
  summary.column_mapping = cols;
  summary.thresholds = thresholds;
  summary.prior_weight = priorWeight;

  await fs.mkdir(outputDir, { recursive: true });
  const addedHeaders = [
    'is_void_or_unknown', 'is_settled', 'is_actual_4_6', 'is_actual_3_6', 'is_actual_4_6_or_3_6',
    'actual_winner_side_first_set', 'actual_margin_family',
    'p1_prior_rows', 'p2_prior_rows', 'p1_prior_first_set_loss_rate', 'p2_prior_first_set_win_rate',
    'p1_prior_loss_4_6_rate', 'p1_prior_loss_3_6_rate', 'p1_prior_loss_4_6_or_3_6_rate',
    'p2_prior_win_6_4_equiv_for_4_6_rate', 'p2_prior_win_6_3_equiv_for_3_6_rate', 'p2_prior_win_6_4_or_6_3_equiv_rate',
    'p1_shrunk_loss_4_6_rate', 'p1_shrunk_loss_3_6_rate', 'p1_shrunk_loss_4_6_or_3_6_rate',
    'p2_shrunk_win_6_4_equiv_for_4_6_rate', 'p2_shrunk_win_6_3_equiv_for_3_6_rate', 'p2_shrunk_win_6_4_or_6_3_equiv_rate',
    'player_floor_4_6_score', 'player_floor_3_6_score', 'player_floor_4_6_or_3_6_score', 'p2_first_set_pressure_score',
    'close_vs_break_indicator', 'companion_3_6_trigger_score', 'player_profile_sample_count', 'player_profile_confidence',
    'player_floor_46_high', 'player_floor_36_high', 'player_floor_combo_high', 'companion_36_recommended', 'avoid_46_profile'
  ];
  const outputHeaders = [...headers, ...addedHeaders.filter((h) => !headers.includes(h))];
  const outputPath = path.join(outputDir, outputName);
  const summaryJsonPath = path.join(outputDir, 'player-floor-analysis-summary.json');
  const summaryMdPath = path.join(outputDir, 'player-floor-analysis-summary.md');

  await fs.writeFile(outputPath, writeCsv(outputHeaders, records));
  await fs.writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(summaryMdPath, buildMarkdown(summary));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${summaryJsonPath}`);
  console.log(`Wrote ${summaryMdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
