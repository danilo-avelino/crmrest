-- Abas novas do Cardápio (cardapio-backstage.html, 26/11/2026): custo e preço promocional do item (planilha e
-- relatório), biblioteca de opções (N1), cupons (N4) e avisos no cardápio (N5).

-- CreateEnum
CREATE TYPE "MenuChoiceKind" AS ENUM ('HALF', 'SIZE', 'DRINK', 'EXTRA');

-- CreateEnum
CREATE TYPE "MenuCouponKind" AS ENUM ('FIXED', 'PERCENT', 'FREE_DELIVERY');

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "cost_cents" INTEGER,
ADD COLUMN     "promo_price_cents" INTEGER;

-- CreateTable
CREATE TABLE "menu_choices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MenuChoiceKind" NOT NULL DEFAULT 'EXTRA',
    "code" TEXT,
    "cost_cents" INTEGER,
    "description" TEXT,
    "photo_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "in_stock" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_choices_pkey" PRIMARY KEY ("id")
);

-- Biblioteca a partir das opções que já existem, uma por uma (decisão do usuário, 26/11/2026): cada opção vira uma
-- opção da biblioteca com o mesmo id, ligada só ao seu grupo. Nada é juntado; o tipo sai do nome da opção e do grupo.
INSERT INTO "menu_choices" ("id", "tenant_id", "menu_id", "name", "kind", "active", "in_stock", "created_at", "updated_at")
SELECT o."id", o."tenant_id", g."menu_id", o."name",
       (CASE
          WHEN o."name" ILIKE 'meia %' OR o."name" ILIKE 'meio %' OR o."name" ILIKE '1/2 %' OR o."name" ILIKE '½%' OR g."name" ILIKE '%sabor%' OR g."name" ILIKE '%meio a meio%' THEN 'HALF'
          WHEN g."name" ILIKE '%tamanho%' THEN 'SIZE'
          WHEN g."name" ILIKE '%bebida%' OR g."name" ILIKE '%refri%' OR g."name" ILIKE '%suco%' THEN 'DRINK'
          ELSE 'EXTRA'
        END)::"MenuChoiceKind",
       o."active", NOT o."sold_out", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "menu_options" o
JOIN "menu_option_groups" g ON g."id" = o."group_id";

-- AlterTable
ALTER TABLE "menu_options" ADD COLUMN "choice_id" UUID;
UPDATE "menu_options" SET "choice_id" = "id";
ALTER TABLE "menu_options" ALTER COLUMN "choice_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "menu_coupons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" "MenuCouponKind" NOT NULL,
    "value_cents" INTEGER NOT NULL DEFAULT 0,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "max_discount_cents" INTEGER,
    "starts_on" TEXT,
    "ends_on" TEXT,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "delivery" BOOLEAN NOT NULL DEFAULT true,
    "pickup" BOOLEAN NOT NULL DEFAULT true,
    "usage_limit" INTEGER,
    "min_order_cents" INTEGER NOT NULL DEFAULT 0,
    "new_customers_only" BOOLEAN NOT NULL DEFAULT false,
    "once_per_customer" BOOLEAN NOT NULL DEFAULT false,
    "payment_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_coupons_pkey" PRIMARY KEY ("id"),
    -- O checkout compara o código em maiúsculas e sem espaços.
    CONSTRAINT "menu_coupons_code_format" CHECK ("code" IS NULL OR ("code" = upper(btrim("code")) AND "code" <> '')),
    CONSTRAINT "menu_coupons_percent_range" CHECK ("percent" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "menu_coupon_redemptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "discount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_notices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "photo_url" TEXT,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "ends_on" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paused_by" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_choices_tenant_id_menu_id_idx" ON "menu_choices"("tenant_id", "menu_id");

-- CreateIndex
CREATE INDEX "menu_coupons_tenant_id_idx" ON "menu_coupons"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_coupons_tenant_id_code_key" ON "menu_coupons"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "menu_coupon_redemptions_order_id_key" ON "menu_coupon_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "menu_coupon_redemptions_tenant_id_coupon_id_idx" ON "menu_coupon_redemptions"("tenant_id", "coupon_id");

-- CreateIndex
CREATE INDEX "menu_coupon_redemptions_tenant_id_contact_id_idx" ON "menu_coupon_redemptions"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "menu_notices_tenant_id_sort_order_idx" ON "menu_notices"("tenant_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_options_tenant_id_choice_id_idx" ON "menu_options"("tenant_id", "choice_id");

-- AddForeignKey
ALTER TABLE "menu_options" ADD CONSTRAINT "menu_options_choice_id_fkey" FOREIGN KEY ("choice_id") REFERENCES "menu_choices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_choices" ADD CONSTRAINT "menu_choices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_choices" ADD CONSTRAINT "menu_choices_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_coupons" ADD CONSTRAINT "menu_coupons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_coupon_redemptions" ADD CONSTRAINT "menu_coupon_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_coupon_redemptions" ADD CONSTRAINT "menu_coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "menu_coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_coupon_redemptions" ADD CONSTRAINT "menu_coupon_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_coupon_redemptions" ADD CONSTRAINT "menu_coupon_redemptions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_notices" ADD CONSTRAINT "menu_notices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A opção do grupo e a da biblioteca são sempre do mesmo restaurante.
ALTER TABLE menu_choices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_choices
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_coupons
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_coupon_redemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_coupon_redemptions
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_notices
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
