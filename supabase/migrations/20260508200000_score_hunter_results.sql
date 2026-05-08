-- Score Hunter forward-test result log.
-- Run with Supabase migrations before deploying result-resolver.

create table if not exists public.score_hunter_results (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null unique references public.opportunities(id) on delete cascade,
  match_id text references public.matches(id) on delete cascade,
  strategy text not null default 'score_hunter_candidate',
  selected_score text not null,
  actual_score text,
  status text not null default 'pending' check (status in ('pending', 'won', 'lost', 'void')),
  profit_units numeric not null default 0,
  note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists score_hunter_results_status_idx on public.score_hunter_results(status, updated_at desc);
create index if not exists score_hunter_results_match_idx on public.score_hunter_results(match_id, selected_score);

drop trigger if exists touch_score_hunter_results_updated_at on public.score_hunter_results;
create trigger touch_score_hunter_results_updated_at before update on public.score_hunter_results for each row execute function public.touch_updated_at();
