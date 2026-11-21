-- Resposta pelo celular da loja conta como resposta da equipe; atendimento em que a equipe foi chamada e não respondeu não é "só IA".
ALTER TABLE "conversation_evaluations" ADD COLUMN "by_phone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_only_attendances" ADD COLUMN "handed_off" BOOLEAN NOT NULL DEFAULT false;

-- Registros antigos: pega a chamada à equipe nos 3 dias antes do registro (mesma janela usada na medição de 20/11).
UPDATE "ai_only_attendances" a SET "handed_off" = true
WHERE EXISTS (
  SELECT 1 FROM messages h
  WHERE h.conversation_id = a.conversation_id AND h.type = 'SYSTEM' AND h.content->>'event' = 'handoff'
    AND h.created_at < a.created_at AND h.created_at > a.created_at - interval '3 days'
);

-- Resposta pelo celular na mesma janela: também era a equipe, então fica fora da conta de "só IA".
UPDATE "ai_only_attendances" a SET "handed_off" = true
WHERE NOT "handed_off" AND EXISTS (
  SELECT 1 FROM messages m
  WHERE m.conversation_id = a.conversation_id AND m.direction = 'OUTBOUND' AND m.content->>'fromPhone' = 'true'
    AND m.created_at < a.created_at AND m.created_at > a.created_at - interval '3 days'
);
