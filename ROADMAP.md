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
| **2 — Pós-MVP** | E13–E15, E17, E26, E30 | **E16:** entrar no painel de um restaurante para suporte (impersonação auditada). **E18:** Inbox para tablet. **E32–E39:** reputação e avaliações. |
| **3 — Campanhas** | — | **E19:** os módulos já são ligados por restaurante pela plataforma; falta o estado bloqueado do módulo Campanhas. **E25:** a assinatura do Dish Desk pela Stripe existe; falta a cobrança do módulo. **E20–E24:** não começaram. |
| **4 — Agente de implantação e suporte** | — | **E31:** falta a tela da equipe Dish Desk que lê e responde as conversas de suporte. |

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

O restaurante usa IA para atender o cliente de duas formas, **atendimento 100% com IA** (E27) ou **suporte com revisão por IA** (E28), e toda conversa recebe uma avaliação automática (E29). O módulo `AI` é ligado por restaurante pela plataforma.

**Decidido em 31/10/2026:** o Dish Desk é vendido com a IA logo de início. Todo restaurante novo já nasce com o módulo `AI` ligado (a plataforma ainda pode desligar; os que já existiam são ligados pelo painel). O menu de atendimento virou o último recurso: LLM principal → reserva (Claude Haiku) → menu. Quando as duas LLMs falham, aquele atendimento segue no menu até o fim, e o próximo volta para a IA.

Vale para os três épicos:
- A IA segue a **personalidade do atendimento** escolhida pelo restaurante (Configurações → Mensagens automáticas, CLAUDE.md §10), a mesma das mensagens automáticas.

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
- Como admin, quero ver a nota média por atendente e por período. A avaliação vale tanto para o atendimento humano quanto para o da IA (E27).
- Como plataforma, quero a avaliação rodando em **job assíncrono** (fila própria no `worker`), fora do caminho do atendimento. Uma falha na avaliação nunca atrasa nem bloqueia a conversa.
- **Primeira versão (24/10/2026):** roda 5 minutos depois de resolvida (ou encerrada por inatividade) e avalia o que veio depois da última avaliação da conversa; reaberta antes disso, espera a próxima resolução. Nota de 1 a 5, resolvido, satisfeito (ou sem reação) e um resumo; aparece na conversa e na aba Avaliações, só para administradores. Modelo em teste: Gemma 4 12B local (Ollama).
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

#### E32 — Convite de avaliação no iFood · **M** · depende de: E7, chat do iFood pela extensão ([docs/plano-chat-ifood.md](docs/plano-chat-ifood.md)) · **⬜ A fazer**
Problema: menos de 5% dos pedidos do iFood recebem avaliação. Quem teve problema avalia, e quem gostou raramente avalia. O pedido de avaliação do próprio app do iFood não basta.
- Como restaurante, quero que o Dish Desk escreva no chat do pedido do iFood, **10 minutos depois da entrega**, pedindo ao cliente que avalie a loja no app do iFood.
- Como restaurante, quero ligar ou desligar o convite numa **seção do iFood em Configurações → Mensagens automáticas**. O texto segue a personalidade do atendimento (CLAUDE.md §10).
- **Decidido em 29/10/2026:**
  - **Quando sai:** entrega (`deliveredAt`) + 10 min. Sem horário de entrega, o horário prometido (`promisedAt`) + 10 min. Sem nenhum dos dois, não há convite.
  - **Quem fica de fora:** o pedido cancelado e o que com certeza atrasou, isto é, foi entregue depois do horário prometido pelo iFood. Atraso desconhecido não tira o convite.
  - **Frequência:** um convite a cada pedido, sem limite por cliente.
  - **Envio:** o iFood não tem API de chat, então quem envia é o painel com a extensão. Só sai se houver painel aberto na hora; sem painel, o convite é descartado (sem fila, sem reenvio).
  - **Inbox:** o convite não aparece nela. Se o cliente responder, segue o fluxo normal: sem IA, a conversa abre e a equipe é chamada; com IA, ela analisa, responde se precisar e chama a equipe se o cliente quiser.
  - **Onde fica guardado:** uma tabela própria (`ReviewInvite`) com um convite por pedido, o desfecho (enviado, pulado e por quê, descartado sem painel, falhou) e as horas. Entra na RLS e no teste de isolamento entre tenants.
- A definir na implementação:
  - como o convite é disparado na hora certa: o próprio pedido de envio do painel decide, uma tarefa com atraso por pedido, ou uma varredura por minuto;
  - por quanto tempo o convite espera um painel aberto antes de ser descartado.
- A conferir antes de construir:
  - **Escrever primeiro:** se um pedido sem mensagens aparece na lista de chats do widget, e se o chat aceita mensagem 10 minutos depois da entrega. Hoje a extensão só abre chats que já estão na lista ([ifood-chat-driver.ts](apps/web/lib/ifood-chat-driver.ts)).
  - **Chat certo:** hoje o envio pelo iFood vai para o último pedido do cliente na loja ([ifood-chat.service.ts](apps/api/src/conversations/ifood-chat.service.ts), `claim`). O convite precisa ir para o pedido dele.
  - **Inatividade:** um envio pela ponte agenda o encerramento por inatividade, e o convite não pode agendar.
  - **Resposta rápida:** uma resposta do cliente em até 5 minutos depois de uma mensagem da loja conta como "atendimento em andamento", sem alarme. Isso não pode valer para o convite.
  - **Horário de entrega:** quantos pedidos de fato recebem `deliveredAt`, por tipo de frota.
  - **Regras do iFood:** se a política dele permite pedir avaliação no chat em todo pedido.
- Medição: avaliações ÷ pedidos do iFood por loja e período, na aba Avaliações → iFood. Depende da homologação do módulo Review ([docs/pendencias-producao.md](docs/pendencias-producao.md)).
- Fora do escopo: envio por WhatsApp ou em massa (fica para o módulo de disparos) e outras plataformas sem chat.

#### E33 — Avisos de andamento para todos os pedidos do iFood · **M** · depende de: E32 (a extensão escrever primeiro) · **⬜ A fazer**
- Como cliente do iFood, quero receber no chat do pedido os avisos de "pronto", "saiu para entrega" e de atraso (E26), mesmo sem ter escrito para a loja. Hoje esses avisos só chegam a quem já conversou com ela ([order-notice.service.ts](apps/api/src/orders/order-notice.service.ts)).
- Como restaurante, quero ligar ou desligar esses avisos na seção do iFood em Mensagens automáticas.
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

Canais vem primeiro porque elimina o onboarding manual por script, que é o gargalo para o 2º restaurante. O assistente de configuração (E30) vem logo depois de Configurações porque só guia o admin pelas telas do E14 e do E15. O Super Admin vem por último porque, com poucos tenants, o seed e o banco resolvem. O **E26 (previsão de saída)** entra logo depois que a integração com o iFood (E7) estiver concluída e homologada, independentemente da ordem acima.

---

## Fase 3 — Módulo Campanhas (add-on pago)

#### E19 — Controle de acesso ao módulo + estado bloqueado · **P** · depende de: E16 · **🟡 Parcial**
- Como plataforma, quero `TenantModule` + guard `@RequiresModule('campaigns')` na API e uma feature flag no front.
- Como admin sem o módulo, quero ver o **estado bloqueado** do design ("Módulo bloqueado", preço, botões "Ativar módulo Campanhas" e "Falar com o suporte").

#### E20 — Segmentos · **M** · depende de: E13 · **⬜ A fazer**
- Como admin, quero criar segmentos salvos (sem pedido há N dias, aniversariantes, tag, canal, bairro) e ver a contagem de contatos.
- O segmento só inclui contatos com **opt-in de marketing no WhatsApp**.

#### E21 — Templates WhatsApp · **M** · depende de: E5, E14 · **⬜ A fazer**
- Como admin, quero criar templates, enviá-los para aprovação da Meta e acompanhar o status.
- Como admin, quero usar variáveis (`{{nome}}`, `{{cupom}}`) e ver o preview no celular.

#### E22 — Criação de campanha em etapas · **M** · depende de: E20, E21 · **⬜ A fazer**
- Como admin, quero criar a campanha em 4 passos: **segmento → template → pré-visualizar → agendar**.
- Como admin, quero salvar rascunho e ver a lista de campanhas com status (Rascunho, Agendada, Enviando, Concluída) e abas.

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

### Ordem sugerida (Fase 3)
`E19 Gating → E21 Templates → E20 Segmentos → E22 Criação → E23 Disparo → E24 Relatório → E25 Faturamento`

O E25 pode começar em paralelo a partir do E19. A ativação pode ser manual (Super Admin) até o faturamento ficar pronto.

---

## Fase 4 — Agente de implantação e suporte

Objetivo: a IA da extensão do Chrome faz a implantação com o restaurante e atende o suporte do Dish Desk. A IA do atendimento ao cliente (E27–E29) passou para o MVP em 29/10/2026.

#### E31 — Agente de implantação e suporte na extensão do Chrome · **G** · depende de: E30, extensão do Chrome ([apps/extension](apps/extension/README.md)) · **🟡 Parcial**
- Como parceiro (restaurante), quero que a **extensão do Chrome do Dish Desk** tenha uma IA que **controla o meu navegador** e faz comigo a implantação do sistema, parecida com o Claude no Chrome: ela lê a tela, clica, preenche e navega entre as páginas.
- Como parceiro, quero que essa mesma IA seja o **suporte do Dish Desk**: tiro dúvidas sobre o sistema e peço ajuda quando algo não funciona (canal desconectado, mensagem que não chegou, configuração errada). Ela investiga na minha tela e no Dish Desk e corrige comigo, com as mesmas regras da implantação.
- Como parceiro, quero que a IA **transfira para o suporte humano** quando não resolver, quando eu pedir ou quando o problema for de cobrança ou de conta, e que a pessoa do suporte receba o histórico da conversa e das ações, sem eu repetir a história.
- Como parceiro, quero pedir em linguagem natural ("conecta o meu WhatsApp", "liga o iFood") e ver a IA executar o passo a passo do assistente de configuração (E30), inclusive nos **painéis de fora** do Dish Desk, onde não temos API: Meta Business (conta do WhatsApp Business, verificação, Página do Instagram), Portal do Parceiro iFood e Portal do Cardápio Web (gerar a chave e colar no Dish Desk).
- Como parceiro, quero acompanhar cada ação na tela, **pausar ou parar a IA a qualquer momento** e assumir o controle.
- **Regra obrigatória:** a IA **pede a minha confirmação** antes de qualquer ação que não dá para desfazer ou que fala em nome do restaurante (aceitar termos, enviar documentos, publicar, pagar, apagar). Ela **nunca digita senha, código de verificação nem dados de cartão**: nesses pontos, para e pede que eu faça.
- Como parceiro, quero que a IA só aja nos sites da implantação (lista fechada de domínios) e peça permissão antes de abrir outro.
- Como plataforma, quero registrar o que a IA fez em cada implantação e em cada atendimento de suporte (passos, onde parou, onde falhou), para o suporte humano continuar de onde ela parou e para melhorar o assistente.
- Como plataforma, quero que a IA de suporte só afirme o que está na documentação do Dish Desk e nos dados do restaurante. Sem a informação, ela transfere (mesma regra do E27).
- Como plataforma, quero que cada integração conferida pela IA passe pela mesma conferência de Configurações → Integrações (E14) antes de dar o passo como concluído.
- A IA também oferece a **importação dos contatos** de cada sistema conectado, quando ele permitir (CLAUDE.md §9).
- As capturas de tela e o conteúdo das páginas vão para o provedor de LLM e podem ter dados do restaurante e dos clientes: entra na política de privacidade e no registro de uso por tenant (LGPD), como os outros épicos desta fase.
- **Decidido em 25/10/2026:** o modelo é o mesmo do atendimento (Gemma 4 local), lendo a árvore da página, sem capturas de tela; a extensão é a mesma do chat do iFood, com um painel lateral; quando a IA se perde (a página mudou ou ela errou várias vezes seguidas), ela para e oferece tentar de novo ou falar com o suporte humano. O E30 vem antes.
- **Motor pronto (25/10/2026):** sessões e registro de cada passo (`agent_sessions`, `agent_events`), `POST /agent/sessions`, `/turn` e `/handoff`, travas no código ([agent-guard.ts](apps/api/src/agent/agent-guard.ts)), conferência do passo pelo progresso do E30, painel lateral e leitura da página na extensão 0.4.0 e o ciclo no painel web ([agent-driver.ts](apps/web/lib/agent-driver.ts)). Testado com o Gemma 4 local. Tela `/extensao/agente` (board "Extensão do Chrome · Agente de implantação e suporte") e indicador na página (faixa, contorno, pausa quando o parceiro mexe na aba) feitos na extensão 0.5.0. Depois da transferência, o parceiro escreve no painel e as respostas da equipe aparecem nele (`/agent/sessions/:id/messages`, eventos `support`). **Falta** a tela da equipe Dish Desk que lê e responde essas conversas (sem board); horário do suporte provisório em `SUPPORT_HOURS` (seg–sex, 9h–18h).
- **Feito em 27/10/2026:** a implantação começa pelas configurações do atendimento e depois passa às integrações; o painel mostra "Pensando…" enquanto a IA decide o próximo passo; depois da implantação, o painel da extensão tem "Fazer uma sugestão": a IA classifica o assunto e a plataforma vê o ranking por assunto.
- A definir na implementação:
  - se o agente é gratuito na implantação ou entra na cobrança da IA;
  - onde fica o suporte humano que recebe as transferências (a própria Inbox do Dish Desk, como um tenant interno, ou outra ferramenta) e o horário de atendimento dele;
  - se o suporte também fica disponível fora da extensão (no Dish Desk web, para quem não usa Chrome).

---

## Itens ainda sem fase
- **Login com Google (OAuth real).** O botão já existe visualmente desde o MVP.
- **Versões mobile** de todas as telas (CLAUDE.md §7), adiadas no MVP.
- **Envio de mídia** pelo atendente (o design mostra só texto). Sugestão: logo após o MVP.
