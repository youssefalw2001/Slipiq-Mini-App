#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return `${[headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n')}\n`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function num(value) {
  const n = Number(String(value ?? '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function compound(events, { bank, risk, odds }) {
  let bankroll = bank;
  let peak = bank;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  let currentLossStreak = 0;
  let worstLosingStreak = 0;
  let flatProfitUnits = 0;
  const curve = [];
  const sorted = [...events].sort((a, b) => String(a.match_start_time).localeCompare(String(b.match_start_time)) || String(a.event_key).localeCompare(String(b.event_key)));
  for (let i = 0; i < sorted.length; i += 1) {
    const event = sorted[i];
    const stake = bankroll * risk;
    const win = Number(event.grouped_win) === 1;
    const profit = win ? stake * (odds - 1) : -stake;
    if (win) {
      wins += 1;
      currentLossStreak = 0;
      flatProfitUnits += odds - 1;
    } else {
      losses += 1;
      currentLossStreak += 1;
      worstLosingStreak = Math.max(worstLosingStreak, currentLossStreak);
      flatProfitUnits -= 1;
    }
    bankroll += profit;
    peak = Math.max(peak, bankroll);
    const drawdown = peak > 0 ? (peak - bankroll) / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({
      index: i + 1,
      ...event,
      scenario_grouped_odds: odds,
      stake: Number(stake.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      bankroll_after: Number(bankroll.toFixed(2)),
      drawdown_pct: Number(drawdown.toFixed(4)),
    });
  }
  return {
    bets: sorted.length,
    wins,
    losses,
    hit_rate: sorted.length ? wins / sorted.length : 0,
    break_even_odds: wins ? sorted.length / wins : null,
    final_bankroll: bankroll,
    profit: bankroll - bank,
    return_pct: bankroll / bank - 1,
    flat_roi_units: sorted.length ? flatProfitUnits / sorted.length : 0,
    worst_losing_streak: worstLosingStreak,
    max_drawdown_pct: maxDrawdown,
    curve,
  };
}

function compact(result) {
  return {
    bets: result.bets,
    wins: result.wins,
    losses: result.losses,
    hit_rate: Number(result.hit_rate.toFixed(4)),
    break_even_odds: result.break_even_odds == null ? null : Number(result.break_even_odds.toFixed(4)),
    final_bankroll: Number(result.final_bankroll.toFixed(2)),
    profit: Number(result.profit.toFixed(2)),
    return_pct: Number(result.return_pct.toFixed(4)),
    flat_roi_units: Number(result.flat_roi_units.toFixed(4)),
    worst_losing_streak: result.worst_losing_streak,
    max_drawdown_pct: Number(result.max_drawdown_pct.toFixed(4)),
  };
}

function rangeLabel(min, max) {
  if (min == null && max == null) return 'all';
  if (min == null) return `p2_odds_under_${String(max).replace('.', '_')}`;
  if (max == null) return `p2_odds_${String(min).replace('.', '_')}_plus`;
  return `p2_odds_${String(min).replace('.', '_')}_to_${String(max).replace('.', '_')}`;
}

function inRange(row, min, max) {
  const odds = num(row.p2_match_odds);
  if (!odds) return false;
  if (min != null && odds < min) return false;
  if (max != null && odds >= max) return false;
  return true;
}

function surface(row, pattern) {
  return pattern.test(String(row.surface ?? ''));
}

async function main() {
  const candidatesPath = arg('candidates', 'artifacts/output/v3-player2-favorite-9-12-backtest/v3-player2-favorite-candidates.csv');
  const outputDir = arg('output-dir', 'artifacts/output/v3-player2-odds-thresholds');
  const bank = Number(arg('bankroll', '5000')) || 5000;
  const risk = Number(arg('risk', '0.02')) || 0.02;
  const scenarioOdds = String(arg('scenario-odds', '3.00,3.30,3.50,3.60')).split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 1);

  const rows = parseCsv(await fs.readFile(candidatesPath, 'utf8'));
  const thresholds = [
    { name: 'v3_all', predicate: () => true },
    { name: 'v3_p2_under_1_40', predicate: (r) => inRange(r, null, 1.4) },
    { name: 'v3_p2_under_1_50', predicate: (r) => inRange(r, null, 1.5) },
    { name: 'v3_p2_under_1_60', predicate: (r) => inRange(r, null, 1.6) },
    { name: 'v3_p2_under_1_75', predicate: (r) => inRange(r, null, 1.75) },
    { name: 'v3_p2_under_2_00', predicate: (r) => inRange(r, null, 2.0) },
    { name: 'v3_p2_1_50_to_1_99', predicate: (r) => inRange(r, 1.5, 2.0) },
    { name: 'v3_p2_2_00_to_2_49', predicate: (r) => inRange(r, 2.0, 2.5) },
    { name: 'v3_p2_2_50_plus', predicate: (r) => inRange(r, 2.5, null) },
    { name: 'v3_p2_under_1_50_hard_grass', predicate: (r) => inRange(r, null, 1.5) && surface(r, /hard|grass/i) },
    { name: 'v3_p2_under_1_50_clay', predicate: (r) => inRange(r, null, 1.5) && surface(r, /clay/i) },
    { name: 'v3_p2_under_1_75_hard_grass', predicate: (r) => inRange(r, null, 1.75) && surface(r, /hard|grass/i) },
  ];

  const summary = {
    mode: 'v3_player2_odds_thresholds_from_v3_candidates_v1',
    warnings: [
      'Uses scenario Player 2 & 9-12 odds, not real historical grouped market odds.',
      'This is a post-process of v3-player2-favorite-candidates.csv generated by API-Tennis V3 scan.',
      'p2_match_odds are from the API-Tennis Home/Away market interpreted as Player 1 / Player 2.'
    ],
    config: { candidatesPath, startingBankroll: bank, riskFraction: risk, scenarioOdds },
    source_rows: rows.length,
    p2_match_odds_rows: rows.filter((r) => num(r.p2_match_odds)).length,
    results: {},
  };

  const comparisonRows = [];
  const curveRows = [];
  for (const filter of thresholds) {
    const xs = rows.filter(filter.predicate);
    const wins = xs.filter((r) => Number(r.grouped_win) === 1).length;
    summary.results[filter.name] = {
      rows: xs.length,
      wins,
      losses: xs.length - wins,
      hit_rate: xs.length ? Number((wins / xs.length).toFixed(4)) : 0,
      break_even_odds: wins ? Number((xs.length / wins).toFixed(4)) : null,
      scenarios: {},
    };
    for (const odds of scenarioOdds) {
      const result = compound(xs, { bank, risk, odds });
      const key = `scenario_${odds}`;
      const packed = compact(result);
      summary.results[filter.name].scenarios[key] = packed;
      comparisonRows.push({ filter: filter.name, scenario_odds: odds, ...packed });
      if ([3.3, 3.5].includes(odds)) {
        curveRows.push(...result.curve.map((r) => ({ filter: filter.name, ...r })));
      }
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'v3-player2-odds-threshold-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'v3-player2-odds-threshold-comparison.csv'), writeCsv(['filter','scenario_odds','bets','wins','losses','hit_rate','break_even_odds','final_bankroll','profit','return_pct','flat_roi_units','worst_losing_streak','max_drawdown_pct'], comparisonRows));
  await fs.writeFile(path.join(outputDir, 'v3-player2-odds-threshold-curves.csv'), writeCsv(Object.keys(curveRows[0] ?? { filter: '' }), curveRows));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
