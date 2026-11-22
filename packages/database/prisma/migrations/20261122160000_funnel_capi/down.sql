-- Desfaz 20261122160000_funnel_capi (rodar à mão).
DROP FUNCTION IF EXISTS app.capi_pending_tenants();
DROP INDEX IF EXISTS public.funnel_events_capi_pending_idx;
ALTER TABLE public.funnel_events DROP COLUMN IF EXISTS capi_sent_at, DROP COLUMN IF EXISTS capi_error;
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122160000_funnel_capi';
