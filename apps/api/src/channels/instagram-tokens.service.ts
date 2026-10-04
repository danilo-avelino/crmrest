import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { QUEUES } from "../queues/queues.module.js";

/** Renova uma vez por semana: folga grande antes dos 60 dias, e a Meta só aceita tokens com mais de 24 h. */
export const INSTAGRAM_TOKEN_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Tokens do Instagram expiram em 60 dias sem uso da renovação: um job diário os renova antes disso. */
@Injectable()
export class InstagramTokensService implements OnModuleInit {
  private readonly logger = new Logger(InstagramTokensService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    @InjectQueue(QUEUES.channels) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Todo dia às 4h. Idempotente entre réplicas.
    await this.queue.upsertJobScheduler(
      "instagram-token-refresh",
      { pattern: "0 4 * * *", tz: "America/Sao_Paulo" },
      { name: "instagram-token-refresh" },
    );
  }

  async refreshAll(): Promise<void> {
    const channels = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.instagram_channels()`;
    for (const { id, tenant_id: tenantId } of channels) {
      try {
        await this.refreshChannel(tenantId, id);
      } catch (error) {
        // Segue para os outros canais; a próxima execução tenta de novo, com semanas de folga até expirar.
        this.logger.warn({ tenantId, channelId: id, err: error }, "Token do Instagram não renovado");
        Sentry.captureException(error, { tags: { tenantId, channel: "instagram" } });
      }
    }
  }

  /** Renova o token do canal se ele tiver mais de 7 dias (ou nenhuma data). */
  async refreshChannel(tenantId: string, channelId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const channel = await this.db.withTenants(scope, (tx) =>
      tx.channel.findUniqueOrThrow({ where: { id: channelId }, select: { credentials: true } }),
    );
    const secrets = this.connectors.secrets(channel.credentials);
    if (secrets.tokenUpdatedAt && Date.now() - Date.parse(secrets.tokenUpdatedAt) < INSTAGRAM_TOKEN_REFRESH_MS) return;

    const accessToken = await this.connectors.instagram.refreshToken(secrets.accessToken);
    const credentials = this.connectors.seal({ ...secrets, accessToken, tokenUpdatedAt: new Date().toISOString() });
    await this.db.withTenants(scope, (tx) => tx.channel.update({ where: { id: channelId }, data: { credentials } }));
  }
}

@Processor(QUEUES.channels)
export class InstagramTokensProcessor extends JobProcessor {
  constructor(private readonly tokens: InstagramTokensService) {
    super();
  }

  async process(): Promise<void> {
    await this.tokens.refreshAll();
  }
}
