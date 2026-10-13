import type { ChannelType } from "@dishdesk/database/enums";
import { ChannelType as ChannelTypeEnum, OrderStatus as OrderStatusEnum } from "@dishdesk/database/enums";
import { z } from "zod";
import type { OrderDto } from "./conversations.js";
import { REPORT_PERIODS } from "./reports.js";

/** Aba Pedidos: período (como na aba Avaliações), status, origem e página. */
export const OrderListQuery = z.object({
  tenantId: z.uuid().optional(),
  period: z.enum(REPORT_PERIODS).default("today"),
  status: z.enum(OrderStatusEnum).optional(),
  channel: z.enum(ChannelTypeEnum).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type OrderListQuery = z.infer<typeof OrderListQuery>;

/**
 * Histórico do cliente em todas as fontes de pedido (o próprio cadastro e outros com o mesmo telefone, CPF ou e-mail),
 * sem os cancelados: "Este cliente tem 5 pedidos (iFood 3 · Cardápio Web 2)".
 */
export type CustomerHistory = {
  orders: number;
  total: string;
  bySource: { channelType: ChannelType; orders: number }[];
};

/** Etapa que a equipe informa à plataforma pelo Dish Desk (iFood): confirmar, avisar que ficou pronto, despachar. */
export type OrderAction = "CONFIRM" | "READY" | "DISPATCH";

/** Motivo de cancelamento que a plataforma aceita para o pedido, no estado em que ele está. */
export type OrderCancellationReason = { code: string; description: string };

export const CancelOrderRequest = z.object({ code: z.string().min(1) });
export type CancelOrderRequest = z.infer<typeof CancelOrderRequest>;

/** Pagamento, descontos e dados da entrega como a plataforma informou (iFood). */
export type OrderPlatformInfo = {
  payments: {
    method: string;
    /** Bandeira do cartão. */
    brand: string | null;
    value: string;
    /** Pago pelo app (true) ou a cobrar na entrega. */
    prepaid: boolean;
    /** Dinheiro: com quanto o cliente vai pagar e o troco a levar. */
    changeFor: string | null;
    change: string | null;
  }[];
  /** Cupons e descontos, com quanto cada um paga (iFood, loja). */
  benefits: { value: string; sponsors: { name: string; value: string }[] }[];
  /** Código que o entregador informa na coleta. */
  pickupCode: string | null;
  /** CPF ou CNPJ que o cliente pediu na nota. */
  document: string | null;
  /** Observações do pedido e da entrega. */
  notes: string[];
};

/**
 * Pedido do cliente em negociação (Plataforma de Negociação do iFood), à espera da resposta da loja: hoje, cancelamento
 * total ou parcial. Sem resposta até `expiresAt`, o iFood aplica `timeoutAction`.
 */
export type OrderDispute = {
  id: string;
  action: string;
  message: string | null;
  expiresAt: string | null;
  timeoutAction: string | null;
  /** Motivos que o iFood aceita para a loja concordar (vazio: não pede motivo). */
  acceptReasons: string[];
};

/** Motivos de decisão da Plataforma de Negociação do iFood; para recusar, a loja escolhe um deles. */
export const DISPUTE_REASON_LABEL: Record<string, string> = {
  HIGH_STORE_DEMAND: "Loja com muita demanda",
  UNKNOWN_ISSUE: "Problema não especificado",
  CUSTOMER_SATISFACTION: "Satisfação do cliente",
  INVENTORY_CHECK: "Verificação de disponibilidade",
  SYSTEM_ISSUE: "Problema técnico",
  WRONG_ORDER: "Pedido incorreto",
  PRODUCT_QUALITY: "Qualidade do produto",
  LATE_DELIVERY: "Entrega atrasada",
  CUSTOMER_REQUEST: "Pedido do cliente",
};

export const AnswerDisputeRequest = z.object({ accept: z.boolean(), reason: z.string().min(1).optional() });
export type AnswerDisputeRequest = z.infer<typeof AnswerDisputeRequest>;

export type OrderListItem = OrderDto & {
  tenant: { id: string; name: string };
  contact: { id: string; name: string | null };
  /** Linha do tempo informada pela plataforma (iFood): código do evento, quando aconteceu e o motivo, se houver. */
  events: { code: string; occurredAt: string; detail: string | null }[];
  /** Tempo de preparo: de confirmado a pronto (null se a loja não marcou as duas etapas). */
  preparationSeconds: number | null;
  /** Pedidos do cliente em todas as fontes (inclui este). */
  history: CustomerHistory;
  /** Próxima etapa que dá para informar à plataforma (null: nenhuma, ou a origem não aceita). */
  nextAction: OrderAction | null;
  /** Dá para pedir o cancelamento à plataforma (ela ainda decide pelos motivos que oferece). */
  cancelable: boolean;
  /** null: a origem do pedido não informa (só o iFood, por enquanto). */
  platform: OrderPlatformInfo | null;
  /** Pedido do cliente à espera da resposta da loja. */
  dispute: OrderDispute | null;
};

export type OrderPage = { items: OrderListItem[]; total: number; page: number; pageSize: number };

/**
 * Pedido ligado ao cliente da conversa (painel lateral da Inbox): o mais recente de hoje ou de ontem, achado pelo
 * cadastro (canais vinculados, telefone, CPF ou e-mail), com o andamento e a previsão de saída.
 */
export type CurrentOrderDto = {
  order: OrderDto;
  /** Observações do pedido como a plataforma informou (ex.: iFood: "extraInfo" e observações da entrega). */
  notes: string[];
  /** Início do preparo para a previsão: a confirmação (ou, sem ela, a hora do pedido). */
  startedAt: string;
  /** Entrega (ou retirada) prometida ao cliente pela plataforma; null se ela não informa (ex.: Cardápio Web). */
  promisedAt: string | null;
  /** Previsão de saída do restaurante (E26); null se o pedido já saiu ou se ainda não há base. */
  forecast: { departAt: string; late: boolean; ahead: number } | null;
  /** Pedidos do cliente em todas as fontes (inclui este). */
  history: CustomerHistory;
  /** Na cozinha há mais de 4 h sem a plataforma avisar a saída: sem andamento nem previsão (status desatualizado). */
  stale: boolean;
};
