import type { Prisma, TenantTx } from "@dishdesk/database";
import { CHANNEL_LABEL, type OrderAlertDto } from "@dishdesk/shared";
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { systemEvent } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { JevClient, type JevQuestion } from "../defense/jev.client.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { addressKey, addressText } from "./address-key.js";
import { ACTIVE_ORDER, assessOrder, conversationOfOrder, linkedContactsWhere, orderAlert, similarAddressCandidates, type StoredAnalysis } from "./fraud-alert.js";
import { platformInfo } from "./ifood-order.js";
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

/** Pedido que acabou de chegar: com o que as regras e o Jev precisam (valor, pagamento, análise guardada). */
const arrivedSelect = { ...orderSelect, total: true, raw: true, alertAnalysis: true, channel: { select: { connectedAt: true, type: true } } } satisfies Prisma.OrderSelect;
type ArrivedOrder = Prisma.OrderGetPayload<{ select: typeof arrivedSelect }>;

/** Chance a partir da qual o Jev dá dois endereços como o mesmo local. */
const SAME_ADDRESS_FROM = 0.8;

const VERDICT_LABEL = { high: "alto", uncertain: "incerto", low: "baixo" } as const;
const CANCELED_BY_LABEL = { customer: "o cliente", store: "a loja", platform: "a plataforma", team: "a equipe da loja, por suspeita" } as const;

const CASE_GUIDE =
  "Pedido que acabou de chegar a um restaurante por um aplicativo de entrega, com o histórico de cancelamentos do cliente. " +
  "A fraude comum: o cliente recebe a comida e pede o cancelamento ou o reembolso à plataforma, que costuma aceitar, e o restaurante fica sem receber. " +
  "Por isso o pagamento online não reduz o risco. Cancelamento feito pela loja antes de o pedido sair (falta de item, loja fechada) não é sinal contra o cliente. " +
  "Poucos cancelamentos em muitos pedidos são normais; muitos em poucos pedidos, não.";

const RISK_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "Há risco relevante de este pedido ser fraude, a ponto de a equipe do restaurante precisar conferir o caso antes de preparar?",
};

/** O caso como o Jev lê: o pedido, o histórico do cliente e, se houver, os endereços parecidos a comparar. */
function caseState(order: ArrivedOrder, alert: OrderAlertDto | null, similar: { address: string }[], now: Date): Record<string, unknown> {
  const payments = order.channel.type === "IFOOD" ? (platformInfo(order.raw)?.payments ?? []) : [];
  const prepaid = payments.filter((payment) => payment.prepaid).length;
  const history = alert?.cancellations;
  return {
    como_ler: CASE_GUIDE,
    pedido: {
      origem: CHANNEL_LABEL[order.channel.type],
      valor: order.total.toFixed(2),
      pagamento: !payments.length ? "não informado" : prepaid === payments.length ? "online, já pago" : prepaid ? "parte online, parte na entrega" : "na entrega",
      tipo: order.deliveryAddress ? "entrega" : "retirada",
    },
    ...(history && {
      historico_do_cliente: {
        pedidos_feitos_com_este: history.ordersCount,
        cancelados: history.canceledCount,
        cancelados_sem_ser_pela_loja: history.riskCount,
        marcados_como_fraude_pela_equipe: history.fraudCount,
        cancelamentos_recentes: history.rows.slice(0, 10).map((row) => ({
          ha_dias: Math.max(0, Math.round((now.getTime() - new Date(row.placedAt).getTime()) / 86_400_000)),
          valor: row.total,
          origem: CHANNEL_LABEL[row.channelType],
          motivo: row.reason ?? "não informado",
          cancelado_por: row.canceledBy ? CANCELED_BY_LABEL[row.canceledBy] : "não informado",
          quando: row.afterDispatch ? "depois de sair para a entrega" : "antes de sair para a entrega",
          marcado_como_fraude: row.fraud !== null,
        })),
      },
    }),
    ...(similar.length > 0 && {
      endereco_do_pedido: addressText(order.deliveryAddress),
      enderecos_marcados_como_fraude: Object.fromEntries(similar.map((match, index) => [`endereco_${index + 1}`, match.address])),
    }),
  };
}

/**
 * Prevenção de fraude (E40). O alerta avisa e quem decide é o atendente: nada é bloqueado nem cancelado sozinho, e nada
 * disto aparece para o cliente. As regras apontam o pedido (fraud-alert.ts); o Jev, pago por chamada, só analisa o que
 * elas apontaram e nunca é chamado para um pedido sem sinal.
 */
@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly notices: OrderNoticeService,
    private readonly jev: JevClient,
  ) {}

  /**
   * Pedido novo, ao chegar pela integração: se ele tem motivo para alerta, a equipe fica sabendo na conversa aberta do
   * cliente ou, sem nenhuma (iFood e Cardápio Web não abrem conversa), numa só da equipe. Uma falha aqui não atrapalha o
   * pedido: o painel calcula o alerta de novo ao abrir a conversa ou o pedido.
   */
  async orderArrived(tenantId: string, orderId: string, now = new Date()): Promise<void> {
    try {
      const scope = { tenantIds: [tenantId] };
      // 1. As regras, sem IA: a maioria dos pedidos para aqui.
      const found = await this.db.withTenants(scope, async (tx) => {
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: arrivedSelect });
        // O que aconteceu antes de conectar a loja não aciona nada (a integração ainda entrega as últimas horas).
        if (order.channel.connectedAt && order.placedAt < order.channel.connectedAt) return null;
        const assessed = await assessOrder(tx, { ...order, alertDecidedBy: null }, order.contact, true);
        return { order, assessed, similar: await similarAddressCandidates(tx, order) };
      });
      if (!found) return;
      const { order, assessed, similar } = found;
      // 2. O Jev, só no que as regras apontaram: alerta sem pedido marcado como fraude, ou endereço parecido com um marcado.
      const doubt = assessed?.alert.level === "HIGH" && !assessed.hard;
      const analysis = doubt || similar.length ? await this.analyze(tenantId, order, assessed?.alert ?? null, doubt, similar, now) : null;
      if (!analysis && assessed?.alert.level !== "HIGH") return;
      // 3. O que sobrou como alerta chega à equipe.
      const conversationId = await this.db.withTenants(scope, async (tx) => {
        if (analysis) await tx.order.update({ where: { id: orderId }, data: { alertAnalysis: analysis } });
        const alert = analysis ? await orderAlert(tx, { ...order, alertAnalysis: analysis, alertDecidedBy: null }, order.contact, true) : assessed?.alert;
        if (alert?.level !== "HIGH") return null;
        await tx.order.update({ where: { id: orderId }, data: { alertAt: now } });
        const open = await conversationOfOrder(tx, order);
        const conversation = open ?? (await this.openForTeam(tx, order, now));
        const { riskCount, ordersCount } = alert.cancellations;
        const reasons = [
          riskCount > 0 && `${riskCount} de ${ordersCount} pedidos cancelados`,
          alert.addressMatches.some((match) => !match.similar) && "endereço marcado como fraude",
          alert.addressMatches.some((match) => match.similar) && "endereço parecido com um marcado como fraude",
          alert.analysis && `IA: risco ${VERDICT_LABEL[alert.analysis.verdict]}`,
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

  /**
   * Pergunta ao Jev sobre o caso que as regras apontaram: a chance de fraude (`askRisk`) e se cada endereço parecido é o
   * mesmo local de entrega. Uma chamada por pedido, no máximo. Sem a chave ou com o Jev fora do ar, devolve null e vale
   * o que as regras disseram. Não vai nome, telefone nem documento; o endereço só vai quando há um parecido a comparar.
   */
  private async analyze(
    tenantId: string,
    order: ArrivedOrder,
    alert: OrderAlertDto | null,
    askRisk: boolean,
    similar: { id: string; address: string }[],
    now: Date,
  ): Promise<StoredAnalysis | null> {
    if (!this.jev.enabled) return null;
    const questions: Record<string, JevQuestion> = {};
    if (askRisk) questions.risk = RISK_QUESTION;
    similar.forEach((_, index) => {
      questions[`endereco_${index + 1}`] = {
        type: "noul",
        instructions: `O "endereco_do_pedido" e o "endereco_${index + 1}" são o mesmo local de entrega (a mesma casa ou o mesmo apartamento)? Apartamentos, blocos ou casas diferentes do mesmo prédio ou condomínio são locais diferentes.`,
      };
    });
    try {
      const { answers, model } = await this.jev.decide(tenantId, caseState(order, alert, similar, now), questions, { privateData: true });
      const chance = (key: string) => (answers[key]?.type === "noul" ? answers[key].noul : null);
      return {
        risk: askRisk ? chance("risk") : null,
        similar: similar.filter((_, index) => (chance(`endereco_${index + 1}`) ?? 0) >= SAME_ADDRESS_FROM).map((match) => match.id),
        model,
        at: now.toISOString(),
      };
    } catch (error) {
      this.logger.warn({ tenantId, orderId: order.id, err: error }, "Jev não analisou o alerta de fraude");
      return null;
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
