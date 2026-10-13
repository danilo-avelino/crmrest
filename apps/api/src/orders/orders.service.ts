import type { Prisma, TenantTx } from "@dishdesk/database";
import { CHANNEL_LABEL, type CurrentOrderDto, type CustomerHistory, type OrderCustomerChat, type OrderListQuery, type OrderPage } from "@dishdesk/shared";
import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { toOrderDto } from "../conversations/conversation.mapper.js";
import { scopeFor } from "../conversations/conversations.service.js";
import { openIfoodConversation } from "../conversations/ifood-conversation.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { periodStart } from "../reports/reports.service.js";
import { forecastOrder, orderUpdateMessage, PlatformOrder, promisedAt, STALE_MS } from "./forecast.js";
import { customerHistory } from "./customer-history.js";
import { latestOrderOf } from "./latest-order.js";

const PAGE_SIZE = 50;

/** Aba Pedidos: todos os pedidos das integrações (iFood, Cardápio Web), sem abrir uma conversa para cada um. */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @Inject(ENV) private readonly env: Env,
  ) {}

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

  /** Card do pedido informado por um entregador: por onde a equipe fala com o cliente. */
  async customerChat(auth: RequestAuth, orderId: string): Promise<OrderCustomerChat> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const { order, whatsapp, ifood } = await this.customerRoute(tx, orderId);
      return { channel: whatsapp ? "WHATSAPP" : ifood ? "IFOOD" : null, contactName: order.contact.name };
    });
  }

  /** Botão do card: abre a conversa com o cliente do pedido (a que já existe, ou uma nova) e devolve o id dela. */
  async openCustomerChat(auth: RequestAuth, orderId: string): Promise<{ conversationId: string }> {
    const opened = await this.db.withTenants(auth.scope, async (tx) => {
      const { order, whatsapp, ifood } = await this.customerRoute(tx, orderId);
      if (whatsapp) return { tenantId: order.tenantId, conversationId: await this.openWhatsApp(tx, whatsapp.id, order.contact) };
      if (!ifood) throw new UnprocessableEntityException("Não há como conversar com este cliente pelo Dish Desk.");
      return { tenantId: order.tenantId, conversationId: (await openIfoodConversation(tx, order, new Date())).id };
    });
    this.realtime.inboxChanged(opened.tenantId, opened.conversationId);
    return { conversationId: opened.conversationId };
  }

  /**
   * WhatsApp, se o cadastro do cliente tem telefone e o restaurante tem um número conectado (o mais antigo); senão, o chat
   * do iFood do pedido, que depende da trava IFOOD_CHAT_BRIDGE.
   */
  private async customerRoute(tx: TenantTx, orderId: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { contact: true, channel: { select: { type: true } } } });
    if (!order) throw new NotFoundException("Pedido não encontrado.");
    const whatsapp = order.contact.phone
      ? await tx.channel.findFirst({
          where: { tenantId: order.tenantId, type: "WHATSAPP", status: "CONNECTED", deletedAt: null },
          orderBy: { id: "asc" },
          select: { id: true },
        })
      : null;
    return { order, whatsapp, ifood: order.channel.type === "IFOOD" && this.env.IFOOD_CHAT_BRIDGE };
  }

  /**
   * Conversa do WhatsApp com o cliente: a última dele (ou de outro cadastro com o mesmo telefone) num número conectado,
   * ou uma nova, que a equipe começa por um template (não há janela de 24h aberta).
   */
  private async openWhatsApp(tx: TenantTx, channelId: string, contact: { id: string; tenantId: string; phone: string | null }): Promise<string> {
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
    const conversation = await tx.conversation.create({
      data: { tenantId: contact.tenantId, contactId: identity.contactId, channelId, status: "OPEN" },
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
