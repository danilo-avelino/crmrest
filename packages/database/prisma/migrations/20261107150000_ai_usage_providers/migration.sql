-- Gastos com IA separados por quem respondeu: o Claude, o Jev e a LLM local (só tokens, sem custo). As linhas que já
-- existiam são todas do Claude.
-- O Jev da defesa da API não serve a um restaurante: o gasto dele fica em platform_ai_usages, que qualquer um grava
-- (a defesa roda sem restaurante no contexto) e só a plataforma lê. Ninguém altera nem apaga pela aplicação.

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('CLAUDE', 'JEV', 'LOCAL');

-- AlterTable
ALTER TABLE "ai_usages" ADD COLUMN "provider" "AiProvider" NOT NULL DEFAULT 'CLAUDE';
ALTER TABLE "ai_usages" ALTER COLUMN "provider" DROP DEFAULT;

-- CreateTable
CREATE TABLE "platform_ai_usages" (
    "id" UUID NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micro_usd" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_ai_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_ai_usages_created_at_idx" ON "platform_ai_usages"("created_at");

ALTER TABLE platform_ai_usages ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_insert ON platform_ai_usages FOR INSERT WITH CHECK (true);
CREATE POLICY platform_select ON platform_ai_usages FOR SELECT USING (app.is_super_admin());
