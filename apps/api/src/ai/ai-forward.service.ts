import { aiFullAutoOf, businessHoursOf, isOpenAt, reopeningAt } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { type AutomationState, setAutomationState, systemEvent } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { type AiForwardJob, QUEUES } from "../queues/queues.module.js";
import { PresenceService } from "../realtime/presence.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Varredura das conversas que esperam um atendente: pega a abertura do restaurante, que não tem outro aviso. */
const SWEEP_MS = 30_000;

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
  constructor(
    private readonly db: DatabaseService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AiForwardJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.automations.upsertJobScheduler("ai-forward-sweep", { every: SWEEP_MS }, { name: "ai-forward-sweep" });
  }

  async sweep(now = new Date()): Promise<void> {
    for (const tenantId of await this.presence.waitingTenants()) await this.forward(tenantId, now);
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
