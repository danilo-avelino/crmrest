import { parseEncryptionKey } from "@dishdesk/database";
import { automationMessagesOf, fillMessage, toE164 } from "@dishdesk/shared";
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, type OnModuleDestroy, UnauthorizedException } from "@nestjs/common";
import { Redis } from "ioredis";
import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { KEY_PREFIX } from "../auth/login-limits.service.js";
import { ENV, type Env } from "../config/env.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { isDemoTenant } from "../demo/demo.js";
import { linkedOrdersWhere } from "../orders/customer-history.js";
import { customerCoupons } from "./benefits.js";
import { PublicMenuService } from "./public-menu.service.js";

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_MS = 45_000;
/** Códigos por telefone e por IP a cada hora (o limite geral por IP das rotas públicas vale por cima). */
export const OTP_PER_PHONE_HOUR = 5;
export const OTP_PER_IP_HOUR = 20;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "dd_menu_session";

const HOUR_MS = 60 * 60_000;
// Códigos e limites no prefixo do rate limit: os testes começam sem eles.
const otpKey = (tenantId: string, phone: string) => `${KEY_PREFIX}menu-otp:code:${tenantId}:${phone}`;
const cooldownKey = (tenantId: string, phone: string) => `${KEY_PREFIX}menu-otp:cooldown:${tenantId}:${phone}`;
const phoneCountKey = (tenantId: string, phone: string) => `${KEY_PREFIX}menu-otp:phone:${tenantId}:${phone}`;
const ipCountKey = (ip: string) => `${KEY_PREFIX}menu-otp:ip:${ip}`;
const sessionKey = (token: string) => `menu-session:${createHash("sha256").update(token).digest("hex")}`;

const INVALID_CODE = "Código inválido ou vencido. Peça um novo código.";
const NO_SESSION = "Entre com o código enviado ao seu WhatsApp.";

type Session = { tenantId: string; contactId: string };
export type OtpRequestResult = { available: false } | { available: true; expiresInSeconds: number; resendInSeconds: number };

/**
 * Entrada do cliente no cardápio público (F3-05, R1): código de uso único pelo WhatsApp do próprio restaurante (D8).
 * Só o hash do código fica no Redis, com validade de 10 min e 5 tentativas. A resposta do pedido de código é a mesma
 * para telefone conhecido e desconhecido; sem WhatsApp por QR Code conectado, `available: false` e o cardápio oferece
 * o pedido como visitante. A sessão é um token aleatório guardado só como hash, preso ao restaurante e ao cadastro.
 */
@Injectable()
export class CustomerAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(CustomerAuthService.name);
  private readonly redis: Redis;
  private readonly hmacKey: Buffer;

  constructor(
    @Inject(ENV) env: Env,
    private readonly menu: PublicMenuService,
    private readonly connectors: ConnectorsService,
    private readonly db: DatabaseService,
  ) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.hmacKey = Buffer.from(hkdfSync("sha256", parseEncryptionKey(env.ENCRYPTION_KEY), Buffer.alloc(0), "dishdesk:menu-otp", 32));
  }

  private codeHash(tenantId: string, phone: string, code: string): Buffer {
    return createHmac("sha256", this.hmacKey).update(`${tenantId}:${phone}:${code}`).digest();
  }

  private phoneOf(input: string): string {
    const phone = toE164(input);
    if (!phone?.startsWith("+55")) throw new BadRequestException("Informe um celular válido com DDD.");
    return phone;
  }

  async requestCode(slug: string, input: string, ip: string): Promise<OtpRequestResult> {
    const phone = this.phoneOf(input);
    const found = await this.menu.withStore(slug, async (tx, store) => {
      // Só o WhatsApp por QR Code (Evolution) manda texto livre a quem não escreveu nas últimas 24 h.
      const channels = await tx.channel.findMany({ where: { tenantId: store.tenantId, type: "WHATSAPP", status: "CONNECTED" } });
      const channel = channels.map((c) => ({ c, secrets: this.connectors.secrets(c.credentials) })).find((c) => c.secrets.instance);
      return { store, channel, text: automationMessagesOf(store.settings).menuLoginCode };
    });
    const { tenantId } = found.store;
    // Sem WhatsApp por QR Code o código não tem por onde sair; na conta de demonstração, nunca sai.
    if (!found.channel || (await isDemoTenant(this.db, tenantId))) return { available: false };

    if (!(await this.redis.set(cooldownKey(tenantId, phone), "1", "PX", OTP_COOLDOWN_MS, "NX"))) {
      const ttl = await this.redis.pttl(cooldownKey(tenantId, phone));
      throw new HttpException(
        { statusCode: 429, message: "Aguarde para pedir outro código.", retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    for (const [key, limit] of [
      [phoneCountKey(tenantId, phone), OTP_PER_PHONE_HOUR],
      [ipCountKey(ip), OTP_PER_IP_HOUR],
    ] as const) {
      const [[, count]] = (await this.redis.multi().incr(key).pexpire(key, HOUR_MS, "NX").exec()) as [[Error | null, number]];
      if (count > limit) throw new HttpException("Muitos códigos pedidos. Tente de novo mais tarde.", HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const key = otpKey(tenantId, phone);
    await this.redis.multi().del(key).hset(key, { hash: this.codeHash(tenantId, phone, code).toString("hex"), attempts: 0 }).pexpire(key, OTP_TTL_MS).exec();

    const { c: channel, secrets } = found.channel;
    try {
      await this.connectors.evolution.send(
        { externalChannelId: secrets.instance!, recipientId: phone.slice(1), accessToken: secrets.accessToken },
        { type: "TEXT", text: fillMessage(found.text, { codigo: code, loja: found.store.name }) },
      );
    } catch (error) {
      this.logger.warn(`Código do cardápio não enviado pelo canal ${channel.id}: ${error instanceof Error ? error.message : String(error)}`);
      await this.redis.del(key);
      return { available: false };
    }
    return { available: true, expiresInSeconds: OTP_TTL_MS / 1000, resendInSeconds: OTP_COOLDOWN_MS / 1000 };
  }

  /** Código certo: apaga o código, acha ou cria o cadastro pelo telefone (regra 9) e abre a sessão. Devolve o token. */
  async verifyCode(slug: string, input: { phone: string; code: string; name?: string | null; marketingOptIn?: boolean }): Promise<string> {
    const phone = this.phoneOf(input.phone);
    return this.menu.withStore(slug, async (tx, store) => {
      const { tenantId } = store;
      const key = otpKey(tenantId, phone);
      const saved = await this.redis.hgetall(key);
      if (!saved.hash) throw new BadRequestException(INVALID_CODE);
      const attempts = await this.redis.hincrby(key, "attempts", 1);
      const ok = attempts <= OTP_MAX_ATTEMPTS && timingSafeEqual(Buffer.from(saved.hash, "hex"), this.codeHash(tenantId, phone, input.code));
      if (!ok) {
        if (attempts >= OTP_MAX_ATTEMPTS) await this.redis.del(key);
        throw new BadRequestException(INVALID_CODE);
      }
      await this.redis.del(key);

      const name = input.name?.trim() || null;
      const existing = await tx.contact.findFirst({
        where: { tenantId, phone, deletedAt: null },
        orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
        select: { id: true },
      });
      // O código provou o número: o telefone do cadastro novo vem como o de um canal, não como digitado pelo cliente.
      const contact = existing ?? (await tx.contact.create({ data: { tenantId, phone, phoneSource: "channel", name }, select: { id: true } }));
      if (input.marketingOptIn === true) {
        await tx.consent.create({ data: { tenantId, contactId: contact.id, purpose: "marketing_whatsapp", granted: true, source: "menu_otp" } });
      }
      const token = randomBytes(32).toString("base64url");
      await this.redis.set(sessionKey(token), JSON.stringify({ tenantId, contactId: contact.id } satisfies Session), "PX", SESSION_TTL_MS);
      return token;
    });
  }

  /** Dados do cliente da sessão; sessão ausente, vencida ou de outro restaurante: 401 sem nenhum dado. */
  async me(slug: string, token: string | undefined) {
    const raw = token ? await this.redis.get(sessionKey(token)) : null;
    if (!raw) throw new UnauthorizedException(NO_SESSION);
    const session = JSON.parse(raw) as Session;
    return this.menu.withStore(slug, async (tx, store) => {
      if (session.tenantId !== store.tenantId) throw new UnauthorizedException(NO_SESSION);
      const contact = await tx.contact.findFirst({
        where: { id: session.contactId, tenantId: store.tenantId, deletedAt: null },
        select: {
          id: true,
          name: true,
          phone: true,
          phoneSource: true,
          cpfHash: true,
          email: true,
          addresses: {
            orderBy: { id: "desc" },
            select: { id: true, label: true, street: true, number: true, district: true, city: true, state: true, zipCode: true, complement: true },
          },
        },
      });
      if (!contact) throw new UnauthorizedException(NO_SESSION);
      const orders = await tx.order.findMany({
        where: await linkedOrdersWhere(tx, contact),
        orderBy: { placedAt: "desc" },
        take: 5,
        select: { id: true, displayCode: true, status: true, total: true, placedAt: true },
      });
      return {
        name: contact.name,
        phone: contact.phone,
        addresses: contact.addresses,
        orders: orders.map((o) => ({ id: o.id, code: o.displayCode, status: o.status, totalCents: Math.round(Number(o.total) * 100), placedAt: o.placedAt })),
      };
    });
  }

  /** Pedidos do cliente identificado (W16), 10 por página, dos mais novos aos mais antigos; `before` é a data do último da página. */
  async orders(slug: string, token: string | undefined, before?: Date) {
    const session = await this.session(token);
    if (!session) throw new UnauthorizedException(NO_SESSION);
    return this.menu.withStore(slug, async (tx, store) => {
      if (session.tenantId !== store.tenantId) throw new UnauthorizedException(NO_SESSION);
      const contact = await tx.contact.findFirst({
        where: { id: session.contactId, tenantId: store.tenantId, deletedAt: null },
        select: { id: true, name: true, phone: true, phoneSource: true, cpfHash: true, email: true },
      });
      if (!contact) throw new UnauthorizedException(NO_SESSION);
      const where = await linkedOrdersWhere(tx, contact);
      const rows = await tx.order.findMany({
        where: before ? { AND: [where, { placedAt: { lt: before } }] } : where,
        orderBy: { placedAt: "desc" },
        take: 11,
        select: { id: true, displayCode: true, status: true, total: true, placedAt: true, source: true, items: { select: { name: true, quantity: true }, orderBy: { id: "asc" } } },
      });
      return {
        orders: rows.slice(0, 10).map((o) => ({
          id: o.id,
          code: o.displayCode,
          status: o.status,
          totalCents: Math.round(Number(o.total) * 100),
          placedAt: o.placedAt.toISOString(),
          fromMenu: o.source === "MENU",
          summary: o.items.map((i) => `${i.quantity}× ${i.name}`).join(", "),
        })),
        hasMore: rows.length > 10,
      };
    });
  }

  /** Cupons das tags positivas do cliente identificado (as negativas nunca aparecem). */
  async coupons(slug: string, token: string | undefined, subtotalCents?: number) {
    const session = await this.session(token);
    if (!session) throw new UnauthorizedException(NO_SESSION);
    return this.menu.withStore(slug, async (tx, store) => {
      if (session.tenantId !== store.tenantId) throw new UnauthorizedException(NO_SESSION);
      const contact = await tx.contact.findFirst({ where: { id: session.contactId, tenantId: store.tenantId, deletedAt: null }, select: { id: true, name: true, tags: true } });
      if (!contact) throw new UnauthorizedException(NO_SESSION);
      const coupons = await customerCoupons(tx, { tenantId: store.tenantId, contactId: contact.id, tags: contact.tags, settings: store.settings, now: new Date(), subtotalCents });
      return { name: contact.name, coupons };
    });
  }

  /** Sessão do código (restaurante e cadastro); null sem token, vencida ou apagada. Quem usa confere o restaurante. */
  async session(token: string | undefined): Promise<Session | null> {
    const raw = token ? await this.redis.get(sessionKey(token)) : null;
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.redis.del(sessionKey(token));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
