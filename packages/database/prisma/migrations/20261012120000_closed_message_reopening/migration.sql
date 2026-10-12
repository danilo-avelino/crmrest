-- A mensagem de fora do horário passa a dizer quando o atendimento volta ({retorno}). Restaurante que salvou o horário
-- com o texto padrão de uma personalidade recebe o texto novo; quem escreveu o próprio texto fica como está.
UPDATE "tenants" t
SET "settings" = jsonb_set(t."settings", '{businessHours,closedMessage}', to_jsonb(texts.new))
FROM (VALUES
  ('Olá! 👋 No momento estamos fechados. Assim que abrirmos, respondemos sua mensagem.',
   'Olá! 👋 No momento estamos fechados. Voltamos a atender {retorno} e, assim que abrirmos, respondemos sua mensagem.'),
  ('Olá. No momento estamos fora do horário de atendimento. Sua mensagem será respondida assim que retomarmos as atividades.',
   'Olá. No momento estamos fora do horário de atendimento. Retomaremos as atividades {retorno}, quando sua mensagem será respondida.'),
  ('Oiê! 🌙 A gente tá fechadinho agora, mas assim que abrir te respondemos, combinado? 😉',
   'Oiê! 🌙 A gente tá fechadinho agora, mas volta {retorno} e te responde assim que abrir, combinado? 😉'),
  ('Opa! Agora a gente tá fechado 😴 Mas relaxa: assim que abrir, a gente te responde.',
   'Opa! Agora a gente tá fechado 😴 Mas relaxa: a gente volta {retorno} e te responde assim que abrir.'),
  ('Olá! 🧡 Agora estamos fechados, descansando para te receber da melhor forma. Assim que abrirmos, respondemos sua mensagem com todo carinho.',
   'Olá! 🧡 Agora estamos fechados, descansando para te receber da melhor forma. Voltamos {retorno} e respondemos sua mensagem com todo carinho.'),
  ('Estamos fechados no momento. Respondemos assim que abrirmos.',
   'Estamos fechados no momento. Voltamos {retorno} e respondemos assim que abrirmos.')
) AS texts(old, new)
WHERE t."settings"->'businessHours'->>'closedMessage' = texts.old;
