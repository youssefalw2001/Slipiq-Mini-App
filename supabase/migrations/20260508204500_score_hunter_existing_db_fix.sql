-- Fix existing Score Hunter result tables that may have been created from
-- the first result-resolver migration before the proof-history safety fix.

alter table public.score_hunter_results
  drop constraint if exists score_hunter_results_opportunity_id_fkey;

alter table public.score_hunter_results
  alter column opportunity_id drop not null;

alter table public.score_hunter_results
  drop constraint if exists score_hunter_results_match_id_fkey;

alter table public.score_hunter_results
  add constraint score_hunter_results_match_id_fkey
  foreign key (match_id) references public.matches(id) on delete set null;

create index if not exists score_hunter_results_opportunity_idx on public.score_hunter_results(opportunity_id);
