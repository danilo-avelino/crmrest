-- Prevenção de fraude: a análise do Jev sobre o pedido que as regras apontaram (risco e endereços parecidos confirmados).

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "alert_analysis" JSONB;
