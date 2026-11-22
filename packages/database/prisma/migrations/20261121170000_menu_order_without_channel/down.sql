-- Desfaz 20261121170000_menu_order_without_channel (rodar à mão; o Prisma não usa este arquivo).
-- Falha se já houver pedido sem canal: apague ou ligue esses pedidos a um canal antes.
DROP INDEX IF EXISTS "orders_tenant_id_external_order_id_no_channel_key";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_channel_required_for_platform";
ALTER TABLE "orders" ALTER COLUMN "channel_id" SET NOT NULL;
DELETE FROM _prisma_migrations WHERE migration_name = '20261121170000_menu_order_without_channel';
