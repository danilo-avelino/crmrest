-- Desfaz 20261122130000_cart_recovery (rodar à mão).
ALTER TABLE "carts" DROP COLUMN IF EXISTS "recovery_sent_at";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122130000_cart_recovery';
