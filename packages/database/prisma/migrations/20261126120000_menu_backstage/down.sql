-- Desfaz 20261126120000_menu_backstage (rodar à mão). Perde cupons, usos, avisos, custos, preços promocionais e os
-- dados da biblioteca (foto, código, custo, descrição); as opções dos grupos ficam como estavam.
DROP TABLE IF EXISTS "menu_coupon_redemptions";
DROP TABLE IF EXISTS "menu_coupons";
DROP TABLE IF EXISTS "menu_notices";
ALTER TABLE "menu_options" DROP CONSTRAINT IF EXISTS "menu_options_choice_id_fkey";
DROP INDEX IF EXISTS "menu_options_tenant_id_choice_id_idx";
ALTER TABLE "menu_options" DROP COLUMN IF EXISTS "choice_id";
DROP TABLE IF EXISTS "menu_choices";
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "cost_cents", DROP COLUMN IF EXISTS "promo_price_cents";
DROP TYPE IF EXISTS "MenuCouponKind";
DROP TYPE IF EXISTS "MenuChoiceKind";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261126120000_menu_backstage';
