-- Desfaz 20261121161000_funnel_events (rodar à mão; o Prisma não usa este arquivo).
DROP TABLE IF EXISTS funnel_events CASCADE;
DROP TYPE IF EXISTS "FunnelStage", "FunnelChannel";
DELETE FROM _prisma_migrations WHERE migration_name = '20261121161000_funnel_events';
