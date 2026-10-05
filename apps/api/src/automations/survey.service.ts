import type { TenantTx } from "@comanda/database";
import { CHANNEL_CAPABILITIES } from "@comanda/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  type AutomationState,
  automationMessage,
  dispatch,
  type InboundEvent,
  localDate,
  setAutomationState,
  systemEvent,
} from "./automation.js";

const TEXTS = {
  question: "Qual nota você dá para nosso atendimento? Digite de 1 a 5",
  thanks: "Obrigado pela avaliação! 😊",
};

/** Pesquisa de satisfação: no fim de um atendimento sobre um pedido do dia, pede uma nota de 1 a 5. */
@Injectable()
export class SurveyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
  ) {}

  /** Roda quando a conversa é resolvida: só pergunta se o atendimento teve um pedido associado hoje. */
  async request(tenantId: string, conversationId: string, now = new Date()): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as AutomationState;
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      if (conversation.status !== "RESOLVED" || state.survey || !state.linkedOrder) return null;
      if (localDate(new Date(state.linkedOrder.at)) !== localDate(now)) return null;
      if (!capabilities.send || (capabilities.window24h && !(conversation.windowExpiresAt && conversation.windowExpiresAt > now))) {
        return null;
      }
      const id = await automationMessage(tx, conversation, "survey", TEXTS.question);
      await setAutomationState(tx, conversationId, { ...state, survey: "awaiting_rating" });
      return id;
    });
    if (messageId) await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
  }

  /** Resposta à pesquisa: grava a nota e agradece. Devolve true se a mensagem era a nota (e não um novo atendimento). */
  async handleAnswer(event: InboundEvent): Promise<boolean> {
    const score = /^\s*([1-5])\s*$/.exec(event.text ?? "")?.[1];
    const { tenantId } = event.channel;
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, event.conversationId);
      const state = conversation.automationState as AutomationState;
      if (state.survey !== "awaiting_rating") return null;
      if (!score) {
        await setAutomationState(tx, conversation.id, { ...state, survey: "skipped" });
        return null;
      }
      await tx.rating.create({
        data: { tenantId, conversationId: conversation.id, orderId: state.linkedOrder?.id ?? null, score: Number(score) },
      });
      await systemEvent(tx, conversation, { event: "rating", text: `Avaliação do atendimento: ${score}/5` });
      const id = await automationMessage(tx, conversation, "survey_thanks", TEXTS.thanks);
      await setAutomationState(tx, conversation.id, { ...state, survey: "answered" });
      // A nota não abre um atendimento novo: a conversa continua resolvida.
      if (event.previousStatus === "RESOLVED") {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: "RESOLVED", unreadCount: Math.max(0, conversation.unreadCount - 1) },
        });
      }
      return id;
    });
    if (!messageId) return false;
    await dispatch(this.outbound, this.realtime, tenantId, event.conversationId, [messageId]);
    return true;
  }

  private load(tx: TenantTx, conversationId: string) {
    return tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        id: true,
        tenantId: true,
        channelId: true,
        status: true,
        unreadCount: true,
        windowExpiresAt: true,
        automationState: true,
        channel: { select: { type: true } },
      },
    });
  }
}
