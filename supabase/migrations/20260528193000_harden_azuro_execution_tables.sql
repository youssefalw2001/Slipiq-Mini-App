-- Harden Azuro / DGPredict execution infrastructure.
-- These tables may contain market audit rows, signed payload metadata, order IDs,
-- transaction hashes, and status material. They must not be writable or readable
-- from public browser/app clients.

revoke all privileges on table public.azuro_execution_audit_v1 from anon;
revoke all privileges on table public.azuro_execution_audit_v1 from authenticated;
revoke all privileges on table public.azuro_execution_audit_v1 from public;

revoke all privileges on table public.azuro_bet_orders_v1 from anon;
revoke all privileges on table public.azuro_bet_orders_v1 from authenticated;
revoke all privileges on table public.azuro_bet_orders_v1 from public;

alter table public.azuro_execution_audit_v1 enable row level security;
alter table public.azuro_bet_orders_v1 enable row level security;

-- Service-role jobs need read/write for audit ingestion and order status updates.
-- Keep execution infrastructure service-role only; do not grant anon/authenticated.
grant select, insert, update on table public.azuro_execution_audit_v1 to service_role;
grant select, insert, update on table public.azuro_bet_orders_v1 to service_role;

comment on table public.azuro_execution_audit_v1 is 'Internal Azuro/DGPredict coverage, odds, liquidity, and execution-readiness audit rows. Service-role only.';
comment on table public.azuro_bet_orders_v1 is 'Internal Azuro/DGPredict prepared/submitted order tracking. Service-role only. Do not store private keys.';
