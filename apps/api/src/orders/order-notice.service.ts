import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import type { AutomationMessages } from "@dishdesk/shared";
import { automationMessagesOf, CHANNEL_CAPABILITIES, CHANNEL_LABEL, fillMessage, PERSONALITY_INFO, personalityOf } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { automationMessage, dispatch, firstName, isPaused, tenantSettings } from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import type { TenantTx } from "@dishdesk/database";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { provenPhone, provenPhoneWhere } from "./customer-history.js";
import { deliveredNoticeMessage, dispatchNoticeMessage, readyNoticeMessage } from "./forecast.js";

/** Status que geram aviso ao cliente. */
export type NoticeStatus = Extract<OrderStatus, "READY" | "DISPATCHED" | "DELIVERED">;

/** Conversa já encerrada ainda recebe os avisos se o cliente escreveu nela neste prazo. */
const RECENT_CONTACT_MS = 24 * 60 * 60 * 1000;

/**
 * Avisos ao cliente sobre o andamento do pedido, na conversa do cadastro dele (WhatsApp, Instagram) e, se ele
 * escreveu no chat do iFood do pedido, também lá.
 */
@Injectable()
export class OrderNoticeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * O pedido acabou de ficar pronto, de sair para entrega ou de ser entregue: avisa na conversa mais recente do cliente,
   * achada pelo cadastro como no painel do pedido (o próprio, ou outro com o mesmo telefone, CPF ou e-mail), aberta,
   * pendente ou encerrada com mensagem do cliente nas últimas 24h. O aviso não reabre a conversa encerrada. Sem
   * conversa assim, com a janela de 24h do canal fechada, ou com o pedido feito antes de a loja ser conectada, não
   * avisa. Pedido do iFood em que o cliente escreveu no chat (conversa ainda em andamento): o aviso vai também para o
   * chat dele.
   */
  async statusChanged(tenantId: string, orderId: string, status: NoticeStatus, now = new Date()): Promise<void> {
    const sent = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      if (await isPaused(tx, tenantId)) return [];
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          displayCode: true,
          externalOrderId: true,
          dispatchedAt: true,
          placedAt: true,
          channelId: true,
          channel: { select: { type: true, connectedAt: true } },
          contact: true,
        },
      });
      // Pedido feito antes de a loja ser conectada (o iFood ainda entrega as últimas horas ao conectar): sem aviso.
      if (order.channel.connectedAt && order.placedAt < order.channel.connectedAt) return [];
      const targets = await this.targetsOf(tx, order, now);
      if (!targets.length) return [];
      const code = order.displayCode ?? order.externalOrderId;
      const messages = automationMessagesOf(await tenantSettings(tx, tenantId));
      const notices = [];
      for (const target of targets) {
        const messageId =
          status === "READY"
            ? await automationMessage(tx, target, "order_ready", readyNoticeMessage(code, messages))
            : status === "DISPATCHED"
              ? await automationMessage(tx, target, "order_dispatched", dispatchNoticeMessage(code, order.dispatchedAt ?? now, messages))
              : await automationMessage(tx, target, "order_delivered", deliveredNoticeMessage(code, messages));
        notices.push({ conversationId: target.id, messageId });
      }
      return notices;
    });
    for (const notice of sent) await dispatch(this.outbound, this.realtime, tenantId, notice.conversationId, [notice.messageId]);
  }

  /** A equipe cancelou o pedido pelo Dish Desk: a mensagem, no tom do restaurante, vai pelas mesmas conversas dos avisos. */
  async canceled(tenantId: string, orderId: string, now = new Date()): Promise<void> {
    const sent = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      if (await isPaused(tx, tenantId)) return [];
      const order = await this.noticeOrder(tx, orderId);
      const targets = await this.targetsOf(tx, order, now);
      const text = canceledText(order, automationMessagesOf(await tenantSettings(tx, tenantId)));
      const notices = [];
      for (const target of targets) notices.push({ conversationId: target.id, messageId: await automationMessage(tx, target, "order_canceled", text) });
      return notices;
    });
    for (const notice of sent) await dispatch(this.outbound, this.realtime, tenantId, notice.conversationId, [notice.messageId]);
  }

  /** Prévia para o modal de cancelamento; null: sem conversa com o cliente, a mensagem não sai. */
  async canceledPreview(tenantId: string, orderId: string, now = new Date()): Promise<{ text: string; via: string; tone: string } | null> {
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      if (await isPaused(tx, tenantId)) return null; // pausado: a mensagem não sai
      const order = await this.noticeOrder(tx, orderId);
      const [target] = await this.targetsOf(tx, order, now);
      if (!target) return null;
      const settings = await tenantSettings(tx, tenantId);
      const channel = CHANNEL_LABEL[target.channel.type];
      return {
        text: canceledText(order, automationMessagesOf(settings)),
        via: target.channel.type === "IFOOD" ? `chat do ${channel}` : channel,
        tone: PERSONALITY_INFO[personalityOf(settings)].label,
      };
    });
  }

  private noticeOrder(tx: TenantTx, orderId: string) {
    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { displayCode: true, externalOrderId: true, channelId: true, channel: { select: { type: true } }, contact: true },
    });
  }

  /** Conversas que recebem os avisos do pedido. A conversa só da equipe nunca recebe: o cliente não está nela. */
  private async targetsOf(
    tx: TenantTx,
    order: { channelId: string; channel: { type: ChannelType }; contact: { id: string; phone: string | null; phoneSource: string | null; cpfHash: string | null; email: string | null } },
    now: Date,
  ) {
    const { id, cpfHash, email } = order.contact;
    // O telefone digitado pelo cliente numa conversa não identifica: os avisos não vão para quem só digitou o número.
    const phone = provenPhone(order.contact);
    const conversations = await tx.conversation.findMany({
      where: {
        teamOnly: false,
        OR: [
          { status: { not: "RESOLVED" } },
          { messages: { some: { direction: "INBOUND", createdAt: { gt: new Date(now.getTime() - RECENT_CONTACT_MS) } } } },
        ],
        contact: {
          OR: [
            { id },
            ...(phone ? [provenPhoneWhere(phone)] : []),
            ...(cpfHash ? [{ cpfHash }] : []),
            ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
          ],
        },
      },
      select: {
        id: true,
        tenantId: true,
        channelId: true,
        status: true,
        windowExpiresAt: true,
        channel: { select: { type: true } },
        _count: { select: { messages: { where: { direction: "INBOUND" } } } },
      },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    });
    const conversation = conversations.find((c) => {
      const capabilities = CHANNEL_CAPABILITIES[c.channel.type];
      return capabilities.send && (!capabilities.window24h || (c.windowExpiresAt && c.windowExpiresAt > now));
    });
    // O chat do iFood é por pedido: só o da loja do pedido, e só com a trava do chat ligada (quem envia é o painel).
    const ifoodChat =
      this.env.IFOOD_CHAT_BRIDGE && order.channel.type === "IFOOD"
        ? conversations.find((c) => c.channelId === order.channelId && c.status !== "RESOLVED" && c._count.messages > 0)
        : undefined;
    return [conversation, ifoodChat].filter((target) => target !== undefined);
  }
}

function canceledText(order: { displayCode: string | null; externalOrderId: string; contact: { name: string | null } }, messages: AutomationMessages): string {
  const name = firstName(order.contact.name);
  // Sem nome conhecido, "{nome}" sai junto com a vírgula: "Olá, {nome}!" vira "Olá!" (como a saudação do menu).
  const template = name ? messages.orderCanceled : messages.orderCanceled.replace(/,?[ \t]*\{nome\}/g, "");
  return fillMessage(template, { pedido: order.displayCode ?? order.externalOrderId, ...(name ? { nome: name } : {}) });
}
