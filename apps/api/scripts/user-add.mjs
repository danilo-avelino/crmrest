// Cria um usuário com acesso a um restaurante, ou dá acesso a mais um restaurante a quem já existe.
// Uso: pnpm user:add --email ana@restaurante.com.br --nome "Ana Silva" --restaurante cantina-da-nonna --papel ADMIN [--senha ...]
// Sem --senha, gera uma senha aleatória e mostra uma única vez. --superadmin dá acesso ao painel da plataforma (E16).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@dishdesk/database";
import { hash } from "@node-rs/argon2";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    nome: { type: "string" },
    restaurante: { type: "string" },
    papel: { type: "string", default: "AGENT" },
    senha: { type: "string" },
    superadmin: { type: "boolean", default: false },
  },
});
const role = values.papel?.toUpperCase();
if (!values.email || !values.restaurante || !["ADMIN", "AGENT"].includes(role)) {
  console.error("Informe --email, --restaurante e --papel (ADMIN ou AGENT); --nome para usuários novos.");
  process.exit(1);
}
if (values.senha && values.senha.length < 8) {
  console.error("A senha precisa de pelo menos 8 caracteres.");
  process.exit(1);
}

const prisma = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");
try {
  const email = values.email.toLowerCase();
  const tenant = await prisma.tenant.findUnique({ where: { slug: values.restaurante }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`Restaurante "${values.restaurante}" não encontrado.`);

  let user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true } });
  let password = null;
  if (!user) {
    if (!values.nome) throw new Error("Usuário novo: informe --nome.");
    password = values.senha ?? randomBytes(9).toString("base64url");
    user = await prisma.user.create({
      data: { email, name: values.nome, passwordHash: await hash(password) },
      select: { id: true, name: true },
    });
  }
  await prisma.tenantMember.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    create: { tenantId: tenant.id, userId: user.id, role },
    update: { role, isActive: true },
  });

  if (values.superadmin) await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });

  console.log(`${user.name} (${email}) agora é ${role === "ADMIN" ? "admin" : "atendente"} em ${tenant.name}.`);
  if (values.superadmin) console.log("Acesso de super admin (painel da plataforma) liberado.");
  if (password && !values.senha) console.log(`Senha gerada (anote, não será mostrada de novo): ${password}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
