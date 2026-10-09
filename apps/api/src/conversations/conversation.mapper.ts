import type { Message, Order, OrderItem, Prisma } from "@dishdesk/database";
import type { ChannelType } from "@dishdesk/database/enums";
import type { ConversationListItem, MessageContent, MessageDto, OrderDto } from "@dishdesk/shared";

export function toMessageDto(message: Message & { sentByUser?: { id: string; name: string } | null }): MessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.type,
    content: message.content as MessageContent,
    status: message.status,
    statusError: message.statusError,
    sentBy: message.sentByUser ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toOrderDto(order: Order & { items: OrderItem[]; channel: { type: ChannelType } }): OrderDto {
  return {
    id: order.id,
    channelType: order.channel.type,
    displayCode: order.displayCode,
    status: order.status,
    subtotal: order.subtotal.toFixed(2),
    deliveryFee: order.deliveryFee.toFixed(2),
    total: order.total.toFixed(2),
    placedAt: order.placedAt.toISOString(),
    dispatchedAt: order.dispatchedAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    items: order.items.map((item) => ({ name: item.name, quantity: item.quantity, unitPrice: item.unitPrice.toFixed(2), notes: item.notes })),
  };
}

/** Campos da conversa que a lista da Inbox mostra. */
export const conversationListInclude = {
  tenant: { select: { id: true, name: true } },
  channel: { select: { id: true, type: true, name: true } },
  contact: { select: { id: true, name: true, phoneStatus: true } },
  assignedUser: { select: { id: true, name: true } },
  messages: {
    where: { type: { not: "NOTE" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { direction: true, type: true, content: true },
  },
  orders: { orderBy: { placedAt: "desc" }, take: 1, select: { displayCode: true } },
} satisfies Prisma.ConversationInclude;

type ConversationWithList = Prisma.ConversationGetPayload<{ include: typeof conversationListInclude }>;

export function toListItem(conversation: ConversationWithList): ConversationListItem {
  const last = conversation.messages[0];
  return {
    id: conversation.id,
    tenant: conversation.tenant,
    status: conversation.status,
    unreadCount: conversation.unreadCount,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    windowExpiresAt: conversation.windowExpiresAt?.toISOString() ?? null,
    awaitingAgentSince: conversation.awaitingAgentSince?.toISOString() ?? null,
    channel: conversation.channel,
    contact: conversation.contact,
    assignedUser: conversation.assignedUser,
    lastMessage: last ? { direction: last.direction, preview: preview(last.type, last.content as MessageContent) } : null,
    orderCode: conversation.orders[0]?.displayCode ?? null,
  };
}

const TYPE_PREVIEW: Partial<Record<Message["type"], string>> = {
  IMAGE: "Imagem",
  AUDIO: "Áudio",
  VIDEO: "Vídeo",
  DOCUMENT: "Documento",
  STICKER: "Figurinha",
  LOCATION: "Localização",
};

function preview(type: Message["type"], content: MessageContent): string {
  if (content.event === "order") return "Pedido do iFood";
  return content.text ?? TYPE_PREVIEW[type] ?? "Mensagem";
}
