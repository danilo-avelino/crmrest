import { CHANNEL_CAPABILITIES } from "@comanda/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { automationMessage, dispatch } from "./automation.js";
import { SurveyService } from "./survey.service.js";

/** Tempo sem resposta do cliente, depois da última mensagem do restaurante, até encerrar o atendimento. */
export const INACTIVITY_CLOSE_MS = 20 * 60_000;

const TEXT = "Encerramos esta conversa por falta de interação. Se precisar de algo, é só mandar uma mensagem que retomamos de onde paramos.";

/** Encerra o atendimento aberto em que o cliente parou de responder e, se houver pedido do dia, pede a avaliação. */
@Injectable()
export class InactivityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly survey: SurveyService,
  ) {}

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
          channel: { select: { type: true } },
        },
      });
      // Pendente é a equipe segurando o atendimento (ex.: "vou ver com a cozinha"): não encerra.
      if (conversation?.status !== "OPEN") return null;
      // Cliente esperando um atendente (o "já vai falar com você" foi a última mensagem): não encerra.
      if (conversation.awaitingAgentSince) return null;
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      if (!capabilities.send || (capabilities.window24h && !(conversation.windowExpiresAt && conversation.windowExpiresAt > now))) {
        return null;
      }
      // Só quando o restaurante falou por último: cliente esperando resposta não tem o atendimento encerrado.
      const last = await tx.message.findFirst({
        where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        select: { direction: true, createdAt: true },
      });
      if (last?.direction !== "OUTBOUND" || now.getTime() - last.createdAt.getTime() < INACTIVITY_CLOSE_MS) return null;

      const id = await automationMessage(tx, conversation, "inactivity_close", TEXT);
      await tx.conversation.update({ where: { id: conversationId }, data: { status: "RESOLVED" } });
      return id;
    });
    if (!messageId) return;
    await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
    await this.survey.request(tenantId, conversationId, now);
  }
}
