import * as Sentry from "@sentry/nextjs";

// Erros do navegador vão para o Sentry. Sem NEXT_PUBLIC_SENTRY_DSN (desenvolvimento), fica desligado.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, environment: process.env.NODE_ENV });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
