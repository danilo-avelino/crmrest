# Roadmap de desenvolvimento — Dish Desk (CRM Omnichannel para Restaurantes)

> Fontes: [PROJETO_CRM_RESTAURANTES.md](PROJETO_CRM_RESTAURANTES.md) (especificação) e o design finalizado ([CRM Restaurantes.html](CRM%20Restaurantes.html) / artifact `FmY8WRPQc1iMuHxzxUQf5F`: Sistema de Design, Login, Inbox, Campanhas).
> Este roadmap **substitui a seção 11 da especificação**. Instagram e iFood saíram da antiga Fase 2 e entraram no MVP.

**Esforço relativo:** **P** ≈ até 1 semana · **M** ≈ 1–2 semanas · **G** ≈ 2–4 semanas (1 dev full-stack).
**Definição de pronto (todas as histórias de UI):** segue os tokens do design; todo botão novo tem guard de duplo-clique e estado "Carregando" (CLAUDE.md §6); nenhuma query roda sem contexto de tenant. **No MVP só existe desktop**: a versão mobile (CLAUDE.md §7) fica para depois da Fase 1.

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

Objetivo: um restaurante piloto atende clientes de WhatsApp, Instagram e iFood em uma única Inbox.

### Épicos

#### E1 — Fundação do projeto · **G** · depende de: —
- Como dev, quero um monorepo (pnpm + Turborepo) com `apps/web`, `apps/api`, `packages/{database,shared,ui,config}` para compartilhar tipos e configs.
- Como dev, quero `docker compose up` subindo Postgres 18 e Redis para desenvolver localmente. O S3 local será decidido no E4, porque o MinIO Community foi descontinuado.
- Como dev, quero o `apps/web` em Next.js (App Router) + Tailwind + shadcn/ui com os **tokens do design** (cores, Fraunces/Inter, raios) já configurados.
- Como dev, quero o `apps/api` em NestJS com bootstrap por papel (`APP_ROLE=api|realtime|gateway|worker|scheduler`).
- Como dev, quero CI no GitHub Actions (lint, typecheck, testes, build) em todo PR.

#### E2 — Modelo de dados e multi-tenancy · **G** · depende de: E1
- Como plataforma, quero o schema Prisma com `tenant_id` em todas as tabelas de negócio e **RLS** no Postgres.
- Como dev, quero os tenants definidos por request (`AsyncLocalStorage` + `SET LOCAL app.tenant_ids`) e uma extensão do Prisma que injeta o `tenantId` nas escritas.
- Como plataforma, quero RLS por **lista** de tenants (`tenant_id = ANY(app.tenant_ids)`), que atende tanto o modo restaurante quanto o painel master (especificação §3.3). A lista vem sempre de `TenantMember`, nunca do cliente.
- Como plataforma, quero **testes automatizados de vazamento entre tenants** obrigatórios no CI, incluindo o modo master: um usuário membro de A e B nunca vê C.
- Modelos novos na especificação: `TenantMember` (usuário em vários tenants, com papel por tenant) e `Order` + `OrderItem`.

#### E3 — Autenticação, escolha de restaurante e papéis · **M** · depende de: E2
- Como usuário, quero entrar com e-mail e senha (Argon2, JWT access + refresh, rate limit no login).
- Como usuário com acesso a vários restaurantes, quero escolher, após o login, **um restaurante** ou o **painel master** (todos os meus restaurantes num CRM único), na tela "Escolha o restaurante", que mostra papel e nº de conversas abertas.
- Como usuário, quero trocar de restaurante ou de modo sem precisar fazer logout.
- Como admin, quero permissões por papel por tenant (`ADMIN`, `AGENT` em `TenantMember`; `isSuperAdmin` para a plataforma) aplicadas via guards na API e no front.
- Como usuário, quero recuperar a senha ("Esqueceu?").
- O botão "Continuar com Google" é implementado **só visualmente**, conforme o design. A integração OAuth real fica para depois.
- ⚠️ O design da tela "Escolha o restaurante" ainda não tem a opção "Painel master". Ela deve ser adicionada seguindo o mesmo padrão visual dos itens da lista.

#### E4 — Pipeline de mensageria (núcleo) · **G** · depende de: E2
- Como plataforma, quero um `webhook-gateway` que valida a assinatura, responde 200 e enfileira (BullMQ: `inbound`, `outbound`, `media`).
- Como plataforma, quero normalizar todo canal para `NormalizedMessage` e ter um `ChannelConnector` por canal.
- Como plataforma, quero idempotência por `(channel_id, external_message_id)`.
- Como plataforma, quero **resolução de identidade** (identidade → telefone E.164 → hash de CPF), sem sobrescrever dados com valores vazios.
- Como atendente, quero receber mensagens novas em tempo real (Socket.IO + adapter Redis).
- Como plataforma, quero mídias baixadas para o S3 e servidas com URL assinada.
- Como plataforma, quero retry exponencial e dead-letter queue nas filas.

#### E5 — Conector WhatsApp · **G** · depende de: E4
- Como restaurante, quero receber e enviar mensagens de texto pelo WhatsApp (Cloud API oficial da Meta).
- Como atendente, quero ver o status de entrega (enviado, entregue, lido, falhou ✓✓).
- Como atendente, quero receber imagens, áudios e documentos (só exibir; o envio de mídia fica para depois).
- Como atendente, quero enviar um **template aprovado** quando a janela de 24h estiver fechada (botão "Template" do composer).
- Decisão: **somente a WhatsApp Cloud API oficial da Meta**, sem provedores intermediários. Bibliotecas não oficiais (WhatsApp Web) estão proibidas.
- No MVP, o canal é conectado por **script/seed administrativo** com credenciais criptografadas (AES-256-GCM). A tela de Canais fica na Fase 2.

#### E6 — Conector Instagram Direct · **M** · depende de: E4, App Review da Meta
- Como restaurante, quero receber e responder DMs do Instagram (conta Profissional vinculada a uma Página).
- Como atendente, quero ver nome, @usuário e foto do contato quando disponíveis.
- Instagram nunca é canal de campanha.

#### E7 — Conector iFood (pedidos) · **G** · depende de: E4, homologação iFood
- Como restaurante, quero que os pedidos do iFood (eventos via polling/webhook da Merchant API) criem ou atualizem o contato e o `Order`.
- Como atendente, quero que um pedido abra ou se associe a uma conversa ("Conversa aberta via iFood").
- Como atendente, quero que o status do pedido se atualize (confirmado, em preparo, em entrega, entregue).
- Se a API de chat do iFood existir e for liberada: receber e responder mensagens. Caso contrário, a conversa do iFood é alimentada pelos eventos de pedido e o atendimento segue pelo WhatsApp, depois da coleta de telefone.

#### E8 — Inbox unificada · **G** · depende de: E3, E4 (os canais entram conforme ficam prontos)
- Como atendente, quero a lista de conversas com busca, filtros (Todos, Abertos, Pendentes, Resolvidos), contador de não lidas, tempo desde a última mensagem e indicador do canal.
- Como atendente, quero abrir uma conversa e ver o histórico completo do cliente em todos os canais.
- Como atendente, quero enviar mensagens de texto com feedback otimista (`pending` → `sent`).
- Como atendente, quero atribuir a conversa a mim ou a um colega e marcá-la como resolvida.
- Como atendente, quero notificação sonora e visual de mensagem nova.
- Como atendente, quero skeletons de carregamento enquanto a lista carrega.
- **Painel master:** como usuário de vários restaurantes, quero uma Inbox única com as conversas de todos eles, cada item identificado pelo restaurante e com filtro por restaurante. Responder, atribuir e resolver respeitam o meu papel no tenant daquela conversa. O realtime assina as salas de todos os tenants do usuário.

#### E9 — Contatos e painel lateral do cliente · **M** · depende de: E4, E8
- Como atendente, quero que todo contato novo gere um cadastro automaticamente (feito no E4; aqui entra a exposição na UI).
- Como atendente, quero o painel lateral com tags (VIP, recorrente, + tag), telefone com origem ("informado pelo cliente"), e-mail, CPF mascarado, canais vinculados, endereço de entrega, histórico (nº de pedidos, valor gasto, tempo como cliente) e os últimos pedidos do iFood.
- Como atendente, quero editar o cadastro no próprio painel (dados digitados têm precedência sobre os automáticos).
- Como atendente, quero buscar contatos por nome, telefone ou CPF (busca de CPF por hash HMAC).
- Como plataforma, quero registrar no `AuditLog` quando alguém visualiza um CPF completo.

#### E10 — Automação de coleta de telefone · **M** · depende de: E4, E9, E5 ou E6 ou E7
- Como restaurante, quero que contatos sem telefone real (Instagram, iFood) recebam automaticamente o pedido de telefone na primeira mensagem (texto padrão; a edição do texto fica na Fase 2).
- Como plataforma, quero extrair e validar o número (libphonenumber, BR), salvá-lo com `phone_source = informed_by_customer` e confirmar ao cliente.
- Como plataforma, quero enviar **um** lembrete após X minutos (job no `scheduler`) e depois marcar `phone_status = pending`.
- Como atendente, quero ver as mensagens de sistema ("Automação · coleta de telefone", "Telefone informado e cadastrado") e o alerta ⚠ na lista quando o telefone estiver pendente.
- Implementar como máquina de estados em `conversation.automationState` (`awaiting_phone` → `phone_collected` | `phone_skipped`).

#### E11 — Ferramentas de atendimento · **M** · depende de: E8 (card de pedido também depende de E7)
- Como atendente, quero escrever **notas internas** (aba "Nota interna" no composer), exibidas em âmbar com borda tracejada e nunca enviadas ao cliente.
- Como atendente, quero usar **respostas rápidas** digitando `/` e escolhendo da lista. No MVP, cadastrá-las por seed ou por um formulário simples de admin.
- Como atendente, quero ver o **indicador da janela de 24h** (tempo restante) no WhatsApp e no Instagram, e o composer deve sugerir template quando ela fechar.
- Como atendente, quero ver o **card do pedido iFood** dentro da conversa (itens, taxa, total, status, horários).

#### E12 — Prontidão para produção · **M** · depende de: E1–E11
- Deploy (provedor/região a definir, preferencialmente `sa-east-1`), Postgres gerenciado com backup e PITR, Redis gerenciado.
- Logs Pino com `tenantId`, Sentry (front e back), health checks `/health/live` e `/health/ready`.
- Painel Bull Board protegido.
- Opt-out "SAIR"/"PARAR" registrado em `Consent`, mesmo antes do módulo Campanhas existir.
- Seed do tenant piloto, dos usuários e do canal.

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
```

O WhatsApp vem primeiro porque é o único canal que não depende de aprovação longa e que entrega telefone. Ele valida o pipeline inteiro antes de entrarem os canais mais incertos.

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

#### E13 — Clientes: lista, detalhe e merge · **G** · depende de: E9
- Como atendente, quero uma lista de clientes com busca e filtros (tag, canal de origem, bairro, telefone pendente, último contato).
- Como atendente, quero uma página de detalhe com histórico de conversas e pedidos.
- Como admin, quero ver os "possíveis duplicados" sinalizados e fazer o **merge** de contatos (identidades, conversas e pedidos migram).
- Como admin, quero exportar e anonimizar os dados de um cliente (direitos do titular, LGPD).

#### E14 — Tela de Canais · **G** · depende de: E5, E6, E7
- Como admin, quero conectar o WhatsApp via **Embedded Signup** da Meta.
- Como admin, quero conectar o Instagram pelo login da Meta.
- Como admin, quero cadastrar as credenciais do iFood (merchant).
- Como admin, quero ver a saúde de cada canal (conectado, erro, token expirando) e reconectar.

#### E15 — Configurações do restaurante · **M** · depende de: E3, E10
- Como admin, quero configurar o horário de funcionamento e a mensagem automática fora do horário.
- Como admin, quero editar os textos automáticos (coleta de telefone, lembrete, confirmação, boas-vindas).
- Como admin, quero convidar, desativar e mudar o papel de usuários.
- Como admin, quero gerenciar as respostas rápidas.

#### E16 — Painel Super Admin · **M** · depende de: E2, E3
- Como super admin, quero criar, suspender e reativar tenants, e atribuir plano e módulos.
- Como super admin, quero ver o uso por tenant (mensagens, conversas, canais).
- Como super admin, quero entrar no painel de um tenant para suporte (impersonação **auditada**).

#### E17 — Estados de erro, offline e canal desconectado · **M** · depende de: E8, E14
- Como atendente, quero um aviso claro quando perder a conexão (socket), com reconexão automática e reenvio das mensagens pendentes.
- Como atendente, quero um banner quando um canal estiver desconectado, com link para reconectar (admin).
- Como atendente, quero estados vazios e de erro em todas as telas principais (Inbox, Clientes, Canais).
- Como atendente, quero que mensagens que falharam ofereçam "tentar novamente".

#### E18 — Inbox versão tablet (1024px) · **M** · depende de: E8, E9
- Como atendente em tablet, quero a Inbox com a lista recolhível e o painel do cliente como gaveta (drawer).

#### E26 — Previsão de saída do pedido · **M** · depende de: E7 concluído (iFood homologado), busca do pedido pelo número
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

### Ordem sugerida (Fase 2)
`E14 Canais → E17 Estados de erro → E15 Configurações → E13 Clientes/merge → E18 Tablet → E16 Super Admin`

Canais vem primeiro porque elimina o onboarding manual por script, que é o gargalo para o 2º restaurante. O Super Admin vem por último porque, com poucos tenants, o seed e o banco resolvem. O **E26 (previsão de saída)** entra logo depois que a integração com o iFood (E7) estiver concluída e homologada, independentemente da ordem acima.

---

## Fase 3 — Módulo Campanhas (add-on pago)

#### E19 — Controle de acesso ao módulo + estado bloqueado · **P** · depende de: E16
- Como plataforma, quero `TenantModule` + guard `@RequiresModule('campaigns')` na API e uma feature flag no front.
- Como admin sem o módulo, quero ver o **estado bloqueado** do design ("Módulo bloqueado", preço, botões "Ativar módulo Campanhas" e "Falar com o suporte").

#### E20 — Segmentos · **M** · depende de: E13
- Como admin, quero criar segmentos salvos (sem pedido há N dias, aniversariantes, tag, canal, bairro) e ver a contagem de contatos.
- O segmento só inclui contatos com **opt-in de marketing no WhatsApp**.

#### E21 — Templates WhatsApp · **M** · depende de: E5, E14
- Como admin, quero criar templates, enviá-los para aprovação da Meta e acompanhar o status.
- Como admin, quero usar variáveis (`{{nome}}`, `{{cupom}}`) e ver o preview no celular.

#### E22 — Criação de campanha em etapas · **M** · depende de: E20, E21
- Como admin, quero criar a campanha em 4 passos: **segmento → template → pré-visualizar → agendar**.
- Como admin, quero salvar rascunho e ver a lista de campanhas com status (Rascunho, Agendada, Enviando, Concluída) e abas.

#### E23 — Motor de disparo · **G** · depende de: E22
- Como plataforma, quero a fila `campaigns` com workers próprios e prioridade **menor** que o atendimento.
- Como plataforma, quero rate limit por número (token bucket no Redis) e respeito ao tier de mensagens da Meta.
- Como admin, quero **pausar e cancelar** uma campanha em andamento.
- Como plataforma, quero que o opt-out "SAIR"/"PARAR" remova o contato das próximas campanhas.

#### E24 — Relatório de campanha · **M** · depende de: E23
- Como admin, quero ver enviadas, entregues, lidas, respondidas, falhas e opt-outs, o funil de engajamento e o progresso em tempo real (com estimativa de término).
- Como admin, quero ver o custo estimado (mensagens de marketing cobradas pela Meta).

#### E25 — Faturamento · **G** · depende de: E19
- Como admin, quero ativar o módulo Campanhas e pagar a assinatura (gateway a definir: Asaas, Pagar.me ou Stripe).
- Como plataforma, quero que o módulo seja ativado ou desativado conforme o status do pagamento (`expiresAt`).
- Decidir antes: o custo das mensagens Meta fica na conta do restaurante ou é intermediado pela plataforma? (especificação §14)

### Ordem sugerida (Fase 3)
`E19 Gating → E21 Templates → E20 Segmentos → E22 Criação → E23 Disparo → E24 Relatório → E25 Faturamento`

O E25 pode começar em paralelo a partir do E19. A ativação pode ser manual (Super Admin) até o faturamento ficar pronto.

---

## Itens ainda sem fase
- **Login com Google (OAuth real).** O botão já existe visualmente desde o MVP.
- **Versões mobile** de todas as telas (CLAUDE.md §7), adiadas no MVP.
- **Envio de mídia** pelo atendente (o design mostra só texto). Sugestão: logo após o MVP.
