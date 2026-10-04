import type { TenantTx } from "@comanda/database";
import type { ChannelType } from "@comanda/database/enums";
import { CHANNEL_CAPABILITIES, type MessageContent, toE164 } from "@comanda/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { type AutomationJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Estado da coleta guardado em `conversation.automationState` (§5.3). */
type PhoneState = {
  phoneCollection?: "awaiting_phone" | "phone_collected" | "phone_skipped";
  phoneReminderSentAt?: string;
};

// Textos padrão; a edição por restaurante chega com as Configurações (E15).
const TEXTS = {
  request: (firstName: string | undefined) =>
    `Olá${firstName ? `, ${firstName}` : ""}! 👋 Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?`,
  reminder: "Só lembrando: pode nos passar seu telefone com DDD? 😊",
  confirmation: "Obrigado! Já anotamos seu telefone.",
};

/** Espera até o lembrete e, depois dele, até desistir. */
export const PHONE_REMINDER_DELAY_MS = 10 * 60_000;

export type InboundEvent = {
  channel: { id: string; tenantId: string; type: ChannelType };
  conversationId: string;
  text?: string;
};

/** Pede o telefone a quem chega sem ele (Instagram e afins) e cadastra o número informado. */
@Injectable()
export class PhoneCollectionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
  ) {}

  /** Roda depois de cada mensagem recebida. */
  async afterInbound(event: InboundEvent): Promise<void> {
    const capabilities = CHANNEL_CAPABILITIES[event.channel.type];
    if (!capabilities.send || capabilities.providesPhone) return;

    const { tenantId } = event.channel;
    const result = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, event.conversationId);
      const state = conversation.automationState as PhoneState;

      if (!state.phoneCollection && !conversation.contact.phone) {
        const messageId = await this.automationMessage(tx, conversation, "phone_collection", TEXTS.request(firstName(conversation.contact.name)));
        await this.setState(tx, conversation.id, { phoneCollection: "awaiting_phone" });
        return { send: [messageId], remind: true };
      }

      if (state.phoneCollection === "awaiting_phone" && event.text) {
        const phone = extractPhone(event.text);
        if (!phone) return null;
        await tx.contact.update({
          where: { id: conversation.contact.id },
          data: { phone, phoneSource: "informed_by_customer", phoneStatus: "ok" },
        });
        await this.systemEvent(tx, conversation, "phone_collected", "Telefone informado e cadastrado");
        const messageId = await this.automationMessage(tx, conversation, "phone_confirmation", TEXTS.confirmation);
        await this.setState(tx, conversation.id, { ...state, phoneCollection: "phone_collected" });
        return { send: [messageId], remind: false };
      }
      return null;
    });

    if (!result) return;
    await this.dispatch(tenantId, event.conversationId, result.send);
    if (result.remind) {
      await this.automations.add("phone-reminder", { tenantId, conversationId: event.conversationId }, { delay: PHONE_REMINDER_DELAY_MS });
    }
  }

  /** Um único lembrete, se o cliente ainda não informou o telefone. */
  async remind(tenantId: string, conversationId: string): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as PhoneState;
      if (state.phoneCollection !== "awaiting_phone" || state.phoneReminderSentAt) return null;
      const id = await this.automationMessage(tx, conversation, "phone_reminder", TEXTS.reminder);
      await this.setState(tx, conversationId, { ...state, phoneReminderSentAt: new Date().toISOString() });
      return id;
    });
    if (!messageId) return;
    await this.dispatch(tenantId, conversationId, [messageId]);
    await this.automations.add("phone-give-up", { tenantId, conversationId }, { delay: PHONE_REMINDER_DELAY_MS });
  }

  /** Sem resposta depois do lembrete: telefone pendente e alerta para o atendente. */
  async giveUp(tenantId: string, conversationId: string): Promise<void> {
    const changed = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as PhoneState;
      if (state.phoneCollection !== "awaiting_phone") return false;
      if (!conversation.contact.phone) {
        await tx.contact.update({ where: { id: conversation.contact.id }, data: { phoneStatus: "pending" } });
      }
      await this.systemEvent(tx, conversation, "phone_pending", "Telefone não informado");
      await this.setState(tx, conversationId, { ...state, phoneCollection: "phone_skipped" });
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
        contact: { select: { id: true, name: true, phone: true } },
      },
    });
  }

  private async setState(tx: TenantTx, conversationId: string, state: PhoneState) {
    await tx.conversation.update({ where: { id: conversationId }, data: { automationState: state } });
  }

  private async automationMessage(
    tx: TenantTx,
    conversation: { id: string; tenantId: string; channelId: string },
    automation: NonNullable<MessageContent["automation"]>,
    text: string,
  ): Promise<string> {
    const message = await tx.message.create({
      data: {
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        direction: "OUTBOUND",
        type: "TEXT",
        content: { text, automation } satisfies MessageContent,
        status: "PENDING",
      },
      select: { id: true },
    });
    return message.id;
  }

  private async systemEvent(
    tx: TenantTx,
    conversation: { id: string; tenantId: string; channelId: string },
    event: NonNullable<MessageContent["event"]>,
    text: string,
  ) {
    await tx.message.create({
      data: {
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        direction: "INTERNAL",
        type: "SYSTEM",
        content: { event, text } satisfies MessageContent,
      },
    });
  }

  private async dispatch(tenantId: string, conversationId: string, messageIds: string[]) {
    for (const messageId of messageIds) await this.outbound.add("send", { tenantId, messageId });
    this.realtime.inboxChanged(tenantId, conversationId);
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

function firstName(name: string | null): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}
