import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import {
  type AddIntegrationRequest,
  CHANNEL_LABEL,
  INTEGRATION_TYPES,
  type IntegrationDto,
  type IntegrationsDto,
  type IntegrationType,
  type WhatsAppSignupRequest,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { CardapioWebClient } from "../connectors/cardapio-web.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { type CardapioWebImportJob, QUEUES } from "../queues/queues.module.js";
import { isTenantAdmin, requireTenantAdmin } from "./tenant-admin.js";

/** O que vai para o canal depois de a credencial ser conferida no sistema de origem. */
type VerifiedChannel = { type: IntegrationType; externalId: string; name: string; secrets: Record<string, string> };

const SELECT = { id: true, type: true, name: true, externalId: true, status: true } as const;

/** O que o `state` do login do Instagram carrega: quem pediu, para qual restaurante e até quando vale. */
const LoginState = z.object({ tenantId: z.uuid(), userId: z.uuid(), exp: z.number() });
const LOGIN_STATE_TTL_MS = 10 * 60_000;

/** Volta do login do Instagram: os parâmetros que o Instagram põe no endereço de retorno. */
export type InstagramCallback = { code?: string; state?: string; error?: string };

/**
 * Integrações do restaurante (Configurações → Integrações): WhatsApp, Instagram, iFood e Cardápio Web, várias de cada.
 * Cada integração é um canal; as credenciais ficam cifradas e nunca voltam para o painel.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly key: Buffer;
  private readonly cardapioWeb: CardapioWebClient;

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    @InjectQueue(QUEUES.cardapioWeb) private readonly cardapioWebQueue: Queue,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
    this.cardapioWeb = new CardapioWebClient(env);
  }

  async list(auth: RequestAuth, tenantId: string): Promise<IntegrationsDto> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    const channels = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) =>
      tx.channel.findMany({
        where: { tenantId, type: { in: [...INTEGRATION_TYPES] } },
        select: SELECT,
        orderBy: [{ type: "asc" }, { name: "asc" }],
      }),
    );
    return {
      tenantId,
      canEdit: isTenantAdmin(auth, tenantId),
      platform: {
        ifood: Boolean(this.env.IFOOD_CLIENT_ID && this.env.IFOOD_CLIENT_SECRET),
        cardapioWeb: this.cardapioWeb.configured,
        instagramLogin: Boolean(this.env.INSTAGRAM_APP_ID && this.env.INSTAGRAM_APP_SECRET),
        whatsappSignup:
          this.env.META_APP_ID && this.env.META_APP_SECRET && this.env.META_EMBEDDED_SIGNUP_CONFIG_ID
            ? { appId: this.env.META_APP_ID, configId: this.env.META_EMBEDDED_SIGNUP_CONFIG_ID }
            : null,
      },
      integrations: channels.map(toDto),
    };
  }

  /**
   * Confere a credencial e cadastra a integração; a mesma conta já conectada aqui só tem a credencial atualizada.
   * Loja do Cardápio Web conectada: a base de clientes dela é importada em segundo plano.
   */
  async add(auth: RequestAuth, tenantId: string, body: AddIntegrationRequest): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    const saved = await this.save(tenantId, auth.userId, await this.verify(body));
    if (saved.type === "CARDAPIO_WEB" && this.cardapioWeb.configured) {
      const job: CardapioWebImportJob = { tenantId, channelId: saved.id, page: 1, imported: 0 };
      await this.cardapioWebQueue.add("import-customers", job);
    }
    return saved;
  }

  /** Endereço da tela de login do Instagram; o `state` assinado diz, na volta, para qual restaurante é a conta. */
  instagramLoginUrl(auth: RequestAuth, tenantId: string): { url: string } {
    requireTenantAdmin(auth, tenantId);
    if (!this.env.INSTAGRAM_APP_ID || !this.env.INSTAGRAM_APP_SECRET) {
      throw new UnprocessableEntityException("O login do Instagram não está configurado neste servidor.");
    }
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.env.INSTAGRAM_APP_ID,
      redirect_uri: this.instagramRedirectUri(),
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages",
      state: this.signLoginState({ tenantId, userId: auth.userId }),
      // Sempre a tela de usuário e senha, mesmo com outra conta já aberta no navegador.
      force_authentication: "1",
    }).toString();
    return { url: url.toString() };
  }

  /** Volta do login do Instagram: conecta a conta e devolve para onde mandar o navegador (a aba Integrações). */
  async finishInstagramLogin(query: InstagramCallback): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.env.WEB_ORIGIN}/configuracoes/integracoes?${new URLSearchParams({ instagram: "erro", ...params }).toString()}`;
    const state = query.state ? this.readLoginState(query.state) : null;
    if (!state) return back({ motivo: "O login expirou. Tente conectar de novo." });
    if (query.error || !query.code) return back({ motivo: "O login no Instagram foi cancelado." });
    try {
      const accessToken = await this.connectors.instagram.exchangeLoginCode(query.code, this.instagramRedirectUri());
      await this.save(state.tenantId, state.userId, await this.verify({ type: "INSTAGRAM", accessToken }));
      return back({ instagram: "conectado" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Login do Instagram não concluído: ${reason}`);
      return back({ motivo: error instanceof HttpException ? reason : `Não foi possível conectar o Instagram: ${reason.replace(/\.$/, "")}.` });
    }
  }

  /** Fim do cadastro incorporado do WhatsApp: troca o código pelo token, registra o número novo e conecta. */
  async whatsappSignup(auth: RequestAuth, tenantId: string, body: WhatsAppSignupRequest): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    let verified: VerifiedChannel;
    try {
      const whatsapp = this.connectors.whatsapp;
      const accessToken = await whatsapp.exchangeSignupCode(body.code);
      const wabaId = body.wabaId ?? (await whatsapp.findSignupWaba(accessToken));
      const phoneNumberId = body.phoneNumberId ?? (await whatsapp.findPhoneNumber(wabaId, accessToken));
      // Só um número novo é registrado na Cloud API. Na Coexistência ele já funciona no app WhatsApp Business, e
      // um número que já estava na Cloud API recusa um PIN diferente: nesse caso segue com o registro que tem.
      let pin: string | undefined;
      if (body.coexistence === false) {
        pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
        await whatsapp.registerNumber(phoneNumberId, pin, accessToken).catch((error: Error) => {
          this.logger.warn(`Número ${phoneNumberId} não registrado de novo: ${error.message}`);
          pin = undefined;
        });
      }
      const { name } = await whatsapp.connectNumber(phoneNumberId, wabaId, accessToken);
      const secrets = { accessToken, wabaId, tokenUpdatedAt: new Date().toISOString(), ...(pin && { pin }) };
      verified = { type: "WHATSAPP", externalId: phoneNumberId, name, secrets };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UnprocessableEntityException(`Não foi possível conectar o WhatsApp: ${reason.replace(/\.$/, "")}.`);
    }
    return this.save(tenantId, auth.userId, verified);
  }

  /**
   * Desconecta uma conta ou loja: apaga a credencial e deixa de aceitar mensagens, pedidos e envios dela.
   * O canal continua existindo por causa do histórico (conversas e pedidos); conectar a mesma conta de novo o reativa.
   */
  async disconnect(auth: RequestAuth, tenantId: string, channelId: string): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const channel = await tx.channel.findFirst({ where: { id: channelId, tenantId, type: { in: [...INTEGRATION_TYPES] } }, select: { id: true } });
      if (!channel) throw new NotFoundException("Integração não encontrada.");
      const data = { status: "DISCONNECTED" as const, credentials: encrypt(JSON.stringify({}), this.key) };
      return toDto(await tx.channel.update({ where: { id: channel.id }, data, select: SELECT }));
    });
  }

  private async save(tenantId: string, userId: string, verified: VerifiedChannel): Promise<IntegrationDto> {
    const data = { name: verified.name, credentials: encrypt(JSON.stringify(verified.secrets), this.key), status: "CONNECTED" as const };
    try {
      return await this.db.withTenants({ tenantIds: [tenantId], userId }, async (tx) => {
        // A RLS só mostra os canais deste restaurante: uma conta de outro restaurante cai no índice único ao criar.
        const existing = await tx.channel.findFirst({ where: { type: verified.type, externalId: verified.externalId }, select: { id: true } });
        const saved = existing
          ? await tx.channel.update({ where: { id: existing.id }, data, select: SELECT })
          : await tx.channel.create({ data: { tenantId, type: verified.type, externalId: verified.externalId, ...data }, select: SELECT });
        return toDto(saved);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new ConflictException("Esta conta já está conectada a outro restaurante.");
      throw error;
    }
  }

  private async verify(body: AddIntegrationRequest): Promise<VerifiedChannel> {
    const tokenUpdatedAt = new Date().toISOString();
    try {
      switch (body.type) {
        case "WHATSAPP": {
          const { name } = await this.connectors.whatsapp.connectNumber(body.phoneNumberId, body.wabaId, body.accessToken);
          return { type: body.type, externalId: body.phoneNumberId, name, secrets: { accessToken: body.accessToken, wabaId: body.wabaId, tokenUpdatedAt } };
        }
        case "INSTAGRAM": {
          const { accountId, username } = await this.connectors.instagram.connectAccount(body.accessToken);
          return {
            type: body.type,
            externalId: accountId,
            name: username ? `@${username}` : `Instagram ${accountId}`,
            secrets: { accessToken: body.accessToken, tokenUpdatedAt },
          };
        }
        case "IFOOD":
          // A credencial é da plataforma (IFOOD_CLIENT_ID/SECRET): a loja só precisa do merchant id.
          return { type: body.type, externalId: body.merchantId, name: body.name || `iFood ${body.merchantId.slice(0, 8)}`, secrets: {} };
        case "CARDAPIO_WEB":
          // Testa a chave lendo os pedidos da última hora (quando a API do Cardápio Web está ligada neste servidor).
          if (this.cardapioWeb.configured) await this.cardapioWeb.updatedOrders(body.apiKey, new Date(Date.now() - 60 * 60_000));
          return { type: body.type, externalId: body.storeId, name: body.name || `Loja ${body.storeId}`, secrets: { accessToken: body.apiKey } };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const detail = /HTTP 40[13]/.test(reason) ? "a credencial não foi aceita" : reason.replace(/\.$/, "");
      throw new UnprocessableEntityException(`Não foi possível conectar o ${CHANNEL_LABEL[body.type]}: ${detail}.`);
    }
  }

  private instagramRedirectUri(): string {
    return this.env.INSTAGRAM_REDIRECT_URI ?? `${this.env.WEB_ORIGIN}/api/integrations/instagram/callback`;
  }

  private signLoginState(data: { tenantId: string; userId: string }): string {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + LOGIN_STATE_TTL_MS })).toString("base64url");
    return `${payload}.${this.loginStateMac(payload)}`;
  }

  /** Confere a assinatura e a validade do `state`; inválido ou vencido devolve null. */
  private readLoginState(state: string): { tenantId: string; userId: string } | null {
    const [payload = "", mac = ""] = state.split(".");
    const expected = this.loginStateMac(payload);
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = LoginState.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  private loginStateMac(payload: string): string {
    return createHmac("sha256", this.env.JWT_SECRET).update(`instagram-login:${payload}`).digest("base64url");
  }
}

function toDto(channel: { id: string; type: string; name: string; externalId: string; status: IntegrationDto["status"] }): IntegrationDto {
  return { ...channel, type: channel.type as IntegrationType };
}
