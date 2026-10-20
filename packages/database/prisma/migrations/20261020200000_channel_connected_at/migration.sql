-- Quando a integração foi conectada: o que aconteceu antes (pedidos que o iFood ainda entrega ao conectar, histórico
-- do chat do iFood) entra no Dish Desk, mas não aciona automações (avisos de pedido, respostas automáticas).

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "connected_at" TIMESTAMPTZ(3);

-- Lojas do iFood já conectadas: o histórico do chat importado até aqui fica de fora das automações.
UPDATE "channels" SET "connected_at" = now() WHERE "type" = 'IFOOD' AND "status" = 'CONNECTED';
