#!/usr/bin/env node
/*
  Safe wrapper for Azuro V3 historical replay.

  It builds AZURO_HISTORICAL_SUBGRAPH_URL from THE_GRAPH_API_KEY and --subgraph-id
  without printing the secret or passing the full URL on the command line.
*/

import { spawnSync } from 'node:child_process';

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const defaultPolygonSubgraphId = '5xDMqPyP6P5X6f2o5B1uQunrYj91mXyT68L9wGgDskK';
const graphKey = (process.env.THE_GRAPH_API_KEY || '').trim();
const explicitUrl = (process.env.AZURO_HISTORICAL_SUBGRAPH_URL || '').trim();
const subgraphId = argValue('subgraph-id') || process.env.AZURO_SUBGRAPH_ID || defaultPolygonSubgraphId;

if (!explicitUrl && graphKey && subgraphId) {
  const encodedKey = encodeURIComponent(graphKey);
  process.env.AZURO_HISTORICAL_SUBGRAPH_URL = `https://gateway-market.thegraph.com/api/${encodedKey}/subgraphs/id/${subgraphId}`;
}

const child = spawnSync(
  'tsx',
  ['scripts/azuro-v3-historical-replay-backtest.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  }
);

process.exit(child.status ?? 1);
