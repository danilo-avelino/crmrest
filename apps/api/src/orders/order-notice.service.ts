import type { OrderStatus } from "@dishdesk/database/enums";
import { automationMessagesOf, CHANNEL_CAPABILITIES } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { automationMessage, dispatch, tenantSettings } from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { deliveredNoticeMessage, dispatchNoticeMessage, readyNoticeMessage } from "./forecast.js";

/** Status que geram aviso ao cliente. READY (ficou pronto) só vai para o chat do iFood do pedido. */
export type NoticeStatus = Extract<OrderStatus, "READY" | "DISPATCHED" | "DELIVERED">;

/**
 * Avisos ao cliente sobre o andamento do pedido, na conversa em andamento do cadastro dele (WhatsApp, Instagram) e,
 * se ele escreveu no chat do iFood do pedido, também lá.
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
   * O pedido acabou de sair para entrega ou de ser entregue: avisa na conversa aberta ou pendente mais recente do
   * cliente, achada pelo cadastro como no painel do pedido (o próprio, ou outro com o mesmo telefone, CPF ou e-mail).
   * Sem conversa em andamento, ou com a janela de 24h fechada, não avisa. Pedido do iFood em que o cliente escreveu
   * no chat (conversa ainda em andamento): toda movimentação, inclusive "ficou pronto", vai também para o chat dele.
   */
  async statusChanged(tenantId: string, orderId: string, status: NoticeStatus, now = new Date()): Promise<void> {
    const sent = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { displayCode: true, externalOrderId: true, dispatchedAt: true, channelId: true, channel: { select: { type: true } }, contact: true },
      });
      const { id, phone, cpfHash, email } = order.contact;
      const conversations = await tx.conversation.findMany({
        where: {
          status: { not: "RESOLVED" },
          contact: {
            OR: [
              { id },
              ...(phone ? [{ phone }] : []),
              ...(cpfHash ? [{ cpfHash }] : []),
              ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
            ],
          },
        },
        select: {
          id: true,
          tenantId: true,
          channelId: true,
          windowExpiresAt: true,
          channel: { select: { type: true } },
          _count: { select: { messages: { where: { direction: "INBOUND" } } } },
        },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      });
      const conversation = conversations.find((c) => {
        const capabilities = CHANNEL_CAPABILITIES[c.channel.type];
        return status !== "READY" && capabilities.send && (!capabilities.window24h || (c.windowExpiresAt && c.windowExpiresAt > now));
      });
      // O chat do iFood é por pedido: só o da loja do pedido, e só com a trava do chat ligada (quem envia é o painel).
      const ifoodChat =
        this.env.IFOOD_CHAT_BRIDGE && order.channel.type === "IFOOD"
          ? conversations.find((c) => c.channelId === order.channelId && c._count.messages > 0)
          : undefined;
      const targets = [conversation, ifoodChat].filter((target) => target !== undefined);
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
}
