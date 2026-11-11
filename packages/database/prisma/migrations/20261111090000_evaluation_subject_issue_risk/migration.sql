-- Avaliação do atendimento pelo Jev: o assunto do contato, o que deu errado, de quem foi a falha (atendimento ou
-- operação) e a chance de perder o cliente. Nulos nas avaliações antigas. A tag automática "Em recuperação" sai daqui.

-- AlterTable
ALTER TABLE "conversation_evaluations"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "issue" TEXT,
  ADD COLUMN "fault" TEXT,
  ADD COLUMN "churn_risk" DOUBLE PRECISION;
