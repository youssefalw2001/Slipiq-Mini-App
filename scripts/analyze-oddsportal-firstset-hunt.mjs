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

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function flattenJson(value, prefix = '', out = {}) {
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

function numbersFromRow(row) {
  const nums = [];
  for (const [key, value] of Object.entries(row)) {
    const s = String(value ?? '').trim().replace(',', '.');
    if (!s) continue;
    const n = Number(s);
    if (Number.isFinite(n) && n > 1.01 && n < 150) nums.push({ key, value: n });
  }
  return nums;
}

function textHasTargetScore(text, score) {
  const escaped = score.replace('-', '[-:]');
  return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`, 'i').test(text);
}

function firstSetHint(text) {
  return /first\s*set|1st\s*set|set\s*1|1\.?\s*set|1st\s*half|first\s*half/i.test(text);
}

function rowToText(row) {
  return Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' | ');
}

function likelyMatchKey(row, file) {
  const keys = [
    'match', 'match_name', 'event', 'event_name', 'name', 'teams', 'participants',
    'home_team', 'away_team', 'home', 'away', 'player_1', 'player_2', 'player1', 'player2',
    'Team 1', 'Team 2', 'Home', 'Away', 'Match', 'Event'
  ];
  const bits = [];
  for (const key of keys) {
    if (row[key]) bits.push(String(row[key]).trim());
  }
  const dateKey = Object.keys(row).find((k) => /date|time/i.test(k) && row[k]);
  if (dateKey) bits.push(String(row[dateKey]).slice(0, 32));
  return bits.length ? bits.join(' | ') : path.basename(file);
}

function candidateOddsForScore(row, score) {
  const rowText = rowToText(row);
  const nums = numbersFromRow(row);
  const scoreRegex = new RegExp(score.replace('-', '[-:]'));
  const direct = [];
  for (const [key, value] of Object.entries(row)) {
    const combined = `${key}=${value}`;
    if (!scoreRegex.test(combined)) continue;
    for (const n of nums) direct.push(n);
  }
  const nearby = [];
  const escaped = score.replace('-', '[-:]');
  const patterns = [
    new RegExp(`${escaped}[^0-9]{0,80}([0-9]+(?:[.,][0-9]+)?)`, 'gi'),
    new RegExp(`([0-9]+(?:[.,][0-9]+)?)[^0-9]{0,80}${escaped}`, 'gi'),
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(rowText))) {
      const n = Number(String(m[1]).replace(',', '.'));
      if (Number.isFinite(n) && n > 1.01 && n < 150) nearby.push({ key: 'nearby_regex', value: n });
    }
  }
  const all = [...direct, ...nearby];
  return all.length ? Math.max(...all.map((x) => x.value)) : null;
}

async function analyzeCsv(file, text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], samples: [] };
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  const samples = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((h, j) => [h || `col_${j}`, cells[j] ?? '']));
    const rowText = rowToText(row);
    const foundScores = ['3-6', '4-6', '5-7'].filter((s) => textHasTargetScore(rowText, s));
    if (!foundScores.length) continue;
    const oddsByScore = Object.fromEntries(foundScores.map((s) => [s, candidateOddsForScore(row, s)]));
    const hit = {
      file,
      source_type: 'csv',
      line: i + 1,
      match_key: likelyMatchKey(row, file),
      has_first_set_hint: firstSetHint(rowText),
      found_scores: foundScores.join('|'),
      odds_3_6: oddsByScore['3-6'] ?? null,
      odds_4_6: oddsByScore['4-6'] ?? null,
      odds_5_7: oddsByScore['5-7'] ?? null,
      row_preview: rowText.slice(0, 1000),
    };
    rows.push(hit);
    if (samples.length < 50) samples.push(hit);
  }
  return { rows, samples };
}

async function analyzeJson(file, text) {
  const parsed = safeJsonParse(text);
  if (!parsed) return { rows: [], samples: [] };
  const items = Array.isArray(parsed) ? parsed : Object.values(parsed).filter((v) => v && typeof v === 'object');
  const rows = [];
  const samples = [];
  for (const item of items.slice(0, 5000)) {
    const flat = flattenJson(item);
    const rowText = rowToText(flat);
    const foundScores = ['3-6', '4-6', '5-7'].filter((s) => textHasTargetScore(rowText, s));
    if (!foundScores.length) continue;
    const oddsByScore = Object.fromEntries(foundScores.map((s) => [s, candidateOddsForScore(flat, s)]));
    const hit = {
      file,
      source_type: 'json',
      line: null,
      match_key: likelyMatchKey(flat, file),
      has_first_set_hint: firstSetHint(rowText),
      found_scores: foundScores.join('|'),
      odds_3_6: oddsByScore['3-6'] ?? null,
      odds_4_6: oddsByScore['4-6'] ?? null,
      odds_5_7: oddsByScore['5-7'] ?? null,
      row_preview: rowText.slice(0, 1000),
    };
    rows.push(hit);
    if (samples.length < 50) samples.push(hit);
  }
  return { rows, samples };
}

function reconstruct(rows) {
  const byMatch = new Map();
  for (const row of rows) {
    const key = row.match_key || row.file;
    if (!byMatch.has(key)) byMatch.set(key, { match_key: key, rows: 0, odds_3_6: null, odds_4_6: null, odds_5_7: null, files: new Set(), first_set_hint_rows: 0, examples: [] });
    const g = byMatch.get(key);
    g.rows += 1;
    g.files.add(row.file);
    if (row.has_first_set_hint) g.first_set_hint_rows += 1;
    for (const score of ['3_6', '4_6', '5_7']) {
      const k = `odds_${score}`;
      if (row[k] && (!g[k] || row[k] > g[k])) g[k] = row[k];
    }
    if (g.examples.length < 3) g.examples.push(row.row_preview);
  }

  const out = [];
  for (const g of byMatch.values()) {
    const hasAll = Boolean(g.odds_3_6 && g.odds_4_6 && g.odds_5_7);
    const implied = hasAll ? (1 / g.odds_3_6 + 1 / g.odds_4_6 + 1 / g.odds_5_7) : null;
    out.push({
      match_key: g.match_key,
      rows: g.rows,
      file_count: g.files.size,
      files: [...g.files].map((f) => path.basename(f)).join('|'),
      first_set_hint_rows: g.first_set_hint_rows,
      odds_3_6: g.odds_3_6,
      odds_4_6: g.odds_4_6,
      odds_5_7: g.odds_5_7,
      has_all_three_scores: hasAll,
      estimated_player2_9_12_odds: implied ? 1 / implied : null,
      example: g.examples[0] ?? '',
    });
  }
  return out.sort((a, b) => Number(b.has_all_three_scores) - Number(a.has_all_three_scores) || b.first_set_hint_rows - a.first_set_hint_rows || b.rows - a.rows);
}

async function main() {
  const inputDir = arg('input-dir', 'artifacts/output/oddsportal-firstset-hunt/raw');
  const outDir = arg('out-dir', 'artifacts/output/oddsportal-firstset-hunt/analysis');
  await fs.mkdir(outDir, { recursive: true });
  const files = (await walk(inputDir)).filter((f) => /\.(csv|json|txt|log)$/i.test(f));
  const allHits = [];
  const fileSummaries = [];

  for (const file of files) {
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(inputDir, file);
    const counts = {
      file: rel,
      bytes: Buffer.byteLength(text),
      contains_3_6: textHasTargetScore(text, '3-6'),
      contains_4_6: textHasTargetScore(text, '4-6'),
      contains_5_7: textHasTargetScore(text, '5-7'),
      contains_first_set_hint: firstSetHint(text),
      contains_exact_score: /exact[_\s-]?score|correct[_\s-]?score/i.test(text),
    };
    const analysis = file.toLowerCase().endsWith('.csv')
      ? await analyzeCsv(file, text)
      : file.toLowerCase().endsWith('.json')
        ? await analyzeJson(file, text)
        : { rows: [], samples: [] };
    allHits.push(...analysis.rows.map((r) => ({ ...r, file: path.relative(inputDir, r.file) })));
    fileSummaries.push({ ...counts, target_rows_found: analysis.rows.length });
  }

  const recon = reconstruct(allHits);
  const summary = {
    generated_at: new Date().toISOString(),
    input_dir: inputDir,
    files_scanned: files.length,
    target_score_rows_found: allHits.length,
    files_with_all_target_score_strings: fileSummaries.filter((f) => f.contains_3_6 && f.contains_4_6 && f.contains_5_7).length,
    files_with_first_set_hint: fileSummaries.filter((f) => f.contains_first_set_hint).length,
    reconstruction_candidates: recon.length,
    reconstruction_candidates_with_all_three_scores: recon.filter((r) => r.has_all_three_scores).length,
    top_reconstruction_candidates: recon.slice(0, 25),
    verdict: recon.some((r) => r.has_all_three_scores && r.first_set_hint_rows > 0)
      ? 'POSSIBLE_FIRST_SET_CORRECT_SCORE_RECONSTRUCTION_FOUND_CHECK_SAMPLES'
      : recon.some((r) => r.has_all_three_scores)
        ? 'ALL_THREE_SCORE_ODDS_FOUND_BUT_FIRST_SET_CONTEXT_UNCLEAR'
        : allHits.length > 0
          ? 'TARGET_SCORE_STRINGS_FOUND_BUT_NOT_ENOUGH_FOR_PLAYER2_9_12_RECONSTRUCTION'
          : 'NO_3_6_4_6_5_7_SCORE_ODDS_FOUND',
    warning: 'This analyzer is generic. Manually inspect samples before treating any reconstructed odds as real first-set correct-score odds.',
  };

  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-file-summary.csv'), writeCsv(Object.keys(fileSummaries[0] ?? { file: '', bytes: '', contains_3_6: '', contains_4_6: '', contains_5_7: '', contains_first_set_hint: '', contains_exact_score: '', target_rows_found: '' }), fileSummaries));
  await fs.writeFile(path.join(outDir, 'oddsportal-firstset-hunt-target-rows.csv'), writeCsv(['file','source_type','line','match_key','has_first_set_hint','found_scores','odds_3_6','odds_4_6','odds_5_7','row_preview'], allHits));
  await fs.writeFile(path.join(outDir, 'oddsportal-player2-9-12-reconstruction-candidates.csv'), writeCsv(['match_key','rows','file_count','files','first_set_hint_rows','odds_3_6','odds_4_6','odds_5_7','has_all_three_scores','estimated_player2_9_12_odds','example'], recon));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
