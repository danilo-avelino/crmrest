import type { Prisma } from "@dishdesk/database";
import type { CurrentOrderDto, CustomerHistory, OrderListQuery, OrderPage } from "@dishdesk/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { toOrderDto } from "../conversations/conversation.mapper.js";
import { scopeFor } from "../conversations/conversations.service.js";
import { DatabaseService } from "../core/database.service.js";
import { periodStart } from "../reports/reports.service.js";
import { forecastOrder, orderUpdateMessage, PlatformOrder, promisedAt, STALE_MS } from "./forecast.js";
import { customerHistory } from "./customer-history.js";
import { latestOrderOf } from "./latest-order.js";

const PAGE_SIZE = 50;

/** Aba Pedidos: todos os pedidos das integrações (iFood, Cardápio Web), sem abrir uma conversa para cada um. */
@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService) {}

  async list(auth: RequestAuth, query: OrderListQuery, now = new Date()): Promise<OrderPage> {
    const where: Prisma.OrderWhereInput = {
      placedAt: { gte: periodStart(query.period, now) },
      ...(query.status && { status: query.status }),
      ...(query.channel && { channel: { type: query.channel } }),
    };
    const [rows, total, histories] = await this.db.withTenants(scopeFor(auth, query.tenantId), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.order.findMany({
          where,
          include: {
            items: true,
            channel: { select: { type: true } },
            tenant: { select: { id: true, name: true } },
            contact: { select: { id: true, name: true, phone: true, cpfHash: true, email: true } },
            events: { orderBy: { occurredAt: "asc" }, select: { code: true, occurredAt: true } },
          },
          orderBy: [{ placedAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }),
        tx.order.count({ where }),
      ]);
      // Um histórico por cliente da página (vários pedidos do mesmo cliente reaproveitam o cálculo).
      const histories = new Map<string, CustomerHistory>();
      for (const { contact } of rows) {
        if (!histories.has(contact.id)) histories.set(contact.id, await customerHistory(tx, contact));
      }
      return [rows, total, histories] as const;
    });
    return {
      items: rows.map((order) => {
        const at = (code: string) => order.events.find((event) => event.code === code)?.occurredAt;
        const confirmed = at("CONFIRMED");
        const ready = at("READY_TO_PICKUP");
        return {
          ...toOrderDto(order),
          tenant: order.tenant,
          contact: { id: order.contact.id, name: order.contact.name },
          history: histories.get(order.contact.id)!,
          events: order.events.map((event) => ({ code: event.code, occurredAt: event.occurredAt.toISOString() })),
          preparationSeconds: confirmed && ready ? Math.round((ready.getTime() - confirmed.getTime()) / 1000) : null,
        };
      }),
      total,
      page: query.page,
      pageSize: PAGE_SIZE,
    };
  }

  /** Botão do card/painel: o texto que o atendente confere antes de mandar (saída ou previsão; null: nada a dizer). */
  async forecast(auth: RequestAuth, orderId: string): Promise<{ text: string | null }> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true } });
      if (!order) throw new NotFoundException("Pedido não encontrado.");
      return { text: (await orderUpdateMessage(tx, orderId))?.text ?? null };
    });
  }

  /** Painel do cliente na Inbox: o pedido ligado ao cadastro da conversa, com o andamento e a previsão de saída. */
  async currentForConversation(auth: RequestAuth, conversationId: string, now = new Date()): Promise<CurrentOrderDto | null> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId }, select: { contact: true } });
      if (!conversation) throw new NotFoundException("Conversa não encontrada.");
      const found = await latestOrderOf(tx, conversation.contact, now);
      if (!found) return null;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: found.id },
        include: {
          items: true,
          channel: { select: { type: true } },
          events: { where: { code: "CONFIRMED" }, orderBy: { occurredAt: "asc" }, take: 1, select: { occurredAt: true } },
        },
      });
      const forecast = await forecastOrder(tx, order.id, now);
      const platform = PlatformOrder.safeParse(order.raw).data;
      return {
        order: toOrderDto(order),
        notes: [platform?.extraInfo, platform?.delivery?.observations].filter((note): note is string => Boolean(note?.trim())),
        startedAt: (order.events[0]?.occurredAt ?? order.placedAt).toISOString(),
        promisedAt: promisedAt(order.raw)?.toISOString() ?? null,
        forecast: forecast && { departAt: forecast.departAt.toISOString(), late: forecast.late, ahead: forecast.ahead },
        history: await customerHistory(tx, conversation.contact),
        stale: !order.dispatchedAt && ["PLACED", "CONFIRMED", "PREPARING", "READY"].includes(order.status) && now.getTime() - order.placedAt.getTime() > STALE_MS,
      };
    });
  }
}
