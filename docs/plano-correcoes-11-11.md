# Plano de correções: atendimento do Grupo Moby Dick em 11/11/2026

Escrito em 12/11/2026, a partir da leitura de todas as conversas de 11/11 (00:00 a 23:55, horário de Teresina) do Grupo Moby Dick, Nippon, Terra Querida, Aglio Nero e Moby Cookies no banco de produção. As consultas de conferência estão no apêndice.

Pedido do usuário: corrigir os erros encontrados e padronizar que a IA consiga o máximo de telefones possível no chat do iFood. A mensagem automática de telefone no iFood (que saiu 7 vezes em 11/11) **não é erro**: é o comportamento que o usuário quer ampliar (item 1).

## Antes de começar

- **Há trabalho sem commit nos mesmos arquivos**: `ai-attendant.service.ts`, `ifood-attendance.service.ts`, `triage.service.ts`, `automation.ts` (função `callTeam`), `forecast.ts`, `ai-evaluation.service.ts` (espera de 1 h) e `personalities.ts` (`forecastProbablyOut`). Construir em cima dele, sem desfazer nada. Se esse trabalho for commitado antes, partir do commit.
- Toda mensagem nova para o cliente ou para o entregador entra em `AutomationMessages` ([packages/shared/src/personalities.ts](../packages/shared/src/personalities.ts)), **com um texto para cada uma das 6 personalidades** (CLAUDE.md §10). Marcador novo entra no `REQUIRED` de [packages/shared/test/settings.test.ts](../packages/shared/test/settings.test.ts).
- Nada de commit sem o pedido do usuário (CLAUDE.md §5).
- Testes: `pnpm --filter @dishdesk/api test` com o Node do fnm (ver a memória `node-version-fnm`); o vitest usa o Redis /15.

## Decisões do usuário (12/11/2026)

| # | Decisão | Resposta | Afeta |
|---|---|---|---|
| D1 | Recado do cliente para o entregador | Vai para o roadmap como **E47**, fora deste plano. | item 4 |
| D2 | Atendente online vale mais que o horário de funcionamento? | **Sim.** | item 8a |
| D3 | Onde pedir o telefone no iFood | **Só nos chats em que o cliente escreve.** Nada de pedido proativo em todo pedido. | item 1 |

## Ordem

0. Dados (sem código) → 1. Telefone no iFood → 2. Entregador marcado sozinho → 3. Menu do entregador com texto livre → 5. Limite da IA → 6. Promessas → 7. Falhas da IA → 8. Horário e loja respondendo pelo Gestor → 9. Pesquisa. O item 4 virou o E47 do roadmap.

---

## 0. Dados: marcar os entregadores sem a tag (sem código)

Em 11/11, quatro entregadores sem a tag Entregador caíram na IA como clientes e geraram 9 chamados à equipe. Pelo telefone do ASSIGN_DRIVER, são estes os contatos do Grupo Moby Dick:

| Entregador (iFood) | Contato no WhatsApp |
|---|---|
| Gustavo | Gusxta🤠 |
| Julio Marques | 🇨🇴 |
| Wallysson | Wallysson 🥶 |
| Francisco Ian | Ian Lima |
| Vanderson Pires da Silva | Vanderson Pires (o telefone não bateu; conferir) |

O usuário marca em Clientes, ou autoriza a escrita no banco de produção. Depois do item 2, isso passa a ser automático.

## 1. Telefone no chat do iFood

**Como está:** dos 729 contatos do iFood desses restaurantes, só 7 têm telefone. Em 11/11 foram 35 conversas com mensagem do cliente no iFood: o telefone foi pedido em 14 e informado em 5.

**Por quê:** com a IA ligada, o telefone só é pedido em dois casos.
- A IA pergunta quando passa para a equipe ("Exceção" no `systemPrompt` de [ai-attendant.service.ts](../apps/api/src/ai/ai-attendant.service.ts)).
- A coleta automática entra quando a IA já saiu da conversa (`PhoneCollectionService.afterInbound`, chamado em `IfoodAttendanceService.afterInbound` com a IA desligada).

Quando a IA resolve sozinha (Lara, Victor, Artur, Lucas, Denise, Danyelle, Esther, Moises...), ninguém pede o telefone.

**Mudança: pedir sempre, uma vez por atendimento, logo depois da primeira resposta da IA.**
- Em `AiAttendantService.reply`, quando todas as condições abaixo valerem, criar a mensagem automática `phone_collection` (texto `phoneRequest`, o "caso a conversa caia") logo depois da resposta e enviá-la no mesmo `dispatch`:
  - o canal da conversa é IFOOD;
  - o contato não tem telefone;
  - `state.phoneCollection` ainda não existe;
  - a resposta da IA não pediu o telefone (`asksPhone`).
- Gravar `phoneCollection: "awaiting_phone"` e agendar o `phone-reminder` como a coleta já faz (`PHONE_REMINDER_DELAY_MS`). O lembrete e a desistência (`phone_pending`) continuam como estão.
- A primeira resposta vem antes do pedido do telefone: o cliente recebe primeiro o que perguntou. Vale também para quem responde ao aviso do entregador ("ok", "tô descendo"), que hoje recebe só a resposta da IA.
- Para a IA não pedir duas vezes: no iFood, com `phoneCollection` já definido, o dado "O telefone do cliente não está no cadastro" sai dos DADOS, e com ele a "Exceção" do prompt.

**Telefone recebido com a IA ligada:** o `aiTakes` já cadastra o número (`phoneCollection.register`). Falta:
- Mensagem que é só o telefone (o texto sem o número fica vazio ou só com pontuação): mandar a automação `phone_confirmation`, gravar `phoneCollection: "phone_collected"` e não chamar a LLM.
- Telefone junto com outro assunto: a IA responde, com um dado a mais nos DADOS ("O cliente acabou de informar o telefone, já cadastrado: agradeça numa frase, sem repetir o número").

**Texto:** no iFood, manter o pedido voltado ao atendimento ("caso a conversa caia"), sem falar em cupom. Dois motivos:
- O cupom pede o opt-in de marketing registrado (`consents`), que a coleta não grava hoje.
- As regras do iFood para a loja falar com o cliente fora da plataforma precisam ser conferidas antes de qualquer texto de marketing.

**Testes** (em [apps/api/test/ifood-chat.test.ts](../apps/api/test/ifood-chat.test.ts) ou [ai.test.ts](../apps/api/test/ai.test.ts)):
- primeira resposta da IA no iFood, contato sem telefone → resposta + `phone_collection`;
- contato com telefone → só a resposta;
- segunda resposta do mesmo atendimento → sem novo pedido;
- resposta da IA que já pediu o telefone → sem a automação;
- mensagem só com o telefone → `phone_confirmation`, sem chamada à LLM;
- WhatsApp e Instagram → sem mudança.

**Decidido (D3, 12/11/2026):** o telefone só é pedido nos chats em que o cliente escreve. Não pedir proativamente em todo pedido do iFood (252 em 11/11, contra 35 conversas): isso contraria a decisão de 21/10 (a automação só fala no chat do iFood para os avisos de status), e o iFood pode punir a loja que pede dados a um cliente que não escreveu.

## 2. Entregador marcado sozinho pelo telefone do iFood

**Como está:** a tag Entregador é manual. 4 dos 15 entregadores de 11/11 não a tinham (item 0), e o Alex Alves (😃) só a ganhou à tarde.

**Mudança:** no `TriageService.step` ([triage.service.ts](../apps/api/src/automations/triage.service.ts)), antes do teste `contact.tags.includes(COURIER_TAG)`:
- Se o contato não tem a tag e o telefone dele (comparado em E.164, com `toE164`) aparece em algum `order_events.metadata.workerPhone` (código `ASSIGN_DRIVER`) dos últimos 30 dias, num dos restaurantes que o canal atende (`withOrderTenants`), então:
  - pôr a tag;
  - registrar o evento interno "Contato marcado como entregador: ele entrega pelo iFood (Fulano)";
  - seguir para o menu do entregador.
- Nunca tirar a tag sozinho.
- Conferir o formato real do `workerPhone` (em 11/11 vinha com 11 dígitos, sem o 55) e se a consulta no JSON precisa de índice (são cerca de 250 eventos por dia).

**Testes:** contato com o telefone de um ASSIGN_DRIVER recente → recebe a tag e o menu do entregador; ASSIGN_DRIVER de 40 dias atrás → não recebe; ASSIGN_DRIVER de um restaurante que o canal não atende → não recebe.

## 3. Menu do entregador que entende texto livre

**Como está:** o [courier-menu.service.ts](../apps/api/src/automations/courier-menu.service.ts) só aceita 1 a 4. Em 11/11, vários entregadores mandaram o pedido inteiro numa frase e receberam o menu de novo:

| Entregador | O que escreveu |
|---|---|
| Ronald | "8240 avisa q tá na portaria" |
| Ronald | "2141 pedi pra aguardar na entrada da lateral" |
| Vinicius (💭) | "0535 Entregue na portaria" (nunca avisou o cliente) |
| Erlan | "Avisa que tou aq na frente aq os vigia não recebem" |
| Josué | "1005" |

**Mudança:** no começo do atendimento (`event.newAttendance`) e em `awaiting_option`, ler a frase antes de mandar o menu. Sem LLM, com expressões fixas:
- **Número + portaria, recepção, deixei, entreguei, segurança** → "deixei na portaria" com esse número (vai direto para `notifyCustomer(..., "front_desk")`).
- **Número + cheguei, tô aqui, na frente, aguardando, avisa** → "cheguei" com esse número.
- **Só o número** → perguntar qual dos dois avisos. Mensagem nova em `AutomationMessages`, nas 6 personalidades, com `{pedido}`.
- O resto segue como hoje (menu; na segunda vez, a equipe).

O número segue a regra do `findOrder` (pedido de hoje ou de ontem, só iFood para os avisos).

**Testes:** cada frase da tabela acima vira o aviso certo; "Oi" mostra o menu; número inexistente segue o `askAgain`.

## 4. Recado do cliente para o entregador → E47 do roadmap

Saiu deste plano por decisão do usuário (D1): virou o **E47** do [ROADMAP.md](../ROADMAP.md) (Fase 2, "Entregadores"). A lista dos recados de 11/11 continua no fim deste arquivo, como base para o épico.

Enquanto o E47 não existir, o recado segue com a equipe: a IA passa a conversa (item 6), em vez de prometer que avisa.

## 5. Limite de respostas da IA também sem atendente

**Como está:** às 09:11 (restaurante fechado), a IA respondeu 21 vezes em 2 minutos a um robô que repetia "Para continuar, é só tocar em um dos botões acima" (conversa `01a1ca84`). Em `AiAttendantService.reply`, o limite `MAX_AI_REPLIES` só vale com atendente: `if (!attendance.available || (state.aiReplies ?? 0) < MAX_AI_REPLIES)`.

**Mudança:**
- **Repetição:** se as 3 últimas mensagens do cliente têm o mesmo texto, a IA não responde mais neste atendimento. A conversa espera a equipe como no `aiWaiting`, com o evento "Mensagens repetidas: a IA parou de responder".
- **Teto sem atendente:** um teto alto também sem atendente (ex.: 20 respostas por atendimento). Ao chegar nele, a IA para e a conversa espera a equipe, sem chamar a LLM.

**Testes:** 4 mensagens iguais seguidas → a 4ª não chama a LLM; 21 mensagens diferentes sem atendente → para no teto; com atendente, o `MAX_AI_REPLIES` segue como está.

## 6. Promessas que ninguém cumpre

**Como está:** em 3 conversas a IA prometeu passar um recado sem passar para a equipe (`handoff = false`):
- Igor, 20:23: "Já deixo anotado que o entregador deve buzinar ao chegar";
- Gabriela S., 17:07: "Anotado, vamos avisar o entregador...";
- Clara, 11:44: "Pode deixar que a equipe já registra a sua orientação".

**Mudança:**
- No `systemPrompt`, entre os casos de passar para a equipe: "pedir que você avise o entregador ou a cozinha (buzinar, interfonar, deixar na portaria, mudar o pedido): você não consegue passar recado". Quando o E47 existir, a regra muda para o recado ir direto ao entregador.
- Rede de segurança no código, como o `promised` que já existe para "sem atendentes": resposta com `handoff = false` que promete repassar algo passa a contar como handoff. Expressões: vou/vamos avisar, anotado, registr..., repass..., aviso o entregador.

**Testes:** a rede de segurança, com as três frases acima e com uma frase que não promete nada ("Pode deixar, bom apetite!").

## 7. A IA sem resposta (4 vezes em 11/11)

**Casos:**

| Hora | Conversa | O que veio antes | Uso registrado nos 3 minutos anteriores |
|---|---|---|---|
| 10:47 | `01a1c6c0` | robô do iFood Hits | duas chamadas ao Claude antes, em 10:46 |
| 12:02 | `01a1cb12` | Gusxta | nenhuma |
| 12:04 | `01a1cb12` | Gusxta | nenhuma |
| 22:37 | `01a1cd66` | Jairo | nenhuma |

Nenhum uso local (Ollama) foi registrado no dia: todas as 207 chamadas foram para o `claude-haiku-5-5`, que é a reserva. Ou seja, a principal (`AI_BASE_URL`) não respondeu o dia todo, e cada resposta esperou o prazo dela antes de ir para o Claude.

**Investigar primeiro (sem código):**
- Nos logs da `api` na Railway, procurar "IA sem resposta na conversa" e "LLM principal sem resposta" nesses horários para ver a causa.
- Conferir se a principal está ligada e qual é o `AI_TIMEOUT_MS`.

**Mudanças:**
- **Guardar a causa:** o evento `ai_fallback` passa a levar o erro no conteúdo (só a equipe vê), para a próxima análise não depender dos logs.
- **Fallback no iFood:** hoje o fallback manda o menu do WhatsApp no chat do iFood ("1 - Falar sobre um pedido 2 - Fazer um pedido 3 - Outro assunto", Jairo às 22:37). No ramo `failed` do `reply`, para conversa IFOOD, fazer o chamado do iFood (`ifoodHandoff`, com o pedido do telefone se faltar, e `callTeam`), como o `IfoodAttendanceService` faz sem a IA. Nos outros canais, o menu segue.
- **Hipótese a conferir nos logs:** `reason` tem `.max(200)` no `AttendantReply`. No Claude, o SDK tira o limite do schema e o `schema.parse` o confere depois, então um motivo com 201 caracteres derruba a resposta inteira. Se os logs mostrarem erro de validação, cortar o texto em 200 em vez de recusar.
- **Principal fora do ar:** se ela estiver desligada em produção, o usuário decide se a reserva vira a principal (variáveis na Railway).

**Testes:** falha da LLM no iFood → `ifoodHandoff`, sem o menu; falha no WhatsApp → menu, como hoje; o `ai_fallback` traz o erro.

## 8. "Restaurante fechado" com a equipe trabalhando, e IA respondendo junto com a loja

**8a. Horário (D2: sim, atendente online vale mais que o horário).**
- **O caso:** às 22:27 de quarta, a IA disse à Ilnara (Terra Querida, conversa `01a1cd5d`) "o restaurante já está fechado. Ele volta a atender amanhã às 11:00". O `waitingReason` gravado foi `closed`. A equipe respondeu às 22:28.
- **Não reproduzi:** o horário salvo hoje na Terra Querida é 16:00 às 23:00 na quarta, e `isOpenAt` com esse horário às 22:27 (`2026-11-12T01:27:24Z`) dá aberto. A cópia do iFood não atrasou (a mensagem foi copiada em 22:27:18). Pode ser que o horário salvo naquela hora fosse outro: Configurações não grava auditoria.
- **Passo 1:** teste em [packages/shared/test/settings.test.ts](../packages/shared/test/settings.test.ts) com esse horário e esse instante. Se passar, gravar o horário lido no evento `awaiting_agent`, para o próximo caso ter a prova.
- **Passo 2 (decidido em 12/11/2026):** em `attendanceOf` ([ai-forward.service.ts](../apps/api/src/ai/ai-forward.service.ts)), atendente online vale mais que o horário: verificar a presença antes do horário. Fazer o mesmo no aviso de fora do horário do menu (`TriageService.startMenu`).

**8b. Loja respondendo pelo Gestor do iFood não tira a IA.**
- **Os casos:** Moises (12:43 a 12:52) e Davi (12:57) receberam resposta da loja e da IA ao mesmo tempo. O Jairo, às 23:02, já tinha sido atendido pela loja ("Os pedidos foram trocados") e escreveu "Resolvido"; mesmo assim a IA chamou a equipe.
- **A causa:** em `IfoodChatService.sync` ([ifood-chat.service.ts](../apps/api/src/conversations/ifood-chat.service.ts)), a mensagem que a loja digita no widget (`typed`) só decide se começa um atendimento novo (`answering`). Ela não desliga a IA nem para o alarme.
- **Mudança:** mensagem digitada no widget logo depois de uma mensagem do cliente (dentro de `STORE_REPLY_MS`, a mesma regra do `answering`) conta como resposta da equipe: aplicar `teamRepliedUpdate` e `ai: "off"`.
- **Cuidado:** a mensagem automática da própria Nippon ("Seu pedido acaba de ser entregue 🥳...", 87 vezes em 11/11) chega sem mensagem do cliente antes e não pode contar.
- **No prompt:** cliente que diz que já resolveu ("resolvido", "já resolveram", "já comi") → despedida, sem handoff.

**Testes:** mensagem da loja logo depois da do cliente → IA desligada, alarme parado; mensagem automática da loja sem mensagem do cliente antes → nada muda.

## 9. Nota da pesquisa perdida

**O caso:** o Igor recebeu a pesquisa às 20:43 e mandou "só me avise quando sair se for possível" e, em seguida, "5". A primeira mensagem não tinha nota e o `SurveyService.handleAnswer` marcou `survey: "skipped"`; o "5" foi para a IA e a nota não foi gravada. Em 11/11 saíram 6 pesquisas no WhatsApp e só 2 notas foram gravadas (uma é do teste do usuário).

**Mudança:**
- Procurar a nota em qualquer linha do texto do evento (as mensagens seguidas chegam juntas).
- Uma mensagem sem nota não encerra a pesquisa: ela segue esperando a nota até o fim do atendimento ou até a segunda mensagem sem nota.
- A mensagem sem nota segue para o atendimento normal.

**Testes:** "texto" e depois "5" → nota 5 gravada; duas mensagens sem nota → pesquisa encerrada; "5" sozinho → como hoje.

## Fora deste plano

- **Lorena, 00:48:** a mensagem só foi copiada às ~09:12, quando o painel com o widget abriu; passou do `ATTEND_WITHIN_MS` e ninguém respondeu. Não é bug: a ponte depende do painel aberto.
- **Bella (12:45) e Marília (21:41):** a IA passou para a equipe e a conversa foi resolvida sem resposta pela Inbox. Pelo padrão do dia, o recado foi passado ao entregador pelo celular. O E47 resolve.

## Apêndice: consultas de conferência

Use o banco de produção só para leitura (`PGOPTIONS="-c default_transaction_read_only=on"`), com `set timezone='America/Fortaleza'`.

```sql
-- Telefone no iFood por dia: conversas com mensagem do cliente, pedidos de telefone e telefones obtidos.
with c as (
  select distinct c.id, c.contact_id from conversations c join channels ch on ch.id = c.channel_id
  join messages m on m.conversation_id = c.id
  where ch.type = 'IFOOD' and m.direction = 'INBOUND' and m.created_at >= :dia and m.created_at < :dia + 1)
select count(*) conversas,
  count(*) filter (where exists (select 1 from messages m where m.conversation_id = c.id and m.created_at >= :dia
    and (m.content->>'automation' in ('phone_collection', 'phone_reminder') or (m.content->>'aiReply' = 'true' and m.content->>'text' ilike '%telefone%')))) pedidos,
  count(*) filter (where exists (select 1 from messages m where m.conversation_id = c.id and m.created_at >= :dia and m.content->>'event' = 'phone_collected')) obtidos
from c;

-- Avisos do entregador enviados sozinhos (meta: subir) e avisos que a loja mandou à mão pelo Gestor (meta: cair).
select m.content->>'automation', count(*) from messages m
where m.created_at >= :dia and m.content->>'automation' in ('courier_arrival', 'courier_front_desk') group by 1;
select count(distinct m.conversation_id) from messages m join channels ch on ch.id = m.channel_id
where ch.type = 'IFOOD' and m.direction = 'OUTBOUND' and m.sent_by_user_id is null and not m.content ? 'automation'
  and m.created_at >= :dia and m.content->>'text' ~* 'entregador está (no local|a caminho)';

-- Falhas da IA e o erro gravado (depois do item 7).
select created_at, conversation_id, content from messages where content->>'event' = 'ai_fallback' and created_at >= :dia;
```

## Lista dos recados para o entregador em 11/11

| Hora | Loja | Pedido | Entregador | Recado do cliente | Como chegou ao entregador |
|---|---|---|---|---|---|
| 11:34 | Terra Querida | 6764 | Ronald | "pede pra ele deixar na recepção do theacolher, Unimed, tô indo buscar" | equipe copiou pelo celular |
| 11:44 | Terra Querida | 2245 | Julio Marques | "pode entregar na portaria" | não está claro: às 11:47 a equipe mandou "pode entregar na portaria, ela disse" ao Alex, que não era o entregador deste pedido |
| 11:44 | Terra Querida | 5825 | Alex Alves | "estou em atendimento, mas ele pode deixar no balcão da entrada. Precisa do código?" (código 8972) | equipe, pelo celular |
| 12:02 | Terra Querida | 3167 | Ronald | "acho que ele não interfonou, desculpa, tô descendo" | não aparece |
| 12:16 | Nippon | 6690 | Josué | "é uma escola, vou pedir pra receber" | equipe, pelo celular |
| 12:42 | Terra Querida | 7480 | Josué | "pode pedir pra ele interfonar? É portaria eletrônica" | não aparece |
| 12:43 | Terra Querida | 4762 | Ronald | "entregador está tendo dificuldade com a maquininha" (pagou por Pix no WhatsApp) | equipe, pelo celular |
| 12:45 | Terra Querida | 3344 | Julio Marques | "se precisar de código, o código é 0084" | não aparece |
| 12:50 | Terra Querida | 0192 | Alex Alves | "quando o entregador chegar, me avise" | loja, pelo Gestor ("entregador está no local") |
| 12:50 | Terra Querida | 7502 | Gustavo | "já está indo / avisei aqui" | equipe, pelo celular |
| 13:34 | Terra Querida | 7263 | Jose Augusto | "vocês vão avisar quando o entregador chegar?" | não precisou: entregue às 13:43 |
| 16:34 | Terra Querida | 0936 | Francisco Ian | "pediram código?" | loja, pelo Gestor |
| 16:50, 17:14, 17:26 | Nippon | 1950 | Erlan César | "pode pedir pro entregador deixar na recepção?" (3 vezes) | equipe: "o segurança não recebe" |
| 17:07 | Terra Querida | 9614 | Erlan César | "quando o motoboy chegar, pede pra ele buzinar e bater no portão, não tem campainha" | **ninguém**: a IA disse "vamos avisar" e não passou |
| 17:25 | Nippon | 4806 | Erlan César | "tem como deixar na portaria? Tem umas moças sentadas à mesa, pode deixar lá" | equipe, pela Inbox |
| 20:06 | WhatsApp (Erica) | 41857 (app) | não registrado | "teria como pedir pro entregador deixar aqui na loja? Ela vai pagar a entrega" | equipe, pela Inbox |
| 20:23 | Aglio Nero (WhatsApp) | 93 (Cardápio Web) | não registrado | "só pede para o entregador buzinar ao chegar" | **ninguém**: a IA disse "já deixo anotado" |
| 21:39 | Aglio Nero | 8150 | Yuri Rodrigues | "estou no hotel, o quarto é 202, quero avisar o motoboy" | não aparece |
| 22:02 | Nippon | 0801 | Ronald | "pode deixar na eclusa" | equipe, pelo celular |
| 22:32 | Terra Querida | 6202 | Vanderson Pires | pedido trocado: "pede pra ele vir buscar" | loja, pelo Gestor |
| 23:07 | WhatsApp (Rebecca) | 96 (Cardápio Web) | Vinicius | "qual código? Precisa de código?" | equipe, pelo celular: "não precisa do código" |
