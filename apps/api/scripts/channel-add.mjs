// Cadastra (ou atualiza) um canal real de um restaurante, com as credenciais cifradas (§5.4).
// Uso:
//   pnpm channel:add --restaurante cantina-da-nonna --tipo WHATSAPP --id-externo <phone_number_id> --token <token> --waba <WABA id> [--nome WhatsApp]
//   pnpm channel:add --restaurante cantina-da-nonna --tipo INSTAGRAM --id-externo <id da conta IG> --token <token>
//   pnpm channel:add --restaurante cantina-da-nonna --tipo IFOOD --id-externo <merchant id>
//   pnpm channel:add --restaurante cantina-da-nonna --tipo CARDAPIO_WEB --id-externo <id da loja> --token <chave de API>
// Enquanto a tela de Canais (E14) não existe, este é o jeito de conectar um número ou conta.
// Cardápio Web: a chave é gerada pelo restaurante no Portal (Configurações → Integrações → API).
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrismaClient, encrypt, parseEncryptionKey } from "@dishdesk/database";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({
  options: {
    restaurante: { type: "string" },
    tipo: { type: "string" },
    "id-externo": { type: "string" },
    token: { type: "string" },
    waba: { type: "string" },
    nome: { type: "string" },
  },
});

const TYPES = ["WHATSAPP", "INSTAGRAM", "IFOOD", "CARDAPIO_WEB"];
const type = values.tipo?.toUpperCase();
// iFood usa a credencial da plataforma (IFOOD_CLIENT_ID/SECRET): a loja só precisa do merchant id.
if (!values.restaurante || !type || !TYPES.includes(type) || !values["id-externo"] || (type !== "IFOOD" && !values.token)) {
  console.error("Informe --restaurante, --tipo (WHATSAPP|INSTAGRAM|IFOOD|CARDAPIO_WEB), --id-externo e --token (exceto iFood).");
  process.exit(1);
}

const prisma = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");
try {
  const tenant = await prisma.tenant.findUnique({ where: { slug: values.restaurante }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`Restaurante "${values.restaurante}" não encontrado.`);

  const externalId = values["id-externo"];
  const existing = await prisma.channel.findUnique({ where: { type_externalId: { type, externalId } } });
  if (existing && existing.tenantId !== tenant.id) throw new Error("Este número/conta já está conectado a outro restaurante.");

  // WhatsApp: --waba (ID da conta do WhatsApp Business) habilita os templates.
  // tokenUpdatedAt: a renovação automática do token do Instagram conta a partir daqui.
  const secrets = values.token
    ? { accessToken: values.token, tokenUpdatedAt: new Date().toISOString(), ...(values.waba && { wabaId: values.waba }) }
    : {};
  const credentials = encrypt(JSON.stringify(secrets), parseEncryptionKey(process.env.ENCRYPTION_KEY ?? ""));
  const name = values.nome ?? { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", IFOOD: "iFood", CARDAPIO_WEB: "Cardápio Web" }[type];
  const channel = await prisma.channel.upsert({
    where: { type_externalId: { type, externalId } },
    create: { tenantId: tenant.id, type, name, externalId, credentials, status: "CONNECTED" },
    update: { name, credentials, status: "CONNECTED" },
  });
  console.log(`${existing ? "Atualizado" : "Cadastrado"}: ${channel.name} (${type} ${externalId}) em ${tenant.name}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
