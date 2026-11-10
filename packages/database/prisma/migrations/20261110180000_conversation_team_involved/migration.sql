-- Inbox: a aba Ativos mostra só as conversas em que a equipe foi chamada ou atuou; as que só tiveram automação ficam na
-- aba Automáticos. A coluna diz se a equipe atuou no atendimento (respondeu, escreveu uma nota, mudou o status ou a
-- conversa é de um caso que só a equipe atende) e zera quando a conversa é resolvida.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "team_involved" BOOLEAN NOT NULL DEFAULT false;

-- As conversas em aberto que já tinham a equipe continuam na aba Ativos.
UPDATE "conversations" c
SET "team_involved" = true
WHERE c."status" <> 'RESOLVED'
  AND (
    -- A equipe respondeu ou escreveu uma nota (pelo Dish Desk ou pelo WhatsApp do celular).
    EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."conversation_id" = c."id"
        AND (m."sent_by_user_id" IS NOT NULL OR (m."content"->>'fromPhone') = 'true')
    )
    -- Funcionário: conversa comum com a equipe, sem automação.
    OR EXISTS (SELECT 1 FROM "contacts" ct WHERE ct."id" = c."contact_id" AND 'Funcionário' = ANY (ct."tags"))
    -- Cliente que escreveu no chat do iFood (ou num canal sem automação): só a equipe atende.
    OR EXISTS (
      SELECT 1 FROM "messages" m JOIN "channels" ch ON ch."id" = m."channel_id"
      WHERE m."conversation_id" = c."id" AND m."direction" = 'INBOUND' AND ch."type" NOT IN ('WHATSAPP', 'INSTAGRAM')
    )
  );
