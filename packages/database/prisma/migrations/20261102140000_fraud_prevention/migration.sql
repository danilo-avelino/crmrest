-- Prevenção de fraude (E40): motivo do cancelamento, decisão do atendente, marca de fraude por endereço, conversa só
-- da equipe e importação dos cancelamentos antigos.

-- AlterTable
ALTER TABLE "orders"
    ADD COLUMN "canceled_at" TIMESTAMPTZ(3),
    ADD COLUMN "cancellation_reason" TEXT,
    ADD COLUMN "imported_at" TIMESTAMPTZ(3),
    ADD COLUMN "alert_at" TIMESTAMPTZ(3),
    ADD COLUMN "alert_decision" TEXT,
    ADD COLUMN "alert_decided_at" TIMESTAMPTZ(3),
    ADD COLUMN "alert_decided_by_id" UUID,
    ADD COLUMN "fraud_marked_at" TIMESTAMPTZ(3),
    ADD COLUMN "fraud_marked_by_id" UUID,
    ADD COLUMN "fraud_address_key" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "team_only" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "order_history_import" JSONB;

-- CreateIndex
CREATE INDEX "orders_tenant_id_fraud_address_key_idx" ON "orders"("tenant_id", "fraud_address_key");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_alert_decided_by_id_fkey" FOREIGN KEY ("alert_decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_fraud_marked_by_id_fkey" FOREIGN KEY ("fraud_marked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Os cancelamentos que já estão no banco entram no alerta com a data e o motivo que a plataforma informou.
UPDATE "orders" o
SET "canceled_at" = e."occurred_at",
    "cancellation_reason" = COALESCE(
      NULLIF(btrim(e."metadata" ->> 'CANCEL_REASON'), ''),
      NULLIF(btrim(e."metadata" ->> 'CANCEL_CODE_DESCRIPTION'), ''),
      NULLIF(btrim(o."raw" ->> 'cancellation_reason'), '')
    )
FROM "order_events" e
WHERE e."order_id" = o."id" AND e."code" = 'CANCELLED' AND o."status" = 'CANCELED';
