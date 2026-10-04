# Comanda

CRM omnichannel para restaurantes: WhatsApp, Instagram e pedidos do iFood numa inbox só, com multi-tenancy por RLS no Postgres.
Especificação em [PROJETO_CRM_RESTAURANTES.md](PROJETO_CRM_RESTAURANTES.md), fases em [ROADMAP.md](ROADMAP.md) e design em `CRM Restaurantes.html`.

| Pasta | O que é |
| --- | --- |
| `apps/api` | NestJS: REST do painel, webhooks, Socket.IO e workers (BullMQ) |
| `apps/web` | Next.js: o painel |
| `packages/database` | Prisma (schema, migrations, RLS), criptografia e seed |
| `packages/shared` | Contratos (Zod) e regras comuns à API e ao painel |

## Desenvolvimento

Requisitos: Node 24, pnpm 10 (`corepack enable`) e Docker.

```sh
cp .env.example .env          # preencha JWT_SECRET, ENCRYPTION_KEY, META_APP_SECRET e META_WEBHOOK_VERIFY_TOKEN
docker compose up -d          # Postgres (5434) e Redis (6381); cria a role da aplicação na primeira subida
pnpm install
pnpm db:migrate               # aplica as migrations
pnpm db:seed                  # restaurantes, contatos e conversas de demonstração
pnpm dev                      # painel em http://localhost:3000, API em http://localhost:4000
```

Login de demonstração: `ana.silva@cantinadanonna.com.br` / `comanda123` (três restaurantes, com painel master).

Com `CHANNELS_DRY_RUN=true`, os envios aos canais são simulados. Para receber uma mensagem como se viesse da Meta:

```sh
pnpm simulate:whatsapp --texto "Vocês entregam no Centro?" --de 5511988887777 --nome "Cliente"
```

### Verificações

```sh
pnpm lint && pnpm typecheck && pnpm test   # testes de integração usam o Postgres e o Redis do docker compose
pnpm e2e                                   # Playwright com o Edge instalado (no CI, Chromium)
```

O CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) roda tudo isso, incluindo o teste de vazamento entre tenants.

## Produção

### Imagens

```sh
docker build -f apps/api/Dockerfile -t comanda-api .
docker build -f apps/api/Dockerfile --target migrate -t comanda-migrate .
docker build -f apps/web/Dockerfile -t comanda-web \
  --build-arg API_URL=http://api:4000 \
  --build-arg NEXT_PUBLIC_REALTIME_URL=https://realtime.seudominio.com.br \
  --build-arg NEXT_PUBLIC_SENTRY_DSN=... .
```

A imagem da API roda um papel por processo, escolhido por `APP_ROLE`: `api` (REST do painel), `gateway` (webhooks), `realtime` (Socket.IO) e `worker` (filas). No piloto, `APP_ROLE=all` roda tudo num processo só. O painel chama a API pelo proxy `/api` do próprio Next (`API_URL`) e o tempo real direto em `NEXT_PUBLIC_REALTIME_URL`. Os dois valores entram no build da imagem do painel.

Health checks: `GET /api/health/live` (processo de pé) e `GET /api/health/ready` (banco e Redis respondendo).

### Banco

- **Role da aplicação:** `DATABASE_URL` usa um login sem superusuário e sem `BYPASSRLS`, membro de `app_user`. A API recusa subir com uma role que ignore a RLS. Crie-o como em [01-app-roles.sql](infra/docker/postgres/init/01-app-roles.sql), com senha forte.
- **Migrations:** antes de cada deploy, rode `comanda-migrate` com `DATABASE_ADMIN_URL`, o dono das tabelas. Só esse job e as CLIs abaixo usam essa URL.
- **Backup:** Postgres gerenciado com backup diário e PITR (critério de aceite do MVP).

### Variáveis da API

| Variável | |
| --- | --- |
| `NODE_ENV=production` | Cookie de sessão `Secure`: exige HTTPS. |
| `DATABASE_URL`, `REDIS_URL` | Role da aplicação e Redis (filas e tempo real). |
| `JWT_SECRET` | Mín. 32 caracteres. |
| `ENCRYPTION_KEY` | 32 bytes em base64. Cifra credenciais de canais e CPFs: **não troque depois de ter dados**. |
| `WEB_ORIGIN` | Origem do painel, para o CORS do Socket.IO. |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Do app da Meta. Sem eles, o webhook responde 503. |
| `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET` | Credencial centralizada. Sem ela, o polling de pedidos fica desligado. |
| `SENTRY_DSN` | Opcional. Erros da API e jobs que falharam de vez. |
| `BULL_BOARD_PASSWORD` | Opcional. Liga o painel das filas em `/api/admin/filas` (Basic auth, usuário `BULL_BOARD_USER`, padrão `admin`). |
| `LOG_LEVEL` | Padrão `info`. Logs em JSON (Pino), com `tenantId` nas requisições autenticadas. |

`CHANNELS_DRY_RUN` não pode ser usado em produção: a API recusa subir.

## Onboarding de um restaurante

Enquanto não existem o Super Admin (E16) e a tela de Canais (E14), o cadastro é feito pelas CLIs. Elas usam `DATABASE_ADMIN_URL` e `ENCRYPTION_KEY`. Localmente: `pnpm <comando>`. Na imagem: `docker run --rm --env-file <arquivo> comanda-api node apps/api/scripts/<comando>.mjs ...`.

```sh
pnpm tenant:add --nome "Cantina da Nonna" --slug cantina-da-nonna
pnpm user:add --email ana@cantinadanonna.com.br --nome "Ana Silva" --restaurante cantina-da-nonna --papel ADMIN
pnpm channel:add --restaurante cantina-da-nonna --tipo WHATSAPP --id-externo <phone_number_id> --token <token> --waba <WABA id>
pnpm channel:add --restaurante cantina-da-nonna --tipo INSTAGRAM --id-externo <id da conta IG> --token <token>
pnpm channel:add --restaurante cantina-da-nonna --tipo IFOOD --id-externo <merchant id>
```

Sem `--senha`, o `user:add` gera uma senha e a mostra uma única vez. Para dar acesso a mais um restaurante, rode de novo com outro `--restaurante`.

Tokens do Instagram expiram em 60 dias: o worker os renova sozinho (job diário às 4h, a cada 7 dias por canal).

No app da Meta, configure o webhook com a URL `https://<api>/api/webhooks/meta`, o token `META_WEBHOOK_VERIFY_TOKEN` e o campo `messages`, tanto no WhatsApp quanto no Instagram.
