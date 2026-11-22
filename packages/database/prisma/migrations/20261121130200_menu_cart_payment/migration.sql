-- Sacola, pagamento e o pedido do cardápio próprio (docs/cardapio-ia, F2-02, PLANO C5).
-- O Order só nasce no checkout e usa o OrderStatus que já existe; orders.source separa o cardápio próprio
-- dos canais integrados sem um ChannelType novo.

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('PLATFORM', 'MENU');

-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('DRAFT', 'AWAITING_CONFIRMATION', 'CHECKED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'REFUNDED', 'CANCELED');

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "menu_item_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payment_method" TEXT,
ADD COLUMN     "scheduled_for" TIMESTAMPTZ(3),
ADD COLUMN     "source" "OrderSource" NOT NULL DEFAULT 'PLATFORM';

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID,
    "session_token" TEXT,
    "conversation_id" UUID,
    "order_id" UUID,
    "status" "CartStatus" NOT NULL DEFAULT 'DRAFT',
    "delivery_address" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "size_id" UUID,
    "halves" UUID[] DEFAULT ARRAY[]::UUID[],
    "options" JSONB NOT NULL DEFAULT '[]',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cart_id" UUID,
    "order_id" UUID,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "txid" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "carts_session_token_key" ON "carts"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "carts_order_id_key" ON "carts"("order_id");

-- CreateIndex
CREATE INDEX "carts_tenant_id_contact_id_status_idx" ON "carts"("tenant_id", "contact_id", "status");

-- CreateIndex
CREATE INDEX "carts_tenant_id_status_updated_at_idx" ON "carts"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "cart_items_tenant_id_cart_id_idx" ON "cart_items"("tenant_id", "cart_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_status_expires_at_idx" ON "payments"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_txid_key" ON "payments"("provider", "txid");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_size_id_fkey" FOREIGN KEY ("size_id") REFERENCES "menu_item_sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sacola sempre de alguém: do contato ou da sessão do visitante.
ALTER TABLE "carts" ADD CONSTRAINT "carts_owner_check" CHECK (contact_id IS NOT NULL OR session_token IS NOT NULL);
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_check" CHECK (quantity > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK (amount_cents > 0);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON carts
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cart_items
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
