-- Gastos com a IA paga (o Claude): tokens e custo de cada chamada, por restaurante. O painel da plataforma soma por mês.

-- CreateTable
CREATE TABLE "ai_usages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micro_usd" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usages_tenant_id_created_at_idx" ON "ai_usages"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_usages" ADD CONSTRAINT "ai_usages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE ai_usages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_usages
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
