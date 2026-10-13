// Simula uma mensagem do cliente no chat do iFood de um pedido (só desenvolvimento): entra na Inbox como se o painel a
// tivesse copiado do widget, e as automações respondem no chat de verdade do pedido (precisa da trava IFOOD_CHAT_BRIDGE
// e de um painel aberto com a extensão). A mensagem simulada não aparece no iFood.
// Uso: pnpm simulate:ifood-chat --pedido 4224 [--texto "Meu pedido veio errado"]
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrismaClient } from "@dishdesk/database";
import { SignJWT } from "jose";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const { values } = parseArgs({
  options: {
    pedido: { type: "string" },
    texto: { type: "string", default: "Oi, meu pedido veio errado" },
    url: { type: "string", default: `http://localhost:${process.env.PORT ?? 4000}/api/ifood-chat/sync` },
  },
});
if (!values.pedido) throw new Error('Informe o número do pedido: --pedido 4224');
if (!process.env.JWT_SECRET || !process.env.DATABASE_ADMIN_URL) throw new Error("JWT_SECRET e DATABASE_ADMIN_URL precisam estar no .env");

// O pedido diz de qual restaurante é a conversa; a chamada vai em nome de alguém da equipe dele.
const admin = createPrismaClient(process.env.DATABASE_ADMIN_URL);
const order = await admin.order.findFirst({
  where: { displayCode: values.pedido.replace(/^#/, ""), channel: { type: "IFOOD" } },
  orderBy: { placedAt: "desc" },
  select: { displayCode: true, tenant: { select: { id: true, name: true, members: { where: { isActive: true }, take: 1, select: { userId: true, role: true } } } } },
});
await admin.$disconnect();
const member = order?.tenant.members[0];
if (!order || !member) throw new Error(`Não há pedido do iFood #${values.pedido} (ou o restaurante dele não tem equipe).`);

const token = await new SignJWT({ mode: "tenant", tenants: [{ id: order.tenant.id, role: member.role }] })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(member.userId)
  .setIssuedAt()
  .setExpirationTime("1m")
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

// O widget só mostra a hora (de Brasília); o dia vem do pedido.
const time = new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium", timeZone: "America/Sao_Paulo" }).format(new Date());
const response = await fetch(values.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ orderCode: order.displayCode, messages: [{ direction: "INBOUND", text: values.texto, time }] }),
});
console.log(
  response.status === 404
    ? "404: a API está sem a trava IFOOD_CHAT_BRIDGE (o chat do iFood na Inbox está desligado)."
    : `${response.status} ${await response.text()} · ${order.tenant.name}, pedido #${order.displayCode}, às ${time}`,
);
