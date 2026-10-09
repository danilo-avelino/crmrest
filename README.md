# Dish Desk

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
docker build -f apps/api/Dockerfile -t dishdesk-api .
docker build -f apps/api/Dockerfile --target migrate -t dishdesk-migrate .
docker build -f apps/web/Dockerfile -t dishdesk-web \
  --build-arg API_URL=http://api:4000 \
  --build-arg NEXT_PUBLIC_REALTIME_URL=https://realtime.seudominio.com.br \
  --build-arg NEXT_PUBLIC_SENTRY_DSN=... .
```

A imagem da API roda um papel por processo, escolhido por `APP_ROLE`: `api` (REST do painel), `gateway` (webhooks), `realtime` (Socket.IO) e `worker` (filas). No piloto, `APP_ROLE=all` roda tudo num processo só. O painel chama a API pelo proxy `/api` do próprio Next (`API_URL`) e o tempo real direto em `NEXT_PUBLIC_REALTIME_URL`. Os dois valores entram no build da imagem do painel.

Health checks: `GET /api/health/live` (processo de pé) e `GET /api/health/ready` (banco e Redis respondendo).

### Railway

Projeto com três serviços na região US East (Virginia), a mesma do Supabase (`us-east-1`): a Railway não tem região no Brasil.

| Serviço | Origem | Configuração | Variáveis |
| --- | --- | --- | --- |
| `Redis` | template de Redis da Railway | — | — |
| `api` | GitHub, `main` | Dockerfile `/apps/api/Dockerfile`, health check `/api/health/ready` | as da tabela abaixo; `APP_ROLE=all`, `PORT=4000`, `REDIS_URL=${{Redis.REDIS_URL}}?family=0` (o `family=0` faz o ioredis aceitar o IPv6 da rede privada), `WEB_ORIGIN=https://${{web.RAILWAY_PUBLIC_DOMAIN}}` |
| `web` | GitHub, `main` | Dockerfile `/apps/web/Dockerfile`, health check `/login` | `API_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4000`, `NEXT_PUBLIC_REALTIME_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}`, `NEXT_PUBLIC_SENTRY_DSN`, `PORT=3000` |

A configuração fica no painel (Settings de cada serviço), sem comando de build ou de início: o Dockerfile define os dois. A Railway não aceita mais `railway.json` em serviços novos. As variáveis do `web` entram como build args do Dockerfile. `api` e `web` têm domínio público; o do `api` atende o Socket.IO e os webhooks da Meta. Com **Wait for CI** ligado, a Railway só publica depois do CI; as migrations rodam no Supabase pelo [deploy-db.yml](.github/workflows/deploy-db.yml), que precisa do segredo `SUPABASE_DATABASE_URL`.

### Banco

- **Supabase** (`us-east-1`), sempre pelo **Session pooler** (porta 5432, IPv4): `DATABASE_URL=postgresql://comanda_app.<ref>:<senha>@<host do pooler>:5432/postgres` e `DATABASE_ADMIN_URL` com `postgres.<ref>`. A Data API fica desligada (Project Settings → Data API). Migrations novas nascem no Postgres local (`pnpm db:migrate`) e chegam ao Supabase só por `migrate deploy`: o `migrate dev` no Supabase pode propor apagar o banco.
- **Role da aplicação:** `DATABASE_URL` usa um login sem superusuário e sem `BYPASSRLS`, membro de `app_user`. A API recusa subir com uma role que ignore a RLS. Crie-o como em [01-app-roles.sql](infra/docker/postgres/init/01-app-roles.sql), com senha forte (no Supabase, pelo SQL Editor, depois das migrations, que criam `app_user`).
- **Migrations:** antes de cada deploy, rode `dishdesk-migrate` com `DATABASE_ADMIN_URL`, o dono das tabelas. Só esse job e as CLIs abaixo usam essa URL.
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
| `INSTAGRAM_APP_SECRET` | Chave secreta do app do Instagram. Sem ela, os webhooks do Instagram são recusados (401). |
| `IFOOD_CLIENT_ID`, `IFOOD_CLIENT_SECRET` | Credencial centralizada. Sem ela, o polling de pedidos fica desligado. |
| `CARDAPIO_WEB_API_URL` | API de parceiros do Cardápio Web (`https://integracao.cardapioweb.com`). Sem ela, o polling de pedidos fica desligado. A chave é de cada loja, no canal. |
| `SENTRY_DSN` | Opcional. Erros da API e jobs que falharam de vez. |
| `BULL_BOARD_PASSWORD` | Opcional. Liga o painel das filas em `/api/admin/filas` (Basic auth, usuário `BULL_BOARD_USER`, padrão `admin`). |
| `LOG_LEVEL` | Padrão `info`. Logs em JSON (Pino), com `tenantId` nas requisições autenticadas. |

`CHANNELS_DRY_RUN` não pode ser usado em produção: a API recusa subir.

## Onboarding de um restaurante

Enquanto não existem o Super Admin (E16) e a tela de Canais (E14), o cadastro é feito pelas CLIs. Elas usam `DATABASE_ADMIN_URL` e `ENCRYPTION_KEY`. Localmente: `pnpm <comando>`. Na imagem: `docker run --rm --env-file <arquivo> dishdesk-api node apps/api/scripts/<comando>.mjs ...`.

```sh
pnpm tenant:add --nome "Cantina da Nonna" --slug cantina-da-nonna
pnpm user:add --email ana@cantinadanonna.com.br --nome "Ana Silva" --restaurante cantina-da-nonna --papel ADMIN
pnpm channel:add --restaurante cantina-da-nonna --tipo WHATSAPP --id-externo <phone_number_id> --token <token> --waba <WABA id>
pnpm channel:add --restaurante cantina-da-nonna --tipo INSTAGRAM --id-externo <id da conta IG> --token <token>
pnpm channel:add --restaurante cantina-da-nonna --tipo IFOOD --id-externo <merchant id>
pnpm channel:add --restaurante cantina-da-nonna --tipo CARDAPIO_WEB --id-externo <id da loja> --token <chave de API>
pnpm tenant:links --restaurante cantina-da-nonna --link "Cardápio digital=https://..." --link "iFood=https://..."
```

O admin do restaurante também conecta WhatsApp, Instagram, iFood e Cardápio Web pelo painel, em **Configurações → Integrações** (várias contas ou lojas de cada sistema); a credencial é conferida no sistema antes de salvar. A chave do Cardápio Web é gerada pelo restaurante no Portal (Configurações → Integrações → API). Os links para fazer pedido são enviados quando o cliente escolhe "2 - Fazer um pedido" no menu de atendimento; sem links, a opção chama um atendente. O admin do restaurante os edita no painel, em **Configurações**; o `tenant:links` faz o mesmo pelo terminal.

Sem `--senha`, o `user:add` gera uma senha e a mostra uma única vez. Para dar acesso a mais um restaurante, rode de novo com outro `--restaurante`.

Tokens do Instagram expiram em 60 dias: o worker os renova sozinho (job diário às 4h, a cada 7 dias por canal).

No app da Meta, configure o webhook com a URL `https://<api>/api/webhooks/meta`, o token `META_WEBHOOK_VERIFY_TOKEN` e o campo `messages`, tanto no WhatsApp quanto no Instagram. O do Instagram fica dentro do produto (Casos de uso > API do Instagram > Configurar webhooks), e o app precisa estar publicado para receber mensagens reais.
