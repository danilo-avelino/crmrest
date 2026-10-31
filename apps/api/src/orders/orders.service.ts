import type { Prisma, TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import {
  type AnswerDisputeRequest,
  CHANNEL_LABEL,
  type CurrentOrderDto,
  type CustomerHistory,
  type OrderAction,
  type OrderCancellationReason,
  type OrderCustomerChat,
  type OrderListQuery,
  type OrderPage,
  type OrderStageCounts,
} from "@dishdesk/shared";
import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { tenantSettings } from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { IfoodAuthService } from "../connectors/ifood-auth.service.js";
import { toOrderDto } from "../conversations/conversation.mapper.js";
import { scopeFor } from "../conversations/conversations.service.js";
import { openIfoodConversation } from "../conversations/ifood-conversation.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { periodStart } from "../reports/reports.service.js";
import { forecastOrder, isTakeout, orderUpdateMessage, PlatformOrder, promisedAt, STALE_MS } from "./forecast.js";
import { customerHistory } from "./customer-history.js";
import { eventDetail, openDispute, platformInfo } from "./ifood-order.js";
import { latestOrderOf } from "./latest-order.js";
import { withOrderTenants } from "./order-scope.js";

const PAGE_SIZE = 50;
/** Ainda no restaurante (filtro "em produção" e o alerta de atraso). */
const IN_PRODUCTION: OrderStatus[] = ["PLACED", "CONFIRMED", "PREPARING", "READY"];

/** Aba Pedidos: todos os pedidos das integrações (iFood, Cardápio Web), sem abrir uma conversa para cada um. */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly ifood: IfoodAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(auth: RequestAuth, query: OrderListQuery, now = new Date()): Promise<OrderPage> {
    const where: Prisma.OrderWhereInput = {
      placedAt: { gte: periodStart(query.period, now) },
      ...(query.status && { status: query.status }),
      ...(query.channel && { channel: { type: query.channel } }),
      ...(query.production && { status: { in: IN_PRODUCTION }, dispatchedAt: null }),
    };
    const sort = query.production ? "asc" : "desc";
    const [rows, total, histories, late] = await this.db.withTenants(scopeFor(auth, query.tenantId), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.order.findMany({
          where,
          include: {
            items: true,
            channel: { select: { type: true, name: true } },
            tenant: { select: { id: true, name: true } },
            contact: { select: { id: true, name: true, phone: true, phoneSource: true, cpfHash: true, email: true } },
            events: { orderBy: { occurredAt: "asc" }, select: { code: true, occurredAt: true, metadata: true } },
          },
          orderBy: [{ placedAt: sort }, { id: sort }],
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
      // Atraso só dos que ainda estão no restaurante (a retirada pronta já está à espera do cliente); sem base para a
      // previsão, vale a entrega prometida.
      const late = new Set<string>();
      for (const order of rows) {
        if (order.dispatchedAt || !IN_PRODUCTION.includes(order.status) || (order.status === "READY" && isTakeout(order.raw))) continue;
        const forecast = await forecastOrder(tx, order.id, now);
        const promised = promisedAt(order.raw);
        if (forecast ? forecast.late : promised !== null && promised < now) late.add(order.id);
      }
      return [rows, total, histories, late] as const;
    });
    return {
      items: rows.map((order) => {
        const at = (code: string) => order.events.find((event) => event.code === code)?.occurredAt;
        const confirmed = at("CONFIRMED");
        // Na entrega, a loja costuma ir de confirmado direto para "saiu" (sem marcar pronto): a saída fecha o preparo.
        const marked = at("READY_TO_PICKUP");
        const ready = marked ?? order.dispatchedAt;
        const ifood = order.channel.type === "IFOOD";
        // Sem a trava, o Dish Desk só acompanha o pedido: nenhuma ação é oferecida.
        const actions = ifood && this.env.IFOOD_ORDER_ACTIONS;
        const dispute = ifood ? openDispute(order.events, now) : null;
        return {
          ...toOrderDto(order),
          tenant: order.tenant,
          store: order.channel.name,
          contact: { id: order.contact.id, name: order.contact.name },
          history: histories.get(order.contact.id)!,
          events: order.events.map((event) => ({ code: event.code, occurredAt: event.occurredAt.toISOString(), detail: eventDetail(event) })),
          preparationSeconds: confirmed && ready ? Math.round((ready.getTime() - confirmed.getTime()) / 1000) : null,
          readySkipped: Boolean(confirmed && !marked && order.dispatchedAt),
          takeout: isTakeout(order.raw),
          late: late.has(order.id),
          nextAction: actions ? nextOrderAction(order) : null,
          cancelable: actions && CANCELABLE.has(order.status),
          platform: ifood ? platformInfo(order.raw) : null,
          dispute: dispute && { ...dispute, answerable: actions },
        };
      }),
      total,
      page: query.page,
      pageSize: PAGE_SIZE,
    };
  }

  /** Pedidos de hoje por etapa: em produção, prontos, em rota (já saíram do restaurante) e entregues. */
  async stages(auth: RequestAuth, now = new Date()): Promise<OrderStageCounts> {
    const rows = await this.db.withTenants(auth.scope, (tx) =>
      tx.order.findMany({ where: { placedAt: { gte: periodStart("today", now) } }, select: { status: true, dispatchedAt: true } }),
    );
    const counts: OrderStageCounts = { production: 0, ready: 0, dispatched: 0, delivered: 0 };
    for (const { status, dispatchedAt } of rows) {
      if (status === "DELIVERED") counts.delivered++;
      else if (status === "DISPATCHED" || (dispatchedAt && IN_PRODUCTION.includes(status))) counts.dispatched++;
      else if (status === "READY") counts.ready++;
      else if (IN_PRODUCTION.includes(status)) counts.production++;
    }
    return counts;
  }

  /** Botão do card/painel: o texto que o atendente confere antes de mandar (saída ou previsão; null: nada a dizer). */
  /**
   * Andamento do pedido para mandar ao cliente. Com a conversa, vale também o pedido de outro restaurante atendido pelo
   * canal dela (Configurações → Integrações).
   */
  async forecast(auth: RequestAuth, orderId: string, conversationId?: string): Promise<{ text: string | null }> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const update = async (orders: TenantTx, speakerSettings?: unknown) => {
        const order = await orders.order.findUnique({ where: { id: orderId }, select: { id: true } });
        if (!order) throw new NotFoundException("Pedido não encontrado.");
        return { text: (await orderUpdateMessage(orders, orderId, new Date(), speakerSettings))?.text ?? null };
      };
      if (!conversationId) return update(tx);
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId }, select: { tenantId: true, channelId: true } });
      if (!conversation) throw new NotFoundException("Conversa não encontrada.");
      // A mensagem sai pelo canal da conversa: no tom do restaurante dela, mesmo com o pedido de outra unidade.
      const speaker = await tenantSettings(tx, conversation.tenantId);
      return withOrderTenants(this.db, tx, conversation.channelId, (orders) => update(orders, speaker));
    });
  }

  /**
   * Botão do pedido: informa ao iFood a próxima etapa. O status só muda quando o evento do iFood chega pelo polling.
   * Esta e as outras ações do pedido só existem com a trava IFOOD_ORDER_ACTIONS ligada.
   */
  async advance(auth: RequestAuth, orderId: string): Promise<{ action: OrderAction }> {
    const order = await this.ifoodOrder(auth, orderId);
    const action = nextOrderAction(order);
    if (!action) throw new UnprocessableEntityException("Não há etapa para informar neste pedido.");
    await this.askIfood(() => order.client.advance(order.externalOrderId, IFOOD_STEP[action]));
    return { action };
  }

  /** Motivos que o iFood aceita para cancelar o pedido agora (lista vazia: não dá para cancelar). */
  async cancellationReasons(auth: RequestAuth, orderId: string): Promise<{ reasons: OrderCancellationReason[] }> {
    const order = await this.ifoodOrder(auth, orderId);
    const reasons = await this.askIfood(() => order.client.cancellationReasons(order.externalOrderId));
    return { reasons };
  }

  /** Pede o cancelamento ao iFood com um dos motivos que ele ofereceu; o pedido vira cancelado quando o evento chega. */
  async cancel(auth: RequestAuth, orderId: string, code: string): Promise<void> {
    const order = await this.ifoodOrder(auth, orderId);
    const reasons = await this.askIfood(() => order.client.cancellationReasons(order.externalOrderId));
    const reason = reasons.find((item) => item.code === code);
    if (!reason) throw new UnprocessableEntityException("O iFood não aceita este motivo para o pedido. Escolha outro.");
    await this.askIfood(() => order.client.requestCancellation(order.externalOrderId, reason));
  }

  /**
   * Resposta da loja ao pedido do cliente em negociação (ex.: cancelamento): aceita ou recusa. O desfecho chega pelo
   * polling (HANDSHAKE_SETTLEMENT e, se aceito, o cancelamento).
   */
  async answerDispute(auth: RequestAuth, orderId: string, answer: AnswerDisputeRequest, now = new Date()): Promise<void> {
    const order = await this.ifoodOrder(auth, orderId);
    const dispute = openDispute(order.events, now);
    if (!dispute) throw new UnprocessableEntityException("Não há pedido do cliente aguardando resposta.");
    if (answer.accept && dispute.acceptReasons.length && !dispute.acceptReasons.includes(answer.reason ?? "")) {
      throw new UnprocessableEntityException("Escolha um dos motivos que o iFood aceita.");
    }
    if (!answer.accept && !answer.reason) throw new UnprocessableEntityException("Escolha o motivo da recusa.");
    await this.askIfood(() => order.client.answerDispute(dispute.id, answer.accept ? "accept" : "reject", answer.reason));
  }

  private async ifoodOrder(auth: RequestAuth, orderId: string) {
    const order = await this.db.withTenants(auth.scope, (tx) =>
      tx.order.findUnique({
        where: { id: orderId },
        select: {
          externalOrderId: true,
          status: true,
          raw: true,
          channel: { select: { id: true, tenantId: true, type: true } },
          events: { orderBy: { occurredAt: "asc" }, select: { code: true, metadata: true } },
        },
      }),
    );
    if (!order) throw new NotFoundException("Pedido não encontrado.");
    if (order.channel.type !== "IFOOD" || !this.ifood.configured) {
      throw new UnprocessableEntityException("Este pedido não pode ser alterado pelo Dish Desk.");
    }
    if (!this.env.IFOOD_ORDER_ACTIONS) {
      throw new UnprocessableEntityException("O Dish Desk só acompanha os pedidos do iFood: a ação é feita no sistema de pedidos da loja.");
    }
    return { ...order, client: this.ifood.clientFor(order.channel) };
  }

  private async askIfood<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logger.warn(`iFood recusou a ação no pedido: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnprocessableEntityException("O iFood não aceitou. Confira se o pedido já mudou de etapa e tente de novo.");
    }
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

  /**
   * Painel do cliente na Inbox: o pedido ligado ao cadastro da conversa, com o andamento e a previsão de saída. Procura
   * no restaurante da conversa e nos que o canal dela atende; no painel master, os outros restaurantes do atendente
   * ficam de fora.
   */
  async currentForConversation(auth: RequestAuth, conversationId: string, now = new Date()): Promise<CurrentOrderDto | null> {
    return this.db.withTenants(auth.scope, async (scoped) => {
      const conversation = await scoped.conversation.findUnique({ where: { id: conversationId }, select: { tenantId: true, channelId: true, contact: true } });
      if (!conversation) throw new NotFoundException("Conversa não encontrada.");
      return withOrderTenants(this.db, scoped, conversation.channelId, async (tx) => {
        const found = await latestOrderOf(tx, conversation.contact, now);
        if (!found) return null;
        const order = await tx.order.findUniqueOrThrow({
          where: { id: found.id },
          include: {
            items: true,
            channel: { select: { type: true } },
            tenant: { select: { name: true } },
            events: {
              where: { code: { in: ["CONFIRMED", "READY_TO_PICKUP"] } },
              orderBy: { occurredAt: "asc" },
              select: { code: true, occurredAt: true },
            },
          },
        });
        const forecast = await forecastOrder(tx, order.id, now);
        const platform = PlatformOrder.safeParse(order.raw).data;
        const at = (code: string) => order.events.find((event) => event.code === code)?.occurredAt;
        return {
          order: { ...toOrderDto(order), ...(order.tenantId !== conversation.tenantId && { restaurantName: order.tenant.name }) },
          notes: [platform?.extraInfo, platform?.delivery?.observations].filter((note): note is string => Boolean(note?.trim())),
          startedAt: (at("CONFIRMED") ?? order.placedAt).toISOString(),
          readyAt: at("READY_TO_PICKUP")?.toISOString() ?? null,
          takeout: isTakeout(order.raw),
          promisedAt: promisedAt(order.raw)?.toISOString() ?? null,
          forecast: forecast && { departAt: forecast.departAt.toISOString(), late: forecast.late, ahead: forecast.ahead },
          history: await customerHistory(tx, conversation.contact),
          stale: !order.dispatchedAt && ["PLACED", "CONFIRMED", "PREPARING", "READY"].includes(order.status) && now.getTime() - order.placedAt.getTime() > STALE_MS,
        };
      });
    });
  }
}

const IFOOD_STEP = { CONFIRM: "confirm", READY: "readyToPickup", DISPATCH: "dispatch" } as const;

/** Depois de entregue (ou cancelado) não há o que cancelar; antes disso, o iFood decide pelos motivos que oferece. */
const CANCELABLE = new Set<OrderStatus>(["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED"]);

/**
 * Próxima etapa que a loja informa ao iFood. O despacho só existe na entrega feita pela própria loja: com entregador do
 * iFood (ou retirada), a saída vem do evento de coleta.
 */
export function nextOrderAction(order: { status: OrderStatus; raw: unknown; channel: { type: ChannelType } }): OrderAction | null {
  if (order.channel.type !== "IFOOD") return null;
  if (order.status === "PLACED") return "CONFIRM";
  if (order.status === "CONFIRMED" || order.status === "PREPARING") return "READY";
  if (order.status !== "READY") return null;
  const platform = PlatformOrder.safeParse(order.raw).data;
  return platform?.orderType === "DELIVERY" && platform.delivery?.deliveredBy !== "IFOOD" ? "DISPATCH" : null;
}
