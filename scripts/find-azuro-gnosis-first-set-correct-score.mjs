#!/usr/bin/env node
/*
  Azuro Gnosis tennis 1st Set - Correct Score scanner.

  Safe read-only utility:
  - Queries the Azuro Gnosis v3 API subgraph.
  - Dynamically loads @azuro-org/dictionaries so export mismatches do not crash import.
  - Attempts schema variants and always prints diagnostic JSON to stdout.
  - No wallet, no signing, no orders.
*/

import axios from 'axios';

const SUBGRAPH_URL = process.env.AZURO_GNOSIS_SUBGRAPH_URL || 'https://thegraph.azuro.org/subgraphs/name/azuro-protocol/azuro-api-gnosis-v3';
const TARGET_MARKET = process.env.TARGET_MARKET || '1st Set - Correct Score';
const PAGE_SIZE = Number(process.env.PAGE_SIZE || '100');
const MAX_PAGES = Number(process.env.MAX_PAGES || '20');
const PRINT_ALL_TENNIS_MARKETS = String(process.env.PRINT_ALL_TENNIS_MARKETS || 'false') === 'true';

const QUERY_VARIANTS = [
  {
    name: 'sport_name_status_created',
    query: `
      query LiveTennisGames($first: Int!, $skip: Int!) {
        games(
          first: $first
          skip: $skip
          where: { sport_: { name: "Tennis" }, status: Created }
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
            outcomes { id outcomeId currentOdds odds }
          }
        }
      }
    `,
  },
  {
    name: 'sport_name_state_created',
    query: `
      query LiveTennisGames($first: Int!, $skip: Int!) {
        games(
          first: $first
          skip: $skip
          where: { sport_: { name: "Tennis" }, state: Created }
          orderBy: startsAt
          orderDirection: asc
        ) {
          id
          gameId
          title
          startsAt
          state
          sport { name }
          conditions {
            id
            conditionId
            state
            outcomes { id outcomeId currentOdds odds }
          }
        }
      }
    `,
  },
  {
    name: 'unfiltered_with_status',
    query: `
      query LiveTennisGames($first: Int!, $skip: Int!) {
        games(first: $first, skip: $skip, orderBy: startsAt, orderDirection: asc) {
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
            outcomes { id outcomeId currentOdds odds }
          }
        }
      }
    `,
  },
  {
    name: 'unfiltered_minimal',
    query: `
      query LiveTennisGames($first: Int!, $skip: Int!) {
        games(first: $first, skip: $skip) {
          id
          gameId
          title
          startsAt
          sport { name }
          conditions {
            id
            conditionId
            outcomes { id outcomeId }
          }
        }
      }
    `,
  },
];

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
  return n > 1_000_000 ? n / 1e12 : n;
}

async function loadDictionaries() {
  try {
    const mod = await import('@azuro-org/dictionaries');
    const exports = Object.keys(mod).sort();
    return {
      ok: true,
      exports,
      getMarketName: typeof mod.getMarketName === 'function' ? mod.getMarketName : null,
      getSelectionName: typeof mod.getSelectionName === 'function' ? mod.getSelectionName : null,
    };
  } catch (error) {
    return {
      ok: false,
      exports: [],
      error: error.message,
      getMarketName: null,
      getSelectionName: null,
    };
  }
}

function callDictionary(fn, outcomeId) {
  if (!fn) return null;
  const attempts = [
    () => fn({ outcomeId }),
    () => fn(outcomeId),
    () => fn(String(outcomeId)),
    () => fn(Number(outcomeId)),
  ];

  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    } catch {
      // try next form
    }
  }

  return null;
}

async function graphql(query, variables = {}) {
  const { data } = await axios.post(
    SUBGRAPH_URL,
    { query, variables },
    { headers: { 'content-type': 'application/json' }, timeout: 30_000 },
  );

  if (data.errors?.length) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function isTennisGame(game) {
  const text = normalize([game.sport?.name, game.title].filter(Boolean).join(' '));
  return text.includes('tennis');
}

function isCreatedGame(game) {
  const value = normalize(game.status ?? game.state ?? 'created');
  return !value || value === 'created' || value === 'live' || value === 'prematch';
}

async function fetchGamesWithVariant(variant) {
  const games = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const skip = page * PAGE_SIZE;
    const data = await graphql(variant.query, { first: PAGE_SIZE, skip });
    const batch = data.games ?? [];
    games.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return games.filter((game) => isTennisGame(game) && isCreatedGame(game));
}

async function fetchLiveTennisGames() {
  const errors = [];

  for (const variant of QUERY_VARIANTS) {
    try {
      const games = await fetchGamesWithVariant(variant);
      return { variant: variant.name, games, errors };
    } catch (error) {
      errors.push({ variant: variant.name, error: error.message });
    }
  }

  return { variant: null, games: [], errors };
}

function decodeCondition(condition, dictionaries) {
  const outcomes = condition.outcomes ?? [];

  const decodedOutcomes = outcomes.map((outcome) => {
    const outcomeId = String(outcome.outcomeId ?? outcome.id);
    const marketName = callDictionary(dictionaries.getMarketName, outcomeId);
    const selectionName = callDictionary(dictionaries.getSelectionName, outcomeId);

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
    conditionStatus: condition.status ?? condition.state ?? null,
    marketName,
    outcomes: decodedOutcomes,
  };
}

function extractTargetMarkets(game, dictionaries) {
  const decodedConditions = (game.conditions ?? []).map((condition) => decodeCondition(condition, dictionaries));

  const allMarkets = decodedConditions
    .filter((condition) => condition.marketName)
    .map((condition) => ({
      gameId: game.gameId ?? game.id,
      title: game.title,
      conditionId: condition.rawConditionId,
      marketName: condition.marketName,
      selections: condition.outcomes.map((o) => o.selectionName).filter(Boolean),
    }));

  if (PRINT_ALL_TENNIS_MARKETS) {
    for (const market of allMarkets) console.error(JSON.stringify(market));
  }

  const matches = decodedConditions
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

  return { matches, allMarkets };
}

async function main() {
  const dictionaries = await loadDictionaries();
  const { variant, games, errors } = await fetchLiveTennisGames();
  const matches = [];
  const decodedMarketSamples = [];

  for (const game of games) {
    const { matches: targetMarkets, allMarkets } = extractTargetMarkets(game, dictionaries);
    decodedMarketSamples.push(...allMarkets.slice(0, 5));

    if (!targetMarkets.length) continue;

    matches.push({
      gameId: game.gameId ?? game.id,
      title: game.title,
      startsAt: game.startsAt,
      status: game.status ?? game.state ?? null,
      markets: targetMarkets,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        subgraph: SUBGRAPH_URL,
        queryVariantUsed: variant,
        queryErrors: errors,
        dictionaries: {
          ok: dictionaries.ok,
          exports: dictionaries.exports,
          error: dictionaries.error ?? null,
          hasGetMarketName: Boolean(dictionaries.getMarketName),
          hasGetSelectionName: Boolean(dictionaries.getSelectionName),
        },
        targetMarket: TARGET_MARKET,
        gamesChecked: games.length,
        decodedMarketSamples: decodedMarketSamples.slice(0, 50),
        matchesFound: matches.length,
        matches,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify(
      {
        ok: false,
        subgraph: SUBGRAPH_URL,
        targetMarket: TARGET_MARKET,
        error: error.message,
        stack: error.stack,
      },
      null,
      2,
    ),
  );
  process.exit(0);
});
