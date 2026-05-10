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
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (quoted) {
      if (c === '"' && n === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows[0] ?? [];
  const records = rows
    .slice(1)
    .filter((items) => items.some((item) => String(item).trim() !== ''))
    .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] ?? ''])));
  return { headers, records };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(headers, records) {
  return `${[headers.map(csvEscape).join(','), ...records.map((record) => headers.map((header) => csvEscape(record[header])).join(','))].join('\n')}\n`;
}

async function main() {
  const inputRaw = arg('inputs');
  const output = arg('output');
  if (!inputRaw || !output) throw new Error('Usage: node scripts/combine-csv-union.mjs --inputs file1.csv,file2.csv --output combined.csv');

  const inputPaths = inputRaw.split(',').map((item) => item.trim()).filter(Boolean);
  if (inputPaths.length < 2) throw new Error('Provide at least two input CSV paths.');

  const allHeaders = [];
  const seenHeader = new Set();
  const allRecords = [];
  const inputSummaries = [];

  for (const inputPath of inputPaths) {
    const text = await fs.readFile(inputPath, 'utf8');
    const { headers, records } = parseCsv(text);
    for (const header of headers) {
      if (!seenHeader.has(header)) {
        seenHeader.add(header);
        allHeaders.push(header);
      }
    }
    for (const record of records) {
      record.__source_file = inputPath;
      allRecords.push(record);
    }
    inputSummaries.push({ path: inputPath, headers: headers.length, rows: records.length });
  }

  if (!seenHeader.has('__source_file')) allHeaders.push('__source_file');

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, writeCsv(allHeaders, allRecords));
  console.log(JSON.stringify({ output, total_rows: allRecords.length, total_headers: allHeaders.length, inputs: inputSummaries }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
