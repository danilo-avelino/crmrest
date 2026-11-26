# Roadmap — CRM de vendas do Dish Desk (uso interno, no modelo do Salesforce)

> Pedido do usuário em 25/11/2026: planejar um CRM **só para a equipe de vendas do Dish Desk**. Não é produto para os restaurantes. Nada foi construído ainda.
> Revisão do mesmo dia: o usuário quer o CRM **igual ao Salesforce**, e não adaptado ao estilo da Inbox. A primeira versão deste plano usava a Inbox do tenant de vendas como CRM básico; esta a substitui.
> Este roadmap absorve a lista "O que falta para a área dos vendedores" de [docs/vendedores.md](../vendedores.md). O código promocional, já feito, continua descrito lá.

**Esforço relativo:** **P** ≈ até 1 semana · **M** ≈ 1–2 semanas · **G** ≈ 2–4 semanas (1 dev full-stack), como no [ROADMAP.md](../../ROADMAP.md).

**Premissas** (corrigir aqui se estiverem erradas):
- "Igual ao Salesforce" é a estrutura e o jeito de trabalhar do Sales Cloud: objetos (lead, conta, contato, oportunidade, atividade), ficha do registro, visões de lista, Kanban, Path (a barra de fases), conversão do lead, regras de atribuição, relatórios, painéis e previsão. O visual segue o Dish Desk Design (D2). Fica fora o que faz do Salesforce uma plataforma para construir sistemas (ver "Fora do escopo").
- O vendedor não usa a Inbox. A conversa com o lead acontece dentro da ficha do registro.
- "Criar novos clientes" é criar a conta de um restaurante (tenant) em teste grátis, a partir da conta ou da oportunidade no CRM.
- "O CRM levaria as leads até ele" é distribuir os leads por filas e regras de atribuição e avisar cada vendedor.
- "Contato inicial pela IA" é a IA responder primeiro todo lead que chega e escrever primeiro só para quem pediu contato (formulário, cadastro). Prospecção fria, em que a IA escreve para restaurantes que não pediram, fica fora das Etapas 1 a 3 (D17).

**Definição de pronto (todas as histórias):**
- As telas seguem o [Dish Desk Design.html](../../Dish%20Desk%20Design.html) e as três regras dele: um número principal com o filtro dentro do bloco que ele altera, aviso colado no item a que se refere (com a ação ao lado) e estado mostrado na forma, confirmado por texto ou número. Nenhuma tela do CRM tem board ainda: pedir o design antes de construir (CLAUDE.md §8).
- Todo botão novo tem guard de duplo clique e "Carregando…" (CLAUDE.md §6).
- As telas que o vendedor usa no dia a dia nascem com a versão celular: listas, ficha, WhatsApp, Tarefas, Agenda e Início. Montar relatório e painel e a Configuração do CRM ficam só no computador. A exceção do CLAUDE.md §7 vale só para a Fase 1 do ROADMAP.md.
- Todo campo novo entra no registro de objetos (C2), para aparecer na ficha, na lista, nos filtros e nos relatórios.
- Todo texto fixo que a IA ou uma automação manda ao lead entra em `AutomationMessages`, com um texto por personalidade (CLAUDE.md §10).
- Toda tabela nova entra na RLS e no teste de isolamento (ver Segurança e LGPD).

---

## Objetivo

Todo lead do Dish Desk é atendido na hora, a qualquer hora, pela IA, e trabalhado num CRM com a estrutura do Salesforce. O vendedor só entra quando a conversa já tem contexto. A gestão sabe quanto vende cada origem, cada vendedor e a IA, e quanto deve fechar no mês.

```
Lead escreve no WhatsApp de vendas
(site, Instagram, indicação, anúncio)
              │
              ▼
   Lead nasce na fila "IA SDR". A IA (Haiku 5.5) diz que é a mesma IA
   que atende os clientes dos restaurantes, tira dúvidas e preenche
   a qualificação do lead
              │
              ├── só quer testar ──► link do teste grátis com o código do vendedor
              ▼
   Regra de atribuição dá o lead a um vendedor:
   tarefa com prazo e aviso (sino e WhatsApp)
              │
              ▼                                Vendedor cria o lead à mão
   Vendedor trabalha na ficha do lead ◄─────── (prospecção, indicação, evento)
   (WhatsApp, tarefas, ligações) e converte:
   conta + contato + oportunidade
              │
              ▼
   Oportunidade: Qualificação → Demonstração → Teste grátis → Negociação
              │
              ▼
   Primeiro pagamento ──► Fechada/Ganha ──► previsão, relatórios e comissão
```

**Medidas de sucesso:** tempo até a primeira resposta ao lead (segundos), % de leads qualificados pela IA sozinha, conversão lead → oportunidade → teste → pago, tempo do ciclo de venda, previsto x fechado no mês e custo de IA por venda.

## O que "igual ao Salesforce" quer dizer aqui

| No Salesforce (Sales Cloud) | No CRM do Dish Desk | Onde |
|---|---|---|
| Navegação por abas, busca global, itens recentes | Navegação do CRM em `/vendas` | C2 |
| Usuários, hierarquia de papéis, perfis e regras de compartilhamento | Vendedores, gestor direto, perfis Vendedor e Gestor, visibilidade por dono | C1 |
| Lead com status, origem e classificação | Lead com status no Path, origem e nota A, B ou C | C3 |
| Visões de lista (filtros, colunas, edição em linha, ações em massa) | Visões de lista | C2 (prontas) e C15 (salvas e em massa) |
| Ficha do registro: destaques, Path, Detalhes, Relacionados, Atividade | A mesma ficha para todos os objetos | C2 |
| Tarefas, eventos, ligações registradas e linha do tempo | Atividades e linha do tempo | C4 |
| Conversa de WhatsApp dentro do registro (Messaging) | Painel do WhatsApp na ficha | C5 |
| Agentforce SDR (agente de IA para leads) | IA SDR no Haiku 5.5, a mesma do atendimento | C6 e C7 |
| Regras de atribuição de leads e filas | Regras de atribuição e filas "IA SDR" e "Sem dono" | C8 |
| Página inicial | Início | C8 (primeira versão) e C19 |
| Conta (com conta-mãe) e contato | Conta (o restaurante; conta-mãe para a rede) e contato | C9 |
| Oportunidade, processo de vendas, Path e Kanban | Oportunidade com fases, Path e Kanban | C10 |
| Produtos, catálogo de preços e produtos da oportunidade | Planos do `billing.ts` como produtos, itens da oportunidade | C11 |
| Processo de aprovação | Aprovação de desconto pelo gestor | C11 |
| Converter lead | Conversão em conta, contato e oportunidade | C12 |
| Assistente de importação e regras de duplicidade | Importação de CSV, aviso e mescla de duplicados | C3 e C15 |
| Histórico de campos e trilha de auditoria | Histórico de campos e AuditLog | C2 |
| Relatórios (tipos de relatório, agrupamentos, gráficos) | Relatórios | C16 |
| Painéis dinâmicos | Painéis que mostram os dados de quem abre | C17 |
| Previsão colaborativa e metas | Previsão por categoria e metas | C18 |
| Calendário e eventos | Agenda de demonstrações | C20 |
| Comissões (produto à parte no Salesforce) | Comissões | C21 |
| Cadências (Sales Engagement) | Cadências | C22 |
| Flow disparado por registro | Automações "quando/então", sem construtor visual | C23 |
| Campos personalizados | Campos personalizados | C24 (D16) |
| Campanhas | Campanhas e origens | C25 |
| Portal de parceiros | Parceiros | C27 |
| Assistente de IA do vendedor | Próxima ação, resumo e rascunho pela IA | C28 |
| App para celular | Versão celular das telas do dia a dia | todas (definição de pronto) |

**Fora do escopo:** criar objetos e montar telas sem código (Object Manager, Lightning App Builder), construtor visual de fluxos, programação dentro do CRM (Apex), loja de apps (AppExchange), tipos de registro, territórios, Chatter, CPQ, contratos e pedidos, sincronização de e-mail, discador e Service Cloud. O suporte aos restaurantes continua nos tickets da plataforma. O que não está na tabela acima só entra com pedido.

## Decisão de arquitetura: CRM próprio no modelo do Salesforce, sobre o motor do Dish Desk

- **Telas:** área própria `/vendas` no `apps/web`, com a navegação do CRM. O login do vendedor abre direto nela. Ele não vê a Inbox nem nenhuma tela do painel do restaurante.
- **Dados:** os objetos do CRM ficam em tabelas novas com o prefixo `crm_` (`crm_leads`, `crm_accounts`, `crm_contacts`, `crm_opportunities`, `crm_activities`…), além de `sellers`. O prefixo evita a confusão com `contacts`, que são os clientes dos restaurantes.
- **Registro de objetos:** um módulo em `packages/shared/src/crm/` descreve cada objeto e cada campo: tipo, rótulo, valores da lista, seção da ficha e se o campo filtra, ordena, agrupa, edita e entra no histórico. Lista, Kanban, filtros, ficha, importação, histórico e relatórios leem esse registro. Assim uma tela genérica serve a todos os objetos, como no Salesforce, sem um construtor de objetos.
- **Org de vendas:** os dados do CRM ficam num tenant técnico, "Dish Desk Vendas" (`SALES_TENANT_ID`), criado pela plataforma, sem teste e sem cobrança. Ele faz o papel da "org" do Salesforce: isola o CRM pela RLS que já existe e hospeda o WhatsApp de vendas, as mensagens e o gasto da IA. Ninguém usa o painel de restaurante desse tenant.
- **WhatsApp por baixo:** a conversa usa o motor de mensagens do Dish Desk (canal da Evolution por QR Code, mídia, áudio transcrito, envio). Cada lead e cada contato do CRM aponta para o contato de mensagens do tenant de vendas. A conversa aparece na ficha, e não na Inbox.
- **IA SDR:** um agente novo no mesmo motor e no mesmo modelo do atendimento, como o agente do cardápio já é. O `AiProcessor` passa a escolher entre três agentes: vendas, cardápio e atendimento. As ferramentas do SDR escrevem direto nos campos do lead.
- **API:** módulo `crm` no `apps/api`, com as rotas em `/crm/*`. O vendedor é membro do tenant de vendas com um papel novo, `SELLER`. As rotas do painel do restaurante recusam esse papel, e as rotas `/crm` só aceitam membros do tenant de vendas.

Por quê:
- O CRM fica com a estrutura e o jeito de trabalhar do Salesforce, como o usuário pediu.
- A frase "a IA que está te atendendo é a mesma que vai atender os seus clientes" continua verdadeira no código, e não só no discurso.
- WhatsApp, IA, áudio, gasto por tenant, RLS, convites e auditoria já existem. O CRM só constrói o que é de vendas.

**Custo da escolha:** a primeira versão usava a Inbox como CRM básico na Etapa 1. Agora a lista, a ficha, a conversa, as atividades e a atribuição são telas novas desde o começo, e a Etapa 1 passa de ≈ 6 para ≈ 14 semanas de 1 dev (ver "Ordem sugerida").

Alternativa descartada: comprar um CRM pronto (o próprio Salesforce, Pipedrive, HubSpot, RD Station). A conversa e a IA ficariam fora do Dish Desk, a IA não seria a mesma, e o vendedor só criaria o restaurante com uma integração feita por nós. A licença também é cobrada por usuário.

## Papéis

Como os perfis e a hierarquia de papéis do Salesforce:

- **Vendedor** (novo): cadastro em `sellers` e papel `SELLER` no tenant de vendas. Trabalha os leads, as contas e as oportunidades de que é dono, cria restaurantes em teste para eles e vê a situação comercial dos próprios clientes. Não vê nenhum dado de dentro dos restaurantes.
- **Gestor de vendas:** vendedor com o perfil Gestor. Edita os registros de quem está abaixo dele na hierarquia, redistribui, aprova desconto, define metas, exporta, vê os relatórios, os painéis e a previsão da equipe e fecha as comissões.
- **Admin do CRM:** o super admin. Configura o CRM: vendedores, hierarquia, WhatsApp de vendas, filas, regras de atribuição, fases, motivos de perda, base de conhecimento e IA.
- **Parceiro** (Etapa 4): agência ou consultor com código próprio. Vê só os próprios códigos, os restaurantes que trouxe e a comissão.
- **IA SDR:** cuida da fila "IA SDR" e faz o primeiro contato com todo lead.

## O que já existe e será aproveitado

Conferido no código em 25/11/2026.

| Peça | Onde está | Uso no CRM |
|---|---|---|
| Código promocional (30 dias de teste, restaurante ligado ao código) | `promo_codes`, `tenants.promo_code_id`, `app.signup_tenant` ([docs/vendedores.md](../vendedores.md)) | atribuir o lead e o cadastro ao vendedor; `seller_name` vira `seller_id` |
| Cadastro do teste grátis (restaurante, nome, WhatsApp, CPF/CNPJ, e-mail, código) | `/cadastro`, `POST /auth/signup`, `SignupRequest` em [billing.ts](../../packages/shared/src/billing.ts) | todo cadastro cria ou atualiza lead, conta e oportunidade (C13) |
| Preços e dias de teste | `BILLING_PLANS`, `TRIAL_DAYS`, `PROMO_TRIAL_DAYS` em [billing.ts](../../packages/shared/src/billing.ts) | produtos do CRM e única fonte dos preços que a IA informa |
| Pagamento (mensal na Stripe, anual na InfinitePay) | `billing_payments` e os webhooks | oportunidade Fechada/Ganha; base da comissão |
| Agente com ferramentas no Haiku 5.5, com cache do prompt e gasto por tenant | `AnthropicLlmProvider` e `LLM_PROVIDER_MODEL` em [llm-provider.ts](../../apps/api/src/ai/llm-provider.ts) | motor do SDR |
| Escolha do agente por conversa | [ai.processor.ts](../../apps/api/src/ai/ai.processor.ts) | entra o agente de vendas |
| Ferramentas de passar para a equipe e de opções numeradas | `handoff-tool.ts`, `offer-tool.ts` em [menu-agent/tools](../../apps/api/src/menu-agent/tools) | passar ao vendedor; oferecer horários de demonstração |
| Personalidade e textos automáticos | `AutomationMessages` em [personalities.ts](../../packages/shared/src/personalities.ts), `toneOf` em [prompts.ts](../../apps/api/src/ai/prompts.ts) | tom do SDR e das retomadas |
| Áudio transcrito | `AudioMediaService`, `TranscriptionProcessor` | o lead manda áudio |
| WhatsApp por QR Code (Evolution) | [evolution.connector.ts](../../apps/api/src/connectors/evolution.connector.ts) | número de vendas; o que for respondido pelo celular entra como mensagem de saída |
| Motor de conversas (conversas, mensagens, envio, mídia, tirar a IA da conversa) | [conversations.service.ts](../../apps/api/src/conversations/conversations.service.ts) e a entrada de mensagens | painel do WhatsApp na ficha; a tela da Inbox não é usada |
| Respostas rápidas | `QuickReply` | modelos de mensagem do vendedor |
| Sugestão de resposta | [ai-suggestion.service.ts](../../apps/api/src/ai/ai-suggestion.service.ts) | sugestão no painel do WhatsApp |
| Notificação do navegador com som | [use-call-notifications.ts](../../apps/web/hooks/use-call-notifications.ts) | aviso de lead novo e de mensagem nova |
| Aviso no WhatsApp do admin | [admin-notifications.service.ts](../../apps/api/src/notifications/admin-notifications.service.ts) | aviso no celular do vendedor |
| Progresso da implantação | `OnboardingService`, `GET /onboarding/:tenantId` | saúde dos testes na conta |
| Plataforma: super admin, criar restaurante, acesso de suporte auditado, AuditLog, tickets | [platform.controller.ts](../../apps/api/src/platform/platform.controller.ts) | admin do CRM; criar o restaurante em teste; cliente atual com problema vai para o suporte |
| Convite de usuário por e-mail | Supabase Auth ("Invite user") | convite do vendedor e do dono do restaurante |
| Tráfego do site (páginas vistas, cliques em "Teste grátis", origem pelo `utm_source`) | [site.controller.ts](../../apps/api/src/site/site.controller.ts), [track.js](../../apps/web/public/assets/track.js) | origem do lead |
| Links de WhatsApp da landing ("Quero conhecer o Dish Desk", desconto do anual) | [index.html](../../apps/web/public/index.html) | principal entrada de leads hoje |
| Demo interativa e conta demo | `/demo`; Pizzaria Vila Brasa (`pnpm demo:reset`), ainda fora da produção | material do vendedor e da IA |

---

## Etapa 0 — Pré-requisitos

- **Número de vendas:** escolher o número (D1 e D6) e conectá-lo por QR Code no tenant de vendas. Se for um número que hoje está num celular, o WhatsApp do celular continua funcionando, porque a Evolution entra como aparelho conectado. Conferir antes se a IA para de responder quando alguém responde pelo celular.
- **A mesma IA de verdade:** segundo as anotações de 09/11 e 15/11/2026, o atendimento dos restaurantes em produção ainda tenta primeiro o endereço do Ollama, que está desligado, e quem responde é a reserva no Claude. Antes de a IA de vendas dizer "sou a mesma", o atendimento passa a usar o `claude-haiku-5-5` como principal, e o SDR usa a mesma constante. Se o modelo do atendimento mudar, o do SDR muda junto. Conferir as variáveis `AI_*` na Railway.
- **Design (D2):** briefing para o Claude Design, no molde de [docs/design/briefing-ia-assistente-agente.md](../design/briefing-ia-assistente-agente.md). Boards:
  - navegação do CRM, visão de lista e Kanban;
  - ficha do registro (lead, conta e oportunidade) com o Path, a linha do tempo e o painel do WhatsApp;
  - conversão do lead, Início, Tarefas e Agenda;
  - relatório (montar e ver), painel, previsão e Configuração do CRM;
  - versão celular de lista, ficha, WhatsApp, Tarefas, Agenda e Início.
- **Privacidade:** a política ([/privacidade](../../apps/web/public/privacidade/index.html)) ganha o contato comercial: que dados do lead guardamos, que a primeira conversa é com IA, por quanto tempo guardamos e como pedir a exclusão. Ela também não cita hoje o provedor da IA (Anthropic), que já recebe as conversas do atendimento dos restaurantes.
- **Decisões:** as que a tabela "Decisões em aberto" marca para antes da Etapa 1, e a D2 antes dos boards.

## Etapa 1 — Leads e a IA no primeiro contato

Objetivo: todo lead que escreve no WhatsApp de vendas é atendido na hora pela IA, que se apresenta, qualifica e passa o lead a um vendedor. O vendedor trabalha o lead na ficha, com a conversa e as atividades, sem a Inbox.

#### C1 — Org de vendas, vendedores e acesso · **M** · depende de: Etapa 0 · **⬜ A fazer**
- Como plataforma, quero o tenant técnico "Dish Desk Vendas", identificado por `SALES_TENANT_ID` na `api`, sem teste grátis e sem cobrança, e fora dos números da plataforma (lista de restaurantes, uso, tráfego), como a conta demo. O assistente de configuração e o aviso "Termine a configuração" não aparecem nele.
- Como admin do CRM, quero conectar o WhatsApp de vendas (QR Code) pela Configuração do CRM, com a mesma tela de conexão dos restaurantes.
- Como admin do CRM, quero cadastrar vendedores: nome, e-mail (convite pelo e-mail, como o de usuários), WhatsApp, perfil (Vendedor ou Gestor), gestor direto, horário, capacidade (máximo de leads abertos), região (opcional) e códigos promocionais.
- Como plataforma, quero a tabela `sellers` ([docs/vendedores.md](../vendedores.md)): `user_id`, nome, WhatsApp, tipo (vendedor ou parceiro), perfil, `manager_id`, ativo, horário, capacidade e região. `promo_codes.seller_name` vira `seller_id`, e os nomes que já existem viram vendedores.
- Como plataforma, quero o vendedor como membro do tenant de vendas com o papel novo `SELLER`, criado com o cadastro dele. O login dele abre `/vendas`, e as rotas do painel do restaurante recusam esse papel.
- Visibilidade (D3), como o compartilhamento do Salesforce: todo vendedor lê os leads, as contas e as oportunidades, para não trabalhar sem saber o lead de outro. Só o dono, os gestores acima dele na hierarquia e o admin editam. A regra fica na RLS, com uma função `app.crm_can_edit(owner_id)`, e não só no serviço.
- Quando o vendedor sai, o acesso é desativado e os registros dele vão para o gestor redistribuir (C8).

#### C2 — Base do CRM: navegação, registro de objetos, lista e ficha · **G** · depende de: C1, boards do design · **⬜ A fazer**
- Como vendedor, quero a navegação do CRM em `/vendas`: abas dos objetos (Início, Leads, Contas, Contatos, Oportunidades, Tarefas, Agenda, Relatórios, Painéis e Previsão, cada uma quando o épico dela entrar), busca global, itens recentes, sino de avisos, botão "Novo" e menu do usuário.
- A engrenagem abre a Configuração do CRM, só para gestor e admin. Cada épico completa uma parte: vendedores e WhatsApp (C1), base de conhecimento e IA (C6 e C7), filas e regras de atribuição (C8), fases, Path e motivos de perda (C10), produtos e teto de desconto (C11) e metas (C18).
- Como plataforma, quero o registro de objetos em `packages/shared/src/crm/`, com zod: objetos, campos, tipos (texto, número, moeda, data, lista, lista múltipla, referência a outro registro, telefone, e-mail, sim ou não), valores das listas, seções da ficha e o que cada campo permite (filtrar, ordenar, agrupar, editar, entrar no histórico).
- Como vendedor, quero a visão de lista de cada objeto: visões prontas (Recentes, Meus, Todos os abertos), filtros, escolha de colunas, ordenação e paginação no servidor. A contagem fica no topo da lista, com o filtro dentro do bloco (regra do design). O gestor troca o dono de vários registros de uma vez.
- Como vendedor, quero a mesma ficha para todo registro:
  - cabeçalho com os campos de destaque e as ações;
  - Path quando o objeto tem fases;
  - aba Atividade (C4), aba Detalhes (seções do registro, com edição no lugar) e aba Relacionados (listas dos registros ligados).
- Como vendedor, quero a busca global por nome, restaurante, telefone, e-mail e CNPJ em leads, contas, contatos e oportunidades.
- Como plataforma, quero o histórico dos campos marcados no registro (`crm_field_history`: quem, quando, de e para). Ele aparece na linha do tempo e na lista "Histórico" da ficha. Trocar dono, exportar, criar restaurante e aprovar desconto também vão para o AuditLog.
- O vendedor não exclui registros: ele desqualifica o lead ou perde a oportunidade. O gestor exclui, e a exclusão só marca `deleted_at`, para poder restaurar.

#### C3 — Leads · **M** · depende de: C2 · **⬜ A fazer**
- Como vendedor, quero o lead com nome, restaurante, WhatsApp, e-mail, cidade e UF, CNPJ, origem, status, nota (A, B ou C), dono, a qualificação feita pela IA (C7) e o resumo da conversa.
- Status no Path: **Novo** → **Em atendimento pela IA** → **Qualificado** → **Em contato** → **Convertido**. Fora da linha: **Nutrição**, com a data para retomar, e **Desqualificado**, com motivo obrigatório (não é restaurante, procura emprego, concorrente, spam, sem interesse, sem resposta, outro). Cada passo do Path mostra os campos-chave e a orientação que o gestor escreveu.
- Origem: botão de WhatsApp do site, cadastro no site, Instagram, indicação, prospecção do vendedor, parceiro, anúncio, evento ou outro, com o `utm_source` quando houver.
- O lead do WhatsApp nasce sozinho quando um número novo escreve no WhatsApp de vendas: fica na fila "IA SDR", com o status Em atendimento pela IA. O mesmo telefone é o mesmo lead, porque a identidade dos contatos já junta pelo número.
- Como vendedor, quero criar um lead à mão (prospecção, indicação, evento). Eu mesmo mando a primeira mensagem, pela ficha. Se o lead responder, posso passar a conversa à IA.
- Visões prontas: Meus leads, Aguardando minha resposta, Novos hoje, Na fila da IA e Nutrição para retomar.
- Ao criar à mão, aviso de possível duplicado pelo telefone, pelo e-mail ou pelo CNPJ, com o link do registro que já existe. Mesclar vem na C15.

#### C4 — Atividades e linha do tempo · **M** · depende de: C2 · **⬜ A fazer**
- Como vendedor, quero registrar na ficha: tarefa (assunto, prazo, prioridade, lembrete), ligação (resultado e nota), evento (data e hora, como uma demonstração) e nota.
- A atividade liga uma pessoa (lead ou contato) a um assunto (conta ou oportunidade), como os campos "Nome" e "Relativo a" do Salesforce. Na conversão (C12), as atividades do lead passam para o contato, a conta e a oportunidade.
- A linha do tempo junta tudo: "Próximas e atrasadas" no topo e o passado por mês. Entram também as conversas do WhatsApp (C5), as mudanças de campo (C2), os links enviados e o que a IA fez. Dá para filtrar por tipo.
- Como vendedor, quero a aba Tarefas: hoje, atrasadas e próximos 7 dias, com concluir em um clique. Uma tarefa atrasada aparece colada no registro dela, com a ação ao lado (regra do design).
- Lembretes pelo sino e, se o vendedor quiser, pelo WhatsApp dele.

#### C5 — WhatsApp na ficha · **M** · depende de: C3, C4 · **⬜ A fazer**
- Como vendedor, quero conversar com o lead dentro da ficha do lead ou do contato, num painel ao lado: a conversa inteira, com os balões do design (entrada, saída, automação), o áudio transcrito e os anexos.
- Como vendedor, quero responder dali com o que o motor de conversas já envia hoje, com os modelos de mensagem (as respostas rápidas, `QuickReply`, do tenant de vendas) e com a sugestão de resposta da IA (`AiSuggestionService`), que passa a ler a base de conhecimento de vendas.
- O estado da IA aparece na forma e no texto: "A IA está atendendo", com o botão **Assumir conversa**. Mandar uma mensagem também assume. **Devolver à IA** religa. Os dois usam o mesmo mecanismo que hoje tira a IA da conversa na Inbox.
- Cada sessão de conversa vira uma atividade "Conversa no WhatsApp" na linha do tempo, com o resumo e o número de mensagens.
- O que o vendedor responde pelo celular do número de vendas também aparece, porque a Evolution traz como mensagem de saída.
- Mensagem nova num lead meu: aviso no sino, notificação do navegador com som (a mesma da Inbox) e entrada na visão "Aguardando minha resposta", ordenada pelo tempo de espera.
- Não há lista de conversas: o vendedor chega à conversa pelo registro.

#### C6 — Base de conhecimento da IA · **P** · depende de: C1 · **⬜ A fazer**
- Como gestor, quero manter na Configuração do CRM o que a IA pode dizer: o que o Dish Desk faz, as integrações, as perguntas frequentes, as objeções com a resposta e o que não fazemos.
- Como plataforma, quero que preços, parcelas e dias de teste venham de [billing.ts](../../packages/shared/src/billing.ts), nunca digitados à mão, para a IA, o CRM e o site não divergirem.
- **Regra obrigatória:** a base só lista o que está no ar para qualquer restaurante. O que depende de terceiros ou ainda não existe (Instagram enquanto a Meta não aprova, Anota AI, Campanhas) aparece como "ainda não temos" ou fica de fora. É a mesma regra dos vídeos: só funções reais.
- A base vai inteira no prompt, com cache do prompt: cabe com folga no contexto do Haiku 5.5 e sai barata.

#### C7 — IA SDR (Haiku 5.5) · **G** · depende de: C3, C5, C6 · **⬜ A fazer**
- Como lead, quero ser respondido na hora, a qualquer hora, por texto ou por áudio.
- Como lead, quero saber desde a primeira mensagem que estou falando com uma IA e que ela é a mesma que vai atender os clientes do meu restaurante.
  - A primeira resposta a todo lead novo traz essa apresentação: texto fixo `salesIntro` em `AutomationMessages`, um por personalidade.
  - Exemplo (Cordial): "Oi, {nome}! Aqui é a inteligência artificial do Dish Desk. Sou a mesma IA que atende os clientes dos restaurantes que usam o Dish Desk, então esta conversa já é uma amostra: pode me mandar texto ou áudio e perguntar o que quiser. Qual é o seu restaurante?"
  - O "pode mandar áudio" só entra se a transcrição estiver ligada na produção.
- Como admin do CRM, quero ligar e desligar a IA e escolher a personalidade e o horário da equipe de vendas na Configuração do CRM, com as mesmas opções dos restaurantes. Fora do horário, ou com o "100% automático" ligado, a IA atende sozinha e o lead espera o vendedor, como no atendimento dos restaurantes (E27).
- Como lead, quero tirar dúvidas de funcionalidades, integrações, preço e teste grátis, e receber o link do teste ou da demo interativa (`/demo`) quando eu quiser. O link do teste sai com o código do dono do lead; se o lead ainda não tem dono, a regra de atribuição (C8) escolhe um antes.
- Como vendedor, quero receber o lead já qualificado. A IA pergunta aos poucos, sem formulário:
  - restaurante, cidade e tipo de cozinha;
  - número de lojas e pedidos por dia (faixa);
  - por onde vende e atende (WhatsApp, Instagram, iFood, Cardápio Web, Neemo, outro);
  - quantas pessoas atendem e a maior dor (demora no WhatsApp, chat do iFood, golpe de cancelamento, avaliações, base de clientes);
  - quem decide e quando quer começar.
- Como plataforma, quero a qualificação gravada nos campos do lead (`crm_leads`) por uma ferramenta com schema fechado (`registrar_qualificacao`). A nota do lead (A, B ou C), que faz o papel da classificação do Salesforce, é calculada pelo código a partir da qualificação, e não pela IA.
- Como lead, quero falar com uma pessoa a qualquer momento.
- A IA passa ao vendedor (`passar_para_vendedor`, com o motivo e o resumo) quando:
  - o lead pede;
  - o lead é A ou B e quer conversar ou ver uma demonstração;
  - a pergunta não está na base;
  - o lead negocia preço ou condição;
  - o lead tem 5 lojas ou mais.
  O lead vai para Qualificado, a regra de atribuição (C8) escolhe o dono, e o motivo e o resumo entram na linha do tempo. Sem vendedor no horário, a IA diz quando alguém vai falar com ele, e o lead espera na fila "Sem dono".
- Fora do funil (`desqualificar_lead`, com motivo): quem não é restaurante, procura emprego, é concorrente ou manda spam. Quem já é cliente e tem um problema vai para o suporte (ticket, como na extensão).
- **Regra obrigatória:** a IA só afirma o que está na base e nos dados do lead. Nunca inventa preço, desconto, prazo, funcionalidade ou integração. Sem a informação, ela passa ao vendedor. Desconto e condição especial são só do vendedor.
- Limites, como no agente do cardápio: até 6 chamadas ao modelo por turno, 30 s por chamada, teto de tokens por conversa por dia e um número máximo de respostas da IA por lead antes de chamar o vendedor.
- Falha do modelo, recusa ou teto estourado: o lead vai para o vendedor da vez pela regra de atribuição, como o atendimento faz quando a LLM cai. No Haiku 5.5, a recusa não tem reserva automática na API e é tratada como falha.
- Como gestor, quero um simulador com personas para ajustar o prompt antes de ligar e depois de cada mudança: dono de pizzaria no iFood, rede com 6 lojas, curioso que só pergunta o preço, cliente atual com problema, quem procura emprego.
  - Critério para ligar: nenhum fato inventado nas simulações e a passagem certa em todas as personas.
- Nas duas primeiras semanas, um vendedor acompanha as conversas da IA pela visão "Na fila da IA". Assumir a conversa tira a IA dela.
- Notas técnicas:
  - O SDR roda no `AnthropicLlmProvider.chatWithTools`, com o `LLM_PROVIDER_MODEL`. O system, a base e as ferramentas já vão com cache do prompt. O gasto cai em `AiUsage` do tenant de vendas e aparece em Plataforma → Gastos com IA.
  - O Haiku 5.5 pensa por padrão, com esforço `medium` (o provider não manda `effort` hoje). Medir no simulador se `low` mantém a qualidade com menos espera.
  - Custo estimado, a conferir no painel na primeira semana: centavos de dólar por conversa de lead. O Haiku 5.5 cobra US$ 0,10 por milhão de tokens de entrada e US$ 0,50 por milhão de saída, e a leitura do cache custa 10% da entrada.

#### C8 — Atribuição, filas, prazo de resposta e Início · **M** · depende de: C1, C3, C7 · **⬜ A fazer**
- Filas, como as do Salesforce: "IA SDR" (leads com a IA) e "Sem dono". Um lead numa fila ainda não tem vendedor dono.
- Regras de atribuição, em ordem, que o gestor liga e desliga:
  1. Lead com dono e atividade nos últimos 30 dias volta para o dono.
  2. Lead que chegou pelo código ou pelo link de um vendedor vai para ele.
  3. Rodízio entre os vendedores ativos, no horário e abaixo da capacidade. Com o filtro por região ligado, só entre os da região (DDD ou cidade).
  4. Sem ninguém disponível, o lead vai para a fila "Sem dono", e a IA segue atendendo.
- Ao receber o lead, o vendedor ganha a tarefa "Responder lead", com o prazo da primeira resposta (D7). Quando o prazo estoura, o vendedor é avisado. Depois, o lead passa ao próximo do rodízio e o gestor é avisado.
- Aviso de lead novo: sino, notificação do navegador com som e mensagem no WhatsApp do vendedor, pelo número de vendas, com o resumo e o link da ficha.
- Como vendedor, quero me marcar ausente (férias, doença) e parar de receber leads.
- Como gestor, quero redistribuir à mão um registro ou a carteira de um vendedor, com o motivo no histórico.
- Como vendedor, quero o Início (primeira versão): aguardando minha resposta, tarefas de hoje e atrasadas, e meus leads novos. A versão completa é a C19.

## Etapa 2 — Contas, oportunidades e o restaurante

Objetivo: o lead qualificado vira conta, contato e oportunidade. A oportunidade anda pelas fases até o pagamento, e o vendedor cria o restaurante em teste sem sair do CRM.

#### C9 — Contas e contatos · **M** · depende de: C2 · **⬜ A fazer**
- Conta é o restaurante, uma por loja. A rede de várias lojas tem uma conta-mãe, como a hierarquia de contas do Salesforce. Campos: nome, CNPJ, telefone, cidade e UF, tipo de cozinha, número de lojas, canais e sistemas de pedido, dono e a situação comercial (C13).
- Contato é a pessoa da conta (dono, sócio, gerente), com WhatsApp e e-mail. O WhatsApp do contato abre a conversa na ficha (C5).
- Listas relacionadas na conta: contatos, oportunidades, atividades, contas-filhas e o restaurante Dish Desk ligado.
- Carga inicial: cada restaurante que já existe vira uma conta (em teste ou cliente), com o dono como contato e sem vendedor, para o gestor distribuir. A conta demo e o tenant de vendas ficam de fora.

#### C10 — Oportunidades · **G** · depende de: C9, D8, D9 · **⬜ A fazer**
- Fases (D8), cada uma com probabilidade e categoria de previsão. Na Configuração do CRM, o gestor edita nome, ordem, probabilidade, categoria, campos-chave e orientação do Path, e os motivos de perda.
- Campos: nome, conta, contato principal, tipo (cliente novo, loja nova, troca para o anual, reativação), valor (C11), data prevista de fechamento, próximo passo, fase, probabilidade, categoria de previsão, origem (vinda do lead), concorrente e motivo da perda.
- Path na ficha. Fechada/Perdida exige o motivo. Teste grátis e Fechada/Ganha também mudam sozinhas, pelo que acontece no produto (C13).
- Kanban por fase, com a contagem e a soma do valor em cada coluna. Arrastar o cartão muda a fase e pede os campos obrigatórios dela.
- Avisos colados no cartão e na ficha, com a ação ao lado: sem atividade há 7 dias, data de fechamento vencida e teste acabando.
- Histórico de fase (entrada e saída de cada fase), para o tempo em cada fase nos relatórios.
- Visões prontas: Minhas oportunidades abertas, Fecham este mês, Paradas e Ganhas no mês.

#### C11 — Produtos, valor e desconto · **P** · depende de: C10, D9, D13 · **⬜ A fazer**
- Os produtos são os planos de `BILLING_PLANS` (mensal e anual), só leitura no CRM: o preço muda no [billing.ts](../../packages/shared/src/billing.ts) e o CRM acompanha.
- Itens da oportunidade: plano e número de lojas. O valor da oportunidade é a soma dos itens (D9).
- Desconto por item: até o teto do perfil, o vendedor aplica; acima dele, o pedido vai ao gestor, com o motivo. A oportunidade mostra "Aguardando aprovação" na forma e no texto até a resposta.
- Aplicar o desconto na cobrança (Stripe e InfinitePay) é trabalho à parte, a definir com a D13.

#### C12 — Conversão do lead · **M** · depende de: C3, C9, C10 · **⬜ A fazer**
- Como vendedor, quero o botão **Converter** no lead, que também é o último passo do Path. Ele abre a conversão: conta (nova ou existente), contato (novo ou existente), oportunidade (nova, com o nome sugerido, ou nenhuma) e o dono.
- Os possíveis duplicados aparecem na hora: a conta pelo CNPJ, pelo telefone ou pelo nome com a cidade; o contato pelo telefone ou pelo e-mail.
- Depois da conversão, o lead fica só para leitura e aponta para o que gerou. A linha do tempo, a conversa do WhatsApp e a qualificação passam para o contato, a conta e a oportunidade.
- O lead converte em qualquer status, menos Desqualificado.

#### C13 — Do CRM ao restaurante · **G** · depende de: C9 a C12 · **⬜ A fazer**
- Como vendedor, quero **criar o restaurante** a partir da conta ou da oportunidade: nome, dono, e-mail, WhatsApp e CPF/CNPJ, já preenchidos com os dados da conta e do contato.
  - O restaurante nasce em teste e ligado a mim, e o dono recebe o convite por e-mail para criar a senha.
  - A conta liga ao restaurante (`crm_accounts.restaurant_tenant_id`), e a oportunidade vai para Teste grátis.
  - Valem as regras do cadastro pelo site: CPF/CNPJ válido, os dias de teste do código (30) e a trava de reuso do teste pelo canal (`app.claim_channel`).
  - Cada vendedor cria até N restaurantes por dia, e toda criação vai para o AuditLog.
- Como vendedor, quero mandar ao lead, pela conversa da ficha e com um clique, registrado como atividade:
  - o link do teste com o meu código (`/cadastro?codigo=…`, que já preenche o campo; hoje a página não lê o parâmetro);
  - a demo interativa (`/demo`);
  - o link de pagamento, mensal ou anual, do restaurante já criado.
- Cadastro pelo site: o CRM procura o cadastro pelo WhatsApp e pelo e-mail.
  - Achou um lead: converte sozinho em conta, contato e oportunidade em Teste grátis.
  - Achou uma conta: liga o restaurante a ela e cria a oportunidade, se não houver uma aberta.
  - Não achou nada: cria conta, contato e oportunidade em Teste grátis.
  - O dono é o vendedor do código, ou quem a regra de atribuição (C8) escolher, e ele recebe a tarefa "Dar boas-vindas ao teste".
- O primeiro pagamento confirmado (`billing_payments`) move a oportunidade para Fechada/Ganha. Teste vencido sem pagamento gera aviso e tarefa ao dono: perder a oportunidade é decisão do vendedor.
- Como vendedor, quero ver na conta a situação do restaurante: dias de teste, passos da implantação (WhatsApp conectado, IA ligada, primeira mensagem, integrações), plano e "pago até". Só esses campos: nunca conversas, clientes ou pedidos do restaurante.
- Avisos ao dono da conta: teste parado (sem WhatsApp conectado em 2 dias, sem primeira mensagem em 3), teste acabando em 3 dias sem pagamento e assinatura vencida.
- `tenants.seller_id` guarda o vendedor creditado pela venda, para a comissão e para a lista de restaurantes da plataforma.
  - Ordem da atribuição: o código usado no cadastro, depois o vendedor que criou o restaurante, depois o dono da oportunidade (a confirmar na D14).
  - Só o gestor troca, com o motivo, no AuditLog.

#### C14 — Retomadas da IA · **M** · depende de: C7, C8 · **⬜ A fazer**
- Como vendedor, quero que a IA retome o lead que parou de responder: em 24 h e em 72 h, no máximo duas vezes, no tom da personalidade. Sem resposta, o lead vai para Nutrição, com a data para tentar de novo.
- Como vendedor, quero que a IA ofereça ajuda ao restaurante com o teste parado ("quer ajuda para conectar o WhatsApp?") e me crie a tarefa.
- Como lead, quero parar de receber mensagens com "SAIR" ou "PARAR", registrado em `Consent`.
- Contra o banimento do número, que é conectado por QR Code:
  - só recebe retomada quem já conversou ou se cadastrou;
  - há um limite de conversas por dia que a IA começa;
  - nada de envio para lista.
- Os textos fixos (`salesFollowUp1`, `salesFollowUp2`, `salesTrialStalled`…) entram em `AutomationMessages`, um por personalidade, e os marcadores novos (`{vendedor}`, `{link}`) no `REQUIRED` do teste de [settings.test.ts](../../packages/shared/test/settings.test.ts).

#### C15 — Listas avançadas, Kanban de leads, importação e mesclagem · **M** · depende de: C2, C3 · **⬜ A fazer**
- Como vendedor, quero salvar visões de lista (só para mim ou para a equipe), editar no lugar na lista e fazer ações em massa (status, retomada). Trocar o dono em massa continua só do gestor.
- Kanban também para leads, por status.
- Como gestor, quero exportar a lista em CSV, com registro no AuditLog.
- Como gestor, quero importar leads de um CSV: ligar as colunas aos campos do registro, com origem e dono obrigatórios e os duplicados avisados antes de gravar.
- Como gestor, quero mesclar leads, contatos e contas duplicados.

## Etapa 3 — Gestão: relatórios, painéis, previsão e comissões

#### C16 — Relatórios · **G** · depende de: C10, C13 · **⬜ A fazer**
- Como gestor, quero montar relatórios como no Salesforce: escolher o tipo, as colunas, os filtros, os agrupamentos e o gráfico.
  - Tipos: Leads; Leads com atividades; Oportunidades; Oportunidades com produtos; Histórico de fases; Contas com a situação do restaurante; Atividades; IA SDR (conversas, passagens e custo de `AiUsage`).
  - Formatos: tabela e resumo (agrupado por até dois campos, com subtotais). Matriz fica para depois.
  - Gráficos: barra, linha, funil e rosca.
  - Filtros por campo e por período (este mês, mês passado, este trimestre, últimos N dias).
  - Pastas: Meus relatórios e Equipe. Exportar em CSV é só do gestor.
- Relatórios prontos:
  - funil, com a conversão entre as fases e o tempo médio em cada uma, por período;
  - por origem: site (pelo `utm_source`), Instagram, indicação, prospecção e cadastro direto;
  - por vendedor: tempo da primeira resposta, leads, testes, vendas, receita e motivos de perda;
  - IA SDR: leads atendidos, qualificados por ela sozinha, passados ao vendedor, conversão dos leads que ela qualificou e custo de IA por lead e por venda.
- Os relatórios só usam os campos do registro e passam pela RLS. Valores de comissão ficam só no extrato da C21.

#### C17 — Painéis · **M** · depende de: C16 · **⬜ A fazer**
- Como gestor, quero painéis com componentes (número, barra, funil, rosca, tabela) feitos de relatórios salvos. O filtro de período e de vendedor fica dentro do bloco que ele altera (regra do design).
- O painel mostra os dados de quem está vendo, como o painel dinâmico do Salesforce: o mesmo painel serve à equipe e a cada vendedor.
- Prontos: Meu painel (vendedor) e Painel de vendas (gestor).
- No celular, os painéis abrem só para leitura.

#### C18 — Previsão e metas · **M** · depende de: C10, D8 · **⬜ A fazer**
- Como gestor, quero metas mensais por vendedor (valor e número de vendas). A meta da equipe é a soma pela hierarquia.
- Como vendedor e como gestor, quero a previsão do mês e do trimestre por categoria (Fechado, Compromisso, Melhor caso, Pipeline), contra a meta. Clicar no número abre as oportunidades dele.
- Como gestor, quero ajustar o número de um vendedor, com uma nota. O número original continua visível.

#### C19 — Início completo · **P** · depende de: C8, C13, C18 · **⬜ A fazer**
- Meta do mês e realizado, com o filtro do período dentro do bloco.
- Carteira: leads por status, oportunidades por fase, testes em andamento (com a saúde da implantação e os dias que faltam), oportunidades que fecham no mês e a comissão prevista (C21).

#### C20 — Agenda de demonstrações · **M** · depende de: C4, C10 · **⬜ A fazer**
- Como vendedor, quero ver meus eventos em calendário (dia e semana) e cadastrar os horários em que faço demonstração.
- Como lead, quero que a IA me ofereça dois ou três horários livres (opções numeradas), confirme o que eu escolher e me mande o link da chamada. O evento nasce ligado ao lead ou à oportunidade; se houver oportunidade, ela vai para Demonstração.
- Lembretes ao lead e ao vendedor pelo WhatsApp, na véspera e 1 h antes, com os textos em `AutomationMessages`. O vendedor registra o resultado no evento: feita, não compareceu ou remarcada.
- Cada vendedor é admin da conta demo (Pizzaria Vila Brasa) para as apresentações. Falta publicá-la na produção.
- Sincronizar com o Google Agenda e gerar o link do Meet sozinho fica para a D15.

#### C21 — Comissões · **M** · depende de: C13, D14 · **⬜ A fazer**
- Como plataforma, quero calcular a comissão de cada vendedor pelos pagamentos confirmados dos restaurantes ligados a ele (`tenants.seller_id`), pela regra da D14.
- Como vendedor, quero o extrato do mês: restaurante, pagamento, comissão e situação (prevista, a pagar, paga).
- Como gestor, quero fechar o mês, marcar como paga e exportar.
- Estorno ou reembolso desfaz a comissão daquele pagamento.
- A comissão só sai de pagamento confirmado, nunca de teste: assim ninguém ganha criando teste falso.

## Etapa 4 — Produtividade e expansão

#### C22 — Cadências · **G** · depende de: C14, D17 · **⬜ A fazer**
- Como gestor, quero montar cadências como as do Sales Engagement do Salesforce: passos com intervalo (mensagem pelo WhatsApp, ligação, tarefa). O gestor escreve o texto de cada passo; os textos padrão que vierem prontos entram em `AutomationMessages`, um por personalidade.
- O lead sai da cadência quando responde, quando é convertido ou quando manda "SAIR".
- Contra o banimento: limite diário de mensagens, e só entra quem pediu contato ou já conversou (D17).
- As retomadas da IA (C14) viram a cadência padrão.

#### C23 — Automações "quando/então" · **M** · depende de: C2 · **⬜ A fazer**
- Como admin do CRM, quero regras simples, sem construtor visual: **quando** (registro criado, campo mudou, N dias sem atividade, data chegou), **se** (filtros do registro) e **então** (criar tarefa, avisar, mudar um campo, pôr na cadência).
- Cada regra mostra quantas vezes rodou e o último erro. Há um limite de regras e de execuções por registro, contra laço infinito.

#### C24 — Campos personalizados · **G** · depende de: C2, D16 · **⬜ A fazer**
- Como admin do CRM, quero criar campos em leads, contas, contatos e oportunidades, com os tipos do registro. Eles aparecem na ficha, na lista, nos filtros, na importação e nos relatórios.
- Os valores ficam numa coluna `custom` (JSONB) de cada objeto, e as definições numa tabela. O registro de objetos junta os campos fixos e os personalizados.

#### C25 — Campanhas e novas origens · **M** · depende de: C3, C16 · **⬜ A fazer**
- Como gestor, quero campanhas (nome, período, custo) com os leads e contatos de cada uma, e ver as oportunidades e a receita que vieram dela.
- Formulário curto no site e no fim da `/demo` (nome, restaurante, WhatsApp). Vira lead, e a IA manda a primeira mensagem, porque o lead pediu o contato.
- Clique no WhatsApp do site medido como o de "Teste grátis" (hoje o [track.js](../../apps/web/public/assets/track.js) só conta os links do `/cadastro`), e a mensagem pronta de cada botão diz de onde o lead veio.
- Instagram @dish.desk no tenant de vendas, depois da análise da Meta.
- Anúncios de clique para o WhatsApp: conferir se a Evolution traz o anúncio de origem.
- Indicação: o restaurante cliente indica outro pelo próprio código. A definir: o benefício de quem indica.

#### C26 — Demonstração com o cardápio do lead · **G** · depende de: C7, importação de cardápio por IA · **⬜ A fazer**
- Como lead, quero mandar a foto ou o PDF do meu cardápio e ver a IA atender um "cliente" do meu restaurante ali mesmo, na conversa.
- A importação de cardápio por IA, que já existe, monta o cardápio numa área de teste. A IA faz a simulação marcada como simulação, sem nada sair do Dish Desk, e no fim oferece criar o teste com o cardápio importado.
- A definir: o custo por simulação, o limite por lead e o que fazer com o cardápio se o lead não fechar.

#### C27 — Parceiros · **P** · depende de: C1, C21 · **⬜ A fazer**
- Como parceiro (agência, consultor de delivery), quero entrar e ver só os meus códigos, os restaurantes que trouxe, a situação de cada um e a minha comissão.
- O parceiro não recebe leads da IA e não vê os registros dos vendedores.

#### C28 — Assistente do vendedor · **M** · depende de: C10, C16 · **⬜ A fazer**
- Como vendedor, quero que a IA sugira na ficha a próxima ação, resuma a conta antes de uma ligação e escreva o rascunho da proposta. Ela lê só os dados do CRM, e nada sai sem o vendedor mandar.

---

## Segurança e LGPD (todas as etapas)

- O vendedor nunca lê dados de dentro de um restaurante: contatos, conversas, pedidos ou avaliações. A situação comercial dos clientes vem de uma função do banco que devolve só os campos comerciais.
- O papel `SELLER` só abre as rotas `/crm`. As rotas do painel do restaurante o recusam.
- Entra no CI um teste de isolamento, como o de tenants: o vendedor não lê nada de restaurante; o `SELLER` não abre nenhuma rota do painel do restaurante; o vendedor A não altera registro do B; o gestor deles altera.
- O vendedor não suspende restaurante, não libera acesso, não liga módulos e não entra no painel do cliente (D10).
- Vão para o AuditLog: criar restaurante, mandar link de pagamento, trocar vendedor, estender teste, trocar dono, aprovar desconto, exportar e importar.
- Exportar e importar CSV é só do gestor. Listas e relatórios só montam consultas com os campos do registro (lista branca) e passam pela RLS.
- Base legal do lead: o próprio pedido de contato (escreveu, se cadastrou ou preencheu o formulário). Prospecção fria só pelo vendedor, uma pessoa por vez (D17).
- Retenção: lead desqualificado ou perdido e sem atividade por 12 meses é anonimizado (proposta). Exportar e apagar a pedido, como no fluxo LGPD que Clientes já tem.
- A próxima auditoria de segurança (CLAUDE.md §11) vence em 29/11/2026. Quando o CRM existir, ele entra no escopo da auditoria seguinte: o papel novo abre um caminho novo até os dados dos restaurantes.

## Riscos

- **Escopo do Salesforce sem fim:** o núcleo primeiro, a lista "Fora do escopo" e cada etapa usável sozinha. O que não está na tabela do Salesforce acima só entra com pedido.
- **Telas genéricas lentas com muitos registros:** paginação e filtros no servidor, índices nos campos filtráveis do registro e limite de linhas nos relatórios.
- **Vazamento pela exportação ou pelos relatórios:** só o gestor exporta, tudo vai para o AuditLog, e os relatórios só usam os campos do registro, sob a RLS.
- **Banimento do número de vendas** (WhatsApp por QR Code, não oficial): só responder quem escreveu, retomadas limitadas, nada de lista e um número reserva pronto para conectar.
- **A promessa "é a mesma IA" deixar de ser verdade:** uma constante de modelo para o atendimento e para o SDR (Etapa 0).
- **Informação comercial errada:** base fechada, preços lidos do código, simulador antes de ligar e acompanhamento nas duas primeiras semanas.
- **Disputa de comissão:** uma regra de atribuição só, gravada no restaurante com a data e a origem.

## Ordem sugerida

```
Etapa 0  número de vendas, atendimento no Haiku 5.5, boards, privacidade, decisões da Etapa 1
Etapa 1  C1 Org → C2 Base do CRM → C3 Leads ∥ C4 Atividades → C5 WhatsApp na ficha
         C6 Base de conhecimento → C7 IA SDR → C8 Atribuição e Início
Etapa 2  C9 Contas → C10 Oportunidades → C11 Produtos → C12 Conversão → C13 Do CRM ao restaurante
         C14 Retomadas ∥ C15 Listas avançadas e importação
Etapa 3  C16 Relatórios → C17 Painéis ∥ C18 Previsão → C19 Início completo
         C20 Agenda ∥ C21 Comissões
Etapa 4  C22 a C28, conforme a necessidade
```

A base do CRM (C2 a C5) vem antes da IA ligada: sem a Inbox, o vendedor precisa da lista, da ficha e da conversa antes de receber o primeiro lead. Com dois devs, a IA (C6 e C7) anda junto com C2 a C5. A comissão fica para a Etapa 3 porque depende da D14 e do `tenants.seller_id` (C13). Até lá, os restaurantes de cada código continuam consultados por SQL ([docs/vendedores.md](../vendedores.md)).

Tamanho, pelas faixas (P = 1, M = 1,5 e G = 3 semanas de 1 dev): Etapa 1 ≈ 14 semanas, Etapa 2 ≈ 13, Etapa 3 ≈ 10 e Etapa 4 ≈ 14.

## Critérios de aceite das Etapas 1 e 2

- [ ] Mensagem no WhatsApp de vendas recebe a resposta da IA em segundos, a qualquer hora, e o lead aparece na fila "IA SDR".
- [ ] A primeira resposta a todo lead novo diz que é a IA do Dish Desk, a mesma que atende os clientes dos restaurantes.
- [ ] A IA nunca informa preço, prazo, desconto ou funcionalidade fora da base (simulador sem nenhum fato inventado).
- [ ] O lead qualificado chega ao vendedor da vez com a qualificação preenchida, o resumo na linha do tempo e a tarefa "Responder lead" com prazo.
- [ ] O vendedor conversa com o lead pela ficha, no computador e no celular, sem abrir a Inbox.
- [ ] Sem vendedor no horário, a IA avisa o lead, e o lead espera na fila "Sem dono".
- [ ] A conversão cria conta, contato e oportunidade, e a linha do tempo do lead vai junto.
- [ ] O vendedor cria o restaurante em teste pela conta, o dono recebe o convite e a oportunidade vai para Teste grátis.
- [ ] Cadastro pelo site com o código de um vendedor cai na carteira dele; sem código, segue a regra de atribuição.
- [ ] O primeiro pagamento move a oportunidade para Fechada/Ganha sozinho.
- [ ] O Kanban de oportunidades mostra a contagem e a soma do valor de cada fase.
- [ ] O vendedor não lê conversas, clientes nem pedidos de nenhum restaurante, e o papel `SELLER` não abre nenhuma rota do painel do restaurante (testes no CI).
- [ ] O vendedor A não altera registro do vendedor B; o gestor deles altera, e a mudança fica no histórico.
- [ ] "SAIR" para as retomadas.
- [ ] O gasto da IA de vendas aparece em Plataforma → Gastos com IA, separado dos restaurantes.

## Decisões em aberto

| # | Decisão | Recomendação | Antes de |
|---|---|---|---|
| D1 | Número de vendas: o dos links do site ou um novo | o do site, se for só da empresa: os leads já escrevem nele | Etapa 1 |
| D2 | Visual do CRM | a organização das telas do Salesforce com o visual do Dish Desk (cores, fontes e componentes do design). Copiar o visual do Salesforce (cores, ícones, marca) fica fora | Etapa 0 (boards) |
| D3 | O vendedor vê os registros dos outros? | lê todos; edita só o dono, os gestores acima dele e o admin. Trocar o dono é só do gestor | Etapa 1 |
| D4 | Gestor e hierarquia | perfil Gestor no vendedor e gestor direto (`manager_id`); o super admin é o admin do CRM | Etapa 1 |
| D5 | Avaliação automática (Jev) nas conversas de vendas | desligar na Etapa 1; medir o vendedor pelo tempo de resposta e pela conversão | Etapa 1 |
| D6 | Um número de vendas para todos ou um por vendedor | um só: o lead fala sempre com o mesmo número, a IA e o vendedor dividem a conversa, e o histórico fica com a empresa se o vendedor sair. Fora do escritório, o vendedor usa a versão celular da ficha | Etapa 1 |
| D7 | Prazo da primeira resposta do vendedor | 15 min no horário, com uma reatribuição | Etapa 1 |
| D8 | Fases da oportunidade | Qualificação 10% (Pipeline) → Demonstração 20% (Pipeline) → Teste grátis 40% (Melhor caso) → Negociação 70% (Compromisso) → Fechada/Ganha 100% (Fechado); Fechada/Perdida 0%, fora da previsão. Ajustar as probabilidades com os números reais | Etapa 2 |
| D9 | Valor da oportunidade | receita do primeiro ano por loja (mensal × 12 ou o preço do anual), com a receita mensal ao lado | Etapa 2 |
| D10 | O vendedor entra no painel do cliente? | não. Se precisar ajudar na implantação, o restaurante o convida como usuário e o remove depois | Etapa 2 |
| D11 | Teste do restaurante criado pelo vendedor | 30 dias, como o do código; estender só o gestor, uma vez, com motivo | Etapa 2 |
| D12 | A IA escreve para quem se cadastrou sozinho? | uma mensagem de boas-vindas com oferta de ajuda, que o lead encerra com "SAIR" | Etapa 2 |
| D13 | Desconto e condição especial | só o vendedor oferece, até um teto; acima dele, o gestor aprova. A IA nunca oferece. Falta definir como o desconto entra na cobrança (Stripe e InfinitePay) | Etapa 2 |
| D14 | Comissão: percentual ou valor, só a primeira mensalidade ou recorrente, mensal e anual iguais ou não; ordem da atribuição | as perguntas de [docs/vendedores.md](../vendedores.md); a ordem proposta está na C13 | Etapa 3 |
| D15 | Agenda | própria no começo; Google Agenda depois | Etapa 3 |
| D16 | Campos personalizados | campos fixos até a Etapa 3; campos personalizados só se a equipe pedir | Etapa 4 |
| D17 | Prospecção fria pela IA (escrever para restaurantes que não pediram contato) | fora das Etapas 1 a 3: alto risco de banimento do número por QR Code e de reclamação. Se for necessária, pela API oficial com modelo aprovado, ou pelo vendedor, uma pessoa por vez | Etapa 4 |
