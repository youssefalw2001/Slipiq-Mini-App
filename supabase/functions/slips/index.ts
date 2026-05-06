import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type TelegramUser = {
  id?: number | string;
  username?: string;
  first_name?: string;
};

type SlipLeg = {
  id: string;
  label: string;
  sport: 'tennis' | 'nba';
  odds: number;
  modelProbability: number;
  eventId: string;
};

type SlipSummary = {
  combinedOdds: number;
  hitRate: number;
  expectedValue: number;
  payout?: number;
  tier: 'S' | 'A' | 'B' | 'C';
  daysToHit?: number | null;
};

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function getSupabase() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

function normalizedTelegramUser(input: unknown): Required<TelegramUser> {
  if (!input || typeof input !== 'object') {
    return { id: 'web-preview-user', username: 'web_preview', first_name: 'Web Preview' };
  }

  const user = input as TelegramUser;
  return {
    id: user.id ? String(user.id) : 'web-preview-user',
    username: user.username ?? 'telegram_user',
    first_name: user.first_name ?? 'SlipIQ User',
  };
}

function assertValidLegs(value: unknown): SlipLeg[] {
  if (!Array.isArray(value)) throw new Error('legs must be an array');
  if (value.length === 0) throw new Error('cannot save an empty slip');
  if (value.length > 8) throw new Error('too many legs for MVP slip save');

  return value.map((leg) => {
    if (!leg || typeof leg !== 'object') throw new Error('invalid leg');
    const item = leg as Partial<SlipLeg>;
    if (!item.id || !item.label || !item.sport || !item.eventId) throw new Error('leg missing required fields');
    if (!Number.isFinite(item.odds) || Number(item.odds) <= 1) throw new Error('leg odds must be greater than 1');
    if (!Number.isFinite(item.modelProbability) || Number(item.modelProbability) <= 0 || Number(item.modelProbability) >= 1) {
      throw new Error('leg modelProbability must be between 0 and 1');
    }

    return {
      id: String(item.id),
      label: String(item.label),
      sport: item.sport,
      odds: Number(item.odds),
      modelProbability: Number(item.modelProbability),
      eventId: String(item.eventId),
    };
  });
}

function assertValidSummary(value: unknown): SlipSummary {
  if (!value || typeof value !== 'object') throw new Error('summary is required');
  const summary = value as Partial<SlipSummary>;
  const tier = summary.tier === 'S' || summary.tier === 'A' || summary.tier === 'B' || summary.tier === 'C' ? summary.tier : 'C';

  return {
    combinedOdds: Number.isFinite(summary.combinedOdds) ? Number(summary.combinedOdds) : 1,
    hitRate: Number.isFinite(summary.hitRate) ? Number(summary.hitRate) : 0,
    expectedValue: Number.isFinite(summary.expectedValue) ? Number(summary.expectedValue) : 0,
    payout: Number.isFinite(summary.payout) ? Number(summary.payout) : 0,
    tier,
    daysToHit: Number.isFinite(summary.daysToHit) ? Number(summary.daysToHit) : null,
  };
}

async function upsertUser(supabase: ReturnType<typeof createClient>, telegramUser: Required<TelegramUser>) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: String(telegramUser.id),
        username: telegramUser.username,
        first_name: telegramUser.first_name,
      },
      { onConflict: 'telegram_id' },
    )
    .select('id, telegram_id, username, first_name, plan')
    .single();

  if (error) throw error;
  return data;
}

async function listSlips(supabase: ReturnType<typeof createClient>, telegramId: string) {
  const { data: user, error: userError } = await supabase.from('users').select('id').eq('telegram_id', telegramId).maybeSingle();
  if (userError) throw userError;
  if (!user) return [];

  const { data, error } = await supabase
    .from('slips')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = getSupabase();

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const telegramId = url.searchParams.get('telegram_id') ?? 'web-preview-user';
      const slips = await listSlips(supabase, telegramId);
      return Response.json({ slips }, { headers: corsHeaders });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const telegramUser = normalizedTelegramUser(body.telegramUser);
      const legs = assertValidLegs(body.legs);
      const summary = assertValidSummary(body.summary);
      const stake = Number.isFinite(body.stake) && Number(body.stake) >= 0 ? Number(body.stake) : 0;
      const user = await upsertUser(supabase, telegramUser);

      const { data, error } = await supabase
        .from('slips')
        .insert({
          user_id: user.id,
          stake,
          legs,
          combined_odds: summary.combinedOdds,
          hit_rate: summary.hitRate,
          expected_value: summary.expectedValue,
          tier: summary.tier,
          status: 'saved',
        })
        .select('*')
        .single();

      if (error) throw error;
      return Response.json({ ok: true, slip: data }, { headers: corsHeaders });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
