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

export type OrderListItem = OrderDto & {
  tenant: { id: string; name: string };
  contact: { id: string; name: string | null };
  /** Linha do tempo informada pela plataforma (iFood): código do evento e quando aconteceu. */
  events: { code: string; occurredAt: string }[];
  /** Tempo de preparo: de confirmado a pronto (null se a loja não marcou as duas etapas). */
  preparationSeconds: number | null;
  /** Pedidos do cliente em todas as fontes (inclui este). */
  history: CustomerHistory;
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
