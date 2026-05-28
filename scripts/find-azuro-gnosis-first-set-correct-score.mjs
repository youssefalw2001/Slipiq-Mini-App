#!/usr/bin/env node
/*
  Azuro Gnosis tennis 1st Set - Correct Score scanner.

  Safe read-only utility:
  - Queries the official Azuro Gnosis subgraph.
  - Uses @azuro-org/dictionaries to decode market/selection names.
  - Prints conditionId, outcomeIds, scores, and odds for matching tennis markets.
*/

import axios from 'axios';
import { getMarketName, getSelectionName } from '@azuro-org/dictionaries';

const SUBGRAPH_URL = process.env.AZURO_GNOSIS_SUBGRAPH_URL || 'https://thegraph.azuro.org/subgraphs/name/azuro-protocol/azuro-api-gnosis';
const TARGET_MARKET = process.env.TARGET_MARKET || '1st Set - Correct Score';
const PAGE_SIZE = Number(process.env.PAGE_SIZE || '100');
const MAX_PAGES = Number(process.env.MAX_PAGES || '20');
const PRINT_ALL_TENNIS_MARKETS = String(process.env.PRINT_ALL_TENNIS_MARKETS || 'false') === 'true';

const LIVE_TENNIS_QUERY = `
  query LiveTennisGames($first: Int!, $skip: Int!) {
    games(
      first: $first
      skip: $skip
      where: {
        sport_: { name: "Tennis" }
        status: Created
      }
      orderBy: startsAt
      orderDirection: asc
    ) {
      id
      gameId
      title
      startsAt
      status
      sport { name }
      conditions {
        id
        conditionId
        status
        outcomes {
          id
          outcomeId
          currentOdds
          odds
        }
      }
    }
  }
`;

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTargetMarket(marketName) {
  const name = normalize(marketName);
  const target = normalize(TARGET_MARKET);

  return (
    name === target ||
    (
      (name.includes('1st set') || name.includes('first set') || name.includes('set 1')) &&
      name.includes('correct') &&
      name.includes('score')
    )
  );
}

function decimalOdds(value) {
  if (value === null || value === undefined || value === '') return null;

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 1) return null;

  // Some Azuro odds values are returned scaled by 1e12.
  return n > 1_000_000 ? n / 1e12 : n;
}

function safeDecode(fn, payload) {
  try {
    return fn(payload);
  } catch {
    return null;
  }
}

async function graphql(query, variables = {}) {
  const { data } = await axios.post(
    SUBGRAPH_URL,
    { query, variables },
    {
      headers: { 'content-type': 'application/json' },
      timeout: 30_000,
    },
  );

  if (data.errors?.length) {
    throw new Error(JSON.stringify(data.errors, null, 2));
  }

  return data.data;
}

async function fetchLiveTennisGames() {
  const games = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const data = await graphql(LIVE_TENNIS_QUERY, { first: PAGE_SIZE, skip });
    const batch = data.games ?? [];

    games.push(...batch);

    if (batch.length < PAGE_SIZE) break;
  }

  return games;
}

function decodeCondition(condition) {
  const outcomes = condition.outcomes ?? [];

  const decodedOutcomes = outcomes.map((outcome) => {
    const outcomeId = String(outcome.outcomeId);
    const marketName = safeDecode(getMarketName, { outcomeId });
    const selectionName = safeDecode(getSelectionName, { outcomeId });

    return {
      outcomeId,
      marketName,
      selectionName,
      currentOdds: decimalOdds(outcome.currentOdds ?? outcome.odds),
      rawCurrentOdds: outcome.currentOdds ?? outcome.odds ?? null,
    };
  });

  const marketName = decodedOutcomes.find((o) => o.marketName)?.marketName ?? null;

  return {
    rawConditionId: condition.conditionId ?? condition.id,
    conditionStatus: condition.status,
    marketName,
    outcomes: decodedOutcomes,
  };
}

function extractTargetMarkets(game) {
  const decodedConditions = (game.conditions ?? []).map(decodeCondition);

  if (PRINT_ALL_TENNIS_MARKETS) {
    for (const condition of decodedConditions) {
      if (!condition.marketName) continue;
      console.error(
        JSON.stringify({
          gameId: game.gameId ?? game.id,
          title: game.title,
          conditionId: condition.rawConditionId,
          marketName: condition.marketName,
          selections: condition.outcomes.map((o) => o.selectionName).filter(Boolean),
        }),
      );
    }
  }

  return decodedConditions
    .filter((condition) => isTargetMarket(condition.marketName))
    .map((condition) => ({
      rawConditionId: condition.rawConditionId,
      conditionStatus: condition.conditionStatus,
      marketName: condition.marketName,
      outcomes: condition.outcomes.map((outcome) => ({
        score: outcome.selectionName,
        outcomeId: outcome.outcomeId,
        currentOdds: outcome.currentOdds,
        rawCurrentOdds: outcome.rawCurrentOdds,
      })),
    }));
}

async function main() {
  const games = await fetchLiveTennisGames();
  const matches = [];

  for (const game of games) {
    const markets = extractTargetMarkets(game);
    if (!markets.length) continue;

    matches.push({
      gameId: game.gameId ?? game.id,
      title: game.title,
      startsAt: game.startsAt,
      status: game.status,
      markets,
    });
  }

  console.log(
    JSON.stringify(
      {
        subgraph: SUBGRAPH_URL,
        targetMarket: TARGET_MARKET,
        gamesChecked: games.length,
        matchesFound: matches.length,
        matches,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
