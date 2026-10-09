# API (NestJS). A mesma imagem roda cada papel do §3.2: APP_ROLE = api, gateway, realtime ou worker.
# Na raiz do monorepo:
#   docker build -f apps/api/Dockerfile -t dishdesk-api .
#   docker build -f apps/api/Dockerfile --target migrate -t dishdesk-migrate .   (migrations, antes de cada deploy)

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Só os pacotes de que a API depende (api, database, shared), com o lockfile reduzido a eles.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @dishdesk/api --docker

FROM base AS build
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
COPY tsconfig.base.json .
RUN pnpm turbo build --filter=@dishdesk/api

# Aplica as migrations com o dono das tabelas (DATABASE_ADMIN_URL) e termina.
FROM build AS migrate
CMD ["pnpm", "--filter", "@dishdesk/database", "exec", "prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune /app/out/json/ .
# Sem o store do pnpm e o cache do corepack: o runtime não instala nada.
RUN pnpm install --frozen-lockfile --prod && rm -rf /root/.local/share/pnpm /root/.cache
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# CLIs de operação (tenant:add, user:add, channel:add): node apps/api/scripts/<script>.mjs ...
COPY --from=build /app/apps/api/scripts apps/api/scripts
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "apps/api/dist/main.js"]
