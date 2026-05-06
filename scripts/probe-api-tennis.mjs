const apiKey = process.env.API_TENNIS_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';

if (!apiKey) {
  console.error('Missing API_TENNIS_KEY environment variable.');
  process.exit(1);
}

const isoDate = (offsetDays = 0) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

const dateStart = process.env.API_TENNIS_DATE_START || isoDate(0);
const dateStop = process.env.API_TENNIS_DATE_STOP || isoDate(2);

const fetchApiTennis = async (method, params = {}) => {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (String(payload.success) !== '1') {
    throw new Error(`${method} returned unsuccessful payload: ${JSON.stringify(payload).slice(0, 1000)}`);
  }

  return payload.result;
};

const normalizeArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value);
};

const marketKeys = (oddsResult) => {
  const markets = new Set();
  for (const matchOdds of normalizeArray(oddsResult)) {
    if (matchOdds && typeof matchOdds === 'object') {
      for (const key of Object.keys(matchOdds)) markets.add(key);
    }
  }
  return [...markets].sort();
};

const countMarketOutcomes = (oddsResult, marketName) => {
  let count = 0;
  const samples = [];
  for (const [matchKey, matchOdds] of Object.entries(oddsResult ?? {})) {
    const market = matchOdds?.[marketName];
    if (!market || typeof market !== 'object') continue;
    const outcomes = Object.keys(market);
    count += outcomes.length;
    samples.push({ matchKey, outcomes: outcomes.slice(0, 10) });
  }
  return { count, samples: samples.slice(0, 3) };
};

const summarizeFixture = (fixture) => ({
  event_key: fixture.event_key,
  event_date: fixture.event_date,
  event_time: fixture.event_time,
  event_first_player: fixture.event_first_player,
  event_second_player: fixture.event_second_player,
  tournament_name: fixture.tournament_name,
  event_type_type: fixture.event_type_type,
  event_final_result: fixture.event_final_result,
});

const run = async () => {
  console.log('SlipIQ API-Tennis probe');
  console.log(`Date range: ${dateStart} to ${dateStop}`);

  console.log('Fetching fixtures...');
  const fixtures = normalizeArray(await fetchApiTennis('get_fixtures', {
    date_start: dateStart,
    date_stop: dateStop,
  }));

  console.log(`Fetched ${fixtures.length} fixtures.`);
  for (const fixture of fixtures.slice(0, 8)) {
    console.log(JSON.stringify(summarizeFixture(fixture), null, 2));
  }

  console.log('Fetching odds...');
  const oddsResult = await fetchApiTennis('get_odds', {
    date_start: dateStart,
    date_stop: dateStop,
  });

  const markets = marketKeys(oddsResult);
  console.log(`Found ${markets.length} market names.`);
  console.log('Market names:');
  for (const market of markets) console.log(`- ${market}`);

  const correctScore1stHalf = countMarketOutcomes(oddsResult, 'Correct Score 1st Half');
  const firstSetWinner = countMarketOutcomes(oddsResult, 'Home/Away (1st Set)');
  const setBetting = countMarketOutcomes(oddsResult, 'Set Betting');

  const verdict = {
    hasCorrectScore1stHalf: correctScore1stHalf.count > 0,
    correctScore1stHalfOutcomeCount: correctScore1stHalf.count,
    hasFirstSetWinner: firstSetWinner.count > 0,
    firstSetWinnerOutcomeCount: firstSetWinner.count,
    hasSetBetting: setBetting.count > 0,
    setBettingOutcomeCount: setBetting.count,
  };

  console.log('Sample Correct Score 1st Half outcomes:');
  console.log(JSON.stringify(correctScore1stHalf.samples, null, 2));

  console.log('Probe verdict signals:');
  console.log(JSON.stringify(verdict, null, 2));

  if (verdict.hasCorrectScore1stHalf) {
    console.log('STRONG MATCH: API-Tennis exposes Correct Score 1st Half markets. This is the best provider candidate for First Set Lab.');
  } else if (verdict.hasFirstSetWinner || verdict.hasSetBetting) {
    console.log('FALLBACK MATCH: API-Tennis exposes first-set winner or set betting, but exact first-set correct score was not returned for this date range.');
  } else {
    console.log('NO CLEAR MATCH: no first-set correct-score or fallback markets were returned for this date range/account.');
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
