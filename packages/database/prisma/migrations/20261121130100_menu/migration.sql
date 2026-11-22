-- Cardápio digital com IA (docs/cardapio-ia, F2-01): cardápio, categorias, itens, tamanhos, complementos,
-- disponibilidade por dia e hora e os campos que a IA usa. Valores em centavos inteiros.

-- CreateEnum
CREATE TYPE "HalfPricingRule" AS ENUM ('MAX', 'AVERAGE', 'SUM');

-- CreateTable
CREATE TABLE "menus" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allows_half" BOOLEAN NOT NULL DEFAULT false,
    "half_pricing" "HalfPricingRule" NOT NULL DEFAULT 'MAX',

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_cents" INTEGER,
    "photo_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sold_out" BOOLEAN NOT NULL DEFAULT false,
    "allows_half" BOOLEAN NOT NULL DEFAULT true,
    "ingredients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serves_people" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_sizes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "menu_item_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_option_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sold_out" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "menu_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_option_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_item_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_availabilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "item_id" UUID,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "menu_availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_pairings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "paired_item_id" UUID NOT NULL,

    CONSTRAINT "menu_item_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "menus_tenant_id_key" ON "menus"("tenant_id");

-- CreateIndex
CREATE INDEX "menu_categories_tenant_id_menu_id_sort_order_idx" ON "menu_categories"("tenant_id", "menu_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_items_tenant_id_category_id_sort_order_idx" ON "menu_items"("tenant_id", "category_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_item_sizes_tenant_id_item_id_idx" ON "menu_item_sizes"("tenant_id", "item_id");

-- CreateIndex
CREATE INDEX "menu_option_groups_tenant_id_menu_id_idx" ON "menu_option_groups"("tenant_id", "menu_id");

-- CreateIndex
CREATE INDEX "menu_options_tenant_id_group_id_idx" ON "menu_options"("tenant_id", "group_id");

-- CreateIndex
CREATE INDEX "menu_item_option_groups_tenant_id_group_id_idx" ON "menu_item_option_groups"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_option_groups_item_id_group_id_key" ON "menu_item_option_groups"("item_id", "group_id");

-- CreateIndex
CREATE INDEX "menu_availabilities_tenant_id_category_id_idx" ON "menu_availabilities"("tenant_id", "category_id");

-- CreateIndex
CREATE INDEX "menu_availabilities_tenant_id_item_id_idx" ON "menu_availabilities"("tenant_id", "item_id");

-- CreateIndex
CREATE INDEX "menu_item_pairings_tenant_id_paired_item_id_idx" ON "menu_item_pairings"("tenant_id", "paired_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_pairings_item_id_paired_item_id_key" ON "menu_item_pairings"("item_id", "paired_item_id");

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "menus_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_sizes" ADD CONSTRAINT "menu_item_sizes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_sizes" ADD CONSTRAINT "menu_item_sizes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_option_groups" ADD CONSTRAINT "menu_option_groups_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_options" ADD CONSTRAINT "menu_options_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_options" ADD CONSTRAINT "menu_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "menu_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_option_groups" ADD CONSTRAINT "menu_item_option_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "menu_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_availabilities" ADD CONSTRAINT "menu_availabilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_availabilities" ADD CONSTRAINT "menu_availabilities_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_availabilities" ADD CONSTRAINT "menu_availabilities_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_pairings" ADD CONSTRAINT "menu_item_pairings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_pairings" ADD CONSTRAINT "menu_item_pairings_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_pairings" ADD CONSTRAINT "menu_item_pairings_paired_item_id_fkey" FOREIGN KEY ("paired_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Disponibilidade é de uma categoria ou de um item, nunca dos dois.
ALTER TABLE "menu_availabilities" ADD CONSTRAINT "menu_availabilities_target_check"
  CHECK ((category_id IS NULL) <> (item_id IS NULL));
ALTER TABLE "menu_availabilities" ADD CONSTRAINT "menu_availabilities_range_check"
  CHECK (weekday BETWEEN 0 AND 6 AND start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 1 AND 1440 AND start_minute <> end_minute);

ALTER TABLE menus ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menus
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_categories
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_items
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_item_sizes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_sizes
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_option_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_option_groups
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_options
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_item_option_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_option_groups
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_availabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_availabilities
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE menu_item_pairings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_pairings
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
