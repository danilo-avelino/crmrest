import type { TenantTx } from "@dishdesk/database";
import { type AutomationMessages, automationMessagesOf } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { LlmClient } from "../ai/llm.client.js";
import { DatabaseService } from "../core/database.service.js";
import { dispatchNoticeMessage, readyNoticeMessage } from "../orders/forecast.js";
import { type AiJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  type AutomationState,
  automationMessage,
  dispatch,
  type InboundEvent,
  leaveToTeam,
  setAutomationState,
  systemEvent,
  tenantSettings,
} from "./automation.js";
import { extractPhone, PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";
import { AI_REPLY_DELAY_MS } from "./triage.service.js";

/**
 * Cliente que escreve no chat do iFood: sem menu, porque é sempre um problema com o pedido. Com o módulo Atendimento com
 * IA, a IA atende (já sabendo o pedido da conversa) e só chama a equipe quando precisar. Sem ele, cada atendimento novo
 * chama a equipe na hora (com o alarme), avisa o cliente e pede o telefone de quem não tem no cadastro: a conversa do
 * iFood se encerra sozinha e depois não há como falar com ele. Se o pedido já ficou pronto ou saiu, manda também esse aviso.
 */
@Injectable()
export class IfoodAttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.ai) private readonly ai: Queue<AiJob>,
    private readonly llm: LlmClient,
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
  ) {}

  /** Roda depois de cada mensagem do cliente copiada do widget; `orderId` é o pedido da conversa. */
  async afterInbound(event: InboundEvent, orderId: string): Promise<void> {
    // A pesquisa não sai mais no iFood; esta é a nota de quem já tinha sido perguntado.
    if (await this.survey.handleAnswer(event)) return;
    if (await this.aiTakes(event, orderId)) return;
    // Sem a IA, quem atende o cliente é a equipe: a conversa vai para a aba Ativos.
    await leaveToTeam(this.db, event.channel.tenantId, event.conversationId);
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
      // O pedido da conversa vale para a sugestão de resposta da IA.
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

  /**
   * Atendimento com IA (módulo AI): a IA responde no lugar do chamado automático, do começo do atendimento até passar
   * para a equipe (o alarme só toca quando ela passa). O pedido da conversa já vale como confirmado, e o aviso de pronto
   * ou saiu fica com a IA, que lê o andamento real. O telefone que o cliente mandar é cadastrado.
   */
  private async aiTakes(event: InboundEvent, orderId: string): Promise<boolean> {
    const { tenantId } = event.channel;
    const takes = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      if (!(await this.llm.activeFor(tx, tenantId))) return false;
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: event.conversationId },
        select: { id: true, tenantId: true, channelId: true, automationState: true, contact: { select: { id: true, phone: true } } },
      });
      const state = conversation.automationState as AutomationState;
      if (!event.newAttendance && state.ai !== "on") return false;
      if (event.newAttendance) {
        await setAutomationState(tx, event.conversationId, {
          ai: "on",
          triage: "done",
          linkedOrder: { id: orderId, at: new Date().toISOString() },
          ...(state.aiWaiting && { aiWaiting: true, aiWaitingReason: state.aiWaitingReason }),
        });
      }
      const phone = !conversation.contact.phone && event.text ? extractPhone(event.text) : null;
      if (phone) await this.phoneCollection.register(tx, conversation, phone);
      return true;
    });
    if (!takes) return false;
    await this.ai.add("reply", { tenantId, conversationId: event.conversationId }, { delay: AI_REPLY_DELAY_MS });
    return true;
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
