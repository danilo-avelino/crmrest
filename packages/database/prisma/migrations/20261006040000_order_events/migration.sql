-- Etapa "pronto" do pedido e a linha do tempo de eventos da plataforma (tempos de preparo e previsão de saída).
ALTER TYPE "OrderStatus" ADD VALUE 'READY' AFTER 'PREPARING';

CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_events_order_id_external_event_id_key" ON "order_events"("order_id", "external_event_id");
CREATE INDEX "order_events_tenant_id_code_occurred_at_idx" ON "order_events"("tenant_id", "code", "occurred_at");
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON order_events TO app_user;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_events
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

