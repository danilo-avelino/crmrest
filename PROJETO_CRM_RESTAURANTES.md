# Dish Desk — CRM Omnichannel para Restaurantes — Especificação do Projeto

> Documento de referência para desenvolvedores (humanos e IA). Descreve visão, arquitetura, stack, modelo de dados, módulos, convenções e roadmap.
> Nome do produto: **Dish Desk**.

---

## 1. Visão do produto

SaaS **multi-tenant** (vários restaurantes) que centraliza o atendimento de **WhatsApp, Instagram, chat do iFood e outras plataformas** em uma única caixa de entrada, mantendo um **cadastro unificado de clientes** e oferecendo um **módulo extra de campanhas automatizadas** (disparos em massa).

### Objetivos principais
1. **Inbox unificada:** atendentes respondem todos os canais em uma única tela, em tempo real.
2. **Cadastro automático de clientes:** todo contato vira (ou atualiza) um cadastro, com o máximo de dados extraídos da origem (nome, telefone, CPF, endereço, histórico).
3. **Coleta ativa de telefone:** quando a origem não fornece telefone real (ex.: chat do iFood, Instagram), o sistema pede o telefone logo na primeira interação.
4. **Campanhas (módulo pago/extra):** disparos segmentados, agendados e automatizados.
5. **Escala:** arquitetura preparada para **100+ restaurantes** com crescimento horizontal.

### Personas
| Persona | Descrição |
|---|---|
| **Super Admin (plataforma)** | Equipe dona do SaaS. Gerencia tenants, planos, módulos e saúde do sistema. |
| **Admin do restaurante** | Dono/gerente. Conecta canais, gerencia usuários, configura mensagens automáticas e campanhas. |
| **Atendente** | Responde conversas, edita cadastros de clientes, usa respostas rápidas. |

---

## 2. Stack tecnológica

Escolhida por ser a mais popular e apreciada entre desenvolvedores (TypeScript ponta a ponta), facilitando contratação e onboarding.

| Camada | Tecnologia |
|---|---|
| Linguagem | **TypeScript** (strict) |
| Frontend | **Next.js** (App Router) + **React** + **Tailwind CSS** + **shadcn/ui** + TanStack Query |
| Backend | **Node.js (LTS)** + **NestJS** |
| Banco de dados | **PostgreSQL 16+** |
| ORM | **Prisma** |
| Filas / cache / pub-sub | **Redis** + **BullMQ** |
| Tempo real | **Socket.IO** com adapter Redis |
| Armazenamento de mídia | **S3 compatível** (AWS S3, Cloudflare R2 ou MinIO local) |
| Autenticação | JWT (access + refresh) com sessões; opcional: Auth.js / provedor externo |
| Validação | **Zod** (contratos compartilhados entre front e back) |
| Monorepo | **pnpm workspaces** + **Turborepo** |
| Testes | **Vitest** (unit), Supertest (API), **Playwright** (E2E) |
| Qualidade | ESLint, Prettier, Husky + lint-staged, Commitlint (Conventional Commits) |
| CI/CD | **GitHub Actions** |
| Infra local | **Docker Compose** |
| Observabilidade | Pino (logs JSON), OpenTelemetry, Sentry, Prometheus/Grafana |

---

## 3. Arquitetura

### 3.1 Visão geral

```
                 ┌──────────────────────────────────────────────────────────┐
  WhatsApp ─────►│                                                          │
  Instagram ────►│   webhook-gateway  (recebe, valida assinatura, responde  │
  iFood ────────►│                     200 rápido e enfileira)              │
  Outros ───────►│                                                          │
                 └───────────────┬──────────────────────────────────────────┘
                                 │  Redis / BullMQ (filas)
                 ┌───────────────▼──────────────────────────────────────────┐
                 │  workers                                                 │
                 │   • inbound   → normaliza, identifica tenant/contato,    │
                 │                 salva mensagem, dispara automações       │
                 │   • outbound  → envia mensagens às APIs dos canais       │
                 │   • media     → baixa/sobe mídias para S3                │
                 │   • campaigns → disparos em massa (fila isolada)         │
                 │   • scheduler → jobs agendados (lembretes, campanhas)    │
                 └───────────────┬──────────────────────────────────────────┘
                                 │
         ┌───────────────────────▼───────────┐      ┌─────────────────────┐
         │ PostgreSQL (RLS por tenant)       │      │ S3 (mídias)         │
         └───────────────────────▲───────────┘      └─────────────────────┘
                                 │
                 ┌───────────────┴──────────────┐   Redis pub/sub
                 │  api (NestJS, REST)          │◄──────────────┐
                 │  realtime (Socket.IO)        │───────────────┘
                 └───────────────▲──────────────┘
                                 │ HTTPS / WebSocket
                 ┌───────────────┴──────────────┐
                 │  web (Next.js) — painel      │
                 └──────────────────────────────┘
```

### 3.2 Processos (deployables)

O código do backend fica em **um único app NestJS** (monólito modular), mas roda em **processos separados** por papel, escaláveis de forma independente:

| Processo | Papel | Escala |
|---|---|---|
| `api` | REST para o painel, autenticação, CRUD | Horizontal (stateless) |
| `realtime` | Socket.IO, eventos de nova mensagem/status | Horizontal (adapter Redis) |
| `webhook-gateway` | Endpoints públicos dos canais; só valida e enfileira | Horizontal, muito leve |
| `worker` | Consome filas (inbound, outbound, media, campaigns) | Horizontal por fila |
| `scheduler` | Agenda jobs recorrentes (uma instância ativa) | 1 réplica (lock no Redis) |
| `web` | Next.js | Horizontal / edge |

> **Por que monólito modular e não microsserviços?** Para uma equipe pequena e ~100–1.000 tenants, um monólito modular bem dividido é mais simples de desenvolver, testar e implantar. Os módulos têm fronteiras claras e podem ser extraídos para serviços no futuro, se necessário.

### 3.3 Estratégia multi-tenant (100+ restaurantes)

**Modelo:** banco **compartilhado**, schema compartilhado, coluna `tenant_id` em todas as tabelas de negócio + **Row-Level Security (RLS) do PostgreSQL** como segunda camada de proteção.

- Cada request autenticada define os tenants no contexto (`AsyncLocalStorage`) e executa `SET LOCAL app.tenant_ids = '{<uuid>}'` na transação (um elemento no modo restaurante; vários no painel master, ver abaixo).
- Políticas RLS: `USING (tenant_id = ANY(current_setting('app.tenant_ids')::uuid[]))`.
- Uma extensão do Prisma Client injeta `tenant_id` automaticamente em queries e criações.
- Workers resolvem o tenant pelo canal de origem (ex.: `phone_number_id` do WhatsApp → `channel` → `tenant_id`) antes de qualquer acesso a dados.
- Índices compostos sempre começando por `tenant_id`.

**Painel master (usuário em vários tenants):** um usuário pode pertencer a vários tenants (`TenantMember`). Após o login ele escolhe **um restaurante** ou o **painel master**, uma visão única que agrega todos os tenants dos quais é membro. No modo master, o contexto passa a ser uma lista: `SET LOCAL app.tenant_ids = '{<uuid>,<uuid>}'`. As políticas RLS aceitam os dois modos: `USING (tenant_id = ANY(current_setting('app.tenant_ids')::uuid[]))` (o modo de um restaurante é uma lista de um elemento). A lista vem **sempre** de `TenantMember` no backend, nunca do cliente. Toda ação de escrita no master age sobre **um** tenant (o do item) e respeita o papel do usuário nesse tenant. Contatos continuam isolados por tenant: o mesmo cliente em dois restaurantes são dois contatos.

**Por que esse modelo:** escala bem para centenas/milhares de tenants, migrações são únicas, custo baixo. Schema-por-tenant ou banco-por-tenant ficam reservados para clientes enterprise no futuro.

### 3.4 Escalabilidade e isolamento entre tenants

| Risco | Solução |
|---|---|
| Pico de webhooks | Gateway responde `200` imediatamente e enfileira; processamento assíncrono. |
| Um tenant "barulhento" atrasar os outros | Rate limit por tenant nas filas; jobs com `tenant_id` e concorrência limitada por tenant. |
| Campanha em massa travar o atendimento | **Fila de campanhas separada** com workers próprios; atendimento (inbound/outbound) sempre tem prioridade. |
| Limites de throughput das APIs (ex.: mensagens/segundo por número WhatsApp) | Rate limiter por `channel_id` (token bucket no Redis). |
| Webhooks duplicados/reenviados | **Idempotência**: chave única `(channel_id, external_message_id)`. |
| Crescimento da tabela de mensagens | Índices `(tenant_id, conversation_id, created_at)`; particionamento mensal por `created_at` quando passar de dezenas de milhões de linhas. |
| Leituras pesadas (relatórios) | Réplica de leitura do Postgres; agregações pré-calculadas. |
| Conexões ao banco | PgBouncer (modo transaction) na frente do Postgres. |
| Mídias | Nunca no banco; S3 com URLs assinadas. |

**Dimensionamento inicial de referência (100 tenants):** 2× api, 2× realtime, 2× webhook-gateway, 2–4× worker, 1× scheduler, Postgres gerenciado (2 vCPU / 8 GB + réplica), Redis gerenciado (2–4 GB).

### 3.5 Fluxo de uma mensagem recebida

1. Canal envia webhook → `webhook-gateway` valida assinatura (ex.: `X-Hub-Signature-256` da Meta) e enfileira `inbound` com payload bruto.
2. Worker `inbound`:
   1. Resolve `channel` → `tenant_id`.
   2. Verifica idempotência.
   3. **Normaliza** para o formato interno `NormalizedMessage` (ver §6).
   4. **Identifica/cria o contato** (ver §5.2 — resolução de identidade).
   5. Abre ou reabre a `conversation`.
   6. Salva a `message`; enfileira download de mídia se houver.
   7. Executa automações (ex.: **coleta de telefone**, mensagem fora do horário).
   8. Publica evento no Redis → `realtime` envia ao painel dos atendentes do tenant.
3. Atendente responde → `api` grava mensagem `pending` → fila `outbound` → envio ao canal → atualização de status (`sent`, `delivered`, `read`, `failed`) via webhook.

---

## 4. Estrutura do monorepo

```
crm-restaurantes/
├── apps/
│   ├── web/                    # Next.js — painel (inbox, clientes, campanhas, config)
│   └── api/                    # NestJS — api, realtime, webhook-gateway, workers, scheduler
│       └── src/
│           ├── main.ts         # bootstrap por papel: APP_ROLE=api|realtime|gateway|worker|scheduler
│           ├── common/         # tenant context, guards, interceptors, prisma, logger
│           └── modules/
│               ├── auth/
│               ├── tenants/
│               ├── users/
│               ├── channels/           # cadastro/conexão de canais
│               ├── connectors/
│               │   ├── whatsapp/
│               │   ├── instagram/
│               │   ├── ifood/
│               │   └── connector.interface.ts
│               ├── contacts/           # cadastro unificado de clientes
│               ├── conversations/
│               ├── messages/
│               ├── automations/        # coleta de telefone, horário, boas-vindas
│               ├── campaigns/          # MÓDULO EXTRA
│               ├── billing/            # planos e módulos habilitados
│               ├── consents/           # LGPD
│               └── realtime/
├── packages/
│   ├── database/               # schema.prisma, migrações, seed, políticas RLS (SQL)
│   ├── shared/                 # tipos, schemas Zod, NormalizedMessage, enums
│   ├── ui/                     # componentes compartilhados (shadcn) — extrair de apps/web/components/ui quando houver um 2º app
│   └── config/                 # eslint, tsconfig, prettier compartilhados
├── infra/
│   ├── docker/                 # Dockerfiles
│   └── k8s/ ou terraform/      # (futuro)
├── docs/
│   ├── adr/                    # Architecture Decision Records
│   └── connectors/             # notas de cada integração
├── docker-compose.yml          # postgres, redis, minio, mailhog
├── turbo.json
├── pnpm-workspace.yaml
├── .env.example
├── CLAUDE.md                   # convenções para assistentes de IA
├── CONTRIBUTING.md
└── README.md
```

---

## 5. Módulos funcionais

### 5.1 Inbox unificada
- Lista de conversas com filtros: canal, status (`open`, `pending`, `resolved`), atendente, tags, não lidas.
- Visualização de conversa com histórico completo do cliente em todos os canais.
- Painel lateral com o **cadastro do cliente** (editável).
- Atribuição manual e automática (round-robin entre atendentes online).
- Respostas rápidas (atalho `/`), notas internas, envio de mídia.
- Indicadores: janela de 24h do WhatsApp/Instagram (tempo restante para resposta livre).
- Notificações em tempo real e som.

### 5.1.1 Painel master (multi-restaurante)
- Disponível para usuários membros de 2+ tenants; escolhido na tela "Escolha o restaurante".
- Inbox única com as conversas de todos os tenants do usuário; cada item mostra o restaurante de origem e há filtro por restaurante.
- Responder, atribuir, resolver e editar seguem o papel do usuário no tenant daquela conversa.
- Contatos não são unificados entre tenants (ver §3.3).

### 5.2 Cadastro de clientes (contatos)

Todo contato que interage com o restaurante gera ou atualiza um **cadastro unificado** dentro do tenant.

**Dados extraídos automaticamente por origem:**

| Origem | Nome | Telefone | CPF | Outros |
|---|---|---|---|---|
| WhatsApp | ✅ nome do perfil | ✅ sempre (wa_id) | ❌ | — |
| Instagram | ✅ nome / @usuário | ❌ | ❌ | foto de perfil (quando disponível) |
| iFood | ✅ nome do cliente | ⚠️ normalmente mascarado/localizador | ⚠️ só se informado no pedido ("CPF na nota") | endereço de entrega, histórico de pedidos |

**Campos do cadastro:** nome, telefone(s), e-mail, CPF (criptografado), data de nascimento, endereços, tags, observações, preferências, canais vinculados (identidades), consentimentos, métricas (primeiro contato, último contato, total de pedidos).

**Resolução de identidade (merge):**
1. Busca identidade existente por `(tenant_id, channel_type, external_id)`.
2. Se não existir, tenta casar por **telefone normalizado (E.164)** e depois por **CPF (hash)**.
3. Se encontrar, vincula a nova identidade ao contato existente; senão, cria novo contato.
4. Merge manual disponível no painel para duplicados ("possível duplicado" sinalizado).

**Regra: dados nunca são sobrescritos por valores vazios**; dados digitados pelo atendente têm precedência sobre dados automáticos.

### 5.3 Automação: coleta de telefone

Quando uma conversa é iniciada por um contato **sem telefone real** (iFood, Instagram, etc.):

1. Na primeira mensagem, o sistema envia automaticamente (texto configurável por tenant):
   > "Olá! 👋 Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?"
2. Ao receber resposta, extrai e valida o número (libphonenumber, padrão BR) e salva no cadastro como `phone_source = 'informed_by_customer'`.
3. Confirma: "Obrigado! Já anotamos seu telefone." e segue o atendimento normal.
4. Se não houver resposta em X minutos (configurável), envia **um** lembrete; depois marca `phone_status = 'pending'` e exibe alerta ao atendente.
5. Atendente pode preencher manualmente a qualquer momento.

Implementação: máquina de estados simples em `automations` (`awaiting_phone` → `phone_collected` | `phone_skipped`) armazenada na conversa. As mesmas bases servirão para coleta opcional de CPF, nome e e-mail.

### 5.4 Gestão de canais
- Conectar **WhatsApp** via *Embedded Signup* da Meta (WhatsApp Business Platform / Cloud API).
- Conectar **Instagram** (e Messenger) via login da Meta — conta Profissional vinculada a uma Página.
- Conectar **iFood** com credenciais do Merchant API (por loja/merchant).
- Tokens armazenados **criptografados** (AES-256-GCM com chave em KMS/variável segura).
- Tela de status do canal (conectado, erro, token expirando).

### 5.5 Módulo extra: Campanhas (disparos em massa)

Habilitado por tenant conforme o plano (`tenant_modules`). Sem o módulo, a UI e os endpoints ficam bloqueados (guard `@RequiresModule('campaigns')`).

**Funcionalidades:**
- **Segmentação:** filtros salvos (ex.: sem pedido há 30 dias, aniversariantes do mês, tag "VIP", canal de origem, bairro).
- **Templates:** gestão e sincronização de templates do WhatsApp (criação, status de aprovação pela Meta), variáveis (`{{nome}}`, `{{cupom}}`).
- **Disparo:** imediato ou agendado; envio em lotes com rate limit por número.
- **Automações (jornadas):** gatilhos por evento (ex.: X dias após último pedido, aniversário, primeira compra).
- **Relatórios:** enviados, entregues, lidos, respondidos, falhas, opt-outs; custo estimado.
- **Opt-out:** palavra-chave "SAIR"/"PARAR" remove automaticamente o cliente das campanhas.

**Regras das plataformas (obrigatórias):**
- **WhatsApp:** só templates aprovados para iniciar conversa fora da janela de 24h; exige **opt-in** do cliente para marketing; mensagens de marketing são cobradas pela Meta. Respeitar limites de mensagens/qualidade do número.
- **Instagram:** não permite disparo promocional em massa — apenas respostas dentro da janela permitida. **Não é canal de campanha.**
- **iFood:** chat restrito a pedidos. **Não é canal de campanha.**
- Futuro: SMS e e-mail como canais de campanha.

**Isolamento:** campanhas rodam na fila `campaigns`, com workers dedicados e prioridade menor que o atendimento.

### 5.6 Administração da plataforma (Super Admin)
- CRUD de tenants, planos e módulos.
- Visão de uso por tenant (mensagens, conversas, campanhas).
- Suspensão/reativação de tenant.
- Impersonação auditada para suporte.

---

## 6. Contrato de conectores

Todo canal implementa a mesma interface — adicionar um canal novo = criar um novo conector, sem tocar no núcleo.

> **Implementado:** `NormalizedMessage` e `StatusUpdate` estão em [packages/shared/src/messaging.ts](packages/shared/src/messaging.ts) como schemas Zod. Os valores de enum são os do banco, em maiúsculas (`WHATSAPP`, `INBOUND`, `TEXT`...), importados de `@dishdesk/database/enums`. O `ChannelConnector` continua previsto para `apps/api` e nasce com o esqueleto da API.

```ts
// packages/shared/src/messaging.ts
export type ChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'ifood' | 'webchat';

export interface NormalizedMessage {
  channelId: string;
  channelType: ChannelType;
  externalMessageId: string;
  externalContactId: string;          // wa_id, IGSID, id do cliente/pedido iFood...
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'sticker' | 'system';
  text?: string;
  media?: { url?: string; mimeType: string; externalMediaId?: string };
  contactProfile?: {                  // tudo que a origem conseguir fornecer
    name?: string;
    phone?: string;                   // E.164
    cpf?: string;
    email?: string;
    avatarUrl?: string;
    address?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>; // ex.: orderId do iFood
  timestamp: Date;
}

// apps/api/src/modules/connectors/connector.interface.ts
export interface ChannelConnector {
  type: ChannelType;
  verifyWebhook(req: RawRequest): boolean;
  parseWebhook(payload: unknown): NormalizedMessage[] | StatusUpdate[];
  sendMessage(channel: Channel, to: string, msg: OutboundMessage): Promise<{ externalMessageId: string }>;
  downloadMedia?(channel: Channel, externalMediaId: string): Promise<Buffer>;
  capabilities: { campaigns: boolean; templates: boolean; window24h: boolean; providesPhone: boolean };
}
```

### Notas por integração
| Canal | API | Observações |
|---|---|---|
| WhatsApp | WhatsApp Business Platform — Cloud API (Meta) | Webhook único da plataforma; roteamento por `phone_number_id`. Janela de 24h; templates; tiers de mensagens. **Não usar bibliotecas não oficiais (WhatsApp Web)** — risco de banimento. |
| Instagram | Instagram Messaging API (Meta Graph API) | Requer App Review da Meta e permissões de mensagens. Roteamento por ID da conta IG. |
| iFood | iFood Merchant API (portal developer) | Pedidos via eventos (polling/webhook). **Validar disponibilidade e requisitos de homologação do módulo de chat** antes de implementar. Telefone do cliente geralmente mascarado. |

---

## 7. Modelo de dados (rascunho Prisma)

> Todas as tabelas de negócio possuem `tenantId` + RLS. IDs em UUID v7 (ordenáveis).
> **Fonte da verdade:** [packages/database/prisma/schema.prisma](packages/database/prisma/schema.prisma) e as migrations ao lado dele. Este rascunho é a referência original; os modelos de fases futuras (módulos, segmentos, templates, campanhas) entram no schema junto com seus épicos.

```prisma
model Tenant {
  id         String   @id @default(uuid())
  name       String
  slug       String   @unique
  status     TenantStatus @default(ACTIVE)
  planId     String?
  settings   Json     @default("{}")   // horário de funcionamento, textos automáticos...
  createdAt  DateTime @default(now())
  modules    TenantModule[]
}

model TenantModule {
  tenantId  String
  module    String          // 'campaigns', ...
  enabled   Boolean @default(true)
  expiresAt DateTime?
  @@id([tenantId, module])
}

model User {
  id           String @id @default(uuid())
  name         String
  email        String @unique
  passwordHash String
  isSuperAdmin Boolean @default(false) // equipe da plataforma
  isActive     Boolean @default(true)
  memberships  TenantMember[]
}

model TenantMember {                   // um usuário pode estar em vários tenants
  tenantId  String
  userId    String
  role      TenantRole                 // ADMIN | AGENT
  isActive  Boolean @default(true)
  createdAt DateTime @default(now())
  @@id([tenantId, userId])
  @@index([userId])
}

model Channel {
  id            String @id @default(uuid())
  tenantId      String
  type          ChannelType
  name          String
  externalId    String                 // phone_number_id, ig account id, merchant id
  credentials   Bytes                  // criptografado
  status        ChannelStatus
  @@unique([type, externalId])
  @@index([tenantId])
}

model Contact {
  id            String @id @default(uuid())
  tenantId      String
  name          String?
  phone         String?                // E.164
  phoneSource   String?                // 'channel' | 'informed_by_customer' | 'agent'
  phoneStatus   String?                // 'ok' | 'pending' | 'refused'
  email         String?
  cpfEncrypted  Bytes?
  cpfHash       String?                // para busca/deduplicação
  birthDate     DateTime?
  notes         String?
  tags          String[]
  firstSeenAt   DateTime @default(now())
  lastSeenAt    DateTime?
  deletedAt     DateTime?              // LGPD: anonimização
  identities    ContactIdentity[]
  addresses     ContactAddress[]
  consents      Consent[]
  @@index([tenantId, phone])
  @@index([tenantId, cpfHash])
  @@index([tenantId, lastSeenAt])
}

model ContactIdentity {
  id          String @id @default(uuid())
  tenantId    String
  contactId   String
  channelType ChannelType
  externalId  String                   // wa_id, IGSID, id iFood
  profile     Json   @default("{}")
  @@unique([tenantId, channelType, externalId])
}

model ContactAddress {
  id        String @id @default(uuid())
  tenantId  String
  contactId String
  label     String?
  street    String
  number    String?
  district  String?
  city      String
  state     String
  zipCode   String?
  complement String?
}

model Conversation {
  id              String @id @default(uuid())
  tenantId        String
  contactId       String
  channelId       String
  status          ConversationStatus     // OPEN | PENDING | RESOLVED
  assignedUserId  String?
  automationState Json   @default("{}")  // ex.: { phoneCollection: 'awaiting_phone' }
  lastMessageAt   DateTime?
  windowExpiresAt DateTime?              // janela de 24h
  unreadCount     Int @default(0)
  @@index([tenantId, status, lastMessageAt])
}

model Message {
  id                String @id @default(uuid())
  tenantId          String
  conversationId    String
  channelId         String
  externalMessageId String?
  direction         Direction
  type              MessageType
  content           Json                 // texto, mídia (chave S3), template...
  status            MessageStatus        // PENDING | SENT | DELIVERED | READ | FAILED
  sentByUserId      String?
  createdAt         DateTime @default(now())
  @@unique([channelId, externalMessageId])
  @@index([tenantId, conversationId, createdAt])
}

model Order {                          // pedidos (iFood e futuras origens)
  id              String @id @default(uuid())
  tenantId        String
  contactId       String
  channelId       String
  conversationId  String?
  externalOrderId String                 // id do pedido no iFood
  displayCode     String?                // código curto exibido (#485329)
  status          OrderStatus            // PLACED | CONFIRMED | PREPARING | DISPATCHED | DELIVERED | CANCELED
  subtotal        Decimal @db.Decimal(10, 2)
  deliveryFee     Decimal @db.Decimal(10, 2)
  total           Decimal @db.Decimal(10, 2)
  deliveryAddress Json?
  placedAt        DateTime
  dispatchedAt    DateTime?
  deliveredAt     DateTime?
  raw             Json                   // payload original
  items           OrderItem[]
  @@unique([channelId, externalOrderId])
  @@index([tenantId, contactId, placedAt])
}

model OrderItem {
  id        String @id @default(uuid())
  tenantId  String
  orderId   String
  name      String
  quantity  Int
  unitPrice Decimal @db.Decimal(10, 2)
  notes     String?
}

model Consent {
  id          String @id @default(uuid())
  tenantId    String
  contactId   String
  purpose     String                     // 'marketing_whatsapp', 'data_collection'...
  granted     Boolean
  source      String                     // canal/forma da coleta
  createdAt   DateTime @default(now())
}

// ---- Módulo Campanhas ----
model Segment   { id String @id @default(uuid()) tenantId String name String filter Json }
model Template  { id String @id @default(uuid()) tenantId String channelId String name String language String category String status String components Json }
model Campaign {
  id          String @id @default(uuid())
  tenantId    String
  name        String
  channelId   String
  templateId  String
  segmentId   String
  scheduledAt DateTime?
  status      CampaignStatus             // DRAFT | SCHEDULED | RUNNING | DONE | CANCELED
  stats       Json @default("{}")
}
model CampaignRecipient {
  id          String @id @default(uuid())
  tenantId    String
  campaignId  String
  contactId   String
  status      String                     // queued | sent | delivered | read | failed | replied
  error       String?
  @@unique([campaignId, contactId])
}

model AuditLog {
  id        String @id @default(uuid())
  tenantId  String?
  userId    String?
  action    String
  entity    String
  entityId  String?
  data      Json?
  createdAt DateTime @default(now())
}
```

---

## 8. Segurança e LGPD

- **Isolamento de tenant:** `tenant_id` + RLS + testes automatizados de vazamento entre tenants (obrigatórios no CI).
- **Criptografia:** CPF e credenciais de canais criptografados em repouso (AES-256-GCM); CPF exibido mascarado (`***.456.789-**`); busca por hash (HMAC-SHA256).
- **Consentimento:** registro de finalidade, data e origem (tabela `Consent`); opt-in obrigatório para campanhas.
- **Direitos do titular:** exportação e exclusão/anonimização de dados do cliente.
- **Retenção:** política configurável de retenção de mensagens/mídias.
- **Webhooks:** validação de assinatura em todos os canais.
- **Autenticação:** senhas com Argon2; 2FA para admins (fase 2); rate limit em login.
- **Auditoria:** `AuditLog` para ações sensíveis (ver CPF, exportar, excluir, impersonar).
- **Segredos:** nunca no repositório; `.env.example` apenas com nomes.

---

## 9. Observabilidade e operação

- Logs estruturados (Pino) sempre com `tenantId`, `channelId`, `requestId`/`jobId`.
- Tracing OpenTelemetry do webhook até a entrega no painel.
- Métricas: latência de processamento inbound, tamanho das filas, taxa de falha de envio por canal, jobs em DLQ.
- Erros: Sentry (front e back).
- Filas com **retry exponencial** e **dead-letter queue**; painel Bull Board protegido.
- Health checks (`/health/live`, `/health/ready`) por processo.
- Backups diários do Postgres com PITR.

---

## 10. Planos e módulos (billing)

| Plano | Inclui |
|---|---|
| Básico | Inbox, cadastro de clientes, 1 número WhatsApp, Instagram, iFood, N atendentes |
| Profissional | + mais atendentes, mais canais, relatórios |
| **Módulo Campanhas (add-on)** | Segmentação, templates, disparos, jornadas, relatórios de campanha |

Implementação: tabela `TenantModule` + guard `@RequiresModule()` no back + feature flags no front. Integração com gateway de pagamento (ex.: Stripe, Asaas, Pagar.me) em fase posterior.

---

## 11. Roadmap

### Fase 0 — Fundação
- [ ] Monorepo (pnpm + Turborepo), configs compartilhadas, Docker Compose (Postgres, Redis, MinIO)
- [ ] NestJS com bootstrap por papel (`APP_ROLE`)
- [ ] Prisma + migrações + políticas RLS + extensão de tenant
- [ ] Autenticação, usuários, tenants, papéis
- [ ] CI (lint, typecheck, testes, build)
- [ ] README, CONTRIBUTING, CLAUDE.md, ADRs iniciais

### Fase 1 — MVP de atendimento (WhatsApp)
- [ ] Conector WhatsApp Cloud API (webhook, envio, status, mídia)
- [ ] Inbox em tempo real (lista, conversa, envio, atribuição)
- [ ] Cadastro de clientes com resolução de identidade
- [ ] Respostas rápidas, notas internas, tags

### Fase 2 — Mais canais
- [ ] Conector Instagram (e Messenger)
- [ ] Conector iFood (pedidos + chat, conforme disponibilidade da API)
- [ ] **Automação de coleta de telefone**
- [ ] Mensagens automáticas (boas-vindas, fora do horário)

### Fase 3 — Módulo Campanhas
- [ ] Segmentos, templates WhatsApp, disparos agendados
- [ ] Opt-in/opt-out, relatórios
- [ ] Jornadas automatizadas

### Fase 4 — Crescimento
- [ ] Relatórios e dashboards de atendimento
- [ ] Chatbot (cardápio, horários, status de pedido) com IA
- [ ] Billing automatizado, painel Super Admin completo
- [ ] Novos canais (webchat no site, outros marketplaces, SMS, e-mail)
- [ ] App mobile para atendentes

---

## 12. Convenções de desenvolvimento

- **Idioma:** código, nomes de variáveis e commits em **inglês**; textos de interface em **português (pt-BR)** via i18n.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`...).
- **Branches:** `main` protegida; `feat/<descrição>`, `fix/<descrição>`; PR com revisão obrigatória e CI verde.
- **Arquitetura:** cada módulo NestJS expõe serviços pela sua fronteira; nada de acessar tabelas de outro módulo diretamente.
- **Tenant:** **nunca** escrever query sem contexto de tenant; usar sempre o Prisma Client estendido.
- **Contratos:** schemas Zod em `packages/shared` são a fonte da verdade para DTOs.
- **Testes:** todo conector com testes de `parseWebhook` usando payloads reais de exemplo (fixtures); testes de isolamento de tenant obrigatórios.
- **Decisões:** decisões arquiteturais registradas em `docs/adr/NNNN-titulo.md`.

---

## 13. Ambiente local

```bash
# pré-requisitos: Node LTS, pnpm, Docker
pnpm install
cp .env.example .env
docker compose up -d          # postgres, redis (S3 local: definido no E4)
pnpm db:migrate               # migrações + RLS
pnpm db:seed                  # tenant e usuário de demonstração
pnpm dev                      # web + api (todos os papéis em modo dev)
```

Para testar webhooks localmente: expor o `webhook-gateway` com um túnel (ngrok / Cloudflare Tunnel) e configurar a URL no app da Meta.

### Variáveis de ambiente (exemplo)
```
DATABASE_URL=                 # aplicação: role sem privilégios, sujeita à RLS
DATABASE_ADMIN_URL=           # migrations e preparação de testes: dono das tabelas
REDIS_URL=
S3_ENDPOINT= / S3_BUCKET= / S3_ACCESS_KEY= / S3_SECRET_KEY=
JWT_SECRET=
ENCRYPTION_KEY=
META_APP_ID= / META_APP_SECRET= / META_WEBHOOK_VERIFY_TOKEN=
IFOOD_CLIENT_ID= / IFOOD_CLIENT_SECRET=
APP_ROLE=api|realtime|gateway|worker|scheduler
```

---

## 14. Pendências e riscos

| Item | Ação |
|---|---|
| Chat do iFood via API | Confirmar disponibilidade, escopo e requisitos de homologação no portal de desenvolvedores do iFood. |
| App Review da Meta | Iniciar cedo; exige política de privacidade, vídeo de demonstração e empresa verificada. |
| Custos de mensagens WhatsApp | Definir se o custo é repassado ao restaurante (cada tenant com sua conta Meta) ou intermediado pela plataforma. |
| Hospedagem | Definir provedor (AWS, GCP, Railway/Render no início) e região (preferencialmente Brasil — `sa-east-1`). |
| Nome e marca do produto | A definir. |
