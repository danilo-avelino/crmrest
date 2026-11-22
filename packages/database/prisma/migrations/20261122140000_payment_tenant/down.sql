-- Desfaz 20261122140000_payment_tenant (rodar à mão).
DROP FUNCTION IF EXISTS app.payment_tenant(uuid, text);
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122140000_payment_tenant';
