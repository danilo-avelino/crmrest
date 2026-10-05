import type { MessageContent } from "@comanda/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { DelayedError, type Job, type Queue } from "bullmq";
import { INACTIVITY_CLOSE_MS } from "../automations/inactivity.service.js";
import { ChannelAuthError, PermanentSendError } from "../connectors/connector.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type AutomationJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Uma mensagem espera as anteriores da mesma conversa só por este tempo: uma pendente esquecida não trava a conversa. */
const ORDER_WAIT_MS = 60_000;

/** Worker outbound (§3.5): envia a mensagem pendente ao canal e registra o resultado. */
@Processor(QUEUES.outbound, { concurrency: 5 })
export class OutboundProcessor extends JobProcessor {
  private readonly logger = new Logger(OutboundProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>, token?: string): Promise<void> {
    const { tenantId, messageId } = job.data;
    const scope = { tenantIds: [tenantId] };
    const { message, earlierPending } = await this.db.withTenants(scope, async (tx) => {
      const message = await tx.message.findUnique({
        where: { id: messageId },
        include: { channel: true, conversation: { select: { contact: { select: { identities: true } } } } },
      });
      const earlierPending = message
        ? await tx.message.count({
            where: {
              conversationId: message.conversationId,
              direction: "OUTBOUND",
              status: "PENDING",
              createdAt: { lt: message.createdAt, gte: new Date(message.createdAt.getTime() - ORDER_WAIT_MS) },
            },
          })
        : 0;
      return { message, earlierPending };
    });
    if (!message || message.status !== "PENDING") return; // já enviada (job repetido) ou removida
    // Os envios são paralelos: mensagens seguidas da mesma conversa (ex.: duas automações) esperam as anteriores, para chegar em ordem.
    if (earlierPending > 0 && token) {
      await job.moveToDelayed(Date.now() + 500, token);
      throw new DelayedError();
    }

    const connector = this.connectors.get(message.channel.type);
    const recipient = message.conversation.contact.identities.find((i) => i.channelType === message.channel.type);
    const content = message.content as MessageContent;

    let outcome: { status: "SENT"; externalMessageId: string } | { status: "FAILED"; statusError: string };
    let authFailed = false;
    try {
      if (message.channel.status === "DISCONNECTED") throw new PermanentSendError("A integração deste canal foi desconectada.");
      if (!connector || !recipient) throw new PermanentSendError("Este canal não permite enviar esta mensagem.");
      const { accessToken } = this.connectors.secrets(message.channel.credentials);
      const target = { externalChannelId: message.channel.externalId, recipientId: recipient.externalId, accessToken };
      let sent: { externalMessageId: string };
      if (content.template && connector.sendTemplate) sent = await connector.sendTemplate(target, content.template);
      else if (content.text) sent = await connector.send(target, { type: "TEXT", text: content.text });
      else throw new PermanentSendError("Este canal não permite enviar esta mensagem.");
      outcome = { status: "SENT", externalMessageId: sent.externalMessageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      // Falha temporária: o BullMQ tenta de novo com backoff; na última tentativa vira FAILED.
      if (!(error instanceof PermanentSendError) && !lastAttempt) throw error;
      this.logger.warn(`Mensagem ${messageId} não enviada: ${reason}`);
      outcome = { status: "FAILED", statusError: reason };
      authFailed = error instanceof ChannelAuthError;
    }

    // Saúde do canal (§5.4): credencial recusada pede reconexão; um envio que passa mostra que voltou a funcionar.
    const channelStatus = outcome.status === "SENT" ? "CONNECTED" : authFailed ? "ERROR" : message.channel.status;
    await this.db.withTenants(scope, async (tx) => {
      await tx.message.update({ where: { id: messageId }, data: outcome });
      if (channelStatus !== message.channel.status) {
        await tx.channel.update({ where: { id: message.channelId }, data: { status: channelStatus } });
      }
    });
    this.realtime.inboxChanged(tenantId, message.conversationId);
    // Se o cliente não responder, o atendimento é encerrado (a checagem acontece quando o job roda).
    if (outcome.status === "SENT") {
      await this.automations.add("inactivity", { tenantId, conversationId: message.conversationId }, { delay: INACTIVITY_CLOSE_MS });
    }
  }
}
