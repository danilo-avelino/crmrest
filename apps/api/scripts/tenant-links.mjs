// Links para fazer pedido, enviados quando o cliente escolhe "2 - Fazer um pedido" no menu de atendimento.
// Enquanto as Configurações do restaurante (E15) não existem, é assim que se cadastram.
// Uso:
//   pnpm tenant:links --restaurante cantina-da-nonna --link "Cardápio digital=https://..." --link "iFood=https://..."
//   pnpm tenant:links --restaurante cantina-da-nonna             (mostra os links atuais)
//   pnpm tenant:links --restaurante cantina-da-nonna --limpar    (sem links: a opção 2 chama um atendente)
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@comanda/database";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({
  options: {
    restaurante: { type: "string" },
    link: { type: "string", multiple: true },
    limpar: { type: "boolean" },
  },
});
if (!values.restaurante) {
  console.error('Informe --restaurante e, para alterar, --link "Nome=https://..." (pode repetir) ou --limpar.');
  process.exit(1);
}

const links = (values.link ?? []).map((value) => {
  const separator = value.indexOf("=");
  const label = value.slice(0, separator).trim();
  const url = value.slice(separator + 1).trim();
  if (separator < 1 || !URL.canParse(url) || !/^https?:/.test(url)) {
    console.error(`Link inválido: "${value}". Use "Nome=https://...".`);
    process.exit(1);
  }
  return { label, url };
});

const prisma = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");
try {
  const tenant = await prisma.tenant.findUnique({ where: { slug: values.restaurante }, select: { id: true, name: true, settings: true } });
  if (!tenant) throw new Error(`Restaurante "${values.restaurante}" não encontrado.`);

  let current = tenant.settings?.orderLinks ?? [];
  if (links.length || values.limpar) {
    current = values.limpar ? [] : links;
    await prisma.tenant.update({ where: { id: tenant.id }, data: { settings: { ...tenant.settings, orderLinks: current } } });
  }
  console.log(current.length ? `Links de ${tenant.name}:\n${current.map((l) => `• ${l.label}: ${l.url}`).join("\n")}` : `${tenant.name} não tem links: a opção "Fazer um pedido" chama um atendente.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
