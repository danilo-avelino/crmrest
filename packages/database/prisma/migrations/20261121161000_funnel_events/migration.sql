-- Funil de vendas do cardápio (docs/cardapio-ia, F7-01, PLANO C9). Separado de site_visits (landing).

-- CreateEnum
CREATE TYPE "FunnelStage" AS ENUM ('PAGE_VIEW', 'VIEW_CONTENT', 'SEARCH', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'ADD_PAYMENT_INFO', 'PURCHASE');

-- CreateEnum
CREATE TYPE "FunnelChannel" AS ENUM ('WEB', 'WHATSAPP');

-- CreateTable
CREATE TABLE "funnel_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "stage" "FunnelStage" NOT NULL,
    "channel" "FunnelChannel" NOT NULL,
    "session_id" TEXT,
    "contact_id" UUID,
    "conversation_id" UUID,
    "cart_id" UUID,
    "order_id" UUID,
    "menu_item_id" UUID,
    "value_cents" INTEGER,
    "attribution" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funnel_events_tenant_id_event_id_key" ON "funnel_events"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "funnel_events_tenant_id_created_at_idx" ON "funnel_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "funnel_events_tenant_id_stage_created_at_idx" ON "funnel_events"("tenant_id", "stage", "created_at");

-- AddForeignKey
ALTER TABLE "funnel_events" ADD CONSTRAINT "funnel_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON funnel_events
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
