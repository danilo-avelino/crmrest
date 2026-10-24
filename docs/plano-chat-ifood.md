# Plano — automação do chat do iFood

Análise dos chats do iFood de 21/10/2026 (produção), com as decisões que o Danilo tomou no mesmo dia. Escrito para quem vai implementar. As decisões estão na seção 3; o que ficou para depois, na seção 5.

Regras do projeto que pesam aqui (CLAUDE.md):

- Mensagem automática nova entra em `AutomationMessages` ([packages/shared/src/personalities.ts](../packages/shared/src/personalities.ts)) com texto para as 6 personalidades; marcador novo entra no `REQUIRED` de [packages/shared/test/settings.test.ts](../packages/shared/test/settings.test.ts) (regra 10).
- Tela nova ou alterada segue o [Dish Desk Design.html](../Dish%20Desk%20Design.html) (regra 8). Botão novo com guard de duplo clique e "Carregando…" (regra 6).
- Nada de commit, push ou deploy sem pedido (regra 5).
- `@dishdesk/shared` é consumido pelo `dist`: rodar `pnpm --filter @dishdesk/shared build` antes dos testes da API. No Bash, usar o Node 24 do fnm.

## 1. O que aconteceu em 21/10

Lojas: Nippon, Terra Querida e Aglio Nero (canais iFood do restaurante Danilo Lanches). As três entregam com frota própria pelo Foody Delivery, que manda ao iFood os eventos `ASSIGN_DRIVER`, `GOING_TO_ORIGIN`, `DISPATCHED` e `ARRIVED_AT_DESTINATION` (64 chegadas ao endereço no dia).

| | 21/10 |
|---|---|
| Conversas do iFood com movimento | 75 |
| … com mensagem do cliente | 15 (40 mensagens) |
| … só com mensagens do lado da loja | 60 (a mensagem automática "Seu pedido acaba de ser entregue 🥳…", que o sistema da loja manda na conclusão, apareceu 57 vezes no dia) |
| Chamados da automação (handoff) | 14 |
| … em que alguém da loja respondeu no chat depois | 4 (2 pela Inbox, 2 pelo Gestor de Pedidos) |
| Mensagens da equipe pela Inbox / digitadas fora dela | 2 / cerca de 25 |
| Pedidos de telefone → telefones recebidos | 14 → 0 |
| Pesquisas de satisfação → notas | 13 (6 entregues, 7 falharam) → 0 |
| Negociações do iFood (Plataforma de Negociação) | 6, duas expiraram sem resposta; mais uma expirada sem o evento de abertura |
| Conversas iFood abertas agora sem nenhuma mensagem de cliente | 48 |

Como foi medido: `messages.created_at` guarda a hora que o widget mostra; a hora em que a linha entrou no banco sai do UUIDv7 do `id`. A diferença é o atraso da ponte (consultas no apêndice).

## 2. O que deu errado

1. **Mensagem pode ir para o cliente errado.** O número do pedido do iFood tem 4 dígitos e repete: em 20–21/10, #1734, #3266, #5462 e #6381 apareceram em duas lojas, e #5801 duas vezes na Nippon. A ponte acha o pedido só pelo número (o mais recente entre todos os restaurantes do usuário). O chat do #5462 da Nippon foi gravado na conversa do #5462 da Terra Querida, uma das mensagens com data de 22/10 11:43 (no futuro: a conversa fica no topo da Inbox até amanhã). No envio, o painel abre o primeiro chat com aquele número, então uma resposta ou um aviso pode ser digitado no chat de outro cliente.
2. **Agradecimento vira chamado.** "Obg" (#9673), "descendo" (#6873) e "Só um minuto" (#9658, com o entregador na porta) receberam "Estamos acionando um de nossos atendentes… informe seu telefone" e "seu pedido saiu às …", com alarme.
3. **A loja responde pelo Gestor e a automação não vê.** A automação só conta como resposta da equipe o que sai pela Inbox, ou o que a loja escreveu fora dela e veio na mesma leitura do widget (correção `97ac444`, de 21/10 às 16:32). No #6873 a loja escreveu às 12:52:44 e o cliente respondeu "descendo" às 12:53:39; as duas mensagens vieram em leituras diferentes (copiadas às 12:52:47 e 12:53:44), e saiu um segundo chamado na mesma conversa. O mesmo no #9658. A mensagem da loja pelo Gestor também não desliga o alarme: chamados de 12:28, 12:44, 12:53 e 13:05 ficaram ativos até 15:52, quando as quatro conversas foram resolvidas em 7 segundos; às 20:15, cinco foram resolvidas em 24 segundos.
4. **Andamento desatualizado ou ausente.** No primeiro chamado a automação manda "saiu às …" quando o pedido está `DISPATCHED`, mesmo com o entregador já no endereço. O #1957 perguntou "O pedido saiu pra entrega?" às 11:56 e recebeu "saiu às 11:27", mas o entregador tinha chegado às 11:50 (`ARRIVED_AT_DESTINATION`). O #6873 recebeu "saiu às 11:53" às 12:17, já com o pedido nas mãos. O #9673 recebeu "saiu às 12:20" um segundo antes da mensagem da loja "acaba de ser entregue". Pedido ainda na cozinha ("vai demorar?", #7310 às 11:33) não recebe a previsão de saída, que já existe no WhatsApp (`orderUpdateMessage`).
5. **Promessa de atendente que não vem.** Em 10 dos 14 chamados ninguém da loja respondeu no chat.
6. **Telefone e pesquisa não funcionam no iFood.** 0 de 14 telefones e 0 notas. Das 13 pesquisas, 7 falharam ("O chat deste pedido não está aberto no widget", "Nenhum painel com a extensão do iFood aberta enviou a mensagem"). A pesquisa saiu também onde ninguém atendeu. O iFood já tem a avaliação dele. Não achei regra pública do iFood sobre pedir telefone no chat.
7. **Negociações do iFood invisíveis.** O parser em [apps/api/src/orders/ifood-order.ts](../apps/api/src/orders/ifood-order.ts) exige `id`, mas o iFood manda `disputeId` (conferido nos 6 eventos do dia): a tela do pedido nunca mostra a negociação aberta. "O pedido está atrasado. Quero uma nova previsão de entrega." expirou em 5 minutos sem resposta no #6788 (12:36) e no #2521 (13:13). No #6379, "Paguei e não veio" foi aceita em 47 segundos e, 5 segundos depois, a automação mandou "Estamos acionando… telefone". No #4075 (Aglio Nero), "Quero adicionar observação do pedido: Por favor, pouca borda." chegou pelo chat às 19:30, a negociação expirou às 19:35 (sem o evento de abertura gravado) e ninguém respondeu; o pedido saiu às 20:02.
8. **Ponte parada por horas.** Nenhuma conversa foi copiada entre 13:16 e 15:50 nem entre 15:53 e 17:21. O cliente do #2521 escreveu às 13:20 e a mensagem entrou às 19:45; o do #1440 escreveu "oi", "vai demorar MT?" e "?" entre 13:37 e 13:53, e as mensagens entraram às 15:50. Sem alarme e sem resposta (passaram das 2 h de `ATTEND_WITHIN_MS`). Com a ponte no ar, a mensagem do cliente quase sempre chegou à Inbox em 2 a 30 segundos, e a resposta automática saiu 3 a 15 segundos depois.
9. **Inbox cheia de conversas sem cliente.** A conversa nasce aberta mesmo quando a leitura só tem mensagens da loja; 48 continuam abertas.
10. **Resposta duplicada.** O aviso de saída do #7310 foi criado às 11:35:39 e só digitado às 11:47:24. `confirmSent` procura a resposta pega pelo painel só até 10 minutos depois da criação, então a mensagem entrou de novo, como se a loja tivesse escrito no Gestor. A demora combina com um painel em aba oculta (o Chrome limita timers encadeados a cerca de um por minuto depois de 5 minutos oculta) que pegou o envio.
11. **Fila do motor.** O motor copia uma conversa por passo, na ordem em que aparecem no HTML, e o que já copiou fica só na memória da aba (recarregar o painel faz reler o dia todo). Conversas pendentes, algumas do almoço e outras de antes da 1h, só entraram à tarde e à noite (17:21–17:27: 18 conversas; 18:48–20:09: outras 16), disputando a vez com as mensagens novas: a primeira mensagem do #4075 levou 5 minutos para entrar. No #9673, a mensagem da loja das 12:44:11 só foi copiada às 20:06.

## 3. O que o Danilo decidiu (21/10)

No chat do iFood, a automação não fala mais com o cliente, exceto para avisar o andamento do pedido. E o entregador ganha uma segunda opção de aviso: "deixei na portaria".

| Continua | Sai |
|---|---|
| Avisos de status no chat do pedido, enquanto a conversa está em andamento: pronto, saiu e entregue (`OrderNoticeService`) | Resposta automática a quem escreve ("Estamos chamando um atendente…") |
| Aviso que o cliente perdeu: quem escreve depois de o pedido ficar pronto ou sair recebe esse aviso (`missedNotice`), como hoje | Pedido de telefone, lembrete e confirmação |
| Aviso do entregador pelo menu do WhatsApp ("cheguei") e o novo "deixei na portaria" | Pesquisa de satisfação e agradecimento da nota |
| Alarme da Inbox e evento "Cliente chamando pelo chat do iFood" no atendimento novo, como hoje | Mensagem de encerramento por inatividade |

O alarme fica como hoje: para quando alguém responde ou resolve pela Inbox; resposta digitada no Gestor não para o alarme.

A primeira versão deste plano propunha uma automação que entende o cliente (intenção, andamento real, espera da rajada). Com a decisão acima, ela saiu do plano (seção 5).

## 4. Plano

Ordem sugerida: 4.1 e 4.3 a) primeiro (os avisos de status continuam, e a 4.3 a) impede que um deles vá para o chat de outro cliente); depois 4.2, o resto da 4.3 e a 4.4.

### 4.1 Desligar as automações do chat do iFood

- `IfoodAttendanceService.afterInbound` ([apps/api/src/automations/ifood-attendance.service.ts](../apps/api/src/automations/ifood-attendance.service.ts)):
  - sai o `survey.handleAnswer`; atendimento em andamento (`!event.newAttendance`) não faz nada (sai o `phoneCollection.afterInbound`);
  - atendimento novo: sai a mensagem `handoff` ao cliente. Ficam o `systemEvent` "Cliente chamando pelo chat do iFood", o `awaitingAgentSince` (alarme) e o `missedNotice`. O `dispatch` com a lista vazia continua avisando o painel;
  - sai o `setAutomationState` (o `linkedOrder` e o `phoneCollection` só serviam à pesquisa e ao telefone);
  - `PhoneCollectionService` e `SurveyService` saem do construtor; atualizar o comentário da classe.
- `InactivityService.close` ([apps/api/src/automations/inactivity.service.ts](../apps/api/src/automations/inactivity.service.ts)): conversa do canal `IFOOD` sai antes de tudo (sem mensagem, sem resolver, sem pesquisa). Isso cobre também os jobs que já estiverem na fila no deploy.
- `IfoodChatService.result` ([apps/api/src/conversations/ifood-chat.service.ts](../apps/api/src/conversations/ifood-chat.service.ts)): não agenda mais o job `inactivity`.
- `SurveyService.request`: canal `IFOOD` não recebe pesquisa (há conversas com `linkedOrder` de antes do deploy, e resolver pela Inbox também chama a pesquisa).
- `AutomationMessages`: tirar `ifoodHandoff` e `ifoodPhoneRequest` (tipo e as 6 personalidades), que ficam sem uso.
- Consequência: a conversa do iFood fica aberta até a equipe resolver, e os avisos de status continuam indo para o chat enquanto ela estiver aberta.
- Testes em `apps/api/test/ifood-chat.test.ts`:
  - "cliente escreveu no chat: chama a equipe com o alarme, avisa o cliente e pede o telefone": passa a esperar o alarme e o evento, sem mensagem ao cliente;
  - "cliente manda o telefone: vai para o cadastro e a automação confirma": sai;
  - "cliente parou de responder: o atendimento é encerrado e a avaliação pedida…": passa a esperar que, depois de um aviso enviado, não saia encerramento nem pesquisa, e que resolver pela Inbox também não mande pesquisa;
  - "telefone informado que já é de outro cadastro: os dois viram um…": mudar para o Instagram (`apps/api/test/instagram.pipeline.test.ts`), onde a coleta de telefone continua. É o único teste da união pelo telefone (`PhoneCollectionService.unify`);
  - "pedido que já saiu quando o chat começa: o aviso da saída vai logo depois do chamado, uma vez só": continua, sem a mensagem de chamado;
  - os demais ficam como estão.

### 4.2 Entregador: "deixei na portaria"

Pedido do Danilo: além de avisar que chegou, o entregador pode avisar que deixou o pedido na portaria, escolhendo uma das duas opções.

- `COURIER_MENU_OPTIONS` ([packages/shared/src/settings.ts](../packages/shared/src/settings.ts)) passa a ter as duas opções de aviso juntas:

  ```
  1 - Avisar que cheguei (iFood)
  2 - Avisar que deixei na portaria (iFood)
  3 - Problema com um pedido
  4 - Outro assunto
  ```

  "Problema com um pedido" e "Outro assunto" mudam de número (ninguém usou o menu em 21/10).
- `CourierMenuService` ([apps/api/src/automations/courier-menu.service.ts](../apps/api/src/automations/courier-menu.service.ts)):
  - `chooseOption` lê de 1 a 4: 1 e 2 pedem o número do pedido (`awaiting_arrival_order` e `awaiting_front_desk_order`), 3 pede o número para o problema e 4 chama a equipe sem urgência, como o 3 de hoje;
  - `notifyArrival` ganha o tipo do aviso (`"arrival" | "front_desk"`). A busca do pedido, o chat do iFood e a resolução da conversa do entregador são as mesmas; mudam o texto ao cliente, a confirmação ao entregador, os rótulos da automação e a nota quando cai para a equipe ("Entregador avisou que deixou o pedido #X na portaria");
  - o aviso não muda o status do pedido: o Dish Desk só acompanha, e a entrega vale pelo evento do iFood.
- Tipos: `AutomationState.triage` ([apps/api/src/automations/automation.ts](../apps/api/src/automations/automation.ts)) ganha `"awaiting_front_desk_order"`; `MessageContent.automation` ([packages/shared/src/conversations.ts](../packages/shared/src/conversations.ts)) ganha `"courier_front_desk"` e `"courier_front_desk_confirmed"`, com os rótulos em [apps/web/components/inbox/message-timeline.tsx](../apps/web/components/inbox/message-timeline.tsx) ("Automação · deixado na portaria" e "Automação · cliente avisado da portaria").
- Textos novos, com as 6 personalidades (regra 10). Referência no tom cordial:

  | Chave | Marcadores | Cordial |
  |---|---|---|
  | `courierFrontDeskNotice` | — | 📦 O entregador deixou seu pedido na portaria! Bom apetite 😋 |
  | `courierFrontDeskConfirmed` | {pedido} | Pronto! Avisamos o cliente do pedido #{pedido} que o pedido ficou na portaria. |

  `courierFrontDeskConfirmed` entra no `REQUIRED` com `["pedido"]`.
- Testes: `packages/shared/test/settings.test.ts` (menu com 4 opções); `apps/api/test/triage.test.ts` (constante `COURIER_MENU`, a opção 3 para o problema, a 4 para outro assunto e um caso da opção 2); `apps/api/test/ifood-chat.test.ts` (aviso da portaria no chat do pedido e conversa do entregador resolvida); conferir `apps/api/test/served-tenants.test.ts`, que usa o aviso de chegada.

### 4.3 Correções

**a) Pedido certo na leitura e no envio** (problema 1)

- [apps/web/lib/ifood-chat-dom.ts](../apps/web/lib/ifood-chat-dom.ts): `WidgetChat` ganha `store` (o 3º `span` do item da lista, hoje descartado; `customer` já existe). `WidgetDrawer` ganha `customer` (grupo 2 do `HEADER` "#código - NOME").
- [packages/shared/src/conversations.ts](../packages/shared/src/conversations.ts): `IfoodChatSync` ganha `customer` e `store`, opcionais (um painel aberto com a versão antiga continua mandando sem eles). `IfoodChatOutboxItem` ganha `customer`.
- `IfoodChatService.sync`, com a regra do Danilo para número repetido (comparar o nome; se não bater, a loja decide): candidatos = pedidos iFood com o número, no escopo, feitos nos últimos 2 dias. Um só: ele. Mais de um: fica o que tem o nome do cliente do pedido (`raw.customer.name`, porque o nome do cadastro pode ter sido editado ou unido) igual ao `customer` do cabeçalho, comparando sem acento, sem diferença de maiúsculas e com espaços colapsados. Se nenhum nome bater, ou mais de um, decide a loja: no chat do iFood não há a quem perguntar, mas o item da lista do widget já mostra a loja (`store`), comparada com o nome do canal. Sem decidir: `{ found: false }` e `logger.warn` com o número e as lojas. Nunca gravar no pedido errado.
- `IfoodChatService.claim`: devolve também `customer` (o `raw.customer.name` do pedido escolhido). `IfoodChatDriver.open` ([apps/web/lib/ifood-chat-driver.ts](../apps/web/lib/ifood-chat-driver.ts)) escolhe o item com número **e** cliente iguais (mesma normalização). Sem item que bata: falha com a mensagem de hoje ("O chat deste pedido não está aberto no widget do iFood."). Nunca digitar em outro chat.
- Testes: em `apps/api/test/ifood-chat.test.ts`, dois pedidos com o mesmo número em lojas diferentes: a leitura vai para o certo e o envio leva o cliente certo. Em `apps/web/lib/ifood-chat-driver.test.ts`, dois itens com o mesmo número: o motor abre o do cliente certo e falha se nenhum bater.

**b) Data nunca no futuro** (problema 1)

`transcript()` em `ifood-chat.service.ts` soma 24 h quando a hora do widget fica mais de 1 h antes do pedido. Se o horário calculado passar de `now` + 2 min, usar o dia anterior; se ainda estiver no futuro, usar `now`. Teste com `now` fixo.

**c) Negociação: ler o que o iFood manda** (problema 7)

- `ifood-order.ts`: o schema `Dispute` lê `disputeId` (aceita `id` como alternativa). `eventDetail` do `HANDSHAKE_DISPUTE`: `message` ou, sem ela, os motivos de `metadata.items[].reason` e `metadata.garnishItems[].reason` ("Paguei e não veio"). Com isso, a tela do pedido passa a mostrar a negociação aberta e o motivo na linha do tempo. Nenhuma automação nova.
- Teste com o payload real (copiar um dos eventos de 21/10, sem as URLs de evidência). Chaves reais: `action, message, metadata, createdAt, disputeId, expiresAt, alternatives, handshakeType, timeoutAction, handshakeGroup`.
- Investigar, sem código: o #4075 recebeu `HANDSHAKE_SETTLEMENT` (EXPIRED, 19:35) sem nenhum `HANDSHAKE_DISPUTE` gravado. Ver nos logs da `api` na Railway o que chegou por volta das 19:30 (o polling não filtra tipos de evento) e se o pedido de observação é outro tipo de negociação.

**d) Resposta digitada tarde não duplica** (problema 10)

`confirmSent`: casar qualquer resposta pega pelo painel (`ifood-chat-claim:`) e ainda não confirmada da conversa, com o mesmo texto, criada até 2 h antes (a mais antiga primeiro). Trocar o `randomUUID()` do marcador por um UUIDv7, para saber quando o painel pegou (serve à 4.4 c). Teste: resposta pega e digitada 15 minutos depois não duplica.

**e) Conversa só com mensagens da loja nasce resolvida** (problema 9)

No `sync`, conversa **nova** criada por uma leitura sem mensagem do cliente nasce `RESOLVED` (`openIfoodConversation` já recebe o status). Mensagem do cliente depois reabre a conversa (o `sync` já põe `OPEN` quando há não lidas) e o alarme toca como hoje. Conversa existente não muda. Teste: leitura só com mensagens da loja não deixa conversa aberta; o cliente escreve depois e o chamado acontece normalmente.

**f) Número repetido na busca do pedido: comparar o nome e, se não bater, perguntar a loja** (pedido do Danilo)

Hoje, quando o número digitado acha mais de um pedido de hoje ou de ontem, o "Falar sobre um pedido" do WhatsApp e do Instagram chama a equipe com o evento `order_ambiguous` ([apps/api/src/automations/triage.service.ts](../apps/api/src/automations/triage.service.ts), `findOrder`), e o menu do entregador trata como pedido não encontrado ([apps/api/src/automations/courier-menu.service.ts](../apps/api/src/automations/courier-menu.service.ts), `findOrder`). As duas buscas olham também os restaurantes que o canal atende (`withOrderTenants`), então o número repete entre lojas (em 20–21/10: #1734, #3266, #5462, #6381) e entre dias na mesma loja (#5801 da Nippon).

- Buscar até 5 candidatos (hoje `take: 2`).
- Cliente (`TriageService.findOrder`): com mais de um, comparar o nome. Bate quando o pedido é do mesmo cadastro da conversa (ou de um com o mesmo telefone, CPF ou e-mail); senão, quando o primeiro nome do cliente do pedido (`raw.customer.name`) é igual ao da conversa, sem acento e sem diferença de maiúsculas. Um só bate: segue como hoje para `offerOrder` (itens, total e "É este o seu pedido?"). Nenhum ou mais de um: pergunta a loja.
- Entregador (`CourierMenuService.findOrder`): o nome do entregador não é o do cliente, então com mais de um pedido pergunta a loja direto. Escolhida, segue o fluxo em que ele estava (cheguei, deixei na portaria ou problema).
- A pergunta: texto da personalidade e as opções numeradas só com o nome da loja (formato pedido pelo Danilo):

  ```
  Encontramos mais de um pedido #5462. Em qual loja você fez o seu?
  1 - Nippon
  2 - Terra Querida
  ```

  - A loja é o nome do canal. Uma opção por loja: se a mesma loja tiver mais de um pedido com o número (dias diferentes, como o #5801 da Nippon), fica o mais recente.
  - Se sobrar uma loja só, não há pergunta: segue com esse pedido (o cliente ainda confirma em "É este o seu pedido?").
  - Se dois nomes ficarem iguais: a plataforma entre parênteses quando a mesma loja aparece no iFood e no Cardápio Web ("Terra Querida (Cardápio Web)"); o nome do restaurante quando o nome do canal se repete entre restaurantes (ex.: dois canais "iFood").
- Estado: `storeChoices: { orderId, label }[]` no `automationState`, mantendo a etapa em que o atendimento estava. A próxima mensagem é lida como a escolha (número da opção, ou o nome da loja): escolha válida segue com o pedido escolhido e limpa `storeChoices`; resposta fora das opções chama a equipe com o evento `order_ambiguous` (cliente, como hoje) ou com a nota de pedido não encontrado (entregador, como hoje).
- Textos novos, com as 6 personalidades (regra 10), os dois com `{pedido}` no `REQUIRED`:

  | Chave | Cordial |
  |---|---|
  | `orderStoreQuestion` | Encontramos mais de um pedido #{pedido}. Em qual loja você fez o seu? |
  | `courierOrderStoreQuestion` | Há mais de um pedido #{pedido}. De qual loja é? |

- Tipos: `MessageContent.automation` ganha `"order_store_question"` (os dois fluxos), com o rótulo "Automação · pergunta da loja" em `message-timeline.tsx`.
- Testes: em `apps/api/test/triage.test.ts`, dois pedidos com o mesmo número em lojas diferentes: com o nome batendo com um, ele é oferecido; sem bater, a pergunta sai com as duas lojas, "2" oferece o segundo e uma resposta fora das opções chama a equipe com `order_ambiguous`. No menu do entregador: dois pedidos → pergunta a loja → o aviso vai para o chat do pedido escolhido. Mesmo número na mesma loja em dias diferentes: sem pergunta, fica o mais recente.

### 4.4 Ponte confiável

Os avisos de status e as respostas pela Inbox dependem do painel aberto com a extensão: se a ponte para, o aviso falha ("Nenhum painel com a extensão do iFood aberta enviou a mensagem") e a mensagem do cliente não chega.

**a) Saúde da ponte** (problema 8)

- Cada `sync` e `claim` grava no Redis, por restaurante do escopo, a hora da última leitura (`ifood-bridge:<tenantId>`, TTL de um dia). `GET /ifood-widget` (ou o `counts` da Inbox) devolve `bridgeSeenAt`.
- Na linha "Chat do iFood" do cartão de Integrações da Inbox ([apps/web/components/inbox/inbox-home.tsx](../apps/web/components/inbox/inbox-home.tsx), commit `879da58`), em qualquer navegador, inclusive sem a extensão: com pedido do iFood em andamento (feito nas últimas 3 h, nem entregue nem cancelado) e `bridgeSeenAt` com mais de 3 minutos, mostrar "O chat do iFood não é lido desde 13:16. Abra o Dish Desk no computador com a extensão." Seguir o design do cartão.

**b) Prioridade e memória do motor** (problema 11)

Em `IfoodChatDriver`:

- ordenar os candidatos: "Pedidos abertos" antes de "concluídos" e, dentro de cada aba, a hora do item (`stamp` "HH:MM • DD/MM") mais recente primeiro;
- guardar o mapa `copied` no `localStorage`, com a data na chave, e ler na inicialização (recarregar o painel não relê o dia inteiro). Acesso dentro de try/catch;
- depois de digitar uma resposta ou aviso, copiar aquele chat de novo em cerca de 5 s;
- ao copiar, se o último balão lido não bate com a prévia da lista, não marcar como copiado (tentar no passo seguinte). É o caso do #9673;
- testes em `ifood-chat-driver.test.ts`.

**c) Só o painel visível envia, e medir** (problema 10)

- O motor só pede envios (`claim`) com `document.visibilityState === "visible"`. Painel oculto só pega envio pendente há mais de 30 s (`claim` com um parâmetro `hidden`: a API filtra `createdAt < now - 30 s`).
- Logar em `IfoodChatService.result` o tempo entre o claim (UUIDv7 da 4.3 d) e o resultado, com a visibilidade do painel, para confirmar a hipótese. Mover os timers do motor para um Worker pode evitar o limite do Chrome, mas isso não foi confirmado: testar antes de adotar.

## 5. Pendente e para depois

Pendente, com o Danilo:

- **Limpeza em produção**, só depois da 4.3 a) e com autorização (a trava do Claude Code pode bloquear): resolver as 48 conversas iFood abertas sem nenhuma mensagem de cliente e apagar a conversa `01a15f32-a75c-7327-ab0c-8a5544be6bfc` (Terra Querida #5462), que só tem mensagens do chat do #5462 da Nippon, uma delas com data de 22/10.

Propostas da análise que ficaram de fora agora:

- Entender a mensagem do cliente (agradecimento, andamento, instrução de entrega, problema, alteração), esperar a rajada e responder com o andamento real (inclusive "o entregador chegou às 11:50" e a previsão de saída).
- Parar o alarme quando a loja responde pelo Gestor (hoje ele só para pela Inbox).
- Negociação do iFood como chamado urgente na Inbox, com o prazo de resposta.
- Aviso automático quando o iFood informa `ARRIVED_AT_DESTINATION` (as lojas mandam "entregador está no local" à mão).
- Responder sozinho à negociação de atraso com mais tempo (motivos `ORDER_OUT_FOR_DELIVERY`, `DRIVER_IS_ALREADY_AT_THE_ADDRESS`): exige as ações no pedido e contraria o "só acompanhar".
- Repassar ao entregador, por WhatsApp, as instruções de entrega do cliente: o `ASSIGN_DRIVER` do Foody traz o nome e o telefone do entregador.

## 6. Como conferir

- Testes de cada item, `pnpm --filter @dishdesk/shared build`, testes da API e do web, lint e typecheck.
- Em produção, depois do deploy (a ponte só roda no Chrome com a extensão), acompanhar um almoço e repetir as consultas do apêndice. Metas:
  - nenhuma mensagem automática no chat do iFood além dos avisos de status, do aviso perdido e dos avisos do entregador;
  - o alarme toca quando o cliente escreve;
  - a opção 2 do menu do entregador avisa "deixei na portaria";
  - nenhuma mensagem no pedido de outra loja;
  - número repetido no WhatsApp, no Instagram ou no menu do entregador pergunta a loja em vez de chamar a equipe;
  - nenhuma conversa aberta sem mensagem de cliente.

## Apêndice — consultas (só leitura)

Atraso da ponte (hora do widget × hora em que a linha entrou no banco):

```sql
select ch.name as loja, m.created_at at time zone 'America/Sao_Paulo' as widget,
  to_timestamp((('x' || replace(left(m.id::text, 13), '-', ''))::bit(48)::bigint) / 1000.0) at time zone 'America/Sao_Paulo' as copiada,
  left(m.content->>'text', 50) as texto
from messages m join channels ch on ch.id = m.channel_id
where ch.type = 'IFOOD' and m.direction = 'INBOUND' and m.created_at >= '2026-10-21 00:00-03'
order by m.created_at;
```

Automações do dia por tipo e status:

```sql
select m.content->>'automation' as automacao, m.status, count(*)
from messages m join channels ch on ch.id = m.channel_id
where ch.type = 'IFOOD' and m.content ? 'automation' and m.created_at >= '2026-10-21 00:00-03'
group by 1, 2 order by 1, 2;
```
