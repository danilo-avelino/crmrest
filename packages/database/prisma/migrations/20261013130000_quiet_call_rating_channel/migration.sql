-- Chamado sem urgência (entregador com outro assunto): a conversa chama a equipe com um aviso sonoro discreto, sem o alarme.
ALTER TABLE "conversations" ADD COLUMN "awaiting_agent_quiet" BOOLEAN NOT NULL DEFAULT false;

-- Canal em que a avaliação foi dada (WhatsApp, Instagram, iFood), para filtrar os relatórios.
ALTER TABLE "ratings" ADD COLUMN "channel_type" "ChannelType";

UPDATE ratings r
SET channel_type = ch.type
FROM conversations cv
JOIN channels ch ON ch.id = cv.channel_id
WHERE cv.id = r.conversation_id;

ALTER TABLE "ratings" ALTER COLUMN "channel_type" SET NOT NULL;
