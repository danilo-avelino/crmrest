import { Logger } from "@nestjs/common";
import { type OnGatewayConnection, WebSocketGateway } from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { TokensService } from "../auth/tokens.service.js";
import { tenantRoom } from "./realtime.emitter.js";

/** Conexões dos painéis: autentica pelo access token e entra nas salas dos tenants dele. */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(private readonly tokens: TokensService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token: unknown = client.handshake.auth?.token;
    try {
      if (typeof token !== "string") throw new Error("sem token");
      const auth = await this.tokens.verifyAccess(token);
      await client.join(auth.tenants.map((tenant) => tenantRoom(tenant.id)));
    } catch {
      this.logger.debug("Conexão recusada: token ausente ou inválido");
      client.disconnect(true);
    }
  }
}
