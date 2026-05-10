#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://api.api-tennis.com/tennis/';
const VOID_PATTERN = /retired|walkover|w\/o|cancelled|canceled|postponed|abandoned|withdrawn|not played/i;

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

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0];
  const records = rows.slice(1).filter((items) => items.some((item) => item.trim() !== '')).map((items) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = items[index] ?? '';
    });
    return record;
  });

  return { headers, records };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(headers, records) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => csvEscape(record[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function truthy(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function normalizeScore(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/\b(\d{1,2})\s*[-:]\s*(\d{1,2})\b/);
  if (!match) return null;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || b < 0 || a > 7 || b > 7) return null;
  // Valid first-set scores are usually one side at 6 or 7. Keep 5-5/4-4 out.
  if (Math.max(a, b) < 6) return null;
  return `${a}-${b}`;
}

function rowEventKey(row) {
  return String(row.event_key || row.match_id || row.fixture_id || row.id || '').trim();
}

function rowDate(row) {
  return String(row.event_date || row.date || row.match_date || '').slice(0, 10);
}

function playerPairFromMatch(matchName) {
  const text = String(matchName || '');
  const parts = text.split(/\s+vs\s+|\s+v\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' vs ')];
  return [null, null];
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fixtureEventKey(fixture) {
  return String(
    fixture.event_key ??
    fixture.fixture_id ??
    fixture.match_id ??
    fixture.id ??
    ''
  ).trim();
}

function fixtureStatusText(fixture) {
  return [
    fixture.event_status,
    fixture.status,
    fixture.event_result,
    fixture.event_final_result,
    fixture.event_game_result,
    fixture.event_type_result,
  ].filter(Boolean).join(' ');
}

function extractScoreFromNamedFirstSetFields(fixture) {
  const candidates = [
    ['event_first_set', fixture.event_first_set],
    ['first_set_score', fixture.first_set_score],
    ['set_1_score', fixture.set_1_score],
    ['set1_score', fixture.set1_score],
    ['score_first_set', fixture.score_first_set],
    ['event_set_result', fixture.event_set_result],
  ];

  for (const [pathName, value] of candidates) {
    const score = normalizeScore(value);
    if (score) return { score, path: pathName };
  }

  return null;
}

function extractScoreFromSetArray(value, pathName) {
  if (!Array.isArray(value)) return null;

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const setNumber = item.score_set ?? item.set_number ?? item.set ?? item.number ?? item.score_set_number;
    const setName = String(item.set_name ?? item.name ?? item.label ?? '').toLowerCase();
    const isFirstSet = String(setNumber) === '1' || /first|1st|set 1/.test(setName);
    if (!isFirstSet) continue;

    const scoreCandidates = [
      item.score,
      item.result,
      item.set_score,
      item.event_score,
      item.value,
      item.home_away_score,
    ];

    for (const candidate of scoreCandidates) {
      const score = normalizeScore(candidate);
      if (score) return { score, path: `${pathName}[set=1]` };
    }

    const first = item.score_first ?? item.home_score ?? item.player_1_score ?? item.player_first_score ?? item.first ?? item.localteam_score;
    const second = item.score_second ?? item.away_score ?? item.player_2_score ?? item.player_second_score ?? item.second ?? item.visitorteam_score;
    const combined = normalizeScore(`${first}-${second}`);
    if (combined) return { score: combined, path: `${pathName}[set=1].score_first/score_second` };
  }

  return null;
}

function findFirstSetScoreRecursively(value, pathName = 'fixture') {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const fromSetArray = extractScoreFromSetArray(value, pathName);
    if (fromSetArray) return fromSetArray;

    for (let i = 0; i < value.length; i += 1) {
      const found = findFirstSetScoreRecursively(value[i], `${pathName}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  const object = value;

  // Never parse event_final_result as a first-set score. In API-Tennis this can be match sets like 2-0.
  const blockedKeys = new Set(['event_final_result', 'final_result', 'match_final_score']);

  for (const [key, nested] of Object.entries(object)) {
    if (blockedKeys.has(key)) continue;
    const lowered = key.toLowerCase();
    if (/(scores|score|sets|set_scores|event_scores)/.test(lowered)) {
      const fromArray = extractScoreFromSetArray(nested, `${pathName}.${key}`);
      if (fromArray) return fromArray;
    }
  }

  for (const [key, nested] of Object.entries(object)) {
    if (blockedKeys.has(key)) continue;
    const found = findFirstSetScoreRecursively(nested, `${pathName}.${key}`);
    if (found) return found;
  }

  return null;
}

function extractFirstSetScore(fixture) {
  const direct = extractScoreFromNamedFirstSetFields(fixture);
  if (direct) return direct;
  return findFirstSetScoreRecursively(fixture);
}

async function fetchFixturesForDate(apiKey, date) {
  const url = new URL(API_BASE);
  url.searchParams.set('method', 'get_fixtures');
  url.searchParams.set('APIkey', apiKey);
  url.searchParams.set('date_start', date);
  url.searchParams.set('date_stop', date);

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`API-Tennis get_fixtures ${date} failed HTTP ${response.status}: ${text.slice(0, 300)}`);

  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') throw new Error(`API-Tennis get_fixtures ${date} unsuccessful: ${JSON.stringify(payload).slice(0, 400)}`);
  if (Array.isArray(payload.result)) return payload.result;
  if (payload.result && typeof payload.result === 'object') return Object.values(payload.result);
  return [];
}

function buildFixtureIndexes(fixtures) {
  const byEventKey = new Map();
  const bySoftKey = new Map();

  for (const fixture of fixtures) {
    const eventKey = fixtureEventKey(fixture);
    if (eventKey) byEventKey.set(eventKey, fixture);

    const eventDate = String(fixture.event_date ?? fixture.date ?? '').slice(0, 10);
    const first = normalizeName(fixture.event_first_player ?? fixture.player_1 ?? fixture.home_team ?? fixture.player_first ?? '');
    const second = normalizeName(fixture.event_second_player ?? fixture.player_2 ?? fixture.away_team ?? fixture.player_second ?? '');
    const tournament = normalizeName(fixture.tournament_name ?? fixture.league_name ?? fixture.event_league ?? fixture.tournament ?? '');
    if (eventDate && first && second) {
      bySoftKey.set(`${eventDate}|${first}|${second}|${tournament}`, fixture);
      bySoftKey.set(`${eventDate}|${second}|${first}|${tournament}`, fixture);
    }
  }

  return { byEventKey, bySoftKey };
}

function findFixtureForRow(row, indexes) {
  const eventKey = rowEventKey(row);
  if (eventKey && indexes.byEventKey.has(eventKey)) {
    return { fixture: indexes.byEventKey.get(eventKey), confidence: 'high', source: 'API-Tennis', note: `matched by event_key ${eventKey}` };
  }

  const date = rowDate(row);
  const [fromMatchFirst, fromMatchSecond] = playerPairFromMatch(row.match);
  const first = normalizeName(row.player_1 ?? row.player_one ?? fromMatchFirst ?? '');
  const second = normalizeName(row.player_2 ?? row.player_two ?? fromMatchSecond ?? '');
  const tournament = normalizeName(row.tournament ?? '');
  const softKey = `${date}|${first}|${second}|${tournament}`;
  if (date && first && second && indexes.bySoftKey.has(softKey)) {
    return { fixture: indexes.bySoftKey.get(softKey), confidence: 'medium', source: 'manual_match', note: 'matched by date/player/tournament soft key' };
  }

  return null;
}

function initializeActualColumns(row) {
  row.actual_first_set_score = '';
  row.actual_score_source = 'unavailable';
  row.actual_score_confidence = 'low';
  row.actual_score_status = 'unknown';
  row.actual_score_notes = 'not resolved yet';
}

function resolveFromExistingWinnerRows(records) {
  const winningScoresByEvent = new Map();

  for (const row of records) {
    const key = rowEventKey(row);
    const score = normalizeScore(row.score);
    if (!key || !score || !truthy(row.won)) continue;
    if (!winningScoresByEvent.has(key)) winningScoresByEvent.set(key, new Set());
    winningScoresByEvent.get(key).add(score);
  }

  for (const row of records) {
    const key = rowEventKey(row);
    const scores = key ? winningScoresByEvent.get(key) : null;
    if (!scores || scores.size === 0) continue;
    if (scores.size === 1) {
      row.actual_first_set_score = [...scores][0];
      row.actual_score_source = truthy(row.won) ? 'existing row' : 'existing row / same event_key winner';
      row.actual_score_confidence = 'high';
      row.actual_score_status = 'resolved';
      row.actual_score_notes = truthy(row.won)
        ? 'won=true means selected score is actual first-set score'
        : 'same event_key has one winning selected score in CSV';
    } else {
      row.actual_score_source = 'existing row';
      row.actual_score_confidence = 'low';
      row.actual_score_status = 'ambiguous';
      row.actual_score_notes = `multiple winning scores found for event_key ${key}: ${[...scores].join('; ')}`;
    }
  }
}

async function resolveWithApi(records, apiKey) {
  const unresolved = records.filter((row) => row.actual_score_status !== 'resolved');
  const dates = [...new Set(unresolved.map(rowDate).filter(Boolean))].sort();
  const fixtureIndexByDate = new Map();

  console.log(`Resolving ${unresolved.length} unresolved rows across ${dates.length} dates with API-Tennis get_fixtures.`);

  for (const date of dates) {
    try {
      console.log(`Fetching fixtures for ${date}...`);
      const fixtures = await fetchFixturesForDate(apiKey, date);
      fixtureIndexByDate.set(date, buildFixtureIndexes(fixtures));
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      console.warn(`Fixture fetch failed for ${date}: ${error instanceof Error ? error.message : String(error)}`);
      fixtureIndexByDate.set(date, buildFixtureIndexes([]));
    }
  }

  for (const row of unresolved) {
    const indexes = fixtureIndexByDate.get(rowDate(row));
    if (!indexes) {
      row.actual_score_notes = 'no fixture index for event date';
      continue;
    }

    const match = findFixtureForRow(row, indexes);
    if (!match) {
      row.actual_score_notes = 'API-Tennis fixture not matched by event_key or safe soft match';
      continue;
    }

    const statusText = fixtureStatusText(match.fixture);
    if (VOID_PATTERN.test(statusText)) {
      row.actual_first_set_score = '';
      row.actual_score_source = match.source;
      row.actual_score_confidence = match.confidence;
      row.actual_score_status = 'void';
      row.actual_score_notes = `${match.note}; fixture status indicates void/retired/cancelled: ${statusText}`;
      continue;
    }

    const extracted = extractFirstSetScore(match.fixture);
    if (!extracted?.score) {
      row.actual_first_set_score = '';
      row.actual_score_source = match.source;
      row.actual_score_confidence = match.confidence;
      row.actual_score_status = 'unknown';
      row.actual_score_notes = `${match.note}; fixture matched but no safe first-set field found`;
      continue;
    }

    row.actual_first_set_score = extracted.score;
    row.actual_score_source = match.source;
    row.actual_score_confidence = match.confidence;
    row.actual_score_status = 'resolved';
    row.actual_score_notes = `${match.note}; first-set score from ${extracted.path}`;
  }
}

function summarize(records) {
  const counts = {
    total_rows: records.length,
    resolved: 0,
    unknown: 0,
    void_or_retired_cancelled: 0,
    ambiguous: 0,
    high_confidence: 0,
    medium_confidence: 0,
    low_confidence: 0,
  };
  const scoreDistribution = new Map();
  const eventCounts = new Map();

  for (const row of records) {
    if (row.actual_score_status === 'resolved') counts.resolved += 1;
    if (row.actual_score_status === 'unknown') counts.unknown += 1;
    if (row.actual_score_status === 'void') counts.void_or_retired_cancelled += 1;
    if (row.actual_score_status === 'ambiguous') counts.ambiguous += 1;
    if (row.actual_score_confidence === 'high') counts.high_confidence += 1;
    if (row.actual_score_confidence === 'medium') counts.medium_confidence += 1;
    if (row.actual_score_confidence === 'low') counts.low_confidence += 1;

    if (row.actual_first_set_score) {
      scoreDistribution.set(row.actual_first_set_score, (scoreDistribution.get(row.actual_first_set_score) ?? 0) + 1);
    }

    const key = rowEventKey(row);
    if (key) eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }

  const duplicateMatchIds = [...eventCounts.values()].filter((count) => count > 1).length;
  const duplicateRowsBeyondFirst = [...eventCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  return {
    ...counts,
    unique_event_keys: eventCounts.size,
    duplicate_match_ids: duplicateMatchIds,
    duplicate_rows_beyond_first: duplicateRowsBeyondFirst,
    score_distribution: Object.fromEntries([...scoreDistribution.entries()].sort((a, b) => b[1] - a[1])),
    examples_resolved: records.filter((row) => row.actual_score_status === 'resolved').slice(0, 10).map((row) => ({
      event_date: row.event_date,
      event_key: rowEventKey(row),
      match: row.match,
      selected_score: row.score,
      won: row.won,
      actual_first_set_score: row.actual_first_set_score,
      source: row.actual_score_source,
      notes: row.actual_score_notes,
    })),
    examples_unresolved: records.filter((row) => row.actual_score_status !== 'resolved').slice(0, 10).map((row) => ({
      event_date: row.event_date,
      event_key: rowEventKey(row),
      match: row.match,
      selected_score: row.score,
      status: row.actual_score_status,
      notes: row.actual_score_notes,
    })),
  };
}

async function main() {
  const inputPath = getArg('input', 'artifacts/input/blind-sim-bets.csv');
  const outputDir = getArg('output-dir', 'artifacts/output');
  const outputName = getArg('output-name', 'blind-sim-bets-enriched-first-set-scores.csv');
  const apiKey = process.env.API_TENNIS_KEY;

  const text = await fs.readFile(inputPath, 'utf8');
  const { headers, records } = parseCsv(text);

  const addedHeaders = [
    'actual_first_set_score',
    'actual_score_source',
    'actual_score_confidence',
    'actual_score_status',
    'actual_score_notes',
  ];

  for (const row of records) initializeActualColumns(row);
  resolveFromExistingWinnerRows(records);

  if (apiKey) {
    await resolveWithApi(records, apiKey);
  } else {
    console.warn('API_TENNIS_KEY is not set. Only won=true / same event_key winners were resolved.');
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, outputName);
  const summaryPath = path.join(outputDir, 'blind-sim-first-set-enrichment-summary.json');
  const allHeaders = [...headers, ...addedHeaders.filter((header) => !headers.includes(header))];

  await fs.writeFile(outputPath, writeCsv(allHeaders, records));
  const summary = summarize(records);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
