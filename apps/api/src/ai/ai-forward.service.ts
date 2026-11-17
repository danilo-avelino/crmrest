import {
  aiFullAutoOf,
  automationMessagesOf,
  businessHoursOf,
  CHANNEL_CAPABILITIES,
  COURIER_TAG,
  fillMessage,
  isOpenAt,
  pausedOf,
  reopeningAt,
  STAFF_TAG,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  type AutomationState,
  automationMessage,
  channelSends,
  dispatch,
  setAutomationState,
  systemEvent,
  teamSpokeSince,
} from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { type AiForwardJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { PresenceService } from "../realtime/presence.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { orderInProgress, TEAM_ACTIVE_MS } from "./ai-attendant.service.js";
import { LlmClient } from "./llm.client.js";

/** Varredura das conversas que esperam um atendente: pega a abertura do restaurante, que não tem outro aviso. */
const SWEEP_MS = 30_000;
/** Mensagem do cliente sem resposta há mais que isto não recebe o aviso de que o restaurante fechou. */
const CLOSED_NOTICE_MAX_MS = 12 * 60 * 60_000;

/** Há atendente para a IA passar a conversa? Sem: o motivo (e, fechado, quando o restaurante volta). */
export type Attendance = { available: true } | { available: false; reason: "closed" | "full_auto" | "offline"; reopening?: string };

export async function attendanceOf(presence: PresenceService, tenantId: string, settings: unknown, now: Date): Promise<Attendance> {
  const hours = businessHoursOf(settings);
  if (hours.enabled && !isOpenAt(hours, now)) return { available: false, reason: "closed", reopening: reopeningAt(hours, now) };
  if (aiFullAutoOf(settings)) return { available: false, reason: "full_auto" };
  if (!(await presence.online(tenantId, now.getTime()))) return { available: false, reason: "offline" };
  return { available: true };
}

/**
 * Conversas em que a IA precisava da equipe sem haver atendente (AutomationState.aiWaiting): vão para a equipe quando o
 * restaurante abre, alguém abre o Dish Desk ou o 100% automático é desligado, com o alarme de sempre (awaitingAgentSince).
 */
@Injectable()
export class AiForwardService implements OnModuleInit {
  private readonly logger = new Logger(AiForwardService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AiForwardJob>,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly llm: LlmClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.automations.upsertJobScheduler("ai-forward-sweep", { every: SWEEP_MS }, { name: "ai-forward-sweep" });
  }

  async sweep(now = new Date()): Promise<void> {
    for (const tenantId of await this.presence.waitingTenants()) await this.forward(tenantId, now);
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id: tenantId } of tenants) {
      try {
        await this.closedNotices(tenantId, now);
      } catch (error) {
        // Segue para os outros restaurantes; a próxima varredura tenta de novo.
        this.logger.warn(`Aviso de fechado do restaurante ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * O restaurante fechou (fim do dia ou intervalo) com cliente esperando a equipe, sem resposta: ele é avisado de que o
   * horário terminou e de quando a equipe responde, e a IA volta a atender até lá (aiWaiting); na abertura, a conversa
   * vai para a equipe pelo forward. 15/11/2026: a IA passou o Mozart para a equipe às 23:55, o Moby Dick fechou às 23:59,
   * e ele seguiu escrevendo sem ninguém dizer nada. Só com a IA: sem ela, ninguém atenderia as mensagens seguintes.
   */
  async closedNotices(tenantId: string, now = new Date()): Promise<void> {
    const sent = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const hours = businessHoursOf(tenant.settings);
      if (!hours.enabled || isOpenAt(hours, now) || pausedOf(tenant.settings) || !(await this.llm.activeFor(tx, tenantId))) return [];
      const waiting = await tx.conversation.findMany({
        where: { tenantId, awaitingAgentSince: { not: null }, status: { not: "RESOLVED" }, teamOnly: false },
        select: {
          id: true,
          tenantId: true,
          channelId: true,
          windowExpiresAt: true,
          automationState: true,
          channel: { select: { type: true } },
          contact: { select: { tags: true } },
        },
      });
      const text = fillMessage(automationMessagesOf(tenant.settings).closedWhileWaiting, { retorno: reopeningAt(hours, now) });
      const sent: { conversationId: string; messageId: string }[] = [];
      for (const conversation of waiting) {
        const state = conversation.automationState as AutomationState;
        // A IA já atende (e já avisa do horário); funcionário e entregador falam só com a equipe.
        if (state.ai === "on" || conversation.contact.tags.some((tag) => tag === STAFF_TAG || tag === COURIER_TAG)) continue;
        const { type } = conversation.channel;
        if (!channelSends(type, this.env)) continue;
        if (CHANNEL_CAPABILITIES[type].window24h && !(conversation.windowExpiresAt && conversation.windowExpiresAt > now)) continue;
        // Só quando a última mensagem é do cliente, e recente: o aviso sai uma vez, e a conversa esquecida não o recebe.
        const last = await tx.message.findFirst({
          where: { conversationId: conversation.id, direction: { in: ["INBOUND", "OUTBOUND"] } },
          orderBy: { createdAt: "desc" },
          select: { direction: true, createdAt: true },
        });
        if (last?.direction !== "INBOUND" || now.getTime() - last.createdAt.getTime() > CLOSED_NOTICE_MAX_MS) continue;
        // A equipe ainda responde nesta conversa depois do horário (pelo painel, pelo celular ou pelo portal do canal): ela
        // continua atendendo. 16/11/2026: a loja respondia pelo portal do iFood e a Any ouviu "respondemos amanhã".
        if (await teamSpokeSince(tx, conversation.id, new Date(now.getTime() - TEAM_ACTIVE_MS))) continue;
        // O aviso sai uma vez: a Any o recebeu às 23:00 e de novo às 23:18.
        const noticed = await tx.message.count({
          where: {
            conversationId: conversation.id,
            createdAt: { gte: new Date(now.getTime() - CLOSED_NOTICE_MAX_MS) },
            content: { path: ["automation"], equals: "after_hours" },
          },
        });
        if (noticed) continue;
        // O pedido do cliente ainda está em andamento: a loja segue entregando, e a equipe é quem responde (a Dandara, com o
        // pedido a caminho, ouviu que a equipe responderia no dia seguinte).
        const orders = await tx.order.findMany({
          where: {
            OR: [{ conversationId: conversation.id }, ...(state.linkedOrder ? [{ id: state.linkedOrder.id }] : [])],
            placedAt: { gte: new Date(now.getTime() - CLOSED_NOTICE_MAX_MS) },
          },
          select: { status: true, placedAt: true },
        });
        if (orders.some((order) => orderInProgress(order, now))) continue;

        const messageId = await automationMessage(tx, conversation, "after_hours", text);
        await setAutomationState(tx, conversation.id, {
          ...state,
          ai: "on",
          aiWaiting: true,
          aiWaitingReason: "O cliente esperava a equipe quando o restaurante fechou",
        });
        await systemEvent(tx, conversation, {
          event: "awaiting_agent",
          waitingReason: "closed",
          text: "O restaurante fechou com o cliente esperando a equipe: ele foi avisado, e a conversa vai para a equipe quando abrir",
        });
        // Como a espera da IA com o restaurante fechado: pendente e sem o alarme, que volta na abertura.
        await tx.conversation.update({ where: { id: conversation.id }, data: { status: "PENDING", awaitingAgentSince: null } });
        sent.push({ conversationId: conversation.id, messageId });
      }
      return sent;
    });
    if (!sent.length) return;
    await this.presence.markWaiting(tenantId);
    for (const { conversationId, messageId } of sent) await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
  }

  /** Com atendente disponível, passa as conversas que esperavam; sem, o restaurante continua na lista da varredura. */
  async forward(tenantId: string, now = new Date()): Promise<void> {
    // Sai da lista antes de ler: uma conversa que começar a esperar durante a leitura põe o restaurante de volta.
    const listed = await this.presence.takeWaiting(tenantId);
    const forwarded = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      if (!tenant || !(await attendanceOf(this.presence, tenantId, tenant.settings, now)).available) return null;
      const waiting = await tx.conversation.findMany({
        where: { tenantId, automationState: { path: ["aiWaiting"], equals: true } },
        select: { id: true, tenantId: true, channelId: true, status: true, automationState: true },
      });
      for (const conversation of waiting) {
        const { aiWaiting: _, aiWaitingReason: reason, ...state } = conversation.automationState as AutomationState;
        await setAutomationState(tx, conversation.id, { ...state, ai: "off" });
        if (conversation.status === "RESOLVED") continue; // a equipe já resolveu
        await systemEvent(tx, conversation, { event: "handoff", text: `IA passou o atendimento para a equipe${reason ? `: ${reason}` : ""}` });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: "OPEN", awaitingAgentSince: now, awaitingAgentQuiet: false },
        });
      }
      return waiting.map((conversation) => conversation.id);
    });
    if (!forwarded) {
      if (listed) await this.presence.markWaiting(tenantId);
      return;
    }
    for (const conversationId of forwarded) this.realtime.inboxChanged(tenantId, conversationId);
  }
}
