-- Desfaz 20261121130200_menu_cart_payment (rodar à mão; o Prisma não usa este arquivo).
DROP TABLE IF EXISTS payments, cart_items, carts CASCADE;
ALTER TABLE order_items DROP COLUMN IF EXISTS menu_item_id;
ALTER TABLE orders DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS scheduled_for, DROP COLUMN IF EXISTS payment_method;
DROP TYPE IF EXISTS "OrderSource", "CartStatus", "PaymentStatus";
DELETE FROM _prisma_migrations WHERE migration_name = '20261121130200_menu_cart_payment';
