import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// O .env fica na raiz do monorepo (o Prisma 7 não carrega .env sozinho).
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Migrations rodam com o dono das tabelas; a aplicação usa DATABASE_URL (role sujeita à RLS).
// Sem a variável (ex.: build no CI) o generate funciona; só os comandos que acessam o banco a exigem.
const url = process.env.DATABASE_ADMIN_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: url ? { url } : undefined,
});
