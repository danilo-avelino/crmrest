import type { TenantTx } from "@dishdesk/database";
import { CHANNEL_LABEL } from "@dishdesk/shared";

/**
 * O número de WhatsApp conectado por onde a equipe começa uma conversa com um cliente do restaurante (o mais antigo): o
 * do próprio restaurante ou, sem ele, um que o atende (o WhatsApp de um grupo; Configurações → Integrações).
 */
export async function connectedWhatsApp(tx: TenantTx, tenantId: string) {
  const channels = await tx.channel.findMany({
    where: { type: "WHATSAPP", status: "CONNECTED", deletedAt: null, OR: [{ tenantId }, { servedTenantIds: { has: tenantId } }] },
    orderBy: { id: "asc" },
    select: { id: true, tenantId: true },
  });
  return channels.find((channel) => channel.tenantId === tenantId) ?? channels[0] ?? null;
}

/**
 * Conversa do WhatsApp com o cliente: a última dele (ou de outro cadastro com o mesmo telefone) num número conectado,
 * ou uma nova, que a equipe começa por um template (não há janela de 24h aberta). A conversa fica no restaurante do
 * canal: se o cliente é de uma unidade atendida por ele, o cadastro usado é o que esse restaurante tem para o telefone.
 */
export async function openWhatsAppConversation(
  tx: TenantTx,
  channel: { id: string; tenantId: string },
  contact: { id: string; tenantId: string; name: string | null; phone: string | null },
): Promise<string> {
  const phone = contact.phone!;
  const channelId = channel.id;
  const tenantId = channel.tenantId;
  const externalId = phone.slice(1);
  const existing = await tx.conversation.findFirst({
    where: {
      tenantId,
      channel: { type: "WHATSAPP", status: "CONNECTED", deletedAt: null },
      contact: { OR: [{ id: contact.id }, { phone }, { identities: { some: { channelType: "WHATSAPP", externalId } } }] },
    },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    select: { id: true },
  });
  if (existing) return existing.id;
  // O envio vai para a identidade do WhatsApp do cadastro: o telefone, sem o "+".
  const key = { tenantId, channelType: "WHATSAPP" as const, externalId };
  const identity = await tx.contactIdentity.findUnique({ where: { tenantId_channelType_externalId: key }, select: { contactId: true } });
  const contactId = identity?.contactId ?? (await contactInChannelTenant(tx, tenantId, contact, phone));
  if (!identity) await tx.contactIdentity.create({ data: { ...key, contactId } });
  // Aberta pela equipe: fica na aba Ativos, não em Automáticos.
  const conversation = await tx.conversation.create({
    data: { tenantId, contactId, channelId, status: "OPEN", teamInvolved: true },
    select: { id: true },
  });
  await tx.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channelId,
      direction: "INTERNAL",
      type: "SYSTEM",
      content: { event: "conversation_opened", text: `Conversa aberta via ${CHANNEL_LABEL.WHATSAPP}` },
    },
  });
  return conversation.id;
}

/** O cadastro do cliente no restaurante do canal: o próprio, o que já tem o telefone ou um novo com o nome e o telefone. */
async function contactInChannelTenant(tx: TenantTx, tenantId: string, contact: { id: string; tenantId: string; name: string | null }, phone: string) {
  if (contact.tenantId === tenantId) return contact.id;
  const known = await tx.contact.findFirst({ where: { tenantId, phone }, select: { id: true } });
  if (known) return known.id;
  const created = await tx.contact.create({
    data: { tenantId, name: contact.name, phone, phoneSource: "agent", phoneStatus: "ok" },
    select: { id: true },
  });
  return created.id;
}
