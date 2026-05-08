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

interface ProofLogResponse {
  signals?: PaperProofSignal[];
}

function getProofLogApiUrl() {
  const explicitUrl = import.meta.env.VITE_SLIPIQ_PROOF_LOG_API_URL as string | undefined;
  if (explicitUrl) return explicitUrl;

  const dataUrl = import.meta.env.VITE_SLIPIQ_DATA_API_URL as string | undefined;
  if (dataUrl) return dataUrl.replace(/data-refresh\/?$/, 'proof-log');

  return null;
}

function normalizeStatus(value: unknown): PaperProofSignal['status'] {
  if (value === 'won' || value === 'lost' || value === 'void') return value;
  return 'pending';
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
    odds: Number.isFinite(row.odds) ? Number(row.odds) : 0,
    signalStrength: Number.isFinite(row.signalStrength) ? Number(row.signalStrength) : 0,
    status: normalizeStatus(row.status),
    result: row.result ? String(row.result) : null,
    profitUnits: Number.isFinite(row.profitUnits) ? Number(row.profitUnits) : 0,
    note: String(row.note ?? 'Paper tracking signal.'),
  };
}

export function getSeedProofLog() {
  return (seedProofLog as PaperProofSignal[]).map((signal) => ({ ...signal }));
}

export async function fetchScoreHunterProofLog(): Promise<PaperProofSignal[]> {
  const apiUrl = getProofLogApiUrl();
  if (!apiUrl) return getSeedProofLog();

  try {
    const response = await fetch(apiUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Proof log request failed: ${response.status}`);
    const payload = (await response.json()) as ProofLogResponse;
    const rows = (payload.signals ?? []).map(normalizeSignal).filter((row): row is PaperProofSignal => Boolean(row));
    return rows.length > 0 ? rows : getSeedProofLog();
  } catch (error) {
    console.warn('SlipIQ proof log unavailable, using seed paper log.', error);
    return getSeedProofLog();
  }
}
