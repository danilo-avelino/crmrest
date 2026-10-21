import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { type ChannelSecrets, ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { QUEUES } from "../queues/queues.module.js";

/** Renova uma vez por semana: folga grande antes dos 60 dias, e a Meta só aceita tokens com mais de 24 h. */
export const TOKEN_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Tokens de longa duração do Instagram e os de 60 dias do WhatsApp. */
const TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Tokens do Instagram e do WhatsApp (cadastro incorporado com tokens de 60 dias) expiram sem renovação: um job diário
 * os renova antes disso e grava quando vencem, para o painel avisar "vence em N dias" se a renovação falhar.
 */
@Injectable()
export class ChannelTokensService implements OnModuleInit {
  private readonly logger = new Logger(ChannelTokensService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    @InjectQueue(QUEUES.channels) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // O agendamento antigo, de quando só o Instagram era renovado.
    await this.queue.removeJobScheduler("instagram-token-refresh");
    // Todo dia às 4h. Idempotente entre réplicas.
    await this.queue.upsertJobScheduler(
      "channel-token-refresh",
      { pattern: "0 4 * * *", tz: "America/Sao_Paulo" },
      { name: "channel-token-refresh" },
    );
  }

  async refreshAll(): Promise<void> {
    const instagram = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.instagram_channels()`;
    const whatsapp = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.whatsapp_channels()`;
    const channels = [
      ...instagram.map((row) => ({ ...row, channel: "instagram" as const })),
      ...whatsapp.map((row) => ({ ...row, channel: "whatsapp" as const })),
    ];
    for (const { id, tenant_id: tenantId, channel } of channels) {
      try {
        await (channel === "instagram" ? this.refreshInstagram(tenantId, id) : this.refreshWhatsApp(tenantId, id));
      } catch (error) {
        // Segue para os outros canais; a próxima execução tenta de novo, com semanas de folga até expirar.
        this.logger.warn({ tenantId, channelId: id, err: error }, "Token do canal não renovado");
        Sentry.captureException(error, { tags: { tenantId, channel } });
      }
    }
  }

  /** Renova o token do Instagram se ele tiver mais de 7 dias (ou nenhuma data). */
  async refreshInstagram(tenantId: string, channelId: string): Promise<void> {
    const secrets = await this.secrets(tenantId, channelId);
    if (recent(secrets.tokenUpdatedAt)) return;

    const accessToken = await this.connectors.instagram.refreshToken(secrets.accessToken);
    await this.save(tenantId, channelId, { ...secrets, accessToken, tokenUpdatedAt: new Date().toISOString() }, new Date(Date.now() + TOKEN_LIFETIME_MS));
  }

  /**
   * Confere o token do WhatsApp na Meta: recusado, o canal fica "Com erro" (a Inbox pede para reconectar); permanente,
   * fica como está; de 60 dias, grava o vencimento e renova se tiver mais de 7 dias.
   */
  async refreshWhatsApp(tenantId: string, channelId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const secrets = await this.secrets(tenantId, channelId);
    const status = await this.connectors.whatsapp.tokenStatus(secrets.accessToken);
    if (!status) return; // simulação ou app da Meta não configurado: não há como conferir
    if (!status.valid) {
      this.logger.warn({ tenantId, channelId }, "Token do WhatsApp recusado pela Meta: canal com erro");
      await this.db.withTenants(scope, (tx) => tx.channel.update({ where: { id: channelId }, data: { status: "ERROR" } }));
      return;
    }
    // O vencimento fica gravado antes da renovação: se ela falhar, o painel já sabe quando o canal para.
    await this.db.withTenants(scope, (tx) => tx.channel.update({ where: { id: channelId }, data: { tokenExpiresAt: status.expiresAt } }));
    if (!status.expiresAt || recent(secrets.tokenUpdatedAt)) return;

    const refreshed = await this.connectors.whatsapp.refreshToken(secrets.accessToken);
    await this.save(
      tenantId,
      channelId,
      { ...secrets, accessToken: refreshed.accessToken, tokenUpdatedAt: new Date().toISOString() },
      refreshed.expiresAt ?? new Date(Date.now() + TOKEN_LIFETIME_MS),
    );
  }

  private async secrets(tenantId: string, channelId: string) {
    const channel = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
      tx.channel.findUniqueOrThrow({ where: { id: channelId }, select: { credentials: true } }),
    );
    return this.connectors.secrets(channel.credentials);
  }

  private async save(tenantId: string, channelId: string, secrets: ChannelSecrets, tokenExpiresAt: Date): Promise<void> {
    const credentials = this.connectors.seal(secrets);
    await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
      tx.channel.update({ where: { id: channelId }, data: { credentials, tokenExpiresAt } }),
    );
  }
}

/** Token renovado (ou conectado) há menos de 7 dias. */
function recent(tokenUpdatedAt: string | undefined): boolean {
  return Boolean(tokenUpdatedAt && Date.now() - Date.parse(tokenUpdatedAt) < TOKEN_REFRESH_MS);
}

@Processor(QUEUES.channels)
export class ChannelTokensProcessor extends JobProcessor {
  constructor(private readonly tokens: ChannelTokensService) {
    super();
  }

  async process(): Promise<void> {
    await this.tokens.refreshAll();
  }
}
