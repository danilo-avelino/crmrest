import { existsSync } from "node:fs";
import * as Sentry from "@sentry/nestjs";

// Primeiro import do main.ts: ambiente e Sentry prontos antes do resto da aplicação carregar.

// Em desenvolvimento o .env fica na raiz do monorepo; em produção as variáveis vêm do ambiente.
const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Sem SENTRY_DSN (desenvolvimento, testes) o Sentry fica desligado.
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? "development" });
}
