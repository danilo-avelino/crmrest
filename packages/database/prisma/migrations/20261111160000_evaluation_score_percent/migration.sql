-- Nota da IA ao atendimento passa de 1 a 5 para porcentagem (1 a 100), com critérios novos. As avaliações feitas até
-- aqui ficam marcadas como antigas e o sistema as ignora (relatórios, conversa, ficha do cliente e tag Em recuperação).
ALTER TABLE "conversation_evaluations" ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false;
UPDATE "conversation_evaluations" SET "legacy" = true;
