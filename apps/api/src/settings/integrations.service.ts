import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import {
  type AddIntegrationRequest,
  type AddIntegrationResponse,
  CHANNEL_LABEL,
  formatPhone,
  type IfoodStoresRequest,
  type IfoodStoresResultDto,
  INTEGRATION_TYPES,
  type IntegrationDto,
  type IntegrationsDto,
  type IntegrationType,
  phoneFromWhatsAppId,
  SERVING_TYPES,
  TRIAL_REUSE_DAYS,
  type WhatsAppQrDto,
  type WhatsAppSignupRequest,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
import { IfoodError, type IfoodGrant, type IfoodMerchant } from "../connectors/ifood.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { IfoodAuthService, type IfoodLinkCode } from "../connectors/ifood-auth.service.js";
import { DatabaseService } from "../core/database.service.js";
import { type CardapioWebImportJob, QUEUES } from "../queues/queues.module.js";
import { isTenantAdmin, requireTenantAdmin } from "./tenant-admin.js";

/** O que vai para o canal depois de a credencial ser conferida no sistema de origem. */
type VerifiedChannel = {
  type: IntegrationType;
  externalId: string;
  name: string;
  secrets: Record<string, string>;
  /** Vencimento do token (WhatsApp e Instagram); sem ele, não vence ou não deu para conferir. */
  tokenExpiresAt?: Date | null;
};

const SELECT = { id: true, type: true, name: true, externalId: true, status: true, servedTenantIds: true, tokenExpiresAt: true } as const;

/** Tokens de longa duração do Instagram valem 60 dias (o job semanal os renova). */
const INSTAGRAM_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/** Autorização do iFood com mais de uma loja: em vez de conectar, `add` devolve as lojas para o restaurante escolher. */
class IfoodStoreChoice {
  constructor(
    readonly grant: IfoodGrant,
    readonly stores: (IfoodMerchant & { connected: boolean; elsewhere: boolean })[],
  ) {}
}

/** O que a escolha de lojas do iFood carrega, cifrado, entre a autorização e a escolha. */
const IfoodSelection = z.object({
  tenantId: z.uuid(),
  grant: z.object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.string() }),
  stores: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  exp: z.number(),
});
type IfoodSelection = z.infer<typeof IfoodSelection>;
const SELECTION_TTL_MS = 10 * 60_000;

/** O que o `state` do login do Instagram carrega: quem pediu, para qual restaurante e até quando vale. */
/** `from`: o login foi aberto pelo assistente de configuração, e a volta é para ele. */
/** `nonce`: o mesmo valor vai num cookie do navegador que abriu o login; a volta sem ele não conecta a conta. */
const LoginState = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  from: z.literal("assistente").optional(),
  nonce: z.string(),
  exp: z.number(),
});
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
    private readonly ifood: IfoodAuthService,
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
        where: { tenantId, deletedAt: null, type: { in: [...INTEGRATION_TYPES] } },
        select: SELECT,
        orderBy: [{ type: "asc" }, { name: "asc" }],
      }),
    );
    const canEdit = isTenantAdmin(auth, tenantId);
    return {
      tenantId,
      canEdit,
      platform: {
        ifood: Boolean(this.env.IFOOD_CLIENT_ID && this.env.IFOOD_CLIENT_SECRET),
        ifoodLinkCode: this.ifood.configured && this.ifood.distributed,
        cardapioWeb: this.cardapioWeb.configured,
        instagramLogin: Boolean(this.env.INSTAGRAM_APP_ID && this.env.INSTAGRAM_APP_SECRET),
        whatsappSignup:
          this.env.META_APP_ID && this.env.META_APP_SECRET && this.env.META_EMBEDDED_SIGNUP_CONFIG_ID
            ? { appId: this.env.META_APP_ID, configId: this.env.META_EMBEDDED_SIGNUP_CONFIG_ID }
            : null,
        whatsappQr: this.connectors.evolution.configured,
      },
      integrations: channels.map(toDto),
      servableTenants: canEdit ? await this.servableTenants(auth.userId, tenantId) : [],
    };
  }

  /**
   * WhatsApp ou Instagram que atende várias unidades: a busca de pedidos do atendimento procura também nos restaurantes
   * escolhidos. Só entram restaurantes de que o administrador também é administrador (outra empresa não é ligada por
   * engano); a lista substitui a anterior.
   */
  async setServedTenants(auth: RequestAuth, tenantId: string, channelId: string, tenantIds: string[]): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    const allowed = new Set((await this.servableTenants(auth.userId, tenantId)).map((tenant) => tenant.id));
    const served = [...new Set(tenantIds)].filter((id) => id !== tenantId);
    if (served.some((id) => !allowed.has(id))) throw new ForbiddenException("Só dá para escolher restaurantes de que você é administrador.");
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const channel = await tx.channel.findFirst({
        where: { id: channelId, tenantId, deletedAt: null, type: { in: [...SERVING_TYPES] } },
        select: { id: true },
      });
      if (!channel) throw new NotFoundException("Integração não encontrada.");
      return toDto(await tx.channel.update({ where: { id: channel.id }, data: { servedTenantIds: served }, select: SELECT }));
    });
  }

  /** Outros restaurantes ativos de que o usuário é administrador. */
  private async servableTenants(userId: string, tenantId: string): Promise<{ id: string; name: string }[]> {
    const memberships = await this.db.withTenants({ tenantIds: [tenantId], userId }, (tx) =>
      tx.tenantMember.findMany({
        where: { userId, role: "ADMIN", isActive: true, tenantId: { not: tenantId }, tenant: { status: "ACTIVE" } },
        select: { tenant: { select: { id: true, name: true } } },
        orderBy: { tenant: { name: "asc" } },
      }),
    );
    return memberships.map((membership) => membership.tenant);
  }

  /**
   * Confere a credencial e cadastra a integração; a mesma conta já conectada aqui só tem a credencial atualizada.
   * Loja do Cardápio Web conectada: a base de clientes dela é importada em segundo plano.
   */
  async add(auth: RequestAuth, tenantId: string, body: AddIntegrationRequest): Promise<AddIntegrationResponse> {
    requireTenantAdmin(auth, tenantId);
    let verified: VerifiedChannel;
    try {
      verified = await this.verify(body, tenantId);
    } catch (error) {
      // iFood com várias lojas na autorização: o restaurante escolhe quais conectar (addIfoodStores).
      if (error instanceof IfoodStoreChoice) {
        return {
          ifoodStores: error.stores.map(({ id, name, connected, elsewhere }) => ({ id, name: name ?? null, connected, elsewhere })),
          selection: this.sealSelection(tenantId, error),
        };
      }
      throw error;
    }
    const saved = await this.save(tenantId, auth.userId, verified);
    if (saved.type === "CARDAPIO_WEB" && this.cardapioWeb.configured) {
      const job: CardapioWebImportJob = { tenantId, channelId: saved.id, page: 1, imported: 0 };
      await this.cardapioWebQueue.add("import-customers", job);
    }
    return saved;
  }

  /**
   * iFood distribuído: conecta as lojas escolhidas entre as que vieram na autorização, todas com o mesmo acesso. Uma
   * loja recusada (fora da autorização) não impede as outras.
   */
  async addIfoodStores(auth: RequestAuth, tenantId: string, body: IfoodStoresRequest): Promise<IfoodStoresResultDto> {
    requireTenantAdmin(auth, tenantId);
    const selection = this.openSelection(tenantId, body.selection);
    if (!selection) throw new UnprocessableEntityException("A escolha das lojas expirou. Gere um novo código e autorize de novo.");
    const client = this.ifood.clientWith(selection.grant);
    const result: IfoodStoresResultDto = { connected: [], failed: [] };
    for (const { id, name } of body.stores) {
      try {
        const store = selection.stores.find((candidate) => candidate.id === id);
        // A loja só entra se o acesso a enxerga (senão o polling seria recusado).
        if (!store || !(await client.authorizes(id))) throw new UnprocessableEntityException("A autorização não inclui essa loja.");
        const verified = { type: "IFOOD" as const, externalId: id, name: name || store.name || `iFood ${id.slice(0, 8)}`, secrets: selection.grant };
        result.connected.push(await this.save(tenantId, auth.userId, verified));
      } catch (error) {
        // Teste grátis repetido: o restaurante acabou de ser bloqueado, e a tela de pagamento explica o motivo.
        if (error instanceof HttpException && error.getStatus() === HttpStatus.PAYMENT_REQUIRED) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        result.failed.push({ id, message: error instanceof HttpException ? reason : `Não foi possível conectar: ${reason.replace(/\.$/, "")}.` });
      }
    }
    return result;
  }

  /** iFood distribuído: código de vinculação para o responsável pela loja autorizar o Dish Desk no Portal do Parceiro. */
  async ifoodLinkCode(auth: RequestAuth, tenantId: string): Promise<IfoodLinkCode> {
    requireTenantAdmin(auth, tenantId);
    if (!this.ifood.configured || !this.ifood.distributed) {
      throw new UnprocessableEntityException("O código de vinculação do iFood não está configurado neste servidor.");
    }
    try {
      return await this.ifood.linkCode();
    } catch (error) {
      this.logger.warn(`Código de vinculação do iFood não gerado: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnprocessableEntityException("O iFood não gerou o código agora. Tente de novo em instantes.");
    }
  }

  /**
   * Endereço da tela de login do Instagram; o `state` assinado diz, na volta, para qual restaurante é a conta.
   * `nonce`: o controller o guarda num cookie, para a volta só valer no navegador que pediu o login.
   */
  instagramLoginUrl(auth: RequestAuth, tenantId: string, from?: "assistente"): { url: string; nonce: string } {
    requireTenantAdmin(auth, tenantId);
    if (!this.env.INSTAGRAM_APP_ID || !this.env.INSTAGRAM_APP_SECRET) {
      throw new UnprocessableEntityException("O login do Instagram não está configurado neste servidor.");
    }
    const nonce = randomBytes(16).toString("base64url");
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: this.env.INSTAGRAM_APP_ID,
      redirect_uri: this.instagramRedirectUri(),
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages",
      state: this.signLoginState({ tenantId, userId: auth.userId, nonce, ...(from && { from }) }),
      // Sempre a tela de usuário e senha, mesmo com outra conta já aberta no navegador.
      force_authentication: "1",
    }).toString();
    return { url: url.toString(), nonce };
  }

  /**
   * Volta do login do Instagram: conecta a conta e devolve para onde mandar o navegador (a aba Integrações ou o assistente).
   * `nonce`: o do cookie do navegador; sem ele, ou diferente do `state`, o login não foi aberto aqui e nada é conectado.
   */
  async finishInstagramLogin(query: InstagramCallback, nonce: string | undefined): Promise<string> {
    const state = query.state ? this.readLoginState(query.state) : null;
    const back = (params: Record<string, string>) =>
      state?.from === "assistente"
        ? `${this.env.WEB_ORIGIN}/assistente?${new URLSearchParams({ restaurante: state.tenantId, instagram: "erro", ...params }).toString()}`
        : `${this.env.WEB_ORIGIN}/configuracoes/integracoes?${new URLSearchParams({ instagram: "erro", ...params }).toString()}`;
    if (!state) return back({ motivo: "O login expirou. Tente conectar de novo." });
    if (!nonce || !safeEqual(nonce, state.nonce)) {
      return back({ motivo: "O login do Instagram foi aberto em outro navegador. Conecte de novo por aqui." });
    }
    if (query.error || !query.code) return back({ motivo: "O login no Instagram foi cancelado." });
    try {
      const accessToken = await this.connectors.instagram.exchangeLoginCode(query.code, this.instagramRedirectUri());
      const saved = await this.save(state.tenantId, state.userId, await this.verify({ type: "INSTAGRAM", accessToken }, state.tenantId));
      // A conta conectada volta no endereço: o painel pergunta em seguida quais restaurantes ela atende.
      return back({ instagram: "conectado", canal: saved.id });
    } catch (error) {
      // Teste grátis repetido: o restaurante acabou de ser bloqueado, e a tela de pagamento explica o motivo.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.PAYMENT_REQUIRED) {
        return `${this.env.WEB_ORIGIN}/assinatura?restaurante=${state.tenantId}`;
      }
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
      const accessToken = await whatsapp.exchangeSignupCode(body.code, body.redirectUri);
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
      verified = { type: "WHATSAPP", externalId: phoneNumberId, name, secrets, tokenExpiresAt: await this.whatsappTokenExpiry(accessToken) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UnprocessableEntityException(`Não foi possível conectar o WhatsApp: ${reason.replace(/\.$/, "")}.`);
    }
    return this.save(tenantId, auth.userId, verified);
  }

  /**
   * WhatsApp por QR Code: cria uma instância na Evolution e devolve o QR Code. A `session` (o nome da instância) começa
   * pelo id do restaurante: é o que prova, na leitura seguinte, de quem é a tentativa.
   */
  async whatsappQrStart(auth: RequestAuth, tenantId: string): Promise<WhatsAppQrDto> {
    requireTenantAdmin(auth, tenantId);
    if (!this.connectors.evolution.configured) {
      throw new UnprocessableEntityException("A conexão do WhatsApp por QR Code não está configurada neste servidor.");
    }
    const session = `${tenantId}-${randomBytes(6).toString("hex")}`;
    try {
      return { status: "waiting", session, qr: await this.connectors.evolution.createInstance(session) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new UnprocessableEntityException(`Não foi possível gerar o QR Code: ${reason.replace(/\.$/, "")}.`);
    }
  }

  /**
   * O painel lê de tempos em tempos: enquanto o número não conecta, devolve o QR Code atual. Conectado, o número vira
   * a integração (o mesmo número de antes só troca de instância, e a antiga é apagada). Recusado (número de outro
   * restaurante, teste grátis repetido), a instância é apagada: ela não pode ficar recebendo mensagens.
   */
  async whatsappQrStatus(auth: RequestAuth, tenantId: string, session: string): Promise<WhatsAppQrDto> {
    requireTenantAdmin(auth, tenantId);
    this.requireQrSession(tenantId, session);
    const evolution = this.connectors.evolution;
    let connection: Awaited<ReturnType<typeof evolution.connection>>;
    try {
      connection = await evolution.connection(session);
    } catch (error) {
      this.logger.warn(`QR Code do WhatsApp indisponível: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnprocessableEntityException("Esta tentativa de conexão expirou. Gere outro QR Code.");
    }
    if (connection.state === "waiting") return { status: "waiting", session, qr: connection.qr };

    const phone = formatPhone(phoneFromWhatsAppId(connection.ownerId));
    const verified: VerifiedChannel = {
      type: "WHATSAPP",
      externalId: connection.ownerId,
      name: connection.name ? `${connection.name} (${phone})` : phone,
      secrets: { accessToken: evolution.instanceToken(session), instance: session },
    };
    const previous = (await this.whatsappInstances(auth, tenantId, connection.ownerId))[0];
    let integration: IntegrationDto;
    try {
      integration = await this.save(tenantId, auth.userId, verified);
    } catch (error) {
      await this.dropInstance(session);
      throw error;
    }
    if (previous && previous !== session) await this.dropInstance(previous);
    return { status: "connected", session, integration };
  }

  /** Fechou o QR Code sem conectar: apaga a instância (a não ser que o número tenha conectado nesse meio tempo). */
  async whatsappQrCancel(auth: RequestAuth, tenantId: string, session: string): Promise<void> {
    requireTenantAdmin(auth, tenantId);
    this.requireQrSession(tenantId, session);
    if ((await this.whatsappInstances(auth, tenantId)).includes(session)) return;
    await this.dropInstance(session);
  }

  private requireQrSession(tenantId: string, session: string): void {
    if (!session.startsWith(`${tenantId}-`)) throw new NotFoundException("Tentativa de conexão não encontrada.");
  }

  /** Instâncias da Evolution dos WhatsApps deste restaurante (só do número informado, se houver). */
  private async whatsappInstances(auth: RequestAuth, tenantId: string, externalId?: string): Promise<string[]> {
    const channels = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) =>
      tx.channel.findMany({ where: { tenantId, type: "WHATSAPP", ...(externalId && { externalId }) }, select: { credentials: true } }),
    );
    return channels.flatMap((channel) => instanceOf(this.connectors, channel.credentials) ?? []);
  }

  /** Apaga uma instância da Evolution; se falhar, só registra (ela fica sem canal e os webhooks dela são ignorados). */
  private async dropInstance(instance: string): Promise<void> {
    await this.connectors.evolution.deleteInstance(instance).catch((error: Error) => {
      this.logger.warn(`Instância ${instance} da Evolution não apagada: ${error.message}`);
    });
  }

  /**
   * Desconecta uma conta ou loja: apaga a credencial e deixa de aceitar mensagens, pedidos e envios dela.
   * O canal continua existindo por causa do histórico (conversas e pedidos); conectar a mesma conta de novo o reativa.
   */
  disconnect(auth: RequestAuth, tenantId: string, channelId: string): Promise<IntegrationDto> {
    return this.turnOff(auth, tenantId, channelId, {});
  }

  /**
   * Exclui uma integração: além de desconectada, ela some de Configurações → Integrações e dos avisos da Inbox.
   * O canal continua no banco, escondido, por causa do histórico e da trava do teste grátis repetido (app.claim_channel);
   * conectar a mesma conta de novo o traz de volta.
   */
  async remove(auth: RequestAuth, tenantId: string, channelId: string): Promise<void> {
    await this.turnOff(auth, tenantId, channelId, { deletedAt: new Date() });
  }

  /** Troca o nome que a integração mostra no painel e na Inbox. */
  rename(auth: RequestAuth, tenantId: string, channelId: string, name: string): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const channel = await tx.channel.findFirst({
        where: { id: channelId, tenantId, deletedAt: null, type: { in: [...INTEGRATION_TYPES] } },
        select: { id: true },
      });
      if (!channel) throw new NotFoundException("Integração não encontrada.");
      return toDto(await tx.channel.update({ where: { id: channel.id }, data: { name }, select: SELECT }));
    });
  }

  private async turnOff(auth: RequestAuth, tenantId: string, channelId: string, extra: { deletedAt?: Date }): Promise<IntegrationDto> {
    requireTenantAdmin(auth, tenantId);
    const { saved, instance } = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const channel = await tx.channel.findFirst({
        where: { id: channelId, tenantId, deletedAt: null, type: { in: [...INTEGRATION_TYPES] } },
        select: { id: true, credentials: true },
      });
      if (!channel) throw new NotFoundException("Integração não encontrada.");
      const data = { status: "DISCONNECTED" as const, credentials: encrypt(JSON.stringify({}), this.key), ...extra };
      const saved = toDto(await tx.channel.update({ where: { id: channel.id }, data, select: SELECT }));
      return { saved, instance: instanceOf(this.connectors, channel.credentials) };
    });
    // WhatsApp por QR Code: o aparelho do Dish Desk sai de "Aparelhos conectados" no celular do restaurante.
    if (instance) await this.dropInstance(instance);
    return saved;
  }

  private async save(tenantId: string, userId: string, verified: VerifiedChannel): Promise<IntegrationDto> {
    await this.claim(tenantId, userId, verified);
    // deletedAt: a conta de uma integração excluída volta para o painel, no mesmo canal.
    const data = {
      name: verified.name,
      credentials: encrypt(JSON.stringify(verified.secrets), this.key),
      status: "CONNECTED" as const,
      deletedAt: null,
      tokenExpiresAt: verified.tokenExpiresAt ?? null,
    };
    try {
      return await this.db.withTenants({ tenantIds: [tenantId], userId }, async (tx) => {
        // A RLS só mostra os canais deste restaurante: uma conta de outro restaurante cai no índice único ao criar.
        const existing = await tx.channel.findFirst({
          where: { type: verified.type, externalId: verified.externalId },
          select: { id: true, status: true, deletedAt: true },
        });
        // Conectada agora (nova, ou de volta depois de desconectada ou com erro): o que veio antes não aciona automações.
        const connectedAt = !existing || existing.status !== "CONNECTED" || existing.deletedAt ? new Date() : undefined;
        const saved = existing
          ? await tx.channel.update({ where: { id: existing.id }, data: { ...data, connectedAt }, select: SELECT })
          : await tx.channel.create({ data: { tenantId, type: verified.type, externalId: verified.externalId, ...data, connectedAt }, select: SELECT });
        // Loja do iFood conectada de novo: o acesso antigo guardado em memória não vale mais.
        if (verified.type === "IFOOD") this.ifood.forget(saved.id);
        return toDto(saved);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new ConflictException("Esta conta já está conectada a outro restaurante.");
      throw error;
    }
  }

  /**
   * Conta que está em outro restaurante (app.claim_channel): fica com quem a autorizou por último, e o outro restaurante
   * a perde (com o histórico). Trava do teste grátis repetido: se este restaurante está em teste e a conta já passou por
   * outro teste há menos de TRIAL_REUSE_DAYS dias, o teste daqui é encerrado. Roda numa transação própria: o bloqueio tem
   * de ficar gravado mesmo com a conexão recusada.
   */
  private async claim(tenantId: string, userId: string, verified: VerifiedChannel): Promise<void> {
    const empty = encrypt(JSON.stringify({}), this.key);
    const [claim] = await this.db.withTenants({ tenantIds: [tenantId], userId }, (tx) =>
      tx.$queryRaw<{ result: "free" | "trial_used"; released: Uint8Array | null }[]>`
        SELECT * FROM app.claim_channel(
          ${tenantId}::uuid, ${verified.type}::"ChannelType", ${verified.externalId}, ${TRIAL_REUSE_DAYS}::int, ${empty}::bytea
        )`,
    );
    if (claim?.result === "trial_used") {
      throw new HttpException(
        `Esta conta já foi usada em um teste grátis nos últimos ${TRIAL_REUSE_DAYS} dias. Para continuar, assine um plano.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    // WhatsApp por QR Code tirado de outro restaurante: o aparelho antigo sai de "Aparelhos conectados" no celular.
    const instance = claim?.released ? instanceOf(this.connectors, claim.released) : null;
    if (instance) await this.dropInstance(instance);
  }

  private async verify(body: AddIntegrationRequest, tenantId: string): Promise<VerifiedChannel> {
    const tokenUpdatedAt = new Date().toISOString();
    try {
      switch (body.type) {
        case "WHATSAPP": {
          const { name } = await this.connectors.whatsapp.connectNumber(body.phoneNumberId, body.wabaId, body.accessToken);
          return {
            type: body.type,
            externalId: body.phoneNumberId,
            name,
            secrets: { accessToken: body.accessToken, wabaId: body.wabaId, tokenUpdatedAt },
            tokenExpiresAt: await this.whatsappTokenExpiry(body.accessToken),
          };
        }
        case "INSTAGRAM": {
          const { accountId, username } = await this.connectors.instagram.connectAccount(body.accessToken);
          return {
            type: body.type,
            externalId: accountId,
            name: username ? `@${username}` : `Instagram ${accountId}`,
            secrets: { accessToken: body.accessToken, tokenUpdatedAt },
            // O token acabou de sair do login; a primeira renovação corrige a data se ele for mais antigo (colado à mão).
            tokenExpiresAt: new Date(Date.now() + INSTAGRAM_TOKEN_LIFETIME_MS),
          };
        }
        case "IFOOD": {
          // Centralizado: a credencial é da plataforma (IFOOD_CLIENT_ID/SECRET) e o restaurante informa o ID da loja.
          // Distribuído: o código de autorização do Portal do Parceiro vira o acesso, e a loja é a que esse acesso enxerga.
          // Com mais de uma loja ainda fora deste restaurante, o restaurante escolhe quais conectar (IfoodStoreChoice); a
          // loja que está em outro restaurante sai de lá. O ID só é pedido quando o iFood não diz qual é.
          let grant: IfoodGrant | null = null;
          let merchant: IfoodMerchant | null = body.merchantId ? { id: body.merchantId } : null;
          if (this.ifood.configured && this.ifood.distributed) {
            if (!body.authorizationCode || !body.linkState) throw new Error("gere o código de vinculação e informe o código de autorização");
            grant = await this.ifood.authorize(body.authorizationCode, body.linkState);
            if (!merchant) {
              const stores = await this.ifood.storesOf(grant, tenantId);
              const open = stores.filter((store) => !store.connected);
              merchant = (stores.length === 1 ? stores[0] : open.length === 1 ? open[0] : undefined) ?? null;
              if (!merchant && stores.length && !open.length) {
                throw new Error(
                  "a autorização só trouxe lojas que já estão conectadas. Para outra loja, confira no Portal do Parceiro se ela está " +
                    "selecionada ao autorizar e se o seu perfil nela é Dono ou Administrador",
                );
              }
              if (!merchant && stores.length) throw new IfoodStoreChoice(grant, stores);
            }
            if (!merchant) throw new Error("o iFood não disse qual loja foi autorizada: gere um novo código, autorize de novo e informe também o ID da loja");
          }
          if (!merchant) throw new Error("informe o ID da loja");
          // A loja só entra se o acesso a enxerga (senão o polling seria recusado).
          if (this.ifood.configured) {
            const client = grant ? this.ifood.clientWith(grant) : this.ifood.platform;
            const authorized = await client.authorizes(merchant.id).catch((error: unknown) => {
              // 400: o que foi colado não é o ID da loja (UUID); o Portal do iFood também mostra um código numérico.
              if (error instanceof IfoodError && error.status === 400) throw new Error("o ID da loja não é válido (use o ID com letras e traços)");
              throw error;
            });
            if (!authorized) {
              throw new Error(
                grant
                  ? "a autorização não inclui essa loja (confira o ID e quem autorizou no Portal do Parceiro)"
                  : "a loja ainda não autorizou o Dish Desk no Portal do Parceiro do iFood",
              );
            }
          }
          return { type: body.type, externalId: merchant.id, name: body.name || merchant.name || `iFood ${merchant.id.slice(0, 8)}`, secrets: grant ?? {} };
        }
        case "CARDAPIO_WEB":
          // Testa a chave lendo os pedidos da última hora (quando a API do Cardápio Web está ligada neste servidor).
          if (this.cardapioWeb.configured) await this.cardapioWeb.updatedOrders(body.apiKey, new Date(Date.now() - 60 * 60_000));
          return { type: body.type, externalId: body.storeId, name: body.name || `Loja ${body.storeId}`, secrets: { accessToken: body.apiKey } };
      }
    } catch (error) {
      if (error instanceof IfoodStoreChoice) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const detail = /HTTP 40[13]/.test(reason) ? "a credencial não foi aceita" : reason.replace(/\.$/, "");
      throw new UnprocessableEntityException(`Não foi possível conectar o ${CHANNEL_LABEL[body.type]}: ${detail}.`);
    }
  }

  /** Vencimento do token do WhatsApp; se a Meta não responder, a conexão segue e o job diário confere depois. */
  private async whatsappTokenExpiry(accessToken: string): Promise<Date | null> {
    try {
      return (await this.connectors.whatsapp.tokenStatus(accessToken))?.expiresAt ?? null;
    } catch (error) {
      this.logger.warn(`Validade do token do WhatsApp não conferida: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** O acesso e as lojas da autorização, cifrados para o painel devolver com a escolha (vale por 10 minutos). */
  private sealSelection(tenantId: string, choice: IfoodStoreChoice): string {
    const data: IfoodSelection = {
      tenantId,
      grant: choice.grant,
      stores: choice.stores.map(({ id, name }) => ({ id, name: name ?? null })),
      exp: Date.now() + SELECTION_TTL_MS,
    };
    return Buffer.from(encrypt(JSON.stringify(data), this.key)).toString("base64url");
  }

  /** A escolha de lojas que veio do painel; null se adulterada, vencida ou de outro restaurante. */
  private openSelection(tenantId: string, selection: string): IfoodSelection | null {
    try {
      const data = IfoodSelection.parse(JSON.parse(decrypt(Buffer.from(selection, "base64url"), this.key)));
      return data.tenantId === tenantId && data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  private instagramRedirectUri(): string {
    return this.env.INSTAGRAM_REDIRECT_URI ?? `${this.env.WEB_ORIGIN}/api/integrations/instagram/callback`;
  }

  private signLoginState(data: { tenantId: string; userId: string; nonce: string; from?: "assistente" }): string {
    const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + LOGIN_STATE_TTL_MS })).toString("base64url");
    return `${payload}.${this.loginStateMac(payload)}`;
  }

  /** Confere a assinatura e a validade do `state`; inválido ou vencido devolve null. */
  private readLoginState(state: string): { tenantId: string; userId: string; nonce: string; from?: "assistente" } | null {
    const [payload = "", mac = ""] = state.split(".");
    if (!safeEqual(mac, this.loginStateMac(payload))) return null;
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

function safeEqual(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A instância da Evolution guardada nas credenciais (WhatsApp por QR Code); credenciais vazias ou da Meta: null. */
function instanceOf(connectors: ConnectorsService, credentials: Uint8Array): string | null {
  try {
    return connectors.secrets(credentials).instance ?? null;
  } catch {
    return null; // integração desconectada: as credenciais foram apagadas
  }
}

function toDto(channel: {
  id: string;
  type: string;
  name: string;
  externalId: string;
  status: IntegrationDto["status"];
  servedTenantIds: string[];
  tokenExpiresAt: Date | null;
}): IntegrationDto {
  return { ...channel, type: channel.type as IntegrationType, tokenExpiresAt: channel.tokenExpiresAt?.toISOString() ?? null };
}
