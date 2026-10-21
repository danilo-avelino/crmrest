import type { TenantTx } from "@dishdesk/database";
import { type AutomationMessages, automationMessagesOf } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { dispatchNoticeMessage, readyNoticeMessage } from "../orders/forecast.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { automationMessage, dispatch, type InboundEvent, setAutomationState, systemEvent, tenantSettings } from "./automation.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";

/**
 * Cliente que escreve no chat do iFood: sem menu, porque é sempre um problema com o pedido. Cada atendimento novo chama
 * a equipe na hora (com o alarme), avisa o cliente e pede o telefone de quem não tem no cadastro: a conversa do iFood
 * se encerra sozinha e depois não há como falar com ele. Se o pedido já ficou pronto ou saiu, manda também esse aviso.
 */
@Injectable()
export class IfoodAttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
  ) {}

  /** Roda depois de cada mensagem do cliente copiada do widget; `orderId` é o pedido da conversa. */
  async afterInbound(event: InboundEvent, orderId: string): Promise<void> {
    if (await this.survey.handleAnswer(event)) return;
    // Atendimento em andamento: só falta anotar o telefone, se o cliente o mandar.
    if (!event.newAttendance) return this.phoneCollection.afterInbound(event);

    const { tenantId } = event.channel;
    const messageIds = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: event.conversationId },
        select: { id: true, tenantId: true, channelId: true, awaitingAgentSince: true, contact: { select: { phone: true } } },
      });
      const messages = automationMessagesOf(await tenantSettings(tx, tenantId));
      const askPhone = !conversation.contact.phone;
      const text = askPhone ? `${messages.ifoodHandoff} ${messages.ifoodPhoneRequest}` : messages.ifoodHandoff;
      const ids = [await automationMessage(tx, conversation, "handoff", text)];
      await systemEvent(tx, conversation, { event: "handoff", text: "Cliente chamando pelo chat do iFood" });
      const missed = await missedNotice(tx, conversation.id, orderId, messages);
      if (missed) ids.push(await automationMessage(tx, conversation, missed.automation, missed.text));
      // O pedido da conversa vale para a pesquisa de satisfação, no fim do atendimento.
      await setAutomationState(tx, conversation.id, {
        triage: "done",
        linkedOrder: { id: orderId, at: new Date().toISOString() },
        ...(askPhone && { phoneCollection: "awaiting_phone" }),
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { awaitingAgentSince: conversation.awaitingAgentSince ?? new Date(), awaitingAgentQuiet: false },
      });
      return ids;
    });
    await dispatch(this.outbound, this.realtime, tenantId, event.conversationId, messageIds);
  }
}

/**
 * O pedido ficou pronto ou saiu antes de o chat existir: os avisos do OrderNoticeService não tinham para onde ir. O do
 * passo atual vai logo depois do chamado, se ainda não foi. Entregue fica de fora: quem escreve depois da entrega
 * costuma ter um problema com o pedido, e "Bom apetite" não é a resposta.
 */
async function missedNotice(
  tx: TenantTx,
  conversationId: string,
  orderId: string,
  messages: AutomationMessages,
): Promise<{ automation: "order_ready" | "order_dispatched"; text: string } | null> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, displayCode: true, externalOrderId: true, dispatchedAt: true, placedAt: true, channel: { select: { connectedAt: true } } },
  });
  // Como no OrderNoticeService: pedido de antes de a loja ser conectada não recebe aviso.
  if (order.channel.connectedAt && order.placedAt < order.channel.connectedAt) return null;
  const code = order.displayCode ?? order.externalOrderId;
  const missed =
    order.status === "READY"
      ? { automation: "order_ready" as const, text: readyNoticeMessage(code, messages) }
      : order.status === "DISPATCHED" && order.dispatchedAt
        ? { automation: "order_dispatched" as const, text: dispatchNoticeMessage(code, order.dispatchedAt, messages) }
        : null;
  if (!missed) return null;
  const sent = await tx.message.count({
    where: { conversationId, createdAt: { gte: order.placedAt }, content: { path: ["automation"], equals: missed.automation } },
  });
  return sent ? null : missed;
}
