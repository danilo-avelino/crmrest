-- Desfaz 20261122150000_pending_pix (rodar à mão).
DROP FUNCTION IF EXISTS app.pending_pix_payments(integer);
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122150000_pending_pix';
