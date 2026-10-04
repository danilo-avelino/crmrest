# Painel (Next.js, saída standalone). Na raiz do monorepo:
#   docker build -f apps/web/Dockerfile \
#     --build-arg API_URL=http://api:4000 \
#     --build-arg NEXT_PUBLIC_REALTIME_URL=https://realtime.seudominio.com.br \
#     --build-arg NEXT_PUBLIC_SENTRY_DSN=... \
#     -t comanda-web .

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Só os pacotes de que o painel depende (web, shared), com o lockfile reduzido a eles.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @comanda/web --docker

FROM base AS build
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
COPY tsconfig.base.json .
# Fixados no build: o destino do proxy /api (rewrites do Next) e as variáveis públicas do navegador.
ARG API_URL=http://api:4000
ARG NEXT_PUBLIC_REALTIME_URL=http://localhost:4000
ARG NEXT_PUBLIC_SENTRY_DSN=
ENV API_URL=$API_URL \
    NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo build --filter=@comanda/web

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
