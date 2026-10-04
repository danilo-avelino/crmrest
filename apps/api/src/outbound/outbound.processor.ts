import type { MessageContent } from "@comanda/shared";
import { Processor } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { PermanentSendError } from "../connectors/connector.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Worker outbound (§3.5): envia a mensagem pendente ao canal e registra o resultado. */
@Processor(QUEUES.outbound, { concurrency: 5 })
export class OutboundProcessor extends JobProcessor {
  private readonly logger = new Logger(OutboundProcessor.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly realtime: RealtimeEmitter,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>): Promise<void> {
    const { tenantId, messageId } = job.data;
    const scope = { tenantIds: [tenantId] };
    const message = await this.db.withTenants(scope, (tx) =>
      tx.message.findUnique({
        where: { id: messageId },
        include: { channel: true, conversation: { select: { contact: { select: { identities: true } } } } },
      }),
    );
    if (!message || message.status !== "PENDING") return; // já enviada (job repetido) ou removida

    const connector = this.connectors.get(message.channel.type);
    const recipient = message.conversation.contact.identities.find((i) => i.channelType === message.channel.type);
    const content = message.content as MessageContent;

    let outcome: { status: "SENT"; externalMessageId: string } | { status: "FAILED"; statusError: string };
    try {
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
    }

    await this.db.withTenants(scope, (tx) => tx.message.update({ where: { id: messageId }, data: outcome }));
    this.realtime.inboxChanged(tenantId, message.conversationId);
  }
}
