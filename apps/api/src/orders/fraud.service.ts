import type { TenantTx } from "@dishdesk/database";
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { systemEvent } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { addressKey } from "./address-key.js";
import { ACTIVE_ORDER, conversationOfOrder, linkedContactsWhere, orderAlert } from "./fraud-alert.js";
import { OrderNoticeService } from "./order-notice.service.js";

const orderSelect = {
  id: true,
  tenantId: true,
  contactId: true,
  channelId: true,
  conversationId: true,
  displayCode: true,
  externalOrderId: true,
  status: true,
  placedAt: true,
  deliveryAddress: true,
  alertDecision: true,
  alertDecidedAt: true,
  alertDecidedBy: { select: { name: true } },
  fraudMarkedAt: true,
  contact: { select: { id: true, name: true, phone: true, phoneSource: true, cpfHash: true, email: true } },
  channel: { select: { connectedAt: true } },
} as const;

/**
 * Prevenção de fraude (E40). O alerta avisa e quem decide é o atendente: nada é bloqueado nem cancelado sozinho, e nada
 * disto aparece para o cliente.
 */
@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly notices: OrderNoticeService,
  ) {}

  /**
   * Pedido novo, ao chegar pela integração: se ele tem motivo para alerta, a equipe fica sabendo na conversa aberta do
   * cliente ou, sem nenhuma (iFood e Cardápio Web não abrem conversa), numa só da equipe. Uma falha aqui não atrapalha o
   * pedido: o painel calcula o alerta de novo ao abrir a conversa ou o pedido.
   */
  async orderArrived(tenantId: string, orderId: string, now = new Date()): Promise<void> {
    try {
      const conversationId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: orderSelect });
        // O que aconteceu antes de conectar a loja não aciona nada (a integração ainda entrega as últimas horas).
        if (order.channel.connectedAt && order.placedAt < order.channel.connectedAt) return null;
        const alert = await orderAlert(tx, { ...order, alertDecidedBy: null }, order.contact, true);
        if (!alert) return null;
        await tx.order.update({ where: { id: orderId }, data: { alertAt: now } });
        const open = await conversationOfOrder(tx, order);
        const conversation = open ?? (await this.openForTeam(tx, order, now));
        const reasons = [
          alert.cancellations.canceledCount > 0 && plural(alert.cancellations.canceledCount, "cancelamento no histórico", "cancelamentos no histórico"),
          alert.addressMatches.length > 0 && "endereço marcado como fraude",
        ].filter(Boolean);
        await systemEvent(tx, conversation, { event: "fraud_alert", text: `Alerta de fraude exibido · ${reasons.join(" · ")}` });
        return conversation.id;
      });
      if (conversationId) this.realtime.inboxChanged(tenantId, conversationId);
    } catch (error) {
      this.logger.warn({ tenantId, orderId, err: error }, "Alerta de fraude não registrado");
      Sentry.captureException(error, { tags: { tenantId } });
    }
  }

  /** O cliente não está nesta conversa: ela existe para a equipe ver o alerta. Reaproveita a última do cliente nessa loja. */
  private async openForTeam(tx: TenantTx, order: { id: string; tenantId: string; contactId: string; channelId: string }, now: Date) {
    const where = { contactId: order.contactId, channelId: order.channelId };
    const select = { id: true, tenantId: true, channelId: true };
    const latest = await tx.conversation.findFirst({ where: { ...where, teamOnly: true }, orderBy: { createdAt: "desc" }, select: { id: true } });
    const conversation = latest
      ? await tx.conversation.update({ where: { id: latest.id }, data: { status: "OPEN", lastMessageAt: now, unreadCount: { increment: 1 } }, select })
      : await tx.conversation.create({
          data: { tenantId: order.tenantId, ...where, status: "OPEN", teamOnly: true, lastMessageAt: now, unreadCount: 1 },
          select,
        });
    await tx.order.update({ where: { id: order.id }, data: { conversationId: conversation.id } });
    await systemEvent(tx, conversation, { event: "order", orderId: order.id });
    return conversation;
  }

  /** "Manter pedido": o alerta vira uma linha discreta e a decisão fica registrada. */
  async keep(auth: RequestAuth, orderId: string, now = new Date()): Promise<void> {
    const changed = await this.db.withTenants(auth.scope, async (tx) => {
      const order = await this.requireOrder(tx, orderId);
      if (order.alertDecision) throw new UnprocessableEntityException("Já decidiram sobre este pedido. Atualize a tela.");
      if (!ACTIVE_ORDER.includes(order.status)) throw new UnprocessableEntityException("Este pedido já terminou.");
      await tx.order.update({ where: { id: orderId }, data: { alertDecision: "KEPT", alertDecidedAt: now, alertDecidedById: auth.userId } });
      const conversation = await conversationOfOrder(tx, order);
      if (conversation) {
        await systemEvent(tx, conversation, { event: "order_kept", text: `Pedido ${codeOf(order)} mantido por ${await nameOf(tx, auth.userId)}` });
      }
      return { tenantId: order.tenantId, conversationId: conversation?.id };
    });
    if (changed.conversationId) this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
  }

  /**
   * O atendente cancelou pelo Dish Desk. `confirmed`: a plataforma já cancelou (Cardápio Web), então o pedido muda agora
   * e o cliente recebe a mensagem. iFood: o pedido, a mensagem e a marca de fraude esperam o evento de cancelamento chegar
   * pelo polling. Até lá, só fica guardado quem pediu a marca (`fraudMarkedById` sem `fraudMarkedAt`).
   */
  async canceledByTeam(
    auth: RequestAuth,
    orderId: string,
    input: { reason: string | null; markFraud: boolean; confirmed: boolean },
    now = new Date(),
  ): Promise<void> {
    const changed = await this.db.withTenants(auth.scope, async (tx) => {
      const order = await this.requireOrder(tx, orderId);
      const user = await nameOf(tx, auth.userId);
      const marking = input.markFraud && !order.fraudMarkedAt;
      await tx.order.update({
        where: { id: orderId },
        data: {
          alertDecision: "CANCELED",
          alertDecidedAt: now,
          alertDecidedById: auth.userId,
          ...(input.reason && { cancellationReason: input.reason }),
          ...(input.confirmed && { status: "CANCELED", canceledAt: now }),
          ...(marking && (input.confirmed ? markData(order.deliveryAddress, auth.userId, now) : { fraudMarkedById: auth.userId })),
        },
      });
      if (input.confirmed) {
        await tx.orderEvent.createMany({
          data: {
            tenantId: order.tenantId,
            orderId,
            externalEventId: "CANCELLED",
            code: "CANCELLED",
            occurredAt: now,
            ...(input.reason && { metadata: { CANCEL_REASON: input.reason } }),
          },
          skipDuplicates: true,
        });
      }
      const conversation = await conversationOfOrder(tx, order);
      if (conversation) {
        const why = input.reason ? ` · motivo: ${input.reason}` : "";
        await systemEvent(tx, conversation, {
          event: "order_canceled_by_team",
          text: input.confirmed
            ? `Pedido ${codeOf(order)} cancelado por ${user}${why}`
            : `Cancelamento do pedido ${codeOf(order)} pedido por ${user}${why} · aguardando o iFood`,
        });
        if (marking && input.confirmed) {
          await systemEvent(tx, conversation, { event: "fraud_marked", text: `Pedido ${codeOf(order)} marcado como fraude por ${user}` });
        }
      }
      return { tenantId: order.tenantId, conversationId: conversation?.id };
    });
    if (changed.conversationId) this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
    if (input.confirmed) await this.notices.canceled(changed.tenantId, orderId);
  }

  /** "Marcar como fraude" num pedido já cancelado (fora do Dish Desk, por exemplo). */
  async mark(auth: RequestAuth, orderId: string, now = new Date()): Promise<void> {
    const changed = await this.db.withTenants(auth.scope, async (tx) => {
      const order = await this.requireOrder(tx, orderId);
      if (order.fraudMarkedAt) return null; // dois atendentes marcando ao mesmo tempo: a primeira marca fica
      if (order.status !== "CANCELED") throw new UnprocessableEntityException("Só um pedido cancelado pode ser marcado como fraude.");
      await tx.order.update({ where: { id: orderId }, data: markData(order.deliveryAddress, auth.userId, now) });
      const conversation = await conversationOfOrder(tx, order);
      if (conversation) {
        await systemEvent(tx, conversation, { event: "fraud_marked", text: `Pedido ${codeOf(order)} marcado como fraude por ${await nameOf(tx, auth.userId)}` });
      }
      return { tenantId: order.tenantId, conversationId: conversation?.id };
    });
    if (changed?.conversationId) this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
  }

  /** "Remover marca": o pedido deixa de aparecer no alerta dos próximos pedidos para o endereço. */
  async unmark(auth: RequestAuth, orderId: string): Promise<void> {
    const changed = await this.db.withTenants(auth.scope, async (tx) => {
      const order = await this.requireOrder(tx, orderId);
      if (!order.fraudMarkedAt) return null;
      await tx.order.update({ where: { id: orderId }, data: { fraudMarkedAt: null, fraudMarkedById: null, fraudAddressKey: null } });
      const conversation = await conversationOfOrder(tx, order);
      if (conversation) {
        await systemEvent(tx, conversation, { event: "fraud_unmarked", text: `Marca de fraude do pedido ${codeOf(order)} removida por ${await nameOf(tx, auth.userId)}` });
      }
      return { tenantId: order.tenantId, conversationId: conversation?.id };
    });
    if (changed?.conversationId) this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
  }

  private async requireOrder(tx: TenantTx, orderId: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: orderSelect });
    if (!order) throw new NotFoundException("Pedido não encontrado.");
    return order;
  }
}

/** O iFood confirmou o cancelamento pedido pela equipe: a marca de fraude pedida junto passa a valer. */
export async function applyPendingMark(
  tx: TenantTx,
  order: { id: string; conversationId: string | null; displayCode: string | null; externalOrderId: string; deliveryAddress: unknown; fraudMarkedAt: Date | null; fraudMarkedById: string | null; contact: Parameters<typeof linkedContactsWhere>[0] },
  now: Date,
): Promise<void> {
  if (order.fraudMarkedAt || !order.fraudMarkedById) return;
  await tx.order.update({ where: { id: order.id }, data: markData(order.deliveryAddress, order.fraudMarkedById, now) });
  const conversation = await conversationOfOrder(tx, order);
  if (conversation) {
    await systemEvent(tx, conversation, { event: "fraud_marked", text: `Pedido ${codeOf(order)} marcado como fraude por ${await nameOf(tx, order.fraudMarkedById)}` });
  }
}

/** O iFood recusou o cancelamento: o pedido continua ativo, a decisão volta para a equipe e a marca pedida junto não vale. */
export async function cancelRefused(tx: TenantTx, order: { id: string; conversationId: string | null; displayCode: string | null; externalOrderId: string; contact: Parameters<typeof linkedContactsWhere>[0] }): Promise<string | null> {
  await tx.order.update({ where: { id: order.id }, data: { alertDecision: null, alertDecidedAt: null, alertDecidedById: null, cancellationReason: null, fraudMarkedById: null } });
  const conversation = await conversationOfOrder(tx, order);
  if (!conversation) return null;
  await systemEvent(tx, conversation, { event: "order_cancel_refused", text: `O iFood recusou o cancelamento do pedido ${codeOf(order)}. Ele continua ativo.` });
  return conversation.id;
}

function markData(deliveryAddress: unknown, userId: string, now: Date) {
  return { fraudMarkedAt: now, fraudMarkedById: userId, fraudAddressKey: addressKey(deliveryAddress) };
}

function codeOf(order: { displayCode: string | null; externalOrderId: string }): string {
  return `#${order.displayCode ?? order.externalOrderId}`;
}

async function nameOf(tx: TenantTx, userId: string): Promise<string> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name.split(" ")[0] ?? "a equipe";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
