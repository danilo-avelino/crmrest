import type { OrderStatus } from "@dishdesk/database/enums";
import { automationMessagesOf, CHANNEL_CAPABILITIES } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { automationMessage, dispatch, tenantSettings } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { deliveredNoticeMessage, dispatchNoticeMessage } from "./forecast.js";

/** Status que geram aviso ao cliente. */
export type NoticeStatus = Extract<OrderStatus, "DISPATCHED" | "DELIVERED">;

/** Avisos ao cliente sobre o andamento do pedido, na conversa em andamento do cadastro dele (WhatsApp, Instagram). */
@Injectable()
export class OrderNoticeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
  ) {}

  /**
   * O pedido acabou de sair para entrega ou de ser entregue: avisa na conversa aberta ou pendente mais recente do
   * cliente, achada pelo cadastro como no painel do pedido (o próprio, ou outro com o mesmo telefone, CPF ou e-mail).
   * Sem conversa em andamento, ou com a janela de 24h fechada, não avisa.
   */
  async statusChanged(tenantId: string, orderId: string, status: NoticeStatus, now = new Date()): Promise<void> {
    const sent = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { displayCode: true, externalOrderId: true, dispatchedAt: true, contact: true },
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
        select: { id: true, tenantId: true, channelId: true, windowExpiresAt: true, channel: { select: { type: true } } },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      });
      const conversation = conversations.find((c) => {
        const capabilities = CHANNEL_CAPABILITIES[c.channel.type];
        return capabilities.send && (!capabilities.window24h || (c.windowExpiresAt && c.windowExpiresAt > now));
      });
      if (!conversation) return null;
      const code = order.displayCode ?? order.externalOrderId;
      const messages = automationMessagesOf(await tenantSettings(tx, tenantId));
      const messageId =
        status === "DISPATCHED"
          ? await automationMessage(tx, conversation, "order_dispatched", dispatchNoticeMessage(code, order.dispatchedAt ?? now, messages))
          : await automationMessage(tx, conversation, "order_delivered", deliveredNoticeMessage(code, messages));
      return { conversationId: conversation.id, messageId };
    });
    if (sent) await dispatch(this.outbound, this.realtime, tenantId, sent.conversationId, [sent.messageId]);
  }
}
