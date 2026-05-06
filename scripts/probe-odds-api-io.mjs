const apiKey = process.env.ODDS_API_IO_KEY;
const baseUrl = 'https://api.odds-api.io/v3';
const preferredBookmakers = (process.env.ODDS_API_IO_BOOKMAKERS || 'Bet365,Unibet,Pinnacle,1xBet')
  .split(',')
  .map((bookmaker) => bookmaker.trim())
  .filter(Boolean);

if (!apiKey) {
  console.error('Missing ODDS_API_IO_KEY environment variable.');
  process.exit(1);
}

const fetchJson = async (path, params) => {
  const url = new URL(`${baseUrl}${path}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} returned non-JSON response: ${text.slice(0, 500)}`);
  }
};

const normalizeArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.bookmakers)) return payload.bookmakers;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.odds)) return payload.odds;
  return [];
};

const bookmakerName = (bookmaker) => {
  if (typeof bookmaker === 'string') return bookmaker;
  return bookmaker.name ?? bookmaker.title ?? bookmaker.slug ?? bookmaker.key ?? bookmaker.id ?? null;
};

const pickValidBookmakers = async () => {
  const payload = await fetchJson('/bookmakers');
  const available = normalizeArray(payload).map(bookmakerName).filter(Boolean);

  console.log(`Fetched ${available.length} valid bookmakers from Odds-API.io.`);
  console.log(`Available bookmaker sample: ${available.slice(0, 12).join(', ')}`);

  if (available.length === 0) {
    throw new Error('No bookmakers returned from /bookmakers. Cannot call /odds/multi safely.');
  }

  const lowerToName = new Map(available.map((name) => [String(name).toLowerCase(), String(name)]));
  const selected = preferredBookmakers
    .map((name) => lowerToName.get(name.toLowerCase()))
    .filter(Boolean);

  return selected.length > 0 ? selected.slice(0, 5) : available.slice(0, 5);
};

const collectMarketSignals = (value, path = [], out = new Map()) => {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMarketSignals(item, [...path, String(index)], out));
    return out;
  }

  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    const childIsPrimitive = child === null || typeof child !== 'object';
    const pathText = [...path, key].join('.');

    if (
      lowerKey.includes('market') ||
      lowerKey.includes('set') ||
      lowerKey.includes('score') ||
      lowerKey.includes('total') ||
      lowerKey.includes('handicap') ||
      lowerKey.includes('winner') ||
      lowerKey.includes('moneyline') ||
      lowerKey.includes('odds') ||
      lowerKey.includes('bookmaker')
    ) {
      const sample = childIsPrimitive ? String(child).slice(0, 80) : Array.isArray(child) ? `[array:${child.length}]` : '[object]';
      out.set(pathText, sample);
    }

    if (typeof child === 'string') {
      const lowerChild = child.toLowerCase();
      if (
        lowerChild.includes('first set') ||
        lowerChild.includes('set 1') ||
        lowerChild.includes('correct score') ||
        lowerChild.includes('score') ||
        lowerChild.includes('total games') ||
        lowerChild.includes('set betting') ||
        lowerChild.includes('winner')
      ) {
        out.set(pathText, child.slice(0, 120));
      }
    }

    collectMarketSignals(child, [...path, key], out);
  }

  return out;
};

const summarizeEvent = (event) => ({
  id: event.id,
  home: event.home,
  away: event.away,
  date: event.date,
  status: event.status,
  sport: event.sport?.slug ?? event.sport?.name ?? event.sport,
  league: event.league?.slug ?? event.league?.name ?? event.league,
});

const run = async () => {
  console.log('SlipIQ Odds-API.io probe');
  console.log('Fetching tennis events...');

  const eventsPayload = await fetchJson('/events', {
    sport: 'tennis',
    status: 'pending,live',
  });

  const events = normalizeArray(eventsPayload).slice(0, 10);
  console.log(`Found ${events.length} tennis events in first page.`);

  if (events.length === 0) {
    console.log('No tennis events returned. Try again during active ATP/WTA windows or inspect league filters.');
    return;
  }

  console.log('Sample events:');
  for (const event of events.slice(0, 5)) {
    console.log(JSON.stringify(summarizeEvent(event), null, 2));
  }

  const selectedBookmakers = await pickValidBookmakers();
  const bookmakers = selectedBookmakers.join(',');
  const eventIds = events.slice(0, 10).map((event) => event.id).filter(Boolean).join(',');
  const eventCount = eventIds ? eventIds.split(',').length : 0;
  console.log(`Fetching odds for ${eventCount} events...`);
  console.log(`Using valid bookmakers: ${bookmakers}`);

  const oddsPayload = await fetchJson('/odds/multi', {
    eventIds,
    bookmakers,
  });
  const oddsEvents = normalizeArray(oddsPayload);
  console.log(`Received odds for ${oddsEvents.length} events.`);

  const signals = collectMarketSignals(oddsPayload);
  const signalEntries = [...signals.entries()].slice(0, 250);

  console.log('Potential market/period/odds signals:');
  if (signalEntries.length === 0) {
    console.log('No obvious market signals found in response shape. Inspect raw provider docs/account dashboard.');
  } else {
    for (const [path, sample] of signalEntries) {
      console.log(`- ${path}: ${sample}`);
    }
  }

  const signalText = signalEntries.map(([path, sample]) => `${path} ${sample}`.toLowerCase()).join('\n');
  const verdict = {
    hasCorrectScoreSignal: /correct.score|score/.test(signalText),
    hasFirstSetSignal: /first.set|set.1/.test(signalText),
    hasSetBettingSignal: /set.betting|set/.test(signalText),
    hasTotalGamesSignal: /total.games|total/.test(signalText),
    hasWinnerSignal: /winner|moneyline/.test(signalText),
  };

  console.log('Probe verdict signals:');
  console.log(JSON.stringify(verdict, null, 2));

  if (verdict.hasCorrectScoreSignal && verdict.hasFirstSetSignal) {
    console.log('POSSIBLE MATCH: first-set correct-score style market may exist. Inspect odds response manually before integrating.');
  } else if (verdict.hasFirstSetSignal || verdict.hasSetBettingSignal || verdict.hasTotalGamesSignal) {
    console.log('FALLBACK LIKELY: first-set/set/total markets may exist, but first-set correct-score is not clearly confirmed.');
  } else if (verdict.hasWinnerSignal) {
    console.log('BASIC TENNIS ODDS ONLY: winner/moneyline-style markets may exist, but no first-set market was clearly detected.');
  } else {
    console.log('NO CLEAR MATCH: this account/response did not clearly expose first-set markets in sampled events.');
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
