import type { TenantTx } from "@dishdesk/database";
import { automationTextsOf, CHANNEL_CAPABILITIES, toE164 } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { type AutomationJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  type AutomationState,
  automationMessage,
  channelSends,
  dispatch,
  type InboundEvent,
  setAutomationState,
  systemEvent,
  tenantSettings,
} from "./automation.js";

/** Espera até o lembrete e, depois dele, até desistir. */
export const PHONE_REMINDER_DELAY_MS = 10 * 60_000;

/**
 * Pede o telefone a quem chega sem ele (Instagram, chat do iFood) e cadastra o número informado: é o que qualifica o
 * contato. Se o número já é de outro cadastro, pode ser a mesma pessoa em outro canal, mas nada prova que o número é
 * de quem digitou: a equipe decide se une os dois (Clientes → Duplicados).
 */
@Injectable()
export class PhoneCollectionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Roda depois de cada mensagem recebida, quando o menu de atendimento já terminou. */
  async afterInbound(event: InboundEvent): Promise<void> {
    if (!channelSends(event.channel.type, this.env) || CHANNEL_CAPABILITIES[event.channel.type].providesPhone) return;

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
        await this.register(tx, conversation, phone);
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

  /**
   * Cadastra o telefone que o cliente informou na conversa (aqui ou ao responder a IA) e, se outro cadastro já tinha
   * este telefone, avisa a equipe na conversa.
   */
  async register(
    tx: TenantTx,
    conversation: { id: string; tenantId: string; channelId: string; contact: { id: string } },
    phone: string,
  ): Promise<void> {
    // Quem já tinha este telefone (o cadastro mais antigo, se houver mais de um).
    const known = await tx.contact.findFirst({
      where: { phone, deletedAt: null, id: { not: conversation.contact.id } },
      orderBy: { firstSeenAt: "asc" },
    });
    await tx.contact.update({
      where: { id: conversation.contact.id },
      data: { phone, phoneSource: "informed_by_customer", phoneStatus: "ok" },
    });
    await systemEvent(tx, conversation, { event: "phone_collected", text: "Telefone informado e cadastrado" });
    if (known) {
      const text = `${known.name ?? "Outro cliente"} já tem este telefone. Se for a mesma pessoa, una os cadastros em Clientes → Duplicados`;
      await systemEvent(tx, conversation, { event: "possible_duplicate", text });
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
