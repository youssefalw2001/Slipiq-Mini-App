import seedProofLog from '../data/scoreHunterProofLog.json';

export interface PaperProofSignal {
  id: string;
  foundAt: string;
  match: string;
  tournament: string;
  score: string;
  odds: number;
  signalStrength: number;
  status: 'pending' | 'won' | 'lost' | 'void';
  result: string | null;
  profitUnits: number;
  note: string;
}

export interface ProofLogData {
  source: 'seed' | 'live';
  signals: PaperProofSignal[];
}

interface ProofLogResponse {
  signals?: unknown;
}

function getProofLogApiUrl() {
  const explicitUrl = import.meta.env.VITE_SLIPIQ_PROOF_LOG_API_URL as string | undefined;
  if (explicitUrl) return explicitUrl;

  const dataUrl = import.meta.env.VITE_SLIPIQ_DATA_API_URL as string | undefined;
  if (dataUrl) return dataUrl.replace(/data-refresh\/?$/, 'proof-log');

  return null;
}

function getProofLogHeaders() {
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  return {
    accept: 'application/json',
    ...(anonKey
      ? {
          apikey: anonKey,
          authorization: `Bearer ${anonKey}`,
        }
      : {}),
  };
}

function normalizeStatus(value: unknown): PaperProofSignal['status'] {
  if (value === 'won' || value === 'lost' || value === 'void') return value;
  return 'pending';
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSignal(value: unknown): PaperProofSignal | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<PaperProofSignal>;
  if (!row.id || !row.foundAt || !row.match || !row.score) return null;

  return {
    id: String(row.id),
    foundAt: String(row.foundAt),
    match: String(row.match),
    tournament: String(row.tournament ?? 'Score Hunter Board'),
    score: String(row.score),
    odds: finiteNumber(row.odds),
    signalStrength: finiteNumber(row.signalStrength),
    status: normalizeStatus(row.status),
    result: row.result ? String(row.result) : null,
    profitUnits: finiteNumber(row.profitUnits),
    note: String(row.note ?? 'Paper tracking signal.'),
  };
}

export function getSeedProofLog() {
  return (seedProofLog as PaperProofSignal[]).map((signal) => ({ ...signal }));
}

export async function fetchScoreHunterProofLog(): Promise<PaperProofSignal[]> {
  return (await fetchScoreHunterProofLogData()).signals;
}

export async function fetchScoreHunterProofLogData(): Promise<ProofLogData> {
  const apiUrl = getProofLogApiUrl();
  if (!apiUrl) return { source: 'seed', signals: getSeedProofLog() };

  try {
    const response = await fetch(apiUrl, { headers: getProofLogHeaders() });
    if (!response.ok) throw new Error(`Proof log request failed: ${response.status}`);
    const payload = (await response.json()) as ProofLogResponse;

    if (!Array.isArray(payload.signals)) {
      throw new Error('Proof log response missing signals array');
    }

    // Empty live results are valid. They should show as Supabase with 0 rows,
    // not Seed, because the endpoint was reached successfully.
    return {
      source: 'live',
      signals: payload.signals.map(normalizeSignal).filter((row): row is PaperProofSignal => Boolean(row)),
    };
  } catch (error) {
    console.warn('SlipIQ proof log unavailable, using seed paper log.', error);
    return { source: 'seed', signals: getSeedProofLog() };
  }
}
