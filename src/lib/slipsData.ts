import { getTelegramUser } from './telegram';
import type { SlipLeg, SlipSummary, Tier } from '../types';

export interface SavedSlip {
  id: string;
  stake: number;
  legs: SlipLeg[];
  combined_odds: number;
  hit_rate: number;
  expected_value: number;
  tier: Tier;
  status: string;
  created_at: string;
}

type TelegramUserPayload = {
  id?: string | number;
  username?: string;
  first_name?: string;
};

function getSlipsApiUrl() {
  const explicitUrl = import.meta.env.VITE_SLIPIQ_SLIPS_API_URL as string | undefined;
  if (explicitUrl) return explicitUrl;

  const dataUrl = import.meta.env.VITE_SLIPIQ_DATA_API_URL as string | undefined;
  if (dataUrl) return dataUrl.replace(/data-refresh\/?$/, 'slips');

  return null;
}

function getUserPayload(): TelegramUserPayload {
  const user = getTelegramUser() as TelegramUserPayload | null;

  if (user?.id) {
    return {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
    };
  }

  return {
    id: 'web-preview-user',
    username: 'web_preview',
    first_name: 'Web Preview',
  };
}

export async function saveSlipToSupabase({ legs, stake, summary }: { legs: SlipLeg[]; stake: number; summary: SlipSummary }) {
  const apiUrl = getSlipsApiUrl();
  if (!apiUrl) throw new Error('Slip save API is not configured.');

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      telegramUser: getUserPayload(),
      legs,
      stake,
      summary,
    }),
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `Slip save failed: ${response.status}`);
  return payload.slip as SavedSlip;
}

export async function fetchSavedSlips() {
  const apiUrl = getSlipsApiUrl();
  if (!apiUrl) return [];

  const user = getUserPayload();
  const url = new URL(apiUrl);
  url.searchParams.set('telegram_id', String(user.id ?? 'web-preview-user'));

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error ?? `Saved slips request failed: ${response.status}`);
  return (payload.slips ?? []) as SavedSlip[];
}
