import type { TenantTx } from "@dishdesk/database";
import type { ConversationStatus } from "@dishdesk/database/enums";
import { CHANNEL_LABEL, type MessageContent } from "@dishdesk/shared";

type IfoodOrder = { id: string; tenantId: string; contactId: string; channelId: string; conversationId: string | null };

/**
 * Conversa do cliente no canal iFood da loja (a última, ou uma nova, criada com `status`), com o pedido na linha do tempo.
 * `previousStatus`: como a conversa estava; null = acabou de ser criada.
 */
export async function openIfoodConversation(tx: TenantTx, order: IfoodOrder, at: Date, status: ConversationStatus = "OPEN") {
  const where = { contactId: order.contactId, channelId: order.channelId };
  const select = { id: true, lastMessageAt: true, status: true };
  const latest = await tx.conversation.findFirst({ where, orderBy: { createdAt: "desc" }, select });
  const conversation = latest ?? (await tx.conversation.create({ data: { tenantId: order.tenantId, ...where, status, createdAt: at }, select }));
  const event = (content: MessageContent, createdAt: Date) =>
    tx.message.create({
      data: { tenantId: order.tenantId, conversationId: conversation.id, channelId: order.channelId, direction: "INTERNAL", type: "SYSTEM", content, createdAt },
    });
  if (!latest) await event({ event: "conversation_opened", text: `Conversa aberta via ${CHANNEL_LABEL.IFOOD}` }, new Date(at.getTime() - 2));
  const shown = await tx.message.findFirst({
    where: { conversationId: conversation.id, content: { path: ["orderId"], equals: order.id } },
    select: { id: true },
  });
  if (!shown) await event({ event: "order", orderId: order.id }, new Date(at.getTime() - 1));
  // Pedido já ligado a outra conversa (o cliente confirmou pelo WhatsApp) continua lá.
  if (!order.conversationId) await tx.order.update({ where: { id: order.id }, data: { conversationId: conversation.id } });
  return { id: conversation.id, lastMessageAt: conversation.lastMessageAt, previousStatus: latest?.status ?? null };
}
