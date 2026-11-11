import type { TenantTx } from "@dishdesk/database";
import { CHANNEL_LABEL } from "@dishdesk/shared";

/** O número de WhatsApp conectado do restaurante por onde a equipe começa uma conversa (o mais antigo). */
export function connectedWhatsApp(tx: TenantTx, tenantId: string) {
  return tx.channel.findFirst({
    where: { tenantId, type: "WHATSAPP", status: "CONNECTED", deletedAt: null },
    orderBy: { id: "asc" },
    select: { id: true },
  });
}

/**
 * Conversa do WhatsApp com o cliente: a última dele (ou de outro cadastro com o mesmo telefone) num número conectado,
 * ou uma nova, que a equipe começa por um template (não há janela de 24h aberta).
 */
export async function openWhatsAppConversation(
  tx: TenantTx,
  channelId: string,
  contact: { id: string; tenantId: string; phone: string | null },
): Promise<string> {
  const phone = contact.phone!;
  const existing = await tx.conversation.findFirst({
    where: {
      tenantId: contact.tenantId,
      channel: { type: "WHATSAPP", status: "CONNECTED", deletedAt: null },
      contact: { OR: [{ id: contact.id }, { phone }] },
    },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    select: { id: true },
  });
  if (existing) return existing.id;
  // O envio vai para a identidade do WhatsApp do cadastro: o telefone, sem o "+".
  const identity = await tx.contactIdentity.upsert({
    where: { tenantId_channelType_externalId: { tenantId: contact.tenantId, channelType: "WHATSAPP", externalId: phone.slice(1) } },
    create: { tenantId: contact.tenantId, contactId: contact.id, channelType: "WHATSAPP", externalId: phone.slice(1) },
    update: {},
    select: { contactId: true },
  });
  // Aberta pela equipe: fica na aba Ativos, não em Automáticos.
  const conversation = await tx.conversation.create({
    data: { tenantId: contact.tenantId, contactId: identity.contactId, channelId, status: "OPEN", teamInvolved: true },
    select: { id: true },
  });
  await tx.message.create({
    data: {
      tenantId: contact.tenantId,
      conversationId: conversation.id,
      channelId,
      direction: "INTERNAL",
      type: "SYSTEM",
      content: { event: "conversation_opened", text: `Conversa aberta via ${CHANNEL_LABEL.WHATSAPP}` },
    },
  });
  return conversation.id;
}
