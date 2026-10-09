import type { TenantTx } from "@dishdesk/database";
import { automationTextsOf, CHANNEL_CAPABILITIES, toE164 } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { type AutomationJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  type AutomationState,
  automationMessage,
  dispatch,
  type InboundEvent,
  setAutomationState,
  systemEvent,
  tenantSettings,
} from "./automation.js";

/** Espera até o lembrete e, depois dele, até desistir. */
export const PHONE_REMINDER_DELAY_MS = 10 * 60_000;

/** Pede o telefone a quem chega sem ele (Instagram e afins) e cadastra o número informado: é o que qualifica o contato. */
@Injectable()
export class PhoneCollectionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
  ) {}

  /** Roda depois de cada mensagem recebida, quando o menu de atendimento já terminou. */
  async afterInbound(event: InboundEvent): Promise<void> {
    const capabilities = CHANNEL_CAPABILITIES[event.channel.type];
    if (!capabilities.send || capabilities.providesPhone) return;

    const { tenantId } = event.channel;
    const result = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, event.conversationId);
      const state = conversation.automationState as AutomationState;

      // Textos de Configurações → Mensagens automáticas (ou os padrões).
      const texts = automationTextsOf(await tenantSettings(tx, tenantId));
      if (!state.phoneCollection && !conversation.contact.phone) {
        const messageId = await automationMessage(tx, conversation, "phone_collection", texts.phoneRequest);
        await setAutomationState(tx, conversation.id, { ...state, phoneCollection: "awaiting_phone" });
        return { send: [messageId], remind: true };
      }

      if (state.phoneCollection === "awaiting_phone" && event.text) {
        const phone = extractPhone(event.text);
        if (!phone) return null;
        await tx.contact.update({
          where: { id: conversation.contact.id },
          data: { phone, phoneSource: "informed_by_customer", phoneStatus: "ok" },
        });
        await systemEvent(tx, conversation, { event: "phone_collected", text: "Telefone informado e cadastrado" });
        const messageId = await automationMessage(tx, conversation, "phone_confirmation", texts.phoneConfirmation);
        await setAutomationState(tx, conversation.id, { ...state, phoneCollection: "phone_collected" });
        return { send: [messageId], remind: false };
      }
      return null;
    });

    if (!result) return;
    await dispatch(this.outbound, this.realtime, tenantId, event.conversationId, result.send);
    if (result.remind) {
      await this.automations.add("phone-reminder", { tenantId, conversationId: event.conversationId }, { delay: PHONE_REMINDER_DELAY_MS });
    }
  }

  /** Um único lembrete, se o cliente ainda não informou o telefone. */
  async remind(tenantId: string, conversationId: string): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as AutomationState;
      if (state.phoneCollection !== "awaiting_phone" || state.phoneReminderSentAt) return null;
      const texts = automationTextsOf(await tenantSettings(tx, tenantId));
      const id = await automationMessage(tx, conversation, "phone_reminder", texts.phoneReminder);
      await setAutomationState(tx, conversationId, { ...state, phoneReminderSentAt: new Date().toISOString() });
      return id;
    });
    if (!messageId) return;
    await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
    await this.automations.add("phone-give-up", { tenantId, conversationId }, { delay: PHONE_REMINDER_DELAY_MS });
  }

  /** Sem resposta depois do lembrete: telefone pendente e alerta para o atendente. */
  async giveUp(tenantId: string, conversationId: string): Promise<void> {
    const changed = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as AutomationState;
      if (state.phoneCollection !== "awaiting_phone") return false;
      if (!conversation.contact.phone) {
        await tx.contact.update({ where: { id: conversation.contact.id }, data: { phoneStatus: "pending" } });
      }
      await systemEvent(tx, conversation, { event: "phone_pending", text: "Telefone não informado" });
      await setAutomationState(tx, conversationId, { ...state, phoneCollection: "phone_skipped" });
      return true;
    });
    if (changed) this.realtime.inboxChanged(tenantId, conversationId);
  }

  private load(tx: TenantTx, conversationId: string) {
    return tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        id: true,
        tenantId: true,
        channelId: true,
        automationState: true,
        contact: { select: { id: true, phone: true } },
      },
    });
  }
}

/** Acha um telefone válido (padrão BR) no meio do texto: "meu número é (11) 97654-3210". */
export function extractPhone(text: string): string | null {
  for (const candidate of text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []) {
    const phone = toE164(candidate);
    if (phone) return phone;
  }
  return null;
}
