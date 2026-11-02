-- A avaliação pela IA agora só roda quando a equipe respondeu ao cliente. O atendimento sem equipe vira só um registro,
-- sem chamada de IA: conta no relatório e marca onde o próximo atendimento da conversa começa.

-- CreateTable
CREATE TABLE "ai_only_attendances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_only_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_only_attendances_tenant_id_created_at_idx" ON "ai_only_attendances"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_only_attendances_conversation_id_idx" ON "ai_only_attendances"("conversation_id");

-- AddForeignKey
ALTER TABLE "ai_only_attendances" ADD CONSTRAINT "ai_only_attendances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_only_attendances" ADD CONSTRAINT "ai_only_attendances_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE ai_only_attendances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_only_attendances
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
