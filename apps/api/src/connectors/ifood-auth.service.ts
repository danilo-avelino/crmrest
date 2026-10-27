import { decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { ConnectorsService } from "./connectors.service.js";
import { IfoodClient, IfoodError, type IfoodGrant, type IfoodMerchant } from "./ifood.client.js";

/** Acesso de uma loja (aplicativo distribuído), como fica cifrado no canal. */
const StoredGrant = z.looseObject({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.iso.datetime() });

/** Canal de uma loja do iFood. */
export type IfoodStore = { id: string; tenantId: string };

/** Código de vinculação para o painel: `state` leva, cifrado, o verificador que a troca pelo acesso exige. */
export type IfoodLinkCode = { userCode: string; verificationUrl: string; expiresIn: number; state: string };

/**
 * Credencial do iFood. Centralizado: a da plataforma vale para todas as lojas. Distribuído (IFOOD_APP_TYPE): cada loja
 * autoriza o Dish Desk com um código de vinculação e tem o próprio acesso, renovado aqui antes de vencer.
 */
@Injectable()
export class IfoodAuthService {
  private readonly logger = new Logger(IfoodAuthService.name);
  /** Credencial da plataforma: chamadas do centralizado e a autorização das lojas no distribuído. */
  readonly platform: IfoodClient;
  readonly distributed: boolean;
  private readonly key: Buffer;
  /**
   * Acessos já lidos do banco, por canal. A renovação em andamento, por refreshToken, é dividida por quem pedir ao mesmo
   * tempo, inclusive as lojas conectadas pela mesma autorização.
   */
  private readonly grants = new Map<string, IfoodGrant>();
  private readonly refreshing = new Map<string, Promise<IfoodGrant>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.platform = new IfoodClient(env);
    this.distributed = env.IFOOD_APP_TYPE === "distributed";
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  get configured(): boolean {
    return this.platform.configured;
  }

  /** Cliente da Merchant API para a loja: no distribuído, com o acesso dela. */
  clientFor(store: IfoodStore): IfoodClient {
    if (!this.distributed) return this.platform;
    return new IfoodClient(this.env, async () => (await this.grantOf(store)).accessToken);
  }

  /** Cliente com um acesso recém-obtido, antes de a loja virar canal (conferência ao conectar). */
  clientWith(grant: IfoodGrant): IfoodClient {
    return new IfoodClient(this.env, () => Promise.resolve(grant.accessToken));
  }

  async linkCode(): Promise<IfoodLinkCode> {
    const code = await this.platform.userCode();
    return {
      userCode: code.userCode,
      verificationUrl: code.verificationUrlComplete,
      expiresIn: code.expiresIn,
      state: Buffer.from(encrypt(code.authorizationCodeVerifier, this.key)).toString("base64url"),
    };
  }

  /** Troca o código de autorização do Portal do Parceiro pelo acesso da loja. `state` veio de `linkCode`. */
  async authorize(authorizationCode: string, state: string): Promise<IfoodGrant> {
    let verifier: string;
    try {
      verifier = decrypt(Buffer.from(state, "base64url"), this.key);
    } catch {
      throw new Error("o código de vinculação não é válido, gere um novo");
    }
    return this.platform.grant({ authorizationCode, verifier }).catch((error: unknown) => {
      if (error instanceof IfoodError) throw new Error("o código de autorização não foi aceito (gere um novo código de vinculação)");
      throw error;
    });
  }

  /**
   * Lojas que um acesso recém-obtido enxerga, para o restaurante não precisar informar o ID: pela lista de lojas (exige
   * o módulo Merchant) ou pela claim `merchant_scope` do token ("<id>:<módulo>"). O acesso de quem responde por várias
   * lojas traz todas elas; `connected` marca as que já estão conectadas a este restaurante, e `elsewhere`, as que estão
   * em outro. Vazio quando nada diz (o motivo fica no log).
   */
  async storesOf(grant: IfoodGrant, tenantId: string): Promise<(IfoodMerchant & { connected: boolean; elsewhere: boolean })[]> {
    let listed: string;
    let stores: IfoodMerchant[] = [];
    try {
      stores = await this.clientWith(grant).merchants();
      listed = `${stores.length} lojas`;
    } catch (error) {
      listed = error instanceof Error ? error.message : String(error);
    }
    const claims = tokenClaims(grant.accessToken);
    if (!stores.length) {
      const scoped = new Set(z.array(z.string()).catch([]).parse(claims?.merchant_scope).map((scope) => scope.split(":")[0] ?? ""));
      stores = [...scoped].filter(Boolean).map((id) => ({ id }));
    }
    if (!stores.length) {
      this.logger.warn(`iFood: loja do acesso não identificada (lista de lojas: ${listed}; claims do token: ${Object.keys(claims ?? {}).join(", ") || "nenhuma"})`);
      return [];
    }
    const connected = await this.db.client.$queryRaw<{ tenant_id: string; external_id: string }[]>`SELECT tenant_id, external_id FROM app.ifood_merchants()`;
    return stores.map((store) => {
      const owners = connected.filter((other) => other.external_id === store.id).map((other) => other.tenant_id);
      return { ...store, connected: owners.includes(tenantId), elsewhere: owners.some((owner) => owner !== tenantId) };
    });
  }

  /** O canal deixou de valer (desconectado, conectado de novo): esquece o acesso guardado em memória. */
  forget(channelId: string): void {
    this.grants.delete(channelId);
  }

  /** Acesso da loja, renovado com o refreshToken quando falta menos de 1 minuto para vencer. */
  private async grantOf(store: IfoodStore): Promise<IfoodGrant> {
    let grant = this.grants.get(store.id);
    if (!grant) {
      const channel = await this.db.withTenants({ tenantIds: [store.tenantId] }, (tx) =>
        tx.channel.findUniqueOrThrow({ where: { id: store.id }, select: { credentials: true } }),
      );
      const stored = StoredGrant.safeParse(JSON.parse(decrypt(channel.credentials, this.key)));
      // Loja conectada antes do distribuído (sem acesso próprio): como um acesso recusado, precisa conectar de novo.
      if (!stored.success) throw new IfoodError(`canal ${store.id} sem acesso guardado`, 401);
      grant = stored.data;
      this.grants.set(store.id, grant);
    }
    if (new Date(grant.expiresAt).getTime() > Date.now() + 60_000) return grant;

    const { refreshToken } = grant;
    let pending = this.refreshing.get(refreshToken);
    if (!pending) {
      pending = this.refresh(store, refreshToken).finally(() => this.refreshing.delete(refreshToken));
      this.refreshing.set(refreshToken, pending);
    }
    return pending;
  }

  /** Renova o acesso e o grava em todas as lojas do restaurante que o dividem (conectadas pela mesma autorização). */
  private async refresh(store: IfoodStore, refreshToken: string): Promise<IfoodGrant> {
    const grant = await this.platform.grant({ refreshToken });
    await this.db.withTenants({ tenantIds: [store.tenantId] }, async (tx) => {
      const channels = await tx.channel.findMany({ where: { tenantId: store.tenantId, type: "IFOOD" }, select: { id: true, credentials: true } });
      const sharing = channels.filter(
        (channel) => channel.id === store.id || StoredGrant.safeParse(JSON.parse(decrypt(channel.credentials, this.key))).data?.refreshToken === refreshToken,
      );
      for (const channel of sharing) {
        await tx.channel.update({ where: { id: channel.id }, data: { credentials: this.connectors.seal(grant) } });
        this.grants.set(channel.id, grant);
      }
    });
    return grant;
  }
}

/** Claims do token do iFood (JWT), sem conferir a assinatura: servem só para achar a loja do acesso. */
function tokenClaims(token: string): Record<string, unknown> | null {
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
  } catch {
    return null;
  }
}
