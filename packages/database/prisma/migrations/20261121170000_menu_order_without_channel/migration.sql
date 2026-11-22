-- Pedido do cardápio próprio sem conversa (docs/cardapio-ia, F3-08): não tem canal. Só source MENU pode ficar sem canal.
ALTER TABLE "orders" ALTER COLUMN "channel_id" DROP NOT NULL;
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_required_for_platform" CHECK ("source" <> 'PLATFORM' OR "channel_id" IS NOT NULL);

-- Sem canal, o único (channel_id, external_order_id) não vale (NULL é distinto): a chave de idempotência do checkout
-- (external_order_id) é única por restaurante nos pedidos sem canal. Os das plataformas seguem com o único de sempre.
CREATE UNIQUE INDEX "orders_tenant_id_external_order_id_no_channel_key" ON "orders"("tenant_id", "external_order_id") WHERE "channel_id" IS NULL;
