import { decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import type { ChannelType } from "@dishdesk/database/enums";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import type { ChannelConnector } from "./connector.js";
import { InstagramConnector } from "./instagram.connector.js";
import { WhatsAppConnector } from "./whatsapp.connector.js";

// accessToken: token do canal; wabaId: conta do WhatsApp (para listar templates); tokenUpdatedAt: quando o token foi salvo ou renovado.
const ChannelSecrets = z.looseObject({
  accessToken: z.string().min(1),
  wabaId: z.string().optional(),
  tokenUpdatedAt: z.iso.datetime().optional(),
});
export type ChannelSecrets = z.infer<typeof ChannelSecrets>;

/** Registro dos conectores e acesso às credenciais (cifradas em repouso, §5.4). */
@Injectable()
export class ConnectorsService {
  private readonly connectors: Map<ChannelType, ChannelConnector>;
  private readonly key: Buffer;
  readonly instagram: InstagramConnector;
  readonly whatsapp: WhatsAppConnector;

  constructor(@Inject(ENV) env: Env) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
    this.instagram = new InstagramConnector(env);
    this.whatsapp = new WhatsAppConnector(env);
    this.connectors = new Map<ChannelType, ChannelConnector>([
      ["WHATSAPP", this.whatsapp],
      ["INSTAGRAM", this.instagram],
    ]);
  }

  get(type: ChannelType): ChannelConnector | undefined {
    return this.connectors.get(type);
  }

  secrets(credentials: Uint8Array): ChannelSecrets {
    return ChannelSecrets.parse(JSON.parse(decrypt(credentials, this.key)));
  }

  seal(secrets: ChannelSecrets): Uint8Array<ArrayBuffer> {
    return encrypt(JSON.stringify(secrets), this.key);
  }
}
