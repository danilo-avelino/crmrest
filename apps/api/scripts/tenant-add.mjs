// Cria um restaurante (tenant). Enquanto o painel Super Admin (E16) não existe, é assim que se cadastra o piloto.
// Uso: pnpm tenant:add --nome "Cantina da Nonna" --slug cantina-da-nonna
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@dishdesk/database";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({ options: { nome: { type: "string" }, slug: { type: "string" } } });
if (!values.nome || !values.slug || !/^[a-z0-9-]+$/.test(values.slug)) {
  console.error('Informe --nome e --slug (só letras minúsculas, números e "-").');
  process.exit(1);
}

const prisma = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");
try {
  const tenant = await prisma.tenant.create({ data: { name: values.nome, slug: values.slug } });
  console.log(`Restaurante criado: ${tenant.name} (${tenant.slug}).`);
} catch (error) {
  console.error(error?.code === "P2002" ? `Já existe um restaurante com o slug "${values.slug}".` : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
