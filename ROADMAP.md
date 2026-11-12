# Roadmap de desenvolvimento — Dish Desk (CRM Omnichannel para Restaurantes)

> Fontes: [PROJETO_CRM_RESTAURANTES.md](PROJETO_CRM_RESTAURANTES.md) (especificação) e o design finalizado ([Dish Desk Design.html](Dish%20Desk%20Design.html) / artifact `FmY8WRPQc1iMuHxzxUQf5F`: Sistema de Design, Login, Inbox, Campanhas).
> Este roadmap **substitui a seção 11 da especificação**. Instagram e iFood saíram da antiga Fase 2 e entraram no MVP.

**Esforço relativo:** **P** ≈ até 1 semana · **M** ≈ 1–2 semanas · **G** ≈ 2–4 semanas (1 dev full-stack).
**Definição de pronto (todas as histórias de UI):** segue os tokens do design; todo botão novo tem guard de duplo-clique e estado "Carregando" (CLAUDE.md §6); nenhuma query roda sem contexto de tenant. **No MVP só existe desktop**: a versão mobile (CLAUDE.md §7) fica para depois da Fase 1.

## Situação em 30/10/2026

Conferida no código. **✅ Feito** quer dizer que o épico está no código. **🟡 Parcial** quer dizer que falta uma parte dele. **⬜ A fazer** quer dizer que não começou. O que depende de terceiros (análise da Meta, homologação do iFood, planos pagos) está em [docs/pendencias-producao.md](docs/pendencias-producao.md).

| Fase | Feito | Falta |
|---|---|---|
| **1 — MVP, com a IA no atendimento** | E1–E11, E27–E29 | **E12:** backup diário (o Supabase está no plano Free). Sentry (api e web) e Bull Board estão no ar desde 30/10/2026. |
| **2 — Pós-MVP** | E13–E15, E17, E26, E30 | **E16:** entrar no painel de um restaurante para suporte (impersonação auditada). **E18:** Inbox para tablet. **E32–E39:** reputação e avaliações. **E40 (parcial):** no código desde 02/11/2026; falta testar com a API real do Cardápio Web e com um pedido real do iFood. **E47:** recado do cliente para o entregador; entrou no roadmap em 12/11/2026, não começou. |
| **3 — Campanhas** | — | **E19:** os módulos já são ligados por restaurante pela plataforma; falta o estado bloqueado do módulo Campanhas. **E25:** a assinatura do Dish Desk pela Stripe existe; falta a cobrança do módulo. **E20–E24, E45–E46:** não começaram. |
| **4 — Agente de implantação e suporte** | — | **E31:** falta o teste com o Chrome de verdade. |
| **5 — Cardápio digital próprio e pedido pela IA** | — | **E41–E44:** entraram no roadmap em 11/11/2026; não começaram. |

Os canais estão no código, mas três dependem de terceiros para chegar aos restaurantes:
- **Instagram (E6):** só funciona para contas testadoras até a análise da Meta.
- **iFood (E7):** o app ainda está "Em revisão" na validação final.
- **WhatsApp (E5):** conecta por QR Code, e falta conectar o número do piloto.

Os critérios de aceite do MVP continuam desmarcados: eles são conferidos no piloto em produção.

---

## Pré-requisitos externos (iniciar na semana 1, em paralelo)

Estes itens têm prazo de aprovação de terceiros e são o maior risco ao cronograma do MVP:

| Item | Por que bloqueia | Prazo típico |
|---|---|---|
| Verificação da empresa no Meta Business Manager | Necessária para a WhatsApp Cloud API em produção e para o App Review | dias a semanas |
| **App Review da Meta** (`instagram_manage_messages`, `whatsapp_business_messaging`) | Sem ele, o Instagram Direct só funciona para contas de teste | semanas; exige política de privacidade, vídeo de demonstração e app funcional |
| Número de WhatsApp dedicado do restaurante piloto | O número não pode estar em uso no app WhatsApp comum | dias |
| Cadastro no portal de desenvolvedores do iFood + homologação | Libera acesso à Merchant API (pedidos). **Confirmar se existe API de chat**; se não existir, o MVP do iFood é só pedidos | semanas |
| Política de privacidade e termos publicados (LGPD) | Requisito da Meta e da LGPD | dias |

---

## Fase 1 — MVP (foco total)

Objetivo: um restaurante piloto atende clientes de WhatsApp, Instagram e iFood em uma única Inbox, com a opção de atendimento por IA.

### Épicos

#### E1 — Fundação do projeto · **G** · depende de: — · **✅ Feito**
- Como dev, quero um monorepo (pnpm + Turborepo) com `apps/web`, `apps/api`, `packages/{database,shared,ui,config}` para compartilhar tipos e configs.
- Como dev, quero `docker compose up` subindo Postgres 18 e Redis para desenvolver localmente. Não há S3 local: as mídias não são guardadas (ver E4).
- Como dev, quero o `apps/web` em Next.js (App Router) + Tailwind + shadcn/ui com os **tokens do design** (cores, Fraunces/Inter, raios) já configurados.
- Como dev, quero o `apps/api` em NestJS com bootstrap por papel (`APP_ROLE=api|realtime|gateway|worker|scheduler`).
- Como dev, quero CI no GitHub Actions (lint, typecheck, testes, build) em todo PR.

#### E2 — Modelo de dados e multi-tenancy · **G** · depende de: E1 · **✅ Feito**
- Como plataforma, quero o schema Prisma com `tenant_id` em todas as tabelas de negócio e **RLS** no Postgres.
- Como dev, quero os tenants definidos por request (`AsyncLocalStorage` + `SET LOCAL app.tenant_ids`) e uma extensão do Prisma que injeta o `tenantId` nas escritas.
- Como plataforma, quero RLS por **lista** de tenants (`tenant_id = ANY(app.tenant_ids)`), que atende tanto o modo restaurante quanto o painel master (especificação §3.3). A lista vem sempre de `TenantMember`, nunca do cliente.
- Como plataforma, quero **testes automatizados de vazamento entre tenants** obrigatórios no CI, incluindo o modo master: um usuário membro de A e B nunca vê C.
- Modelos novos na especificação: `TenantMember` (usuário em vários tenants, com papel por tenant) e `Order` + `OrderItem`.

#### E3 — Autenticação, escolha de restaurante e papéis · **M** · depende de: E2 · **✅ Feito**
- Como usuário, quero entrar com e-mail e senha (Argon2, JWT access + refresh, rate limit no login).
- Como usuário com acesso a vários restaurantes, quero escolher, após o login, **um restaurante** ou o **painel master** (todos os meus restaurantes num CRM único), na tela "Escolha o restaurante", que mostra papel e nº de conversas abertas.
- Como usuário, quero trocar de restaurante ou de modo sem precisar fazer logout.
- Como admin, quero permissões por papel por tenant (`ADMIN`, `AGENT` em `TenantMember`; `isSuperAdmin` para a plataforma) aplicadas via guards na API e no front.
- Como usuário, quero recuperar a senha ("Esqueceu?").
- O botão "Continuar com Google" é implementado **só visualmente**, conforme o desig. A integração OAuth real fica para depois.
- ⚠️ O design da tela "Escolha o restaurante" ainda não tem a opção "Painel master". Ela deve ser adicionada seguindo o mesmo padrão visual dos itens da lista.

#### E4 — Pipeline de mensageria (núcleo) · **G** · depende de: E2 · **✅ Feito**
- Como plataforma, quero um `webhook-gateway` que valida a assinatura, responde 200 e enfileira (BullMQ: `inbound`, `outbound`, `media`).
- Como plataforma, quero normalizar todo canal para `NormalizedMessage` e ter um `ChannelConnector` por canal.
- Como plataforma, quero idempotência por `(channel_id, external_message_id)`.
- Como plataforma, quero **resolução de identidade** (identidade → telefone E.164 → hash de CPF), sem sobrescrever dados com valores vazios.
- Como atendente, quero receber mensagens novas em tempo real (Socket.IO + adapter Redis).
- Como atendente, quero ver as mídias recebidas: a API busca o arquivo na origem (Meta ou Evolution) a cada abertura. **Decisão de 30/10/2026:** as mídias não são guardadas (sem S3); quando a origem apaga o arquivo, a conversa mostra "não está mais disponível".
- Como plataforma, quero retry exponencial e dead-letter queue nas filas.

#### E5 — Conector WhatsApp · **G** · depende de: E4 · **✅ Feito**
- Como restaurante, quero receber e enviar mensagens de texto pelo WhatsApp (Cloud API oficial da Meta).
- Como atendente, quero ver o status de entrega (enviado, entregue, lido, falhou ✓✓).
- Como atendente, quero receber imagens, áudios e documentos (só exibir; o envio de mídia fica para depois).
- Como atendente, quero enviar um **template aprovado** quando a janela de 24h estiver fechada (botão "Template" do composer).
- Decisão original: **somente a WhatsApp Cloud API oficial da Meta**. **Revista em 21/10/2026:** a Meta desabilitou o portfólio Dish Desk no WhatsApp e o canal passou a conectar **por QR Code, pela Evolution API** (WhatsApp Web, não oficial; serviço próprio). Sem janela de 24h nem templates. Risco aceito: o WhatsApp pode banir números, sobretudo com envio em massa. O código da API oficial continua no repositório para quando a Meta liberar.
- No MVP, o canal é conectado por **script/seed administrativo** com credenciais criptografadas (AES-256-GCM). A tela de Canais fica na Fase 2.

#### E6 — Conector Instagram Direct · **M** · depende de: E4, App Review da Meta · **✅ Feito**
- Como restaurante, quero receber e responder DMs do Instagram (conta Profissional vinculada a uma Página).
- Como atendente, quero ver nome, @usuário e foto do contato quando disponíveis.
- Instagram nunca é canal de campanha.

#### E7 — Conector iFood (pedidos) · **G** · depende de: E4, homologação iFood · **✅ Feito**
- Como restaurante, quero que os pedidos do iFood (eventos via polling/webhook da Merchant API) criem ou atualizem o contato e o `Order`.
- Como atendente, quero que um pedido abra ou se associe a uma conversa ("Conversa aberta via iFood").
- Como atendente, quero que o status do pedido se atualize (confirmado, em preparo, em entrega, entregue).
- Se a API de chat do iFood existir e for liberada: receber e responder mensagens. Caso contrário, a conversa do iFood é alimentada pelos eventos de pedido e o atendimento segue pelo WhatsApp, depois da coleta de telefone.

#### E8 — Inbox unificada · **G** · depende de: E3, E4 (os canais entram conforme ficam prontos) · **✅ Feito**
- Como atendente, quero a lista de conversas com busca, filtros (Todos, Abertos, Pendentes, Resolvidos), contador de não lidas, tempo desde a última mensagem e indicador do canal.
- Como atendente, quero abrir uma conversa e ver o histórico completo do cliente em todos os canais.
- Como atendente, quero enviar mensagens de texto com feedback otimista (`pending` → `sent`).
- Como atendente, quero atribuir a conversa a mim ou a um colega e marcá-la como resolvida.
- Como atendente, quero notificação sonora e visual de mensagem nova.
  - **Feito em 30/10/2026:** os avisos continuam fora da Inbox (Configurações, Avaliações, Clientes...): alarme de chamado, bipe e aviso "Nova mensagem na Inbox" no topo, com o atalho para ela, e as não lidas no título da aba.
- Como atendente, quero skeletons de carregamento enquanto a lista carrega.
- **Painel master:** como usuário de vários restaurantes, quero uma Inbox única com as conversas de todos eles, cada item identificado pelo restaurante e com filtro por restaurante. Responder, atribuir e resolver respeitam o meu papel no tenant daquela conversa. O realtime assina as salas de todos os tenants do usuário.

#### E9 — Contatos e painel lateral do cliente · **M** · depende de: E4, E8 · **✅ Feito**
- Como atendente, quero que todo contato novo gere um cadastro automaticamente (feito no E4; aqui entra a exposição na UI).
- Como atendente, quero o painel lateral com tags (VIP, recorrente, + tag), telefone com origem ("informado pelo cliente"), e-mail, CPF mascarado, canais vinculados, endereço de entrega, histórico (nº de pedidos, valor gasto, tempo como cliente) e os últimos pedidos do iFood.
- Como atendente, quero editar o cadastro no próprio painel (dados digitados têm precedência sobre os automáticos).
- Como atendente, quero buscar contatos por nome, telefone ou CPF (busca de CPF por hash HMAC).
- Como plataforma, quero registrar no `AuditLog` quando alguém visualiza um CPF completo.

#### E10 — Automação de coleta de telefone · **M** · depende de: E4, E9, E5 ou E6 ou E7 · **✅ Feito**
- Como restaurante, quero que contatos sem telefone real (Instagram, iFood) recebam automaticamente o pedido de telefone na primeira mensagem (texto padrão; a edição do texto fica na Fase 2).
- Como plataforma, quero extrair e validar o número (libphonenumber, BR), salvá-lo com `phone_source = informed_by_customer` e confirmar ao cliente.
- Como plataforma, quero enviar **um** lembrete após X minutos (job no `scheduler`) e depois marcar `phone_status = pending`.
- Como atendente, quero ver as mensagens de sistema ("Automação · coleta de telefone", "Telefone informado e cadastrado") e o alerta ⚠ na lista quando o telefone estiver pendente.
- Implementar como máquina de estados em `conversation.automationState` (`awaiting_phone` → `phone_collected` | `phone_skipped`).

#### E11 — Ferramentas de atendimento · **M** · depende de: E8 (card de pedido também depende de E7) · **✅ Feito**
- Como atendente, quero escrever **notas internas** (aba "Nota interna" no composer), exibidas em âmbar com borda tracejada e nunca enviadas ao cliente.
- Como atendente, quero usar **respostas rápidas** digitando `/` e escolhendo da lista. No MVP, cadastrá-las por seed ou por um formulário simples de admin.
- Como atendente, quero ver o **indicador da janela de 24h** (tempo restante) no WhatsApp e no Instagram, e o composer deve sugerir template quando ela fechar.
- Como atendente, quero ver o **card do pedido iFood** dentro da conversa (itens, taxa, total, status, horários).

#### E12 — Prontidão para produção · **M** · depende de: E1–E11 · **🟡 Parcial**
- Deploy (provedor/região a definir, preferencialmente `sa-east-1`), Postgres gerenciado com backup e PITR, Redis gerenciado.
- Logs Pino com `tenantId`, Sentry (front e back), health checks `/health/live` e `/health/ready`. **Sentry no ar em 30/10/2026** (projetos `dishdesk-api` e `dishdesk-web` na organização `dish-desk`).
- Painel Bull Board protegido. **No ar em 30/10/2026** em `/api/admin/filas` (usuário `admin`, senha em `BULL_BOARD_PASSWORD` na `api`).
- **Falta:** backup diário do banco (o Supabase está no plano Free, que não tem backup).
- Opt-out "SAIR"/"PARAR" registrado em `Consent`, mesmo antes do módulo Campanhas existir.
- Seed do tenant piloto, dos usuários e do canal.

### IA no atendimento (entrou no MVP em 29/10/2026)

O restaurante usa IA para atender o cliente de duas formas, **atendimento 100% com IA** (E27) ou **suporte com revisão por IA** (E28), e toda conversa em que a equipe respondeu recebe uma avaliação automática (E29). O módulo `AI` é ligado por restaurante pela plataforma.

**Decidido em 31/10/2026:** o Dish Desk é vendido com a IA logo de início. Todo restaurante novo já nasce com o módulo `AI` ligado (a plataforma ainda pode desligar; os que já existiam são ligados pelo painel). O menu de atendimento virou o último recurso: LLM principal → reserva (Claude Haiku) → menu. Quando as duas LLMs falham, aquele atendimento segue no menu até o fim, e o próximo volta para a IA.

Vale para os três épicos:
- A IA segue a **personalidade do atendimento** escolhida pelo restaurante (Configurações → Personalidade, CLAUDE.md §10), a mesma das mensagens automáticas.

#### E27 — Atendimento 100% com IA · **G** · depende de: E8, E15, E7 (busca do pedido) · **✅ Feito**
- Como restaurante, quero que a IA responda sozinha às conversas, no tom da personalidade do atendimento.
- Como cliente, quero tirar dúvidas de cardápio, horário de funcionamento, endereço e status do meu pedido sem esperar um atendente.
- Como cliente, quero pedir para falar com uma pessoa a qualquer momento e ser transferido.
- Como restaurante, quero que a IA **transfira para um atendente** quando não souber responder, quando o cliente reclamar ou quando o assunto estiver fora do que ela pode resolver (ex.: reembolso, cancelamento).
- Como atendente, quero assumir uma conversa que está com a IA. A partir daí a IA para de responder nessa conversa.
- Como atendente, quero ver na conversa quais mensagens foram escritas pela IA.
- **Regra obrigatória:** a IA só afirma o que está nos dados do restaurante (cardápio, horários, pedido). Nunca inventa preço, prazo, promoção ou política. Sem a informação, ela transfere.
- A IA respeita a janela de 24h e o opt-out, como qualquer mensagem enviada.
- **Primeira versão (24/10/2026, módulo `AI` ligado pela plataforma):** a IA atende no lugar do menu do WhatsApp e do Instagram (o entregador continua com o menu dele), com horário, links para pedir e o pedido recente do cliente; não anota pedidos; transfere com o restaurante fechado deixando a conversa pendente; até 8 respostas por atendimento; sem a LLM, chama a equipe. O atendente que responde tira a IA da conversa até o próximo atendimento.
- A definir na implementação:
  - ~~o que acontece quando a IA transfere e não há atendente online~~ **Decidido em 24/10/2026:** sem atendente (restaurante fechado, ninguém com o Dish Desk aberto ou o **100% automático** ligado pelo administrador na tela inicial da Inbox), a IA responde tudo e não chama a equipe; quando o cliente precisa de alguém, ela avisa que no momento não há atendentes e que a conversa vai para um assim que houver. A conversa fica pendente, esperando; quando o restaurante abre, alguém abre o Dish Desk ou o 100% automático é desligado, ela vai para a equipe com o alarme de sempre;
  - os limites por conversa (nº de mensagens da IA antes de transferir).

#### E28 — Suporte com revisão por IA · **M** · depende de: E8, E15 · **✅ Feito**
- Como atendente, quero escrever a resposta do meu jeito e pedir para a IA **ler a conversa e adaptar o meu texto** para a linguagem e a personalidade do restaurante.
- Como atendente, quero ver o texto adaptado antes de enviar e poder aceitar, editar ou manter o meu original. Nada é enviado sem a minha confirmação.
- Como restaurante, quero que a IA corrija ortografia, clareza e tom, **sem mudar o conteúdo**: valores, prazos e promessas ficam como o atendente escreveu.
- ⚠️ O design do composer ainda não tem a revisão por IA. A tela precisa ser desenhada antes da implementação.
- **Decidido em 24/10/2026 (teste com LLM local):** a revisão é **automática a cada envio**, sem prévia: o texto revisado sai direto e o original fica visível só para a equipe ("ver original" no balão). Se a revisão mudar ou acrescentar um número, horário, valor, link ou @, sai o texto do atendente. Isso substitui o "nada é enviado sem a minha confirmação" acima.
- Como atendente, quero pedir à IA uma **sugestão de resposta** quando ainda não escrevi nada: o texto entra no composer, eu edito e envio (a revisão vale como para qualquer resposta). Nada é enviado sozinho.
  - **Decidido em 25/10/2026:** botão "Sugerir com IA" no composer, ativo com o campo vazio. A sugestão só usa os dados do restaurante e da conversa; com um número, horário, valor, link ou @ que não está neles, ela é descartada. API (`POST /conversations/:id/suggestion`) e tela (board "Inbox · Composer · Sugerir com IA") feitas.

#### E29 — Avaliação automática da conversa · **M** · depende de: E8 · **✅ Feito**
- Como plataforma, quero que uma LLM leia a conversa quando ela for resolvida e registre:
  - se **o problema foi resolvido**;
  - se **o cliente ficou satisfeito**;
  - uma **nota para o atendimento**, de acordo com a reação do cliente.
- Como admin, quero ver a avaliação na conversa e filtrar as conversas com nota baixa ou problema não resolvido.
- Como admin, quero ver a nota média por atendente e por período.
- Como plataforma, quero a avaliação rodando em **job assíncrono** (fila própria no `worker`), fora do caminho do atendimento. Uma falha na avaliação nunca atrasa nem bloqueia a conversa.
- **Primeira versão (24/10/2026):** roda 5 minutos depois de resolvida (ou encerrada por inatividade) e avalia o que veio depois da última avaliação da conversa; reaberta antes disso, espera a próxima resolução. Nota de 1 a 5, resolvido, satisfeito (ou sem reação) e um resumo; aparece na conversa e na aba Avaliações, só para administradores. Modelo em teste: Gemma 4 12B local (Ollama).
- **Só com a equipe (02/11/2026):** para reduzir chamadas à IA, só são avaliados os atendimentos em que alguém da equipe respondeu ao cliente. Nota interna ou resolver sem responder não contam. O atendimento sem resposta da equipe não recebe nota, só fica registrado (`ai_only_attendances`), para o relatório seguir mostrando quantos a IA resolveu sozinha. Falhas da IA nesses atendimentos não aparecem mais nas Avaliações.
- **Avaliação pelo Jev (07/11/2026):** a LLM saiu da avaliação. O Jev (modelo de decisão da TypeSafe AI, pelo OpenRouter, o mesmo da defesa da API) responde resolvido, reação, nota de 1 a 5 e motivo de precisar da equipe, sem texto: as avaliações novas não têm resumo (as antigas mantêm o delas). Na aba Avaliações, a coluna do resumo virou "Motivo". A conversa vai ao OpenRouter com `data_collection: "deny"` (só provedores que não guardam os dados para treino). Sem `JEV_API_KEY`, os atendimentos não são avaliados.
- A definir na implementação:
  - a escala da nota (ex.: 1 a 5) e os critérios de cada nível;
  - o que fazer com conversas sem reação do cliente (ex.: cliente que parou de responder);
  - se a conversa reaberta é avaliada de novo.

### Ordem de implementação sugerida (Fase 1)

```
1. E1 Fundação
2. E2 Dados + multi-tenancy           (RLS e teste de vazamento desde o dia 1)
3. E3 Auth  ∥  E4 Pipeline            (em paralelo se houver 2 devs)
4. E5 WhatsApp                         → primeiro canal ponta a ponta
5. E8 Inbox                            → validar o fluxo completo com WhatsApp
6. E9 Contatos + painel lateral
7. E11 Notas, "/", janela 24h          (card iFood fica para depois de E7)
8. E6 Instagram                        (assim que o App Review sair)
9. E7 iFood + card de pedido
10. E10 Coleta de telefone              (só faz sentido com Instagram/iFood ativos)
11. E12 Prontidão para produção
12. E29 Avaliação → E28 Revisão por IA → E27 Atendimento 100% com IA
```

O WhatsApp vem primeiro porque é o único canal que não depende de aprovação longa e que entrega telefone. Ele valida o pipeline inteiro antes de entrarem os canais mais incertos.

Na IA, a avaliação (E29) vem primeiro porque não envia nada ao cliente (o risco é o menor) e porque cria a medida que vai dizer se os outros dois funcionam. A revisão (E28) vem em seguida porque mantém o atendente no controle. O atendimento 100% com IA (E27) fica por último: é o de maior risco e só deve ser ligado quando a nota do E29 mostrar que a IA atende tão bem quanto a equipe. Com a IA ligada de saída (31/10/2026), a nota do E29 passa a acompanhar a qualidade da IA, em vez de decidir quando ligá-la.

### Critérios de aceite do MVP (piloto em produção)

- [ ] Atendente faz login, escolhe o restaurante e só vê dados desse tenant (teste de vazamento verde no CI).
- [ ] Mensagem de WhatsApp recebida aparece na Inbox em **menos de 3 s**, sem recarregar a página.
- [ ] Atendente responde pelo WhatsApp e vê o status mudar até "lido".
- [ ] Fora da janela de 24h, só é possível enviar template aprovado.
- [ ] DM do Instagram recebida e respondida pela mesma Inbox (com o App Review aprovado).
- [ ] Pedido do iFood cria ou atualiza o contato, aparece como card na conversa e atualiza o status.
- [ ] Contato sem telefone recebe a mensagem de coleta; o número informado é validado e salvo no cadastro.
- [ ] Um mesmo cliente que chega por dois canais com o mesmo telefone vira **um** contato.
- [ ] Nota interna nunca é enviada ao cliente.
- [ ] Respostas rápidas funcionam com `/`.
- [ ] Atribuir e resolver conversa funcionam e refletem em tempo real para os outros atendentes.
- [ ] Webhook duplicado não duplica mensagem.
- [ ] CPF é exibido mascarado e fica criptografado no banco.
- [ ] Erros vão para o Sentry; backup diário do banco está ativo.
- [ ] Usuário membro de 2+ restaurantes escolhe entre um restaurante e o painel master. No master vê as conversas só dos seus restaurantes e consegue respondê-las.

---

## Fase 2 — Pós-MVP imediato

#### E13 — Clientes: lista, detalhe e merge · **G** · depende de: E9 · **✅ Feito**
- Como atendente, quero uma lista de clientes com busca e filtros (tag, canal de origem, bairro, telefone pendente, último contato).
- Como atendente, quero uma página de detalhe com histórico de conversas e pedidos.
- Como admin, quero ver os "possíveis duplicados" sinalizados e fazer o **merge** de contatos (identidades, conversas e pedidos migram).
- Como admin, quero exportar e anonimizar os dados de um cliente (direitos do titular, LGPD).

#### E14 — Tela de Canais · **G** · depende de: E5, E6, E7 · **✅ Feito**
- Como admin, quero conectar o WhatsApp via **Embedded Signup** da Meta.
- Como admin, quero conectar o Instagram pelo login da Meta.
- Como admin, quero cadastrar as credenciais do iFood (merchant).
- Como admin, quero ver a saúde de cada canal (conectado, erro, token expirando) e reconectar.

#### E15 — Configurações do restaurante · **M** · depende de: E3, E10 · **✅ Feito**
- Como admin, quero configurar o horário de funcionamento e a mensagem automática fora do horário.
- Como admin, quero editar os textos automáticos (coleta de telefone, lembrete, confirmação, boas-vindas).
- Como admin, quero convidar, desativar e mudar o papel de usuários.
- Como admin, quero gerenciar as respostas rápidas.

#### E16 — Painel Super Admin · **M** · depende de: E2, E3 · **🟡 Parcial**
- Como super admin, quero criar, suspender e reativar tenants, e atribuir plano e módulos.
- Como super admin, quero ver o uso por tenant (mensagens, conversas, canais).
- Como super admin, quero entrar no painel de um tenant para suporte (impersonação **auditada**).

#### E17 — Estados de erro, offline e canal desconectado · **M** · depende de: E8, E14 · **✅ Feito**
- Como atendente, quero um aviso claro quando perder a conexão (socket), com reconexão automática e reenvio das mensagens pendentes.
- Como atendente, quero um banner quando um canal estiver desconectado, com link para reconectar (admin).
- Como atendente, quero estados vazios e de erro em todas as telas principais (Inbox, Clientes, Canais).
- Como atendente, quero que mensagens que falharam ofereçam "tentar novamente".

#### E18 — Inbox versão tablet (1024px) · **M** · depende de: E8, E9 · **⬜ A fazer**
- Como atendente em tablet, quero a Inbox com a lista recolhível e o painel do cliente como gaveta (drawer).

#### E26 — Previsão de saída do pedido · **M** · depende de: E7 concluído (iFood homologado), busca do pedido pelo número · **✅ Feito**
- Como cliente, quero receber uma **previsão de saída do restaurante** junto com a confirmação do meu pedido, enquanto ele ainda não saiu (recebido, confirmado ou em preparo).
- Como atendente, quero ver a mesma previsão no card do pedido, para responder "quando chega?" sem perguntar à cozinha.
- Como cliente, quero saber **quantos pedidos estão na minha frente em produção**: os feitos antes do meu que ainda não saíram, sem contar os cancelados. É **opcional para o restaurante**: o admin liga ou desliga em Configurações → Mensagens automáticas.
- Como plataforma, quero calcular o tempo de preparo a partir dos **últimos pedidos que já saíram** (`dispatchedAt − placedAt`), usando uma medida robusta a extremos (ex.: mediana). Assim a previsão acompanha o ritmo real da cozinha naquele momento.
- **Regra obrigatória:** a previsão nunca pode ser menor que o tempo já decorrido desde o pedido. Se o pedido já passou do tempo típico, a previsão é recalculada só com os pedidos que demoraram mais que o tempo já decorrido. Sem base para isso, a previsão é "agora + margem". Nunca informar um horário que já passou.
- A definir na implementação:
  - a janela de pedidos usada (ex.: os últimos N do dia ou as últimas 2 h);
  - o que fica de fora (pedidos agendados, retirada no balcão, cancelados);
  - o valor padrão quando ainda há poucos pedidos no dia (tempo informado pelo iFood ou configurado pelo restaurante);
  - se pedidos de outros canais (Cardápio Web) entram na base e na contagem da fila, já que a cozinha é a mesma;
  - se a contagem da fila vem ligada ou desligada para restaurantes novos.
- Fora do escopo: o tempo de entrega (trajeto). A previsão é só de **saída** do restaurante.

### Reputação e avaliações (E32–E39)
Inspiração: Super Avaliações ([superavaliacoes.com.br](https://superavaliacoes.com.br/)), analisado em 29/10/2026. Ficam de fora por decisão:
- pedir avaliação do Google só a quem ficou satisfeito, e dar brinde ou cupom em troca de avaliação. As regras do Google proíbem as duas coisas.
- 99Food e Keeta, que esperam haver restaurante usando.
- conexão via MCP com ferramentas de IA de fora.

#### E32 — Convite de avaliação no iFood · **M** · depende de: E7, chat do iFood pela extensão ([docs/plano-chat-ifood.md](docs/plano-chat-ifood.md)) · **🟡 Construído em 02/11/2026; falta o teste numa loja real (desligado por padrão)**
Problema: menos de 5% dos pedidos do iFood recebem avaliação. Quem teve problema avalia, e quem gostou raramente avalia. O pedido de avaliação do próprio app do iFood não basta.
- Como restaurante, quero que o Dish Desk escreva no chat do pedido do iFood, **10 minutos depois da entrega**, pedindo ao cliente que avalie a loja no app do iFood.
- Como restaurante, quero ligar ou desligar o convite em **Configurações → Personalidade → Mensagens sobre o pedido**. O texto segue a personalidade do atendimento (CLAUDE.md §10).
- **Decidido em 29/10/2026:**
  - **Quando sai:** entrega (`deliveredAt`) + 10 min. Sem horário de entrega, o horário prometido (`promisedAt`) + 10 min. Sem nenhum dos dois, não há convite.
  - **Quem fica de fora:** o pedido cancelado e o que com certeza atrasou, isto é, foi entregue depois do horário prometido pelo iFood. Atraso desconhecido não tira o convite.
  - **Frequência:** um convite a cada pedido, sem limite por cliente.
  - **Envio:** o iFood não tem API de chat, então quem envia é o painel com a extensão. Só sai se houver painel aberto na hora; sem painel, o convite é descartado (sem fila, sem reenvio).
  - **Inbox:** o convite não aparece nela. Se o cliente responder, segue o fluxo normal: sem IA, a conversa abre e a equipe é chamada; com IA, ela analisa, responde se precisar e chama a equipe se o cliente quiser.
  - **Onde fica guardado:** uma tabela própria (`ReviewInvite`) com um convite por pedido, o desfecho (enviado, pulado e por quê, descartado sem painel, falhou) e as horas. Entra na RLS e no teste de isolamento entre tenants.
- **Decidido na implementação (02/11/2026):**
  - **Disparo:** varredura por minuto ([review-invite.service.ts](apps/api/src/automations/review-invite.service.ts)), que também registra os desfechos.
  - **Espera por um painel:** 30 minutos; depois disso, o convite é descartado. A varredura olha os pedidos das últimas 24 horas.
  - **Sem aviso de entrega:** pedido que ainda não saiu da loja no horário prometido + 10 min fica de fora (`not_delivered`), porque com certeza atrasou.
  - **Pesquisa de satisfação:** saiu do iFood no lugar do convite; continua no WhatsApp e no Instagram.
  - **Chat certo:** o convite vai para o pedido dele e só abre a conversa com o nome do cliente do pedido; sem esse nome na lista do widget, registra a falha e não digita em nenhuma.
  - **Inatividade e resposta rápida:** o convite não é mensagem, então não agenda encerramento. A leitura do widget deixa o balão dele fora da cópia, e a resposta do cliente segue como conversa nova.
- A conferir numa loja real antes de ligar (o desfecho fica em `review_invites`, com o motivo em `reason`):
  - **Escrever primeiro:** se um pedido sem mensagens aparece na lista de chats do widget, e se o chat aceita mensagem 10 minutos depois da entrega. Hoje a extensão só abre chats que já estão na lista ([ifood-chat-driver.ts](apps/web/lib/ifood-chat-driver.ts)).
  - **Nome do cliente:** se o nome que o widget mostra é igual ao `raw.customer.name` do pedido. Se não for, os convites falham com "O chat deste pedido não está aberto no widget do iFood.", sem digitar em conversa errada.
  - **Horário de entrega:** quantos pedidos de fato recebem `deliveredAt`, por tipo de frota.
  - **Regras do iFood:** se a política dele permite pedir avaliação no chat em todo pedido.
- Medição: avaliações ÷ pedidos do iFood por loja e período, na aba Avaliações → iFood. Depende da homologação do módulo Review ([docs/pendencias-producao.md](docs/pendencias-producao.md)).
- Fora do escopo: envio por WhatsApp ou em massa (fica para o módulo de disparos) e outras plataformas sem chat.

#### E33 — Avisos de andamento para todos os pedidos do iFood · **M** · depende de: E32 (a extensão escrever primeiro) · **⬜ A fazer**
- Como cliente do iFood, quero receber no chat do pedido os avisos de "pronto", "saiu para entrega" e de atraso (E26), mesmo sem ter escrito para a loja. Hoje esses avisos só chegam a quem já conversou com ela ([order-notice.service.ts](apps/api/src/orders/order-notice.service.ts)).
- Como restaurante, quero ligar ou desligar esses avisos em Configurações → Personalidade → Mensagens sobre o pedido.
- A definir: quais avisos vão para todos e como evitar repetir a mensagem que o sistema da loja já manda ("Seu pedido acaba de ser entregue 🥳…").

#### E34 — Alerta de avaliação negativa · **P** · depende de: homologação do módulo Review do iFood · **⬜ A fazer**
- Como gerente, quero ser avisado quando chegar uma avaliação com nota baixa, com o pedido e o cliente.
- Como atendente, quero abrir o cadastro do cliente a partir da avaliação, para tratar o problema como um atendimento.
- A definir: a nota que dispara o alerta e onde ele aparece (notificação no Dish Desk, e-mail).

#### E35 — Resumo diário de reputação · **P** · depende de: homologação do módulo Review do iFood · **⬜ A fazer**
- Como dono, quero receber todo dia um resumo com a nota do dia, as avaliações novas e as negativas ainda sem resposta, com o prazo de 5 dias do iFood para responder.
- A definir: o canal (e-mail ou o WhatsApp do próprio dono; não é disparo para cliente) e o horário.

#### E36 — Avaliações do Google · **G** · depende de: E14 · **⬜ A fazer**
- Como restaurante, quero conectar o Google Meu Negócio e ver as avaliações do Google na aba Avaliações, ao lado das do iFood.
- Como atendente, quero responder as avaliações do Google pelo Dish Desk, com resposta sugerida pela IA, como no iFood.
- Regra 9 do CLAUDE.md: verificar se dá para importar contatos. O Google não traz o telefone de quem avalia.

#### E37 — Pesquisa no salão por QR Code · **M** · depende de: E13 · **⬜ A fazer**
- Como cliente no salão, quero ler um QR Code na mesa e responder uma pesquisa curta (nota de 0 a 10, a NPS, e um comentário).
- Como restaurante, quero que quem responde e informa o telefone vire contato na base, com opt-in, para aumentar a base do módulo de Campanhas.
- Como admin, quero ver a NPS por período na aba Avaliações.

#### E38 — Assistente de dados da operação · **M** · depende de: E27 (a IA local) · **⬜ A fazer**
- Como dono, quero perguntar em linguagem natural sobre a operação ("quantas avaliações ruins essa semana?", "qual loja cancelou mais pedidos?") e receber a resposta com os números dos relatórios.
- A IA só responde a partir dos dados do restaurante. Sem a informação, diz que não sabe (mesma regra do E27).

#### E39 — Comentários do Instagram · **G** · depende de: E6, E27 (a IA local), App Review da Meta com a permissão `instagram_manage_comments` · **⬜ A fazer**
- Como atendente, quero ver numa tela os comentários dos posts e reels do perfil do restaurante e responder por ela.
- Como restaurante, quero que a IA responda os comentários no tom da personalidade do atendimento, inclusive os depreciativos, com uma resposta educada que não discute com o cliente. Quando a IA não souber responder (reclamação de pedido, pergunta sem informação), o comentário fica para a equipe, como no E27.
- Como restaurante, quero que a IA marque os comentários depreciativos (ofensa, deboche, ataque à marca) para eu ver separados dos outros.
- Como admin, quero **restringir** quem faz comentários depreciativos: os comentários novos dessa pessoa ficam ocultos para o público, sem ela ser avisada. Quero também ver a lista de restritos e desfazer a restrição.
- A conferir antes de construir:
  - **Restringir pela API:** a API do Instagram permite responder, ocultar e apagar comentários, mas não achei o "Restringir" do app nela. **Decidido em 29/10/2026:** se a API não tiver como restringir, a restrição é feita pelo Dish Desk, ocultando todo comentário novo do usuário restrito assim que ele chega.
  - **Permissão da Meta:** a `instagram_manage_comments` precisa entrar na análise do app junto com as do Direct ([docs/pendencias-producao.md](docs/pendencias-producao.md)).
- A definir:
  - se a IA responde sozinha ou sugere a resposta para a equipe aprovar (como no E28), e se isso muda para os comentários depreciativos;
  - se o comentário depreciativo também é ocultado na hora, além de respondido.
- Regra 9 do CLAUDE.md: quem comenta vira contato, pelo usuário do Instagram, como no Direct.

**Ordem sugerida (reputação):** `E32 Convite → E33 Avisos para todos → E34 Alerta negativo + E35 Resumo diário → E36 Google → E37 Salão → E38 Assistente`. O E33 aproveita o trabalho do E32 na extensão. O E34 e o E35 entram assim que o módulo Review for homologado. O **E39 (comentários do Instagram)** não depende dos outros e pode entrar assim que a Meta aprovar a permissão de comentários.

### Prevenção de fraude (E40)
O alerta na Inbox (board "Prevenção de fraude · Inbox e Landing"): o pedido de um cliente que já cancelou algum pedido abre a conversa com o alerta, o pedido e a lista de cancelamentos; o atendente decide entre manter e cancelar. A tag manual "Cancelamento recorrente" continua existindo, à parte.

#### E40 — Prevenção de fraude: histórico completo e cancelamento em todas as integrações · **G** · depende de: E7, integração do Cardápio Web · **🟡 Parcial**
- **Falta:**
  - **Testar com a API real do Cardápio Web:** o cancelamento e o histórico de pedidos só rodaram contra uma API falsa, feita a partir da documentação. Da última vez, a API real tinha limites que a documentação não contava.
  - **iFood real:** cancelar um pedido de uma loja real pelo Dish Desk. Até aqui, só com API falsa.
  - **Anota AI:** nasce com o histórico e o cancelamento, se a API permitir, quando a integração existir.
- **Decidido ao implementar (02 e 03/11/2026):**
  - **Cancelamento do iFood:** tem trava própria, `IFOOD_ORDER_CANCEL`, ligada na `api` da Railway em 03/11/2026 por decisão do usuário. Ela libera só o cancelamento; confirmar, marcar pronto, despachar e responder negociação seguem em `IFOOD_ORDER_ACTIONS`. A documentação do iFood avisa que cancelamentos em excesso geram penalidades, como fechar a loja temporariamente.
  - **Pedidos antigos do iFood:** o módulo Order só tem consulta por id e os eventos do polling, sem listagem por loja (conferido na documentação em 03/11/2026). Por isso não há importação.
  - **Recurso no iFood:** a API não tem rota para recorrer de cancelamento. Só existe a Plataforma de Negociação, para o que o cliente abre: aceitar, recusar ou contraproposta. A contraproposta não foi feita no Dish Desk.
  - **Endereço:** condomínio, bloco e apartamento são procurados em todos os campos, não só no complemento, em qualquer ordem e abreviação ([address-key.ts](apps/api/src/orders/address-key.ts)). Bairro e CEP não entram, porque a grafia varia entre os sistemas.
  - **Pedido sem conversa:** como iFood e Cardápio Web não abrem conversa, é o caso mais comum. Abre uma conversa só da equipe, em que só cabem notas. Se o cliente escrever no chat do iFood, ela vira uma conversa normal.
  - **Marcar como fraude:** vale também para pedido já cancelado e pode ser removida. Decisão do usuário: pedido que não foi cancelado não fica marcado. No Cardápio Web, a marca vale na hora, porque a API confirma o cancelamento na resposta. No iFood, a marca só vale quando ele confirmar; se recusar, o pedido volta a ter alerta, sem marca.
  - **Histórico importado:** só os cancelados do Cardápio Web, até 3 anos ou até a API recusar o período. Eles não entram nos relatórios, nas tags, nos totais da lista de Clientes nem em "Chateados". Cada pedido exige uma consulta, por isso só os cancelados: isso substitui, para este caso, a decisão de 07/10 de não contar pedido a pedido.
  - **Progresso e aviso da importação:** mostra os cancelamentos importados e o período percorrido, porque a API não informa o total de pedidos. O aviso de fim só aparece com a tela aberta: o produto não tem e-mail nem sino para isso.
  - **Cancelado fora do Dish Desk:** a linha só aparece sem decisão da equipe e sem pedido de cancelamento no histórico do pedido. Na dúvida, não aparece. Um pedido antigo cancelado pela equipe, sem esse evento, ainda pode mostrá-la.
  - **Lista de Clientes:** Pedidos, Total e a ordenação por pedidos deixam de fora os cancelados e os importados, como o detalhe. O detalhe também soma cadastros ligados por telefone, CPF ou e-mail; a lista conta só o próprio cadastro, por decisão do usuário.
  - **Bloco do endereço:** mostra data, motivo e quem marcou, sem nome, telefone nem itens do outro cliente.
  - **LGPD:** anonimizar o cliente apaga o endereço marcado e o motivo; a marca deixa de valer para aquele endereço.
  - **Só contadores:** o estado do board para fontes que só têm totais não foi feito, porque nenhuma integração atual é assim.
- **Decidido em 01/11/2026:**
  - **Quando dispara:** um cancelamento no histórico já basta, sem janela de tempo (golpista não costuma pedir várias vezes seguidas). Quem decide se o pedido segue é o atendente.
  - **Qualquer histórico conta:** o do Dish Desk, de todas as fontes ligadas ao cliente (telefone, CPF, e-mail; [customer-history.ts](apps/api/src/orders/customer-history.ts)), e o que vier importado de uma integração.
  - **Sem API para cancelar:** o botão "Cancelar pedido" não aparece; no lugar, um aviso para cancelar no sistema de origem.
  - **Pagamento online não é proteção:** golpista costuma preferir o pagamento online, então o Dish Desk não sugere nem exige pagamento online de quem tem cancelamentos.
  - **Motivo à vista:** todo cancelamento conta, não importa quem cancelou. O que ajuda o atendente é ver o **motivo** de cada um na lista (ex.: "não veio retirar o pedido" num pedido para retirada, "ninguém recebeu na entrega"). Cada integração precisa guardar o motivo no pedido.
  - **Marcar como fraude:** ao cancelar, o atendente pode marcar o pedido como fraude (fica guardado no pedido, com quem marcou). Os próximos pedidos, de qualquer cliente, para o **mesmo endereço** mostram esse pedido no alerta. O endereço precisa ser idêntico: rua, número, condomínio, bloco e apartamento iguais (comparação normalizada, sem diferenciar maiúsculas, acentos e abreviações como "R." e "Rua"). Endereço parecido não conta.
- Como restaurante, quero que o **histórico de pedidos de antes da conexão** entre na conta do alerta. Hoje a importação traz só o cadastro do cliente, sem pedidos:
  - **Cardápio Web:** a base de clientes importada não tem pedidos, e a consulta de pedidos volta no máximo 24 h. Perguntar ao Cardápio Web se a API tem pedidos antigos (por cliente ou por data) ou um resumo no cadastro do cliente (total de pedidos e de cancelamentos). Se tiver, importar junto com a base de clientes.
  - **iFood:** a Merchant API só entrega pedidos novos (polling de eventos). Conferir se há como consultar pedidos antigos da loja.
  - **Anota AI:** quando a integração existir, já nasce importando o histórico de pedidos, se a API permitir (CLAUDE.md §9).
  - Cancelamento importado conta como os outros e aparece na lista com a origem e a data. Se a fonte só tiver contadores (sem cada pedido), o alerta mostra o número e a origem, sem a lista.
- Como atendente, quero **cancelar pelo Dish Desk** o pedido de qualquer integração:
  - **iFood:** pronto no cliente da API (`cancellationReasons` e `requestCancellation` em [ifood.client.ts](apps/api/src/connectors/ifood.client.ts)); o botão só aparece quando o iFood devolve motivos (vazio = não dá para cancelar agora).
  - **Cardápio Web:** o cliente da API não tem cancelamento. Conferir se a API de parceiros tem um endpoint para cancelar o pedido; se tiver, ligar o botão. Até lá, vale o aviso.
  - **Anota AI:** mesma conferência quando a integração existir.
- Como cliente, quero receber a mensagem de cancelamento no tom da personalidade do restaurante (CLAUDE.md §10), na conversa do canal de onde o pedido veio.
- A definir:
  - **mobile e tablet:** o alerta e o painel do pedido entram na Inbox para tablet (E18) e na versão mobile, depois do MVP.

### Entregadores (E47)

#### E47 — Recado do cliente para o entregador · **M** · depende de: E27, E7 (evento `ASSIGN_DRIVER` com o telefone do entregador), menu do entregador · **⬜ A fazer**
Pedido do usuário em 12/11/2026, a partir da análise do dia 11/11 do Grupo Moby Dick ([docs/plano-correcoes-11-11.md](docs/plano-correcoes-11-11.md), com a lista dos recados no fim).
- **Por quê:**
  - Em 11/11 foram cerca de 20 recados de clientes para o entregador, o motivo mais comum de a IA chamar a equipe. Exemplos: "deixa na recepção", "interfona", "buzina e bate no portão", "quarto 202", "o código é 0084".
  - A equipe os copiava à mão para o entregador pelo WhatsApp do celular. Em 2 casos a IA prometeu passar o recado e ninguém passou.
  - 243 dos 257 pedidos do dia traziam o nome e o telefone do entregador no `ASSIGN_DRIVER` (frota própria pelo Foody Delivery).
- Como cliente, no chat do iFood ou no WhatsApp com o pedido confirmado, quero mandar um recado para o entregador e saber que ele recebeu.
- Como restaurante, quero que a IA identifique o recado e o mande ao entregador do pedido, pelo WhatsApp que atende a loja, sem chamar a equipe.
  - Contam como recado: instrução de entrega (portaria, recepção, interfone, buzina, quarto, ponto de referência), código de entrega e "estou descendo".
  - A mensagem ao entregador leva o número do pedido e as palavras do cliente.
  - A IA confirma ao cliente que o recado foi passado.
- Como atendente, quero ver o recado nas duas conversas (a do cliente e a do entregador), como evento.
- **Sem como passar:** pedido ainda sem entregador, sem o telefone dele ou já concluído, ou plataforma que não informa o entregador (Cardápio Web). A IA passa para a equipe, como hoje, com o motivo "Recado para o entregador".
- As mensagens novas (ao entregador e a confirmação ao cliente) entram em `AutomationMessages`, uma por personalidade (CLAUDE.md §10).
- Fora do escopo por enquanto: levar a resposta do entregador de volta ao cliente. A resposta dele cai no menu do entregador.
- A definir: se o recado também vale para o entregador do iFood (sem frota própria), que não tem telefone no pedido.

#### E30 — Assistente de configuração (primeiro acesso) · **M** · depende de: E14, E15 · **✅ Feito**
- Como admin de um restaurante novo, quero um **assistente passo a passo** no primeiro acesso, que me ensine a configurar o sistema até a primeira mensagem chegar na Inbox.
- **Regra obrigatória:** antes de cada integração, o assistente **pergunta se o restaurante vai usar aquele sistema** ("Você atende pelo WhatsApp?", "Você vende pelo iFood?"). Com "sim", abre o passo a passo daquela integração. Com "não" ou "agora não", pula para a próxima. Nenhuma integração é obrigatória.
- Integrações, nesta ordem:
  - **WhatsApp:** conecta o número pelo QR Code (Evolution API, como no WhatsApp Web), que substituiu a API oficial em 21/10/2026.
  - **Instagram:** explica que a conta precisa ser Profissional e vinculada a uma Página, e conecta pelo login da Meta.
  - **iFood:** conecta a loja (merchant) para os pedidos e ensina a instalar a extensão do Chrome que leva o chat do iFood para a Inbox.
  - **Cardápio Web:** mostra onde gerar a chave no Portal (Configurações → Integrações → API) e onde colá-la.
  - **Anota AI** *(pendente)*: entra no assistente quando a integração existir. Até lá, não aparece.
- Como admin, quero que cada passo **confira a conexão** antes de avançar (a mesma conferência de Configurações → Integrações) e me diga o que corrigir quando falhar.
- Como admin, quero, depois das integrações, ser guiado pelo resto da configuração: horário de funcionamento, personalidade do atendimento e mensagens automáticas, links para fazer pedido e convite dos atendentes.
- Como admin, quero ver o progresso, **sair e continuar depois** de onde parei, e reabrir o assistente em Configurações (por exemplo, para ligar uma integração que pulei).
- Como plataforma, quero que o assistente **reutilize** as telas e as validações de Configurações → Integrações (E14) e de Configurações (E15), sem duplicar formulários.
- Ao concluir uma integração, oferecer a **importação dos contatos** daquele sistema, quando ele permitir (CLAUDE.md §9).
- **Feito em 25/10/2026** (board "Configurações · Assistente de configuração"): tela `/assistente`, aviso "Termine a configuração" na Inbox (abre sozinho no 1º acesso) e entrada em Configurações → Links de pedido. Os passos usam as próprias abas de Configurações e a conexão de Integrações (QR Code no próprio passo; o login do Instagram volta ao assistente). Ajuste: a base do Cardápio Web já é importada ao conectar, então o passo avisa em vez de perguntar.
- **Decidido em 25/10/2026:** o assistente abre sozinho no primeiro login do admin e, até terminar, a Inbox mostra o aviso "Termine a configuração"; o que depende de terceiros deixa o passo "em andamento" e avisa o admin quando sair; é só do admin (atendentes sem tour).
- **API pronta (25/10/2026):** `GET /onboarding/:tenantId` (o progresso vem do que o restaurante tem: integrações conectadas, configurações salvas, primeira mensagem de cliente), `PUT /onboarding/:tenantId/steps/:step` (pular, manter o padrão, em andamento) e `POST /onboarding/:tenantId/opened`. Faltam as telas e o aviso ao admin quando um passo em andamento terminar.

### Ordem sugerida (Fase 2)
`E14 Canais → E17 Estados de erro → E15 Configurações → E30 Assistente de configuração → E13 Clientes/merge → E18 Tablet → E16 Super Admin`

Canais vem primeiro porque elimina o onboarding manual por script, que é o gargalo para o 2º restaurante. O assistente de configuração (E30) vem logo depois de Configurações porque só guia o admin pelas telas do E14 e do E15. O Super Admin vem por último porque, com poucos tenants, o seed e o banco resolvem. O **E26 (previsão de saída)** entra logo depois que a integração com o iFood (E7) estiver concluída e homologada, independentemente da ordem acima. O **E47 (recado para o entregador)** não depende dos outros e pode entrar a qualquer momento.

---

## Fase 3 — Módulo Campanhas (add-on pago)

#### E19 — Controle de acesso ao módulo + estado bloqueado · **P** · depende de: E16 · **🟡 Parcial**
- Como plataforma, quero `TenantModule` + guard `@RequiresModule('campaigns')` na API e uma feature flag no front.
- Como admin sem o módulo, quero ver o **estado bloqueado** do design ("Módulo bloqueado", preço, botões "Ativar módulo Campanhas" e "Falar com o suporte").

#### E20 — Segmentos · **M** · depende de: E13 · **⬜ A fazer**
- Como admin, quero criar segmentos salvos (sem pedido há N dias, aniversariantes, tag, canal, bairro) e ver a contagem de contatos.
- O segmento só inclui contatos com **opt-in de marketing no WhatsApp**.
- Como admin, quero a **matriz RFV** (recência, frequência e valor; método da Repediu): cada cliente cai sozinho num grupo (campeões, fiéis, promissores, em risco, perdidos), que se atualiza conforme ele compra ou para de comprar. Os grupos viram segmentos prontos.
- Como admin, quero filtrar pelo **produto preferido** (o que o cliente mais pede no cardápio próprio, E41, e nas integrações), para oferecer o que ele já gosta.

#### E21 — Templates WhatsApp · **M** · depende de: E5, E14 · **⬜ A fazer**
- Como admin, quero criar templates, enviá-los para aprovação da Meta e acompanhar o status.
- Como admin, quero usar variáveis (`{{nome}}`, `{{cupom}}`) e ver o preview no celular.

#### E22 — Criação de campanha em etapas · **M** · depende de: E20, E21 · **⬜ A fazer**
- Como admin, quero criar a campanha em 4 passos: **segmento → template → pré-visualizar → agendar**.
- Como admin, quero salvar rascunho e ver a lista de campanhas com status (Rascunho, Agendada, Enviando, Concluída) e abas.
- Como admin, quero que a campanha leve o **link do cardápio próprio** (E41) com o **cupom** (E44) já aplicado, e que o cliente possa responder e pedir pela IA na mesma conversa (E43).

#### E23 — Motor de disparo · **G** · depende de: E22 · **⬜ A fazer**
- Como plataforma, quero a fila `campaigns` com workers próprios e prioridade **menor** que o atendimento.
- Como plataforma, quero rate limit por número (token bucket no Redis) e respeito ao tier de mensagens da Meta.
- Como admin, quero **pausar e cancelar** uma campanha em andamento.
- Como plataforma, quero que o opt-out "SAIR"/"PARAR" remova o contato das próximas campanhas.

#### E24 — Relatório de campanha · **M** · depende de: E23 · **⬜ A fazer**
- Como admin, quero ver enviadas, entregues, lidas, respondidas, falhas e opt-outs, o funil de engajamento e o progresso em tempo real (com estimativa de término).
- Como admin, quero ver o custo estimado (mensagens de marketing cobradas pela Meta).

#### E25 — Faturamento · **G** · depende de: E19 · **🟡 Parcial**
- Como admin, quero ativar o módulo Campanhas e pagar a assinatura (gateway a definir: Asaas, Pagar.me ou Stripe).
- Como plataforma, quero que o módulo seja ativado ou desativado conforme o status do pagamento (`expiresAt`).
- Decidir antes: o custo das mensagens Meta fica na conta do restaurante ou é intermediado pela plataforma? (especificação §14)

### Métodos da Repediu (pesquisa de 11/11/2026)
Pedido do usuário em 11/11/2026: o disparo de campanhas segue os métodos da [Repediu](https://repediu.com.br/funcionalidades) e fica ligado ao cardápio próprio (Fase 5). Lido no site deles:
- **Segmentação:** matriz RFV automática (campeões, fiéis, promissores, em risco, perdidos), filtros cruzados (canal, valor gasto, frequência, bairro, produto preferido) e disparo de um segmento com um clique. Entra no E20.
- **Automações:** montagem com gatilho, condição, espera e ação, com mais de 30 modelos prontos (reativação após 30 dias sem pedido, boas-vindas, aniversário, carrinho abandonado após 5 min, avaliação baixa do iFood avisando o gerente). Se o cliente não responde em 48 h, tentam de novo em outro canal com o mesmo cupom. Entra no E45.
- **Cupons:** cupons personalizados por segmento, com controle de uso. Não achei cashback nem programa de pontos. Entra no E44.
- **Medição:** atribuição de conversão com janela configurável por grupo RFV (ex.: 2 dias para fiéis, 7 para perdidos), ROAS por campanha, clientes recuperados, LTV, recompra e coorte. Entra no E46.
- **Canais:** o WhatsApp deles é só pela **API oficial** (contratada direto com a Meta). Têm também SMS, RCS, e-mail, voz e exportação de públicos para anúncios da Meta.
- **Fica de fora por enquanto:** SMS, RCS, e-mail, voz, públicos para anúncios, previsão de gênero e gatilho por clima. Os números de resultado do site (ex.: "+34% de recompra no WhatsApp") são do marketing deles, sem metodologia.
- **Decidir antes do E21:** o nosso WhatsApp é pela Evolution API (QR Code) desde 21/10/2026. Os templates da Meta (E21) só existem na API oficial, e disparo em massa por número conectado via QR Code corre risco de banimento do número do restaurante. Escolher entre usar a API oficial só para as campanhas ou disparar pela Evolution com limite baixo e risco assumido.

#### E45 — Automações de marketing (jornadas) · **G** · depende de: E23, E44 · **⬜ A fazer**
- Como admin, quero montar automações com **gatilho → condição → espera → ação**, ver cada execução e ligar ou desligar cada uma.
- Gatilhos: sem pedido há N dias, primeiro pedido, aniversário, entrou num grupo RFV (ex.: virou "em risco"), ganhou a tag "Em recuperação", carrinho abandonado no cardápio próprio (E41), pedido pela IA que não foi até o Pix (E43) e avaliação negativa (E34).
- Ações: mandar mensagem (com cupom do E44 e link do cardápio), pôr ou tirar tag, avisar a equipe.
- Como admin, quero começar por **modelos prontos**: reativação, boas-vindas, aniversário, carrinho abandonado e recuperação. O texto padrão de cada modelo segue a personalidade do atendimento (CLAUDE.md §10).
- Como plataforma, quero respeitar opt-in, opt-out e um limite de mensagens de marketing por cliente por semana, somando campanhas e automações.
- A definir: o limite semanal e se a automação sai do mesmo número do atendimento.

#### E46 — Receita atribuída às campanhas · **M** · depende de: E24, E41 · **⬜ A fazer**
- Como admin, quero saber quanto cada campanha e cada automação vendeu.
- Pedido com o cupom ou pelo link da campanha conta como **conversão certa**. Outro pedido do cliente dentro da janela (configurável por grupo RFV) conta como **conversão provável**, mostrada à parte. Pedidos do iFood e do Cardápio Web entram na janela, porque o cliente pode voltar por lá.
- Como admin, quero ver receita, pedidos, clientes recuperados (voltaram depois de estar em risco ou perdidos), custo (mensagens e desconto dado) e retorno.

### Ordem sugerida (Fase 3)
`E19 Gating → E21 Templates → E20 Segmentos → E22 Criação → E23 Disparo → E24 Relatório → E25 Faturamento → E45 Automações → E46 Receita atribuída`

O E25 pode começar em paralelo a partir do E19. A ativação pode ser manual (Super Admin) até o faturamento ficar pronto. O E45 e o E46 esperam o cardápio próprio e os cupons (E41 e E44, Fase 5).

---

## Fase 4 — Agente de implantação e suporte

Objetivo: a IA da extensão do Chrome faz a implantação com o restaurante e atende o suporte do Dish Desk. A IA do atendimento ao cliente (E27–E29) passou para o MVP em 29/10/2026.

#### E31 — Agente de implantação e suporte na extensão do Chrome · **G** · depende de: E30, extensão do Chrome ([apps/extension](apps/extension/README.md)) · **🟡 Parcial**
- Como parceiro (restaurante), quero que a **extensão do Chrome do Dish Desk** tenha uma IA que **controla o meu navegador** e faz comigo a implantação do sistema, parecida com o Claude no Chrome: ela lê a tela, clica, preenche e navega entre as páginas.
- Como parceiro, quero que essa mesma IA seja o **suporte do Dish Desk**: tiro dúvidas sobre o sistema e peço ajuda quando algo não funciona (canal desconectado, mensagem que não chegou, configuração errada). Ela investiga na minha tela e no Dish Desk e corrige comigo, com as mesmas regras da implantação.
- Como parceiro, quero que a IA **ofereça um ticket ao suporte** quando não resolver, quando eu pedir ou quando o problema for de cobrança ou de conta: ela avisa que não conseguiu e pergunta se quero enviar; informo o nome e o telefone, ela escreve o resumo do problema e o suporte entra em contato depois, sem eu repetir a história.
- Como parceiro, quero pedir em linguagem natural ("conecta o meu WhatsApp", "liga o iFood") e ver a IA executar o passo a passo do assistente de configuração (E30), inclusive nos **painéis de fora** do Dish Desk, onde não temos API: Meta Business (conta do WhatsApp Business, verificação, Página do Instagram), Portal do Parceiro iFood e Portal do Cardápio Web (gerar a chave e colar no Dish Desk).
- Como parceiro, quero acompanhar cada ação na tela, **pausar ou parar a IA a qualquer momento** e assumir o controle.
- **Regra obrigatória:** a IA **pede a minha confirmação** antes de qualquer ação que não dá para desfazer ou que fala em nome do restaurante (aceitar termos, enviar documentos, publicar, pagar, apagar). Ela **nunca digita senha, código de verificação nem dados de cartão**: nesses pontos, para e pede que eu faça.
- Como parceiro, quero que a IA só aja nos sites da implantação (lista fechada de domínios) e peça permissão antes de abrir outro.
- Como plataforma, quero registrar o que a IA fez em cada implantação e em cada atendimento de suporte (passos, onde parou, onde falhou), para o suporte humano continuar de onde ela parou e para melhorar o assistente.
- Como plataforma, quero que a IA de suporte só afirme o que está na documentação do Dish Desk e nos dados do restaurante. Sem a informação, ela oferece o ticket.
- Como plataforma, quero que cada integração conferida pela IA passe pela mesma conferência de Configurações → Integrações (E14) antes de dar o passo como concluído.
- A IA também oferece a **importação dos contatos** de cada sistema conectado, quando ele permitir (CLAUDE.md §9).
- As capturas de tela e o conteúdo das páginas vão para o provedor de LLM e podem ter dados do restaurante e dos clientes: entra na política de privacidade e no registro de uso por tenant (LGPD), como os outros épicos desta fase.
- **Decidido em 25/10/2026:** o modelo é o mesmo do atendimento (Gemma 4 local), lendo a árvore da página, sem capturas de tela; a extensão é a mesma do chat do iFood, com um painel lateral; quando a IA se perde (a página mudou ou ela errou várias vezes seguidas), ela para e oferece tentar de novo ou enviar um ticket ao suporte. O E30 vem antes.
- **Motor pronto (25/10/2026):** sessões e registro de cada passo (`agent_sessions`, `agent_events`), `POST /agent/sessions`, `/turn` e `/ticket`, travas no código ([agent-guard.ts](apps/api/src/agent/agent-guard.ts)), conferência do passo pelo progresso do E30, painel lateral e leitura da página na extensão 0.4.0 e o ciclo no painel web ([agent-driver.ts](apps/web/lib/agent-driver.ts)). Testado com o Gemma 4 local. Tela `/extensao/agente` (board "Extensão do Chrome · Agente de implantação e suporte") e indicador na página (faixa, contorno, pausa quando o parceiro mexe na aba) feitos na extensão 0.5.0. Horário do suporte provisório em `SUPPORT_HOURS` (seg–sex, 9h–18h).
- **Mudado em 02/11/2026:** o chat com o suporte saiu. Quando a IA não resolve, o painel oferece um **ticket** (`support_tickets`): o parceiro informa o nome e o telefone, a IA escreve o resumo e o painel avisa que o suporte entrará em contato (fora do horário, a partir de quando ele volta). A equipe lê em `/plataforma/tickets` (sem board).
- **Feito em 27/10/2026:** a implantação começa pelas configurações do atendimento e depois passa às integrações; o painel mostra "Pensando…" enquanto a IA decide o próximo passo; depois da implantação, o painel da extensão tem "Fazer uma sugestão": a IA classifica o assunto e a plataforma vê o ranking por assunto.
- A definir na implementação:
  - se o agente é gratuito na implantação ou entra na cobrança da IA;
  - o horário de atendimento do suporte humano;
  - se o suporte também fica disponível fora da extensão (no Dish Desk web, para quem não usa Chrome).

---

## Fase 5 — Cardápio digital próprio e pedido pela IA

Objetivo: o restaurante vende pelo próprio cardápio do Dish Desk, sem comissão de marketplace. A IA conhece o cardápio, recomenda e fecha o pedido pelo WhatsApp com Pix. Os cupons e as campanhas (Fase 3) levam o cliente a esse cardápio. Pedido do usuário em 11/11/2026.

Ainda não há board no [Dish Desk Design.html](Dish%20Desk%20Design.html) para estas telas (cardápio público, cadastro do cardápio, cupons): pedir o design antes de construir (CLAUDE.md §8).

#### E41 — Cardápio digital próprio · **G** · depende de: E15 · **⬜ A fazer**
- Como admin, quero cadastrar categorias e itens (nome, descrição, preço, foto), adicionais e opções (tamanho, sabor, ponto), e pausar o item que acabou.
- Como admin, quero importar o cardápio do Cardápio Web (e do Anota AI, quando existir), se a API deixar, para não cadastrar tudo de novo.
- Como admin, quero marcar itens como **destaque**: são os que a IA indica primeiro (E42).
- Como admin, quero configurar área e taxa de entrega (por bairro ou distância), pedido mínimo e retirada. O horário é o de Configurações.
- Como cliente, quero abrir o cardápio por um link, montar o carrinho, escolher entrega ou retirada, aplicar cupom (E44) e pagar com Pix.
- Como atendente, quero que o pedido do cardápio entre como os outros (card do pedido, painel do cliente, previsão de saída do E26, alerta de fraude do E40) e avançar o status (confirmado, em preparo, pronto, saiu, entregue). Os avisos ao cliente seguem a personalidade (CLAUDE.md §10).
- Regra 9 do CLAUDE.md: quem pede vira contato, com o opt-in de marketing pedido no checkout.
- Sem chat no cardápio (decidido em 11/11/2026): o cliente fala com a loja pelo WhatsApp, para o restaurante ter o número dele.
- Entra na landing, nas listas de funcionalidades.
- A definir: onde a cozinha vê o pedido (tela de pedidos no Dish Desk, impressão ou envio a um PDV); o endereço do link (subdomínio do Dish Desk ou domínio do restaurante); outras formas de pagamento (cartão ou dinheiro na entrega); se o cardápio é um módulo pago.

#### E42 — IA com acesso ao cardápio · **M** · depende de: E41, E27 · **⬜ A fazer**
- Como cliente, quero perguntar à IA sobre os itens (o que vem, tamanho, preço, se tem opção sem lactose, se tem hoje) e receber a resposta certa.
- Como restaurante, quero que a IA indique primeiro os **itens em destaque** e sugira um complemento (bebida, sobremesa) quando fizer sentido, sem insistir.
- Mesma regra do E27: a IA só afirma o que está no cardápio. Ingrediente ou alergia sem informação, ela diz que não sabe e chama a equipe. Item pausado nunca é oferecido.
- Como cliente, quero receber a foto do item na conversa. Depende do envio de mídia (Itens ainda sem fase).

#### E43 — Pedido completo pelo WhatsApp com Pix · **G** · depende de: E41, E42, provedor de Pix · **⬜ A fazer**
- Como cliente, quero fazer o pedido inteiro na conversa do WhatsApp, sem abrir o site: a IA mostra opções com fotos, recomenda, monta o pedido, pergunta os adicionais, entrega ou retirada e o endereço (confirma o que já está no cadastro) e aplica o cupom.
- Antes de cobrar, a IA manda o **resumo** (itens, adicionais, taxa, desconto, total, endereço e previsão do E26) e pede a confirmação.
- Depois da confirmação, a IA manda o **Pix copia e cola** (e o QR Code em imagem), com o valor e a validade.
- **Regra obrigatória:** o pedido só vai para a produção quando o provedor do Pix confirmar o pagamento. Comprovante mandado pelo cliente não vale (print falso é golpe comum). Pix vencido: a IA pergunta se gera outro, e nada vai para a cozinha.
- Paga, a IA confirma ao cliente e o pedido segue como os do cardápio (E41), com o alerta de fraude do E40.
- Endereço fora da área, item que acabou no meio da conversa ou cliente que quer mudar o pedido depois de pagar: a IA chama a equipe.
- Os textos fixos (resumo, Pix, pagamento confirmado, Pix vencido) entram em `AutomationMessages`, um por personalidade (CLAUDE.md §10).
- A definir:
  - o provedor do Pix: o dinheiro cai na conta do restaurante, então ele conecta a própria conta (ex.: Mercado Pago, Efí, Asaas, InfinitePay). Conferir quais têm cobrança Pix com aviso de pagamento (webhook);
  - se o Dish Desk cobra taxa por pedido;
  - a validade do Pix e o estorno de pedido cancelado depois de pago;
  - se vale também no Instagram Direct.

#### E44 — Cupons criados pela IA para os perfis de cliente · **M** · depende de: E41, E20 · **⬜ A fazer**
- Como admin, quero criar cupons (percentual, valor fixo, frete grátis, item grátis) com validade, pedido mínimo e limite de uso por cliente e no total. Valem no cardápio próprio (E41) e no pedido pela IA (E43).
- Como admin, quero que a IA **sugira cupons para cada perfil**: os grupos RFV do E20, a tag "Em recuperação", aniversariantes e clientes novos. A sugestão traz o público, o desconto, a validade e o porquê (ex.: "em risco: 15% até domingo; ticket médio R$ 62"). Eu aprovo ou ajusto antes de o cupom valer.
- Como plataforma, quero cupom com código único por cliente, para medir o uso e evitar que circule.
- Os cupons entram nas campanhas (E22, variável `{{cupom}}`) e nas automações (E45). A tag "Em recuperação" já existe para ser o público do cupom de recuperação (decidido em 11/11/2026).
- Como admin, quero ver cupons usados, receita e desconto dado.
- A definir: o desconto máximo que a IA pode sugerir; se a IA pode oferecer na conversa, por conta própria, um cupom já aprovado (ex.: para quem reclamou).
- Fora do escopo: cupom no iFood e no Cardápio Web, que são sistemas de terceiros.

### Ordem sugerida (Fase 5)
`E41 Cardápio → E42 IA com o cardápio → E43 Pedido pelo WhatsApp com Pix → E44 Cupons`

Depois do E44, a Fase 3 segue com as automações (E45) e a receita atribuída (E46).

---

## Itens ainda sem fase
- **Login com Google (OAuth real).** Feito em 07/11/2026 e no ar em produção: só entra quem já tem conta com o mesmo e-mail (o Google não cria conta).
- **Versões mobile** de todas as telas (CLAUDE.md §7), adiadas no MVP.
- **Envio de mídia** pelo atendente (o design mostra só texto). Sugestão: logo após o MVP.
- **Vídeos UGC para divulgar o Dish Desk** (marketing, não é funcionalidade do produto). Vídeos curtos de criadores ou de donos de restaurante mostrando o Dish Desk no dia a dia, para anúncios no Instagram e no Facebook e para a landing. Referência: a página de creators para SaaS da Turbo Partners (pages.turbopartners.com.br/creators/saas), não analisada ainda porque a rede desta sessão bloqueia o site. Para o marketing automatizado, avaliar o [Crush](https://trycrush.ai) e o [Holo](https://tryholo.ai) (também não analisados, pelo mesmo bloqueio). A definir: contratar uma agência ou criadores diretamente, roteiros (atendimento com IA, prevenção de fraude) e quantos vídeos por mês.
