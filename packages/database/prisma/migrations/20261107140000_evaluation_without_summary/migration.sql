-- A avaliação dos atendimentos passou para o Jev, que só responde valores estruturados: sem resumo. As antigas mantêm o delas.
ALTER TABLE "conversation_evaluations" ALTER COLUMN "summary" DROP NOT NULL;
