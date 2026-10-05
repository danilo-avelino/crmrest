-- CreateTable
CREATE TABLE "ratings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "order_id" UUID,
    "score" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ratings_tenant_id_created_at_idx" ON "ratings"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ratings
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

-- Polling de pedidos do Cardápio Web: cada loja tem a própria chave de API, guardada (cifrada) no canal.
-- Esta função lista os canais sem contexto de tenant; cada um é lido depois com a RLS.
CREATE FUNCTION app.cardapio_web_channels()
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = 'CARDAPIO_WEB' AND c.status = 'CONNECTED' AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.cardapio_web_channels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cardapio_web_channels() TO app_user;
