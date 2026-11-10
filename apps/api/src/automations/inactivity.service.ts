import { automationMessagesOf, CHANNEL_CAPABILITIES, STAFF_TAG } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { scheduleEvaluation } from "../ai/ai-evaluation.service.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { type AiJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  AUTOMATIC_ONLY,
  type AutomationState,
  automationMessage,
  channelSends,
  dispatch,
  isPaused,
  tenantSettings,
} from "./automation.js";
import { SurveyService } from "./survey.service.js";

/** Tempo sem resposta do cliente, depois da última mensagem do restaurante, até encerrar o atendimento. */
export const INACTIVITY_CLOSE_MS = 20 * 60_000;
/**
 * Conversa só com automação, sem mensagem há este tempo, é resolvida sem aviso ao cliente. Fica acima do encerramento por
 * inatividade, que chega antes (com a mensagem de encerramento e a pesquisa) quando o restaurante falou por último.
 */
export const AUTO_RESOLVE_MS = 30 * 60_000;
const AUTO_RESOLVE_SWEEP_MS = 5 * 60_000;

/** Encerra o atendimento aberto em que o cliente parou de responder e, se houver pedido do dia, pede a avaliação. */
@Injectable()
export class InactivityService implements OnModuleInit {
  private readonly logger = new Logger(InactivityService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.ai) private readonly ai: Queue<AiJob>,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue,
    private readonly survey: SurveyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.automations.upsertJobScheduler("auto-resolve-sweep", { every: AUTO_RESOLVE_SWEEP_MS }, { name: "auto-resolve-sweep" });
  }

  /**
   * Conversas da aba Automáticos (a equipe não foi chamada nem atuou) sem mensagem há AUTO_RESOLVE_MS: o atendimento
   * acabou, e elas são resolvidas sem mensagem ao cliente. Ex.: no chat do iFood, a conversa aberta só pelas mensagens
   * automáticas da loja; o cliente que recebeu os links e parou de escrever. Com o Dish Desk pausado, nada é resolvido.
   */
  async resolveIdle(now = new Date()): Promise<void> {
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id: tenantId } of tenants) {
      try {
        await this.resolveIdleOf(tenantId, now);
      } catch (error) {
        // Segue para os outros restaurantes; a próxima varredura tenta de novo.
        this.logger.warn(`Conversas automáticas do restaurante ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async resolveIdleOf(tenantId: string, now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - AUTO_RESOLVE_MS);
    const resolved = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      if (await isPaused(tx, tenantId)) return [];
      const idle = await tx.conversation.findMany({
        where: {
          tenantId,
          ...AUTOMATIC_ONLY,
          createdAt: { lt: cutoff },
          messages: { none: { direction: { in: ["INBOUND", "OUTBOUND"] }, createdAt: { gte: cutoff } } },
        },
        select: { id: true },
      });
      const ids = idle.map((conversation) => conversation.id);
      // A condição volta no update: a equipe pode ter entrado na conversa durante a leitura.
      if (ids.length) await tx.conversation.updateMany({ where: { id: { in: ids }, ...AUTOMATIC_ONLY }, data: { status: "RESOLVED" } });
      return ids;
    });
    for (const conversationId of resolved) {
      await scheduleEvaluation(this.ai, tenantId, conversationId);
      this.realtime.inboxChanged(tenantId, conversationId);
    }
  }

  /** Roda INACTIVITY_CLOSE_MS depois de cada envio; se houve mensagem depois dele, não faz nada. */
  async close(tenantId: string, conversationId: string, now = new Date()): Promise<void> {
    const messageId = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          tenantId: true,
          channelId: true,
          status: true,
          windowExpiresAt: true,
          awaitingAgentSince: true,
          automationState: true,
          channel: { select: { type: true } },
          contact: { select: { tags: true } },
        },
      });
      // Pendente é a equipe segurando o atendimento (ex.: "vou ver com a cozinha"): não encerra.
      if (conversation?.status !== "OPEN") return null;
      // Funcionário: conversa comum, sem automação; quem encerra é a equipe.
      if (conversation.contact.tags.includes(STAFF_TAG)) return null;
      // Cliente esperando um atendente (o "já vai falar com você" foi a última mensagem): não encerra.
      if (conversation.awaitingAgentSince) return null;
      // Nem esperando um atendente que ainda não havia (fechado, 100% automático ou ninguém online).
      if ((conversation.automationState as AutomationState).aiWaiting) return null;
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      const sends = channelSends(conversation.channel.type, this.env);
      if (!sends || (capabilities.window24h && !(conversation.windowExpiresAt && conversation.windowExpiresAt > now))) {
        return null;
      }
      // Só quando o restaurante falou por último: cliente esperando resposta não tem o atendimento encerrado.
      const last = await tx.message.findFirst({
        where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        select: { direction: true, createdAt: true },
      });
      if (last?.direction !== "OUTBOUND" || now.getTime() - last.createdAt.getTime() < INACTIVITY_CLOSE_MS) return null;

      const { inactivityClose } = automationMessagesOf(await tenantSettings(tx, tenantId));
      const id = await automationMessage(tx, conversation, "inactivity_close", inactivityClose);
      await tx.conversation.update({ where: { id: conversationId }, data: { status: "RESOLVED", teamInvolved: false } });
      return id;
    });
    if (!messageId) return;
    await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
    await this.survey.request(tenantId, conversationId, now);
    await scheduleEvaluation(this.ai, tenantId, conversationId);
  }
}
