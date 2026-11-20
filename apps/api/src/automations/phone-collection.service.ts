import type { TenantTx } from "@dishdesk/database";
import { automationMessagesOf, CHANNEL_CAPABILITIES, toE164 } from "@dishdesk/shared";
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
  teamSpokeSince,
  tenantSettings,
} from "./automation.js";
import { ATTENDANCE_END_MS } from "./inactivity.service.js";

/** Espera até o lembrete e, depois dele, até desistir. */
export const PHONE_REMINDER_DELAY_MS = 10 * 60_000;

/**
 * Espera entre a equipe resolver a conversa e o pedido do telefone. Colado na resposta do atendente, o pedido saía com a
 * conversa ainda andando (18/11/2026: a Marisa recebeu e escreveu de novo 12 min depois; 17/11: o Gladyson, logo depois de
 * perguntar "Vai demorar muito ainda?"). Se o cliente escrever nesse intervalo, a conversa reabre e o pedido não sai.
 */
export const PHONE_AT_END_DELAY_MS = 5 * 60_000;

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

      // Textos da personalidade do restaurante.
      const texts = automationMessagesOf(await tenantSettings(tx, tenantId));
      if (!state.phoneCollection && !conversation.contact.phone) {
        // No meio da conversa com a equipe, o pedido atrapalha: o cliente respondia o atendente e recebia a pergunta (e
        // mandava o apartamento no lugar do telefone, 15/11/2026). Fica para o fim do atendimento (askAtEnd).
        if (await teamSpoke(tx, conversation.id)) return null;
        const messageId = await automationMessage(tx, conversation, "phone_collection", texts.phoneRequest);
        await setAutomationState(tx, conversation.id, { ...state, phoneCollection: "awaiting_phone" });
        return { send: [messageId], remind: true };
      }

      if (askedPhone(state) && event.text) {
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
  register(tx: TenantTx, conversation: PhoneConversation, phone: string): Promise<void> {
    return registerPhone(tx, conversation, phone);
  }

  /**
   * Fim do atendimento (a equipe resolveu, ou encerrou por inatividade): o telefone que ficou de fora por a equipe estar
   * na conversa é pedido agora, uma vez, sem lembrete. A resposta é cadastrada como no começo (askedPhone).
   */
  async askAtEnd(tenantId: string, conversationId: string): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const { type } = conversation.channel;
      if (!channelSends(type, this.env) || CHANNEL_CAPABILITIES[type].providesPhone) return null;
      const state = conversation.automationState as AutomationState;
      // Conversa reaberta (o cliente escreveu depois de resolvida): o atendimento continua, e o pedido espera o próximo fim.
      if (conversation.status !== "RESOLVED") return null;
      if (state.phoneCollection || conversation.contact.phone || !(await teamSpoke(tx, conversationId))) return null;
      // Sem mensagem do cliente (só a loja escreveu no chat do pedido), não há com quem falar: nada de pedir o telefone.
      if (!(await customerWrote(tx, conversationId))) return null;
      const texts = automationMessagesOf(await tenantSettings(tx, tenantId));
      const id = await automationMessage(tx, conversation, "phone_collection", texts.phoneRequest);
      await setAutomationState(tx, conversationId, { ...state, phoneCollection: "awaiting_phone", phoneReminderSentAt: new Date().toISOString() });
      return id;
    });
    if (messageId) await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
  }

  /** Um único lembrete, se o cliente ainda não informou o telefone. */
  async remind(tenantId: string, conversationId: string): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await this.load(tx, conversationId);
      const state = conversation.automationState as AutomationState;
      if (state.phoneCollection !== "awaiting_phone" || state.phoneReminderSentAt) return null;
      const texts = automationMessagesOf(await tenantSettings(tx, tenantId));
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
        status: true,
        automationState: true,
        channel: { select: { type: true } },
        contact: { select: { id: true, phone: true } },
      },
    });
  }
}

/**
 * Alguém da equipe falou neste atendimento (a última hora, ATTENDANCE_END_MS): pelo Dish Desk, pelo celular da loja ou
 * pelo portal do canal (a mensagem sem a marca da automação nem da IA).
 */
function teamSpoke(tx: TenantTx, conversationId: string, now = new Date()): Promise<boolean> {
  return teamSpokeSince(tx, conversationId, new Date(now.getTime() - ATTENDANCE_END_MS));
}

/** O cliente escreveu neste atendimento (a última hora). Quem só recebeu mensagens da loja não é perguntado (16/11/2026). */
async function customerWrote(tx: TenantTx, conversationId: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - ATTENDANCE_END_MS);
  return (await tx.message.count({ where: { conversationId, direction: "INBOUND", createdAt: { gte: since } } })) > 0;
}

type PhoneConversation = { id: string; tenantId: string; channelId: string; contact: { id: string } };

/**
 * A coleta pediu o telefone e ainda aceita a resposta. Depois da desistência também: o número mandado na hora em que ela
 * rodou chegava logo depois (o chat do iFood copia com alguns segundos de atraso) e se perdia (14/11/2026).
 */
export function askedPhone(state: AutomationState): boolean {
  return state.phoneCollection === "awaiting_phone" || state.phoneCollection === "phone_skipped";
}

/** O corpo de PhoneCollectionService.register, para quem não tem o serviço (a leitura do chat do iFood). */
export async function registerPhone(tx: TenantTx, conversation: PhoneConversation, phone: string): Promise<void> {
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

/** Acha um telefone válido (padrão BR) no meio do texto: "meu número é (11) 97654-3210". */
export function extractPhone(text: string): string | null {
  for (const candidate of text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []) {
    const phone = toE164(candidate);
    if (phone) return phone;
  }
  return null;
}
