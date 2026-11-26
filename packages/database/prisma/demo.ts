// Cria ou reseta a conta de demonstração (apresentações de venda). Rodar de novo volta tudo ao estado inicial, com as
// datas contadas a partir de agora; nada é duplicado. Só mexe no restaurante e nos usuários da demo.
// Uso: pnpm demo:reset                      (banco do DATABASE_ADMIN_URL do .env, o Docker de dev)
//      DEMO_PASSWORD=... pnpm demo:reset    (define a senha dos logins da demo; sem ela, a senha só é criada na 1ª vez)
//      pnpm demo:reset --confirmar-producao (obrigatório quando o banco não é local)
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hash } from "@node-rs/argon2";
import { createPrismaClient, DEMO_SLUG, DEMO_TENANT_NAME, DEMO_USERS, type DemoUserKey, parseEncryptionKey, seedDemoData, wipeDemoData } from "../src/index.js";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida (copie .env.example para .env)`);
  return value;
}

const url = requireEnv("DATABASE_ADMIN_URL");
const host = new URL(url).hostname;
const local = ["localhost", "127.0.0.1", "::1", "postgres"].includes(host);
if (!local && !process.argv.includes("--confirmar-producao")) {
  console.error(`O banco ${host} não é local. Para criar a demo nele, rode de novo com --confirmar-producao.`);
  process.exit(1);
}

const prisma = createPrismaClient(url);
const key = parseEncryptionKey(requireEnv("ENCRYPTION_KEY"));

async function main() {
  // Restaurante da demo: sem teste grátis nem cobrança (trialEndsAt vazio), sempre com a marca `demo`.
  const tenant =
    (await prisma.tenant.findUnique({ where: { slug: DEMO_SLUG }, select: { id: true } })) ??
    (await prisma.tenant.create({ data: { slug: DEMO_SLUG, name: DEMO_TENANT_NAME, settings: { demo: true } }, select: { id: true } }));

  const chosen = process.env.DEMO_PASSWORD;
  let created: string | null = null;
  const users = {} as Record<DemoUserKey, string>;
  for (const user of DEMO_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: user.email }, select: { id: true } });
    if (existing) {
      // Uma conta com o e-mail da demo que pertença a outro restaurante não é da demo: não mexe nela.
      const others = await prisma.tenantMember.count({ where: { userId: existing.id, tenantId: { not: tenant.id } } });
      if (others > 0) throw new Error(`${user.email} já pertence a outro restaurante: a demo não usa esse login.`);
      if (chosen) await prisma.user.update({ where: { id: existing.id }, data: { passwordHash: await hash(chosen), isActive: true } });
      users[user.key] = existing.id;
    } else {
      const password = chosen ?? (created ??= randomBytes(9).toString("base64url"));
      users[user.key] = (await prisma.user.create({ data: { email: user.email, name: user.name, passwordHash: await hash(password) }, select: { id: true } })).id;
    }
    await prisma.tenantMember.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: users[user.key] } },
      create: { tenantId: tenant.id, userId: users[user.key], role: user.role },
      update: { role: user.role, isActive: true, invitePending: false },
    });
  }
  // Todos os módulos ligados: Atendimento com IA e Cardápio digital.
  await prisma.tenantModule.createMany({ data: (["AI", "MENU"] as const).map((module) => ({ tenantId: tenant.id, module })), skipDuplicates: true });

  const summary = await prisma.$transaction(
    async (tx) => {
      const photos = await wipeDemoData(tx, tenant.id);
      return seedDemoData(tx, { tenantId: tenant.id, users, key, photos });
    },
    { timeout: 180_000, maxWait: 20_000 },
  );

  console.log(`Demo pronta: ${DEMO_TENANT_NAME} (${DEMO_SLUG}).`);
  console.table(summary);
  console.log(`Login: ${DEMO_USERS[0].email}`);
  if (chosen) console.log("Senha: a de DEMO_PASSWORD.");
  else if (created) console.log(`Senha (guarde, só aparece agora): ${created}`);
  else console.log("Senha: a mesma de antes (para trocar, rode com DEMO_PASSWORD=...).");
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
