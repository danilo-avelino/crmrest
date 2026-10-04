import * as Sentry from "@sentry/nextjs";

// Erros do servidor do Next (renderização e proxy /api) vão para o Sentry, com o mesmo DSN do navegador.
export function register() {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, environment: process.env.NODE_ENV });
  }
}

export const onRequestError = Sentry.captureRequestError;
