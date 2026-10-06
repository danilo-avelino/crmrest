-- Conversa chamando o atendente: a automação passou à equipe e ninguém respondeu ainda (alarme e topo da Inbox).
ALTER TABLE "conversations" ADD COLUMN "awaiting_agent_since" TIMESTAMPTZ(3);
