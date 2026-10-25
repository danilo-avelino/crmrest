-- Avaliações: por que o atendimento precisou da equipe (a IA classifica ao avaliar).

-- AlterTable
ALTER TABLE "conversation_evaluations" ADD COLUMN "team_reason" TEXT;
