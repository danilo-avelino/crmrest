-- Fase 4: módulo Atendimento com IA e a avaliação dos atendimentos pela IA (E29).

-- AlterEnum
ALTER TYPE "ModuleKey" ADD VALUE 'AI';

-- CreateTable
CREATE TABLE "conversation_evaluations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "user_id" UUID,
    "resolved" BOOLEAN NOT NULL,
    "satisfied" BOOLEAN,
    "score" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_evaluations_tenant_id_created_at_idx" ON "conversation_evaluations"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "conversation_evaluations_conversation_id_idx" ON "conversation_evaluations"("conversation_id");

-- AddForeignKey
ALTER TABLE "conversation_evaluations" ADD CONSTRAINT "conversation_evaluations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_evaluations" ADD CONSTRAINT "conversation_evaluations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE conversation_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_evaluations
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
