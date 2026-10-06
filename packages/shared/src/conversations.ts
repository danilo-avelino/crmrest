import type {
  ChannelStatus,
  ChannelType,
  ConversationStatus,
  Direction,
  MessageStatus,
  MessageType,
  OrderStatus,
  TenantRole,
} from "@comanda/database/enums";
import { ConversationStatus as ConversationStatusEnum } from "@comanda/database/enums";
import { z } from "zod";

/** Conteúdo de uma mensagem, conforme o tipo (texto, mídia, evento do sistema, nota...). */
export type MessageContent = {
  text?: string;
  /** Mensagem enviada por automação (coleta de telefone, menu de atendimento, pesquisa de satisfação, encerramento). */
  automation?:
    | "phone_collection"
    | "phone_reminder"
    | "phone_confirmation"
    | "menu"
    | "order_number_request"
    | "order_lookup"
    | "order_confirmed"
    | "order_links"
    | "handoff"
    | "survey"
    | "survey_thanks"
    | "after_hours"
    | "inactivity_close";
  /** Evento do sistema mostrado na conversa. */
  event?:
    | "conversation_opened"
    | "phone_collected"
    | "phone_pending"
    | "order"
    | "opt_out"
    | "contacts_merged"
    | "merge_conflict"
    | "order_ambiguous"
    | "rating"
    | "handoff";
  orderId?: string;
  /** Template aprovado do WhatsApp (o único envio permitido fora da janela de 24h). */
  template?: { name: string; language: string; variables: string[] };
  media?: { mimeType: string; externalMediaId?: string; url?: string; filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
};

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: Direction;
  type: MessageType;
  content: MessageContent;
  status: MessageStatus | null;
  statusError: string | null;
  sentBy: { id: string; name: string } | null;
  createdAt: string;
};

export type OrderDto = {
  id: string;
  /** De onde veio o pedido (iFood, Cardápio Web). */
  channelType: ChannelType;
  displayCode: string | null;
  status: OrderStatus;
  subtotal: string;
  deliveryFee: string;
  total: string;
  placedAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  items: { name: string; quantity: number; unitPrice: string }[];
};

/** Item da lista de conversas da Inbox (no painel master, `tenant` diz de qual restaurante é). */
export type ConversationListItem = {
  id: string;
  tenant: { id: string; name: string };
  status: ConversationStatus;
  unreadCount: number;
  createdAt: string;
  lastMessageAt: string | null;
  windowExpiresAt: string | null;
  /** Desde quando o cliente espera um atendente (a automação chamou a equipe e ninguém respondeu); null = não espera. */
  awaitingAgentSince: string | null;
  channel: { id: string; type: ChannelType; name: string };
  contact: { id: string; name: string | null; phoneStatus: string | null };
  assignedUser: { id: string; name: string } | null;
  lastMessage: { direction: Direction; preview: string } | null;
  /** Código do último pedido ligado à conversa (cabeçalho "iFood · #485329"). */
  orderCode: string | null;
};

export type ConversationPage = { items: ConversationListItem[]; nextCursor: string | null };
/** Conversas por status e quantas estão chamando um atendente (alarme da Inbox). */
export type ConversationCounts = Record<ConversationStatus, number> & { awaitingAgent: number };
export type ConversationMessages = { messages: MessageDto[]; orders: Record<string, OrderDto> };

export const ConversationListQuery = z.object({
  /** ACTIVE: abertas e pendentes (o que a equipe ainda precisa tratar). */
  status: z.enum([...Object.values(ConversationStatusEnum), "ACTIVE"]).optional(),
  search: z.string().trim().max(100).optional(),
  tenantId: z.uuid().optional(),
  cursor: z.uuid().optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(4096) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** Template aprovado na conta do WhatsApp; `variables` = quantos {{n}} o corpo tem. */
export type WhatsAppTemplate = { name: string; language: string; category: string; body: string; variables: number };

export const SendTemplateRequest = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(15),
  variables: z.array(z.string().trim().min(1).max(1024)).max(20),
});
export type SendTemplateRequest = z.infer<typeof SendTemplateRequest>;

/** Corpo do template com as variáveis no lugar de {{1}}, {{2}}... */
export function renderTemplate(body: string, variables: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, index: string) => variables[Number(index) - 1] ?? match);
}

export const UpdateConversationRequest = z
  .object({
    status: z.enum(ConversationStatusEnum).optional(),
    assignedUserId: z.uuid().nullable().optional(),
  })
  .refine((body) => body.status !== undefined || body.assignedUserId !== undefined, "Nada para alterar.");
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequest>;

/** Membro de um restaurante, para atribuir conversas. */
export type MemberDto = { id: string; name: string; tenantId: string; role: TenantRole };

export type QuickReplyDto = { id: string; tenantId: string; shortcut: string; content: string };

/** Canal do restaurante como a equipe o vê (sem credenciais): para avisar quando ele precisa ser reconectado. */
export type ChannelHealthDto = { id: string; tenantId: string; type: ChannelType; name: string; status: ChannelStatus };
