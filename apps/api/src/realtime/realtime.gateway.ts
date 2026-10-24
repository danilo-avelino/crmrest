import { InjectQueue } from "@nestjs/bullmq";
import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { type OnGatewayConnection, type OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Queue } from "bullmq";
import type { Server, Socket } from "socket.io";
import { TokensService } from "../auth/tokens.service.js";
import { type AiForwardJob, QUEUES } from "../queues/queues.module.js";
import { PRESENCE_REFRESH_MS, PresenceService } from "./presence.service.js";
import { tenantRoom } from "./realtime.emitter.js";

/**
 * Conexões dos painéis: autentica pelo access token e entra nas salas dos tenants dele. Cada painel conectado é alguém da
 * equipe online (PresenceService); ao chegar, as conversas que esperavam um atendente vão para a equipe.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() private readonly server!: Server;
  private readonly refresh = setInterval(() => void this.refreshPresence(), PRESENCE_REFRESH_MS);

  constructor(
    private readonly tokens: TokensService,
    private readonly presence: PresenceService,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AiForwardJob>,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token: unknown = client.handshake.auth?.token;
    let tenantIds: string[];
    try {
      if (typeof token !== "string") throw new Error("sem token");
      const auth = await this.tokens.verifyAccess(token);
      tenantIds = auth.tenants.map((tenant) => tenant.id);
      await client.join(tenantIds.map(tenantRoom));
    } catch {
      this.logger.debug("Conexão recusada: token ausente ou inválido");
      client.disconnect(true);
      return;
    }
    client.data.tenantIds = tenantIds;
    await this.presence.join(client.id, tenantIds);
    for (const tenantId of tenantIds) await this.automations.add("ai-forward", { tenantId });
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const tenantIds = client.data.tenantIds as string[] | undefined;
    if (tenantIds) await this.presence.leave(client.id, tenantIds);
  }

  /** Renova a presença dos painéis conectados a este processo. */
  private async refreshPresence(): Promise<void> {
    try {
      for (const client of this.server?.sockets.sockets.values() ?? []) {
        const tenantIds = client.data.tenantIds as string[] | undefined;
        if (tenantIds) await this.presence.join(client.id, tenantIds);
      }
    } catch (error) {
      this.logger.warn(`Presença não renovada: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.refresh);
  }
}
