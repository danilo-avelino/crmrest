import type { Message, Order, OrderItem, Prisma, TenantTx } from "@dishdesk/database";
import type { ChannelType } from "@dishdesk/database/enums";
import type { ConversationEvaluationDto, ConversationListItem, MessageContent, MessageDto, OrderDto, TeamReason } from "@dishdesk/shared";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { type AutomationState, RATING_ANSWER } from "../automations/automation.js";
import { isTenantAdmin } from "../settings/tenant-admin.js";

/** O que o atendente vê no lugar da nota da pesquisa de satisfação: o valor é só do administrador. */
const RATING_HIDDEN = "Avaliação do atendimento recebida";

/** Linha do tempo do atendente: some a resposta do cliente à pesquisa e o evento da avaliação fica sem a nota. */
export function withoutRatingScores(messages: MessageDto[]): MessageDto[] {
  let awaitingAnswer = false;
  return messages.flatMap((message) => {
    if (message.content.automation === "survey") awaitingAnswer = true;
    else if (message.direction === "INBOUND") {
      // Só a primeira mensagem do cliente depois da pergunta pode ser a nota (como em SurveyService.handleAnswer).
      const answer = awaitingAnswer && RATING_ANSWER.test(message.content.text ?? "");
      awaitingAnswer = false;
      if (answer) return [];
    }
    return message.content.event === "rating" ? [{ ...message, content: { ...message.content, text: RATING_HIDDEN } }] : [message];
  });
}

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
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice.toFixed(2),
      notes: item.notes,
      options: item.options,
    })),
  };
}

/** Campos da conversa que a lista da Inbox mostra. */
export const conversationListInclude = {
  tenant: { select: { id: true, name: true } },
  channel: { select: { id: true, type: true, name: true } },
  contact: { select: { id: true, name: true, phoneStatus: true, tags: true } },
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

/** A última mensagem mostra a nota (o evento, ou a resposta do cliente ainda por registrar) e quem pede é atendente. */
function hidesRating(conversation: ConversationWithList, auth: RequestAuth): boolean {
  const last = conversation.messages[0];
  if (!last || isTenantAdmin(auth, conversation.tenantId)) return false;
  const content = last.content as MessageContent;
  const { survey } = conversation.automationState as AutomationState;
  return content.event === "rating" || (last.direction === "INBOUND" && survey === "awaiting_rating" && RATING_ANSWER.test(content.text ?? ""));
}

export function toListItem(conversation: ConversationWithList, auth: RequestAuth): ConversationListItem {
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
    awaitingAgentQuiet: conversation.awaitingAgentQuiet,
    channel: conversation.channel,
    contact: conversation.contact,
    assignedUser: conversation.assignedUser,
    lastMessage: last
      ? { direction: last.direction, preview: hidesRating(conversation, auth) ? RATING_HIDDEN : preview(last.type, last.content as MessageContent) }
      : null,
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

export function preview(type: Message["type"], content: MessageContent): string {
  if (content.event === "order") return "Pedido do iFood";
  return content.text ?? TYPE_PREVIEW[type] ?? "Mensagem";
}

/** Avaliações da IA (nome de quem da equipe respondeu por último incluído) das conversas que casam com `where`. */
export async function listEvaluations(
  tx: TenantTx,
  tenantId: string,
  where: Prisma.ConversationEvaluationWhereInput,
): Promise<ConversationEvaluationDto[]> {
  const rows = await tx.conversationEvaluation.findMany({ where, orderBy: { createdAt: "asc" } });
  const userIds = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
  const members = userIds.length
    ? await tx.tenantMember.findMany({ where: { tenantId, userId: { in: userIds } }, select: { user: { select: { id: true, name: true } } } })
    : [];
  const names = new Map(members.map((member) => [member.user.id, member.user.name]));
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    resolved: row.resolved,
    satisfied: row.satisfied,
    score: row.score,
    summary: row.summary,
    agentName: row.userId ? (names.get(row.userId) ?? "Ex-atendente") : null,
    teamReason: row.teamReason as TeamReason | null,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  }));
}
