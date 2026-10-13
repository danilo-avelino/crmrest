import { automationMessagesOf } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { automationMessage, dispatch, type InboundEvent, setAutomationState, systemEvent, tenantSettings } from "./automation.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";

/**
 * Cliente que escreve no chat do iFood: sem menu, porque é sempre um problema com o pedido. Cada atendimento novo chama
 * a equipe na hora (com o alarme), avisa o cliente e pede o telefone de quem não tem no cadastro: a conversa do iFood
 * se encerra sozinha e depois não há como falar com ele.
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
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: event.conversationId },
        select: { id: true, tenantId: true, channelId: true, awaitingAgentSince: true, contact: { select: { phone: true } } },
      });
      const messages = automationMessagesOf(await tenantSettings(tx, tenantId));
      const askPhone = !conversation.contact.phone;
      const text = askPhone ? `${messages.ifoodHandoff} ${messages.ifoodPhoneRequest}` : messages.ifoodHandoff;
      const id = await automationMessage(tx, conversation, "handoff", text);
      await systemEvent(tx, conversation, { event: "handoff", text: "Cliente chamando pelo chat do iFood" });
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
      return id;
    });
    await dispatch(this.outbound, this.realtime, tenantId, event.conversationId, [messageId]);
  }
}
