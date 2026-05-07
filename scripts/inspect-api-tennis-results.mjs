const apiKey = process.env.API_TENNIS_KEY;
const baseUrl = 'https://api.api-tennis.com/tennis/';

const dateStart = process.env.INSPECT_DATE_START ?? '2026-05-01';
const dateStop = process.env.INSPECT_DATE_STOP ?? '2026-05-06';
const maxSamples = Number(process.env.INSPECT_MAX_SAMPLES ?? 12);

if (!apiKey) {
  console.error('Missing API_TENNIS_KEY environment variable.');
  process.exit(1);
}

async function fetchApiTennis(method, params = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('method', method);
  url.searchParams.set('APIkey', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);

  const payload = JSON.parse(text);
  if (String(payload.success) !== '1') throw new Error(`${method} unsuccessful: ${JSON.stringify(payload).slice(0, 1000)}`);
  return payload.result;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).filter((item) => item && typeof item === 'object');
}

function looksResultRelated(key, value) {
  const text = `${key} ${typeof value === 'string' ? value : ''}`.toLowerCase();
  return (
    text.includes('score') ||
    text.includes('result') ||
    text.includes('set') ||
    text.includes('period') ||
    text.includes('final') ||
    text.includes('winner') ||
    text.includes('status')
  );
}

function resultRelatedShape(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (looksResultRelated(key, value)) out[key] = value;
  }
  return out;
}

function compactFixture(item) {
  return {
    event_key: item.event_key,
    event_date: item.event_date,
    event_time: item.event_time,
    event_first_player: item.event_first_player,
    event_second_player: item.event_second_player,
    tournament_name: item.tournament_name,
    event_status: item.event_status,
    event_final_result: item.event_final_result,
    event_game_result: item.event_game_result,
    event_first_set_result: item.event_first_set_result,
    event_result: item.event_result,
    scores: item.scores,
    score: item.score,
    result: item.result,
  };
}

const run = async () => {
  console.log('SlipIQ API-Tennis result-field inspector');
  console.log(`Range: ${dateStart} to ${dateStop}`);
  const fixtures = normalizeArray(await fetchApiTennis('get_fixtures', { date_start: dateStart, date_stop: dateStop }));
  console.log(`Fixtures returned: ${fixtures.length}`);

  const finished = fixtures.filter((fixture) => {
    const joined = Object.values(resultRelatedShape(fixture)).map((value) => JSON.stringify(value)).join(' ').toLowerCase();
    return /\d\s*[:-]\s*\d/.test(joined) || joined.includes('finished') || joined.includes('ended') || joined.includes('final');
  });

  console.log(`Result-looking fixtures: ${finished.length}`);
  console.log('All keys from first fixture:');
  console.log(fixtures[0] ? Object.keys(fixtures[0]).sort().join(', ') : '(none)');

  console.log('Sample compact fixtures:');
  for (const fixture of fixtures.slice(0, Math.min(maxSamples, fixtures.length))) {
    console.log(JSON.stringify(compactFixture(fixture), null, 2));
  }

  console.log('Sample result-related shapes:');
  for (const fixture of finished.slice(0, maxSamples)) {
    console.log(JSON.stringify({
      event_key: fixture.event_key,
      players: `${fixture.event_first_player ?? 'P1'} vs ${fixture.event_second_player ?? 'P2'}`,
      result_related: resultRelatedShape(fixture),
    }, null, 2));
  }

  if (finished.length === 0) {
    console.log('No result-looking fixtures found in this date range. Try an older completed range or inspect API-Tennis result methods/docs.');
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
