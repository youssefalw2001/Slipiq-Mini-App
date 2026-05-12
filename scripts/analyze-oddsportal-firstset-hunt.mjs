#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  if (!(await exists(dir))) return [];
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n') + '\n';
}

function americanToDecimal(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  const n = Number(s.replace('+', '').replace(',', ''));
  if (!Number.isFinite(n)) return null;

  if (s.startsWith('+') || n >= 100) return 1 + n / 100;
  if (s.startsWith('-') || n <= -100) return 1 + 100 / Math.abs(n);
  return n > 1 ? n : null;
}

function extractBestMarketOdds(rawMarket) {
  const s = String(rawMarket ?? '').trim();
  if (!s || s === '[]') return { decimal: null, american: null, bookmaker: null, period: null, raw: s };

  const entries = [];
  const itemRegex = /correct_score['"]?\s*:\s*['"]([^'"]+)['"][\s\S]*?bookmaker_name['"]?\s*:\s*['"]([^'"]*)['"][\s\S]*?period['"]?\s*:\s*['"]([^'"]*)['"]/g;
  let m;
  while ((m = itemRegex.exec(s))) {
    const decimal = americanToDecimal(m[1]);
    if (decimal) entries.push({ american: m[1], decimal, bookmaker: m[2], period: m[3] });
  }

  if (!entries.length) {
    const fallbackRegex = /[+\-]\d{3,4}|\b\d+(?:\.\d+)?\b/g;
    const candidates = [...s.matchAll(fallbackRegex)]
      .map((x) => ({ american: x[0], decimal: americanToDecimal(x[0]), bookmaker: null, period: null }))
      .filter((x) => x.decimal && x.decimal > 1.01 && x.decimal < 150);
    entries.push(...candidates);
  }

  entries.sort((a, b) => b.decimal - a.decimal);
  const best = entries[0];
  return best ? { ...best, raw: s } : { decimal: null, american: null, bookmaker: null, period: null, raw: s };
}

function firstSetScore(partialResults) {
  const s = String(partialResults ?? '').trim();
  const m = s.match(/^(\d+)\s*[:\-]\s*(\d+)/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

function groupedOdds(odds36, odds46, odds57) {
  if (!odds36 || !odds46 || !odds57) return null;
  const implied = 1 / odds36 + 1 / odds46 + 1 / odds57;
  return implied > 0 ? 1 / implied : null;
}

function rowToText(row) {
  return Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' | ');
}

function textHasTargetScore(text, score) {
  const escaped = score.replace('-', '[-:]');
  return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`, 'i').test(text);
}

function firstSetHint(text) {
  return /first\s*set|1st\s*set|set\s*1|1\.?\s*set|FirstSet/i.test(text);
}

async function analyzeOddsHarvesterCsv(file, text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const hasMarketColumns = headers.includes('correct_score_3_6_market')
    && headers.includes('correct_score_4_6_market')
    && headers.includes('correct_score_5_7_market');
  if (!hasMarketColumns) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((h, j) => [h || `col_${j}`, cells[j] ?? '']));

    const m36 = extractBestMarketOdds(row.correct_score_3_6_market);
    const m46 = extractBestMarketOdds(row.correct_score_4_6_market);
    const m57 = extractBestMarketOdds(row.correct_score_5_7_market);
    const odds36 = m36.decimal;
    const odds46 = m46.decimal;
    const odds57 = m57.decimal;
    const estimated = groupedOdds(odds36, odds46, odds57);
    const fsScore = firstSetScore(row.partial_results);

    rows.push({
      file,
      source_type: 'oddsharvester_csv',
      line: i + 1,
      scraped_date: row.scraped_date ?? '',
      match_date: row.match_date ?? '',
      match_link: row.match_link ?? '',
      league_name: row.league_name ?? '',
      home_team: row.home_team ?? '',
      away_team: row.away_team ?? '',
      first_set_score: fsScore,
      player2_9_12_result_win: ['3-6', '4-6', '5-7'].includes(fsScore) ? 'true' : 'false',
      odds_3_6_american: m36.american,
      odds_4_6_american: m46.american,
      odds_5_7_american: m57.american,
      odds_3_6_decimal: odds36,
      odds_4_6_decimal: odds46,
      odds_5_7_decimal: odds57,
      bookmaker_3_6: m36.bookmaker,
      bookmaker_4_6: m46.bookmaker,
      bookmaker_5_7: m57.bookmaker,
      period_3_6: m36.period,
      period_4_6: m46.period,
      period_5_7: m57.period,
      has_all_three_scores: odds36 && odds46 && odds57 ? 'true' : 'false',
      estimated_player2_9_12_odds: estimated,
      reconstructed_price_band: estimated === null ? 'missing'
        : estimated < 2.8 ? '<2.80'
          : estimated < 3.0 ? '2.80-2.99'
            : estimated < 3.3 ? '3.00-3.29'
              : estimated < 3.5 ? '3.30-3.49'
                : estimated < 3.6 ? '3.50-3.59'
                  : '3.60+',
      row_preview: rowToText(row).slice(0, 1200),
    });
  }
  return rows;
}

async function analyzeGenericFile(file, text) {
  const rows = [];
  const foundScores = ['3-6', '4-6', '5-7'].filter((s) => textHasTargetScore(text, s));
  if (!foundScores.length) return rows;
  rows.push({
    file,
    source_type: 'generic_text_hit',
    line: null,
    scraped_date: '',
    match_date: '',
    match_link: '',
    league_name: '',
    home_team: '',
    away_team: '',
    first_set_score: '',
    player2_9_12_result_win: '',
    odds_3_6_american: '',
    odds_4_6_american: '',
    odds_5_7_american: '',
    odds_3_6_decimal: '',
    odds_4_6_decimal: '',
    odds_5_7_decimal: '',
    bookmaker_3_6: '',
    bookmaker_4_6: '',
    bookmaker_5_7: '',
    period_3_6: firstSetHint(text) ? 'possible_first_set_context' : '',
    period_4_6: firstSetHint(text) ? 'possible_first_set_context' : '',
    period_5_7: firstSetHint(text) ? 'possible_first_set_context' : '',
    has_all_three_scores: foundScores.length === 3 ? 'true' : 'false',
    estimated_player2_9_12_odds: '',
    reconstructed_price_band: 'unparsed',
    row_preview: text.slice(0, 1200),
  });
  return rows;
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

function summarize(rows, fileSummaries, inputDir) {
  const reconstructed = rows.filter((r) => r.source_type === 'oddsharvester_csv' && r.has_all_three_scores === 'true' && r.estimated_player2_9_12_odds);
  const odds = reconstructed.map((r) => Number(r.estimated_player2_9_12_odds)).filter((x) => Number.isFinite(x));
  const winners = reconstructed.filter((r) => r.player2_9_12_result_win === 'true');
  const bandCounts = {};
  for (const row of reconstructed) bandCounts[row.reconstructed_price_band] = (bandCounts[row.reconstructed_price_band] ?? 0) + 1;

  return {
    generated_at: new Date().toISOString(),
    input_dir: inputDir,
    files_scanned: fileSummaries.length,
    oddsharvester_rows_parsed: rows.filter((r) => r.source_type === 'oddsharvester_csv').length,
    reconstructed_rows_with_all_three_scores: reconstructed.length,
    player2_9_12_result_wins_in_sample: winners.length,
    player2_9_12_result_hit_rate_in_sample: reconstructed.length ? winners.length / reconstructed.length : 0,
    estimated_player2_9_12_odds_summary: {
      count: odds.length,
      min: odds.length ? Math.min(...odds) : null,
      p25: quantile(odds, 0.25),
      median: quantile(odds, 0.5),
      mean: odds.length ? odds.reduce((a, b) => a + b, 0) / odds.length : null,
      p75: quantile(odds, 0.75),
      max: odds.length ? Math.max(...odds) : null,
    },
    price_band_counts: bandCounts,
    files: fileSummaries,
    top_rows_by_estimated_grouped_odds: [...reconstructed]
      .sort((a, b) => Number(b.estimated_player2_9_12_odds) - Number(a.estimated_player2_9_12_odds))
      .slice(0, 25),
    verdict: reconstructed.length > 0
      ? 'FIRST_SET_CORRECT_SCORE_ODDS_FOUND_AND_PLAYER2_9_12_RECONSTRUCTED'
      : rows.length > 0
        ? 'TARGET_SCORE_STRINGS_FOUND_BUT_MARKET_ODDS_NOT_RECONSTRUCTED'
        : 'NO_3_6_4_6_5_7_SCORE_ODDS_FOUND',
    warning: 'Odds are reconstructed from first-set correct-score prices. Confirm home/away maps to Player 1/Player 2 before using as final proof.',
  };
}

async function main() {
  const inputDir = arg('input-dir', 'artifacts/output/oddsportal-firstset-hunt/raw');
  const outDir = arg('out-dir', 'artifacts/output/oddsportal-firstset-hunt/analysis');
  await fs.mkdir(outDir, { recursive: true });
  const files = (await walk(inputDir)).filter((f) => /\.(csv|json|txt|log)$/i.test(f));
  const allRows = [];
  const fileSummaries = [];

  for (const file of files) {
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(inputDir, file);
    let rows = [];
    if (file.toLowerCase().endsWith('.csv')) rows = await analyzeOddsHarvesterCsv(file, text);
    if (!rows.length) rows = await analyzeGenericFile(file, text);
    const normalizedRows = rows.map((r) => ({ ...r, file: path.relative(inputDir, r.file) }));
    allRows.push(...normalizedRows);
    fileSummaries.push({
      file: rel,
      bytes: Buffer.byteLength(text),
      parsed_rows: normalizedRows.length,
      contains_3_6: textHasTargetScore(text, '3-6'),
      contains_4_6: textHasTargetScore(text, '4-6'),
      contains_5_7: textHasTargetScore(text, '5-7'),
      contains_first_set_hint: firstSetHint(text),
      contains_correct_score_market_columns: /correct_score_3_6_market/.test(text) && /correct_score_4_6_market/.test(text) && /correct_score_5_7_market/.test(text),
    });
  }

  const summary = summarize(allRows, fileSummaries, inputDir);
  const headers = [
    'file','source_type','line','scraped_date','match_date','match_link','league_name','home_team','away_team',
    'first_set_score','player2_9_12_result_win','odds_3_6_american','odds_4_6_american','odds_5_7_american',
    'odds_3_6_decimal','odds_4_6_decimal','odds_5_7_decimal','bookmaker_3_6','bookmaker_4_6','bookmaker_5_7',
    'period_3_6','period_4_6','period_5_7','has_all_three_scores','estimated_player2_9_12_odds','reconstructed_price_band','row_preview'
  ];
  const reconHeaders = [
    'match_date','league_name','home_team','away_team','first_set_score','player2_9_12_result_win',
    'odds_3_6_decimal','odds_4_6_decimal','odds_5_7_decimal','estimated_player2_9_12_odds','reconstructed_price_band',
    'bookmaker_3_6','bookmaker_4_6','bookmaker_5_7','match_link'
  ];
  const reconstructed = allRows.filter((r) => r.source_type === 'oddsharvester_csv' && r.has_all_three_scores === 'true');

  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-file-summary.csv'), writeCsv(['file','bytes','parsed_rows','contains_3_6','contains_4_6','contains_5_7','contains_first_set_hint','contains_correct_score_market_columns'], fileSummaries));
  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-target-rows.csv'), writeCsv(headers, allRows));
  await fs.writeFile(path.join(outDir, 'oddsportal-player2-9-12-reconstruction-candidates.csv'), writeCsv(reconHeaders, reconstructed));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
