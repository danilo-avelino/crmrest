import { parseEncryptionKey, Prisma, type TenantTx } from "@dishdesk/database";
import {
  automationMessagesOf,
  businessHoursOf,
  effectivePaymentMethods,
  isValidCpf,
  pixAvailable,
  pixExpiresMinutesOf,
  fillMessage,
  isOpenAt,
  menuStoreOf,
  pausedOf,
  reopeningAt,
  toE164,
} from "@dishdesk/shared";
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import { automationMessage, dispatch, systemEvent } from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { connectedWhatsApp, openWhatsAppConversation } from "../conversations/open-whatsapp.js";
import { FunnelService } from "../funnel/funnel.service.js";
import { DatabaseService } from "../core/database.service.js";
import { PagarmePixProvider, type PixProvider } from "../payments/pix.js";
import { applyBenefit, resolveBenefit } from "./benefits.js";
import { rememberAddress } from "../inbound/orders.js";
import { quoteDelivery, scheduleSlots } from "../menu/delivery.js";
import { loadMenuCategories, loadMenuItems, pricingCatalogOf } from "../menu/menu-catalog.js";
import { formatCents, type LineSelection, type PricedLine, type PricingError, priceLine } from "../menu/pricing.js";
import { FraudService } from "../orders/fraud.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { CustomerAuthService } from "./customer-auth.service.js";
import { PublicMenuService } from "./public-menu.service.js";

export type PayOnDelivery = "cash" | "credit" | "debit" | "pix_on_delivery";

export type PlaceOrderInput = {
  idempotencyKey: string;
  lines: (LineSelection & { lineId: string; note?: string | null; expectedTotalCents?: number })[];
  fulfillment:
    | {
        mode: "DELIVERY";
        savedAddressId?: string | null;
        address?: {
          street: string;
          number: string;
          complement?: string | null;
          district: string;
          city: string;
          state: string;
          zipCode?: string | null;
          reference?: string | null;
        } | null;
        lat?: number | null;
        lng?: number | null;
        saveAs?: "Casa" | "Trabalho" | null;
      }
    | { mode: "PICKUP" };
  when: { kind: "now" } | { kind: "scheduled"; start: string };
  payment: { method: "pix" | PayOnDelivery; changeForCents?: number | null; cpf?: string | null };
  customer?: { name: string; phone: string } | null;
  notes?: string | null;
  marketingOptIn?: boolean;
  sessionId?: string;
  attribution?: Record<string, string | undefined>;
  couponId?: string | null;
  /** Só do agente de pedidos (F4-03), nunca do corpo público: o carrinho da conversa que vira o pedido. */
  cartId?: string;
  /** Link com contexto (F3-11): o `?c=` que o agente mandou; o pedido feito no site fecha o carrinho da conversa. */
  contextToken?: string | null;
};

export type PlacedOrder = { id: string; code: string; token: string };
/** Pix gerado (W14): o pedido só nasce quando a Pagar.me confirmar o pagamento. */
export type PixPending = { kind: "pix"; paymentId: string; token: string; qrCode: string; qrCodeUrl: string | null; expiresAt: string; amountCents: number };
export type PaymentView = {
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELED" | "REFUNDED";
  amountCents: number;
  qrCode: string | null;
  qrCodeUrl: string | null;
  expiresAt: string | null;
  orderId: string | null;
  orderToken: string | null;
};

/** O que vai para o cliente na confirmação (W15): nada interno (custo, fraude, ids de cadastro). */
export type PublicOrderDto = {
  id: string;
  code: string;
  status: string;
  placedAt: string;
  scheduledFor: string | null;
  mode: "DELIVERY" | "PICKUP";
  eta: { minMinutes: number; maxMinutes: number } | null;
  address: string | null;
  items: { name: string; quantity: number; totalCents: number; options: string[]; notes: string | null }[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  payment: { method: PayOnDelivery | "pix"; changeForCents: number | null };
  notes: string | null;
  storePhone: string | null;
  /** Etapas que já aconteceram (W15), da mais antiga à mais nova. */
  timeline: { code: string; at: string }[];
  /** Vantagem aplicada (cupom da tag ou presente da casa) e o desconto. */
  benefit: { label: string; discountCents: number; freeDelivery: boolean } | null;
  /** Nota do cliente (1 a 5), depois de entregue; null sem nota. */
  rating: number | null;
  /** Escolhas para "Pedir de novo" (pedidos feitos depois de 22/11/2026); vazio nos antigos. */
  reorder: { itemId: string; sizeId: string | null; optionIds: string[]; halves: string[]; quantity: number; note: string | null }[];
};

/** Forma de pagamento como fica no `Order.paymentMethod` (o painel lê). */
const PAYMENT_METHOD: Record<PayOnDelivery | "pix", string> = {
  pix: "PIX", cash: "CASH", credit: "CREDIT_ON_DELIVERY", debit: "DEBIT_ON_DELIVERY", pix_on_delivery: "PIX_ON_DELIVERY" };
const PAYMENT_TEXT: Record<PayOnDelivery | "pix", string> = {
  pix: "pago com Pix", cash: "em dinheiro", credit: "no cartão de crédito", debit: "no cartão de débito", pix_on_delivery: "no Pix na maquininha" };

/** Erros que o checkout mostra (W12, W13): o código decide a tela; a mensagem já vem em português. */
/** A origem da visita do pedido, só com os textos (vai para o funil e para a Meta). */
const attributionOf = (input: PlaceOrderInput) =>
  Object.fromEntries(Object.entries(input.attribution ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;

function fail(code: string, message: string, extra: Record<string, unknown> = {}, status = HttpStatus.UNPROCESSABLE_ENTITY): never {
  throw new HttpException({ statusCode: status, code, message, ...extra }, status);
}

const UNAVAILABLE_CODES = new Set(["ITEM_NOT_FOUND", "ITEM_UNAVAILABLE", "OPTION_NOT_FOUND", "OPTION_UNAVAILABLE", "SIZE_NOT_FOUND"]);

const cents = (value: Prisma.Decimal | number) => Math.round(Number(value) * 100);
const reais = (value: number) => value / 100;

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(at);

/**
 * Pedido do cardápio público (F3-08, F6-07). Tudo é conferido de novo no servidor (preço, área, horário, mínimo e forma
 * de pagamento); o navegador só manda as escolhas. Pagamento na entrega (D9): o pedido nasce CONFIRMED, sem canal (não
 * veio de conversa), com o alerta de fraude (E40) como nos outros. Pix ainda não existe (F6-03): PIX_UNAVAILABLE.
 * A chave de idempotência do navegador é o `externalOrderId`: o mesmo envio repetido (rede caiu) devolve o mesmo pedido.
 */
@Injectable()
export class PublicOrderService {
  private readonly logger = new Logger(PublicOrderService.name);
  private readonly tokenKey: Buffer;
  private readonly contextKey: Buffer;
  private readonly webOrigin: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly menu: PublicMenuService,
    private readonly customers: CustomerAuthService,
    private readonly fraud: FraudService,
    private readonly funnel: FunnelService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly db: DatabaseService,
  ) {
    this.tokenKey = Buffer.from(hkdfSync("sha256", parseEncryptionKey(env.ENCRYPTION_KEY), Buffer.alloc(0), "dishdesk:menu-order", 32));
    this.contextKey = Buffer.from(hkdfSync("sha256", parseEncryptionKey(env.ENCRYPTION_KEY), Buffer.alloc(0), "dishdesk:menu-context", 32));
    this.webOrigin = env.WEB_ORIGIN;
    this.pix = new PagarmePixProvider(env);
  }

  /** Provedor do Pix (Pagar.me); os testes trocam por um falso. */
  pix: PixProvider;

  /** Token do link do pedido: refeito a partir da chave do envio, então o reenvio devolve o mesmo. Só o hash fica no pedido. */
  private tokenOf(tenantId: string, idempotencyKey: string): string {
    return createHmac("sha256", this.tokenKey).update(`${tenantId}:${idempotencyKey}`).digest("base64url");
  }

  async place(slug: string, input: PlaceOrderInput, sessionToken: string | undefined, now = new Date()): Promise<PlacedOrder | PixPending> {
    const session = await this.customers.session(sessionToken);
    let placed: Awaited<ReturnType<PublicOrderService["create"]>>;
    try {
      placed = await this.menu.withStore(slug, (tx, store) => this.create(tx, store, input, session, now));
    } catch (error) {
      // Dois envios iguais ao mesmo tempo: o segundo bate no único da chave e devolve o pedido do primeiro.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      placed = await this.menu.withStore(slug, async (tx, store) => {
        const existing = await this.existing(tx, store.tenantId, input.idempotencyKey);
        if (!existing) throw error;
        return { ...existing, fresh: false as const };
      });
    }
    return this.after(placed, input, session, now);
  }

  /**
   * Pedido fechado pelo agente de pedidos no WhatsApp (F4-03): o carrinho da conversa, já com o resumo confirmado. O
   * contato é o da conversa (o telefone é o do próprio WhatsApp), então vale como a sessão do código. Mesmas regras do
   * site: preço, horário, área, pagamento e Pix só pago na fonte.
   */
  async placeForAgent(tenantId: string, contactId: string, input: PlaceOrderInput & { cartId: string }, now = new Date()): Promise<PlacedOrder | PixPending> {
    const session = { tenantId, contactId };
    const inTenant = <T>(fn: (tx: TenantTx, store: { tenantId: string; name: string; settings: unknown; menuId: string }) => Promise<T>) =>
      this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } });
        const menu = await tx.menu.findUnique({ where: { tenantId }, select: { id: true, active: true } });
        if (!menu?.active) fail("MENU_UNAVAILABLE", "O cardápio não está ativo.");
        return fn(tx, { tenantId, name: tenant.name, settings: tenant.settings, menuId: menu.id });
      });
    let placed: Awaited<ReturnType<PublicOrderService["create"]>>;
    try {
      placed = await inTenant((tx, store) => this.create(tx, store, input, session, now));
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      placed = await inTenant(async (tx) => {
        const existing = await this.existing(tx, tenantId, input.idempotencyKey);
        if (!existing) throw error;
        return { ...existing, fresh: false as const };
      });
    }
    return this.after(placed, input, session, now);
  }

  /** Depois do `create`: o Pix é cobrado; o pedido novo passa pela fraude, avisa o painel e manda a confirmação. */
  private async after(
    placed: Awaited<ReturnType<PublicOrderService["create"]>>,
    input: PlaceOrderInput,
    session: { tenantId: string; contactId: string } | null,
    now: Date,
  ): Promise<PlacedOrder | PixPending> {
    if (placed.kind === "pix") return this.chargePix(placed, input, session, now);
    const result = { id: placed.id, code: placed.code, token: this.tokenOf(placed.tenantId, input.idempotencyKey) };
    if (!placed.fresh) return result;

    await this.fraud.orderArrived(placed.tenantId, placed.id, now);
    this.realtime.ordersChanged(placed.tenantId);
    if (placed.notice) await dispatch(this.outbound, this.realtime, placed.tenantId, placed.notice.conversationId, [placed.notice.messageId]);
    return result;
  }

  // ---------- Link com contexto (F3-11) ----------

  /** `?c=`: o carrinho da conversa e a validade, assinados por restaurante. Vale 24 h. */
  private contextTokenOf(tenantId: string, cartId: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = createHmac("sha256", this.contextKey).update(`${tenantId}:${cartId}:${exp}`).digest("base64url");
    return `${cartId}.${exp}.${sig}`;
  }

  /** O carrinho do `?c=`, ou null (assinatura errada, de outro restaurante ou vencido). */
  contextCart(tenantId: string, token: string, now = new Date()): string | null {
    const [cartId, exp, sig] = token.split(".");
    if (!cartId || !exp || !sig || !/^[0-9a-f-]{36}$/.test(cartId) || !/^\d{1,12}$/.test(exp)) return null;
    if (Number(exp) * 1000 < now.getTime()) return null;
    const expected = createHmac("sha256", this.contextKey).update(`${tenantId}:${cartId}:${exp}`).digest();
    const given = Buffer.from(sig, "base64url");
    return given.length === expected.length && timingSafeEqual(given, expected) ? cartId : null;
  }

  /** Link do cardápio com o carrinho desta conversa (o agente manda; o site abre a sacola com os mesmos itens). */
  async contextLink(tenantId: string, conversationId: string, now = new Date()): Promise<string | null> {
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
      const cart = await tx.cart.findFirst({
        where: { tenantId, conversationId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const base = `${this.webOrigin}/c/${encodeURIComponent(tenant.slug)}`;
      return cart ? `${base}?c=${this.contextTokenOf(tenantId, cart.id, new Date(now.getTime() + 24 * 60 * 60_000))}` : base;
    });
  }

  /** O que o `?c=` põe na sacola do site: as escolhas do carrinho da conversa (o preço o site confere de novo). */
  context(slug: string, token: string, now = new Date()) {
    return this.menu.withStore(slug, async (tx, store) => {
      const cartId = this.contextCart(store.tenantId, token, now);
      const cart = cartId
        ? await tx.cart.findFirst({
            where: { id: cartId, tenantId: store.tenantId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } },
            include: { items: { orderBy: { createdAt: "asc" } } },
          })
        : null;
      if (!cart) throw new NotFoundException("Este link venceu ou o pedido já foi feito.");
      return {
        lines: cart.items.map((row) => ({
          itemId: row.itemId,
          sizeId: row.sizeId,
          optionIds: Array.isArray(row.options) ? (row.options as { id: string }[]).map((o) => o.id) : [],
          halves: row.halves,
          quantity: row.quantity,
          note: row.notes,
        })),
      };
    });
  }

  /** Situação de um Pix para o agente (consultar_pagamento): confere na fonte se ainda pendente. Só do restaurante dado. */
  async pixStatusFor(tenantId: string, paymentId: string): Promise<{ status: PaymentView["status"]; orderCode: string | null; expiresAt: string | null } | null> {
    const row = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.payment.findFirst({ where: { id: paymentId, tenantId }, select: { status: true } }));
    if (!row) return null;
    if (row.status === "PENDING") await this.settle(paymentId, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, expiresAt: true, order: { select: { displayCode: true } } } });
      return { status: payment.status, orderCode: payment.order?.displayCode ?? null, expiresAt: payment.expiresAt?.toISOString() ?? null };
    });
  }

  /** Pix pedido no checkout: cobra na Pagar.me e guarda o envio para criar o pedido quando o pagamento for confirmado. */
  private async chargePix(
    pending: { tenantId: string; recipientId: string; expiresMinutes: number; totalCents: number; contact: { id: string; name: string; phone: string; cpf: string }; description: string },
    input: PlaceOrderInput,
    session: { tenantId: string; contactId: string } | null,
    now: Date,
  ): Promise<PixPending> {
    const paymentId = randomUUID();
    let charge;
    try {
      charge = await this.pix.createCharge({
        reference: paymentId,
        amountCents: pending.totalCents,
        description: pending.description,
        expiresInSeconds: pending.expiresMinutes * 60,
        recipientId: pending.recipientId,
        customer: { name: pending.contact.name, phoneE164: pending.contact.phone, cpf: pending.contact.cpf },
      });
    } catch (error) {
      this.logger.warn(`Pix não gerado: ${error instanceof Error ? error.message : String(error)}`);
      fail("PIX_FAILED", "Não conseguimos gerar o Pix agora. Tente de novo ou escolha pagar na entrega.", {}, HttpStatus.BAD_GATEWAY);
    }
    await this.db.withTenants({ tenantIds: [pending.tenantId] }, (tx) =>
      tx.payment.create({
        data: {
          id: paymentId,
          tenantId: pending.tenantId,
          provider: this.pix.name,
          txid: charge.providerOrderId,
          cartId: input.cartId ?? null,
          amountCents: pending.totalCents,
          expiresAt: charge.expiresAt,
          status: "PENDING",
          raw: {
            input: { ...input, payment: { ...input.payment, cpf: null } },
            session: session ? { tenantId: session.tenantId, contactId: session.contactId } : null,
            placedAt: now.toISOString(),
            qrCode: charge.qrCode,
            qrCodeUrl: charge.qrCodeUrl,
            chargeId: charge.chargeId,
          } as Prisma.InputJsonObject,
        },
      }),
    );
    // Funil: Pix gerado (ADD_PAYMENT_INFO só sai do servidor).
    await this.db.withTenants({ tenantIds: [pending.tenantId] }, (tx) =>
      this.funnel.record(tx, pending.tenantId, { eventId: randomUUID(), stage: "ADD_PAYMENT_INFO", channel: input.cartId ? "WHATSAPP" : "WEB", contactId: pending.contact.id, valueCents: pending.totalCents, sessionId: input.sessionId ?? null, attribution: attributionOf(input) }),
    );
    return {
      kind: "pix",
      paymentId,
      token: this.tokenOf(pending.tenantId, `payment:${paymentId}`),
      qrCode: charge.qrCode,
      qrCodeUrl: charge.qrCodeUrl,
      expiresAt: charge.expiresAt.toISOString(),
      amountCents: pending.totalCents,
    };
  }

  /**
   * Situação do Pix para a tela (W14). Ainda pendente: confere na Pagar.me (o webhook só avisa) e, pago, cria o pedido.
   * Acesso: o token devolvido ao gerar o Pix.
   */
  async payment(slug: string, paymentId: string, token: string | undefined): Promise<PaymentView> {
    const found = await this.menu.withStore(slug, async (tx, store) => {
      const row = await tx.payment.findFirst({ where: { id: paymentId, tenantId: store.tenantId } });
      if (!row || !token || !sameHash(createHash("sha256").update(this.tokenOf(store.tenantId, `payment:${paymentId}`)).digest("hex"), token)) {
        throw new NotFoundException("Pagamento não encontrado.");
      }
      return { row, tenantId: store.tenantId };
    });
    if (found.row.status === "PENDING") await this.settle(found.row.id, found.tenantId);
    return this.db.withTenants({ tenantIds: [found.tenantId] }, async (tx) => {
      const row = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const raw = (row.raw ?? {}) as { qrCode?: string; qrCodeUrl?: string | null; input?: { idempotencyKey?: string } };
      return {
        status: row.status,
        amountCents: row.amountCents,
        qrCode: row.status === "PENDING" ? (raw.qrCode ?? null) : null,
        qrCodeUrl: row.status === "PENDING" ? (raw.qrCodeUrl ?? null) : null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        orderId: row.orderId,
        orderToken: row.orderId && raw.input?.idempotencyKey ? this.tokenOf(found.tenantId, raw.input.idempotencyKey) : null,
      };
    });
  }

  /** Webhook da Pagar.me: acha o pagamento pela cobrança e confere a situação na fonte. */
  async providerNotified(paymentId: string, providerOrderId: string): Promise<void> {
    const [row] = await this.db.withTenants({ tenantIds: [] }, (tx) =>
      tx.$queryRaw<{ tenant: string | null }[]>`SELECT app.payment_tenant(${paymentId}::uuid, ${providerOrderId}) AS tenant`,
    );
    if (row?.tenant) await this.settle(paymentId, row.tenant);
  }

  /**
   * Confere na Pagar.me e aplica: pago cria o pedido (com o horário do Pix, para valerem as mesmas regras); vencido sem
   * pagamento vira EXPIRED. Comprovante do cliente nunca conta (E43): só a situação na fonte.
   */
  /**
   * Varredura do worker (F6-06), a cada minuto: confere os Pix pendentes de todas as lojas. Pega o pago cujo aviso da
   * Pagar.me se perdeu (o cliente fechou a página) e fecha os vencidos. Sem a chave da Pagar.me, não faz nada.
   */
  async sweepPix(now = new Date()): Promise<void> {
    if (!this.pix.configured) return;
    const rows = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`SELECT * FROM app.pending_pix_payments(${200}::integer)`;
    for (const row of rows) {
      try {
        await this.settle(row.id, row.tenant_id, now);
      } catch (error) {
        this.logger.warn(`Pix ${row.id} não conferido: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async settle(paymentId: string, tenantId: string, now = new Date()): Promise<void> {
    const row = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.payment.findUnique({ where: { id: paymentId } }));
    if (!row || row.status !== "PENDING" || !row.txid) return;
    const status = await this.pix.status(row.txid).catch(() => null);
    if (status === "PENDING" && row.expiresAt && row.expiresAt < now) {
      await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.payment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "EXPIRED" } }));
      return;
    }
    if (status === "CANCELED") {
      await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.payment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "CANCELED" } }));
      return;
    }
    if (status !== "PAID") return;
    const raw = (row.raw ?? {}) as { input: PlaceOrderInput; session: { tenantId: string; contactId: string } | null; placedAt: string };
    const marked = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.payment.updateMany({ where: { id: paymentId, status: "PENDING" }, data: { status: "PAID", paidAt: now } }));
    if (marked.count === 0) return; // outro aviso já tratou
    try {
      const placed = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } });
        const menu = await tx.menu.findUniqueOrThrow({ where: { tenantId }, select: { id: true } });
        return this.create(tx, { tenantId, name: tenant.name, settings: tenant.settings, menuId: menu.id }, raw.input, raw.session, new Date(raw.placedAt), { paymentId });
      });
      if (placed.kind === "pix" || !placed.fresh) return;
      await this.fraud.orderArrived(tenantId, placed.id, now);
      this.realtime.ordersChanged(tenantId);
      if (placed.notice) await dispatch(this.outbound, this.realtime, tenantId, placed.notice.conversationId, [placed.notice.messageId]);
    } catch (error) {
      // Pago e sem pedido: fica registrado para a equipe resolver (o dinheiro já está com o restaurante).
      this.logger.error(`Pix ${paymentId} pago sem pedido: ${error instanceof Error ? error.message : String(error)}`);
      await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
        tx.payment.update({ where: { id: paymentId }, data: { raw: { ...(row.raw as Prisma.JsonObject), orderError: error instanceof Error ? error.message : String(error) } } }),
      );
    }
  }

  private async existing(tx: TenantTx, tenantId: string, idempotencyKey: string) {
    const order = await tx.order.findFirst({
      where: { tenantId, externalOrderId: idempotencyKey, channelId: null, source: "MENU" },
      select: { id: true, displayCode: true },
    });
    return order && { id: order.id, code: order.displayCode ?? order.id.slice(0, 6), tenantId };
  }

  private async create(
    tx: TenantTx,
    store: { tenantId: string; name: string; settings: unknown; menuId: string },
    input: PlaceOrderInput,
    session: { tenantId: string; contactId: string } | null,
    now: Date,
    paid: { paymentId: string } | null = null,
  ) {
    const { tenantId } = store;
    const repeated = await this.existing(tx, tenantId, input.idempotencyKey);
    if (repeated) return { ...repeated, fresh: false as const };

    const menuStore = menuStoreOf(store.settings);
    const hours = businessHoursOf(store.settings);

    // 1. Quando (R2): agora só com a loja aberta; agendado só numa faixa que a loja oferece agora.
    const slots = scheduleSlots(menuStore, hours, now);
    const nextSlot = slots[0] ? { start: slots[0].start.toISOString(), end: slots[0].end.toISOString(), day: slots[0].day, label: slots[0].label } : null;
    let scheduled: { start: Date; end: Date } | null = null;
    if (input.when.kind === "now") {
      if (pausedOf(store.settings)) fail("STORE_CLOSED", "A loja pausou os pedidos por enquanto.", { paused: true, nextSlot: null, nextOpening: null });
      if (hours.enabled && !isOpenAt(hours, now)) {
        fail("STORE_CLOSED", "A loja fechou enquanto você finalizava o pedido.", { paused: false, nextSlot, nextOpening: reopeningAt(hours, now) });
      }
    } else {
      const wanted = Date.parse(input.when.start);
      const slot = slots.find((s) => s.start.getTime() === wanted);
      if (!slot) fail("SLOT_UNAVAILABLE", "Esse horário não está mais disponível. Escolha outro.", { nextSlot });
      scheduled = { start: slot.start, end: slot.end };
    }

    // 2. Preço de cada linha no horário do pedido (item fora do horário conta como indisponível).
    const at = scheduled?.start ?? now;
    const [categories, items] = await Promise.all([loadMenuCategories(tx, tenantId, store.menuId), loadMenuItems(tx, tenantId, store.menuId)]);
    const catalog = pricingCatalogOf(categories, items, at);
    const priced: { lineId: string; note: string | null; line: PricedLine }[] = [];
    const unavailable: { lineId: string; message: string }[] = [];
    const invalid: { lineId: string; errors: PricingError[] }[] = [];
    for (const selection of input.lines) {
      const result = priceLine(catalog, selection);
      if (result.ok) priced.push({ lineId: selection.lineId, note: selection.note?.trim() || null, line: result.value });
      else if (result.errors.some((e) => UNAVAILABLE_CODES.has(e.code))) unavailable.push({ lineId: selection.lineId, message: result.errors[0]!.message });
      else invalid.push({ lineId: selection.lineId, errors: result.errors });
    }
    if (unavailable.length) fail("ITEM_UNAVAILABLE", unavailable.length === 1 ? unavailable[0]!.message : "Alguns itens esgotaram.", { lines: unavailable });
    if (invalid.length) fail("INVALID_LINE", invalid[0]!.errors[0]!.message, { lines: invalid });

    const itemById = new Map(items.map((item) => [item.id, item]));
    const nameOf = (line: PricedLine) => lineName(line, itemById);
    const changed = input.lines.flatMap((selection) => {
      const found = priced.find((p) => p.lineId === selection.lineId)!;
      return selection.expectedTotalCents != null && selection.expectedTotalCents !== found.line.totalCents
        ? [{ lineId: selection.lineId, name: nameOf(found.line), fromCents: selection.expectedTotalCents, toCents: found.line.totalCents }]
        : [];
    });
    if (changed.length) {
      const first = changed[0]!;
      fail("PRICE_CHANGED", `O preço de ${first.name} mudou de ${formatCents(first.fromCents)} para ${formatCents(first.toCents)}.`, { lines: changed });
    }
    const subtotalCents = priced.reduce((sum, p) => sum + p.line.totalCents, 0);

    // 3. Cliente: a sessão do código (telefone provado) ou o visitante (nome e telefone digitados).
    const contact = await this.contactOf(tx, tenantId, input, session);

    // 4. Entrega: endereço salvo (só com a sessão) ou novo; cotação de novo no servidor.
    const { fulfillment } = input;
    let address: DeliveryAddressJson | null = null;
    if (fulfillment.mode === "DELIVERY") {
      if (fulfillment.savedAddressId) {
        if (!contact.verified) fail("ADDRESS_REQUIRED", "Informe o endereço de entrega.");
        const saved = await tx.contactAddress.findFirst({ where: { id: fulfillment.savedAddressId, contactId: contact.id, tenantId } });
        if (!saved) fail("ADDRESS_REQUIRED", "Esse endereço não está mais salvo. Informe o endereço de entrega.");
        address = { street: saved.street, number: saved.number ?? "", complement: saved.complement, neighborhood: saved.district ?? "", city: saved.city, state: saved.state, zipCode: saved.zipCode, reference: null };
      } else if (fulfillment.address) {
        const a = fulfillment.address;
        address = { street: a.street, number: a.number, complement: a.complement || null, neighborhood: a.district, city: a.city, state: a.state, zipCode: a.zipCode || null, reference: a.reference || null };
      } else {
        fail("ADDRESS_REQUIRED", "Informe o endereço de entrega.");
      }
      if (fulfillment.lat != null && fulfillment.lng != null) address = { ...address, lat: fulfillment.lat, lng: fulfillment.lng };
    }
    const quote = quoteDelivery(menuStore, {
      mode: fulfillment.mode,
      subtotalCents,
      address: address ? { district: address.neighborhood, lat: address.lat ?? null, lng: address.lng ?? null } : undefined,
    });
    if (!quote.ok) fail(quote.code, quote.message);
    if (quote.missingForMinimumCents > 0) {
      fail("MIN_ORDER", `Faltam ${formatCents(quote.missingForMinimumCents)} para o pedido mínimo de ${formatCents(quote.minOrderCents)}.`, {
        missingCents: quote.missingForMinimumCents,
        minOrderCents: quote.minOrderCents,
      });
    }
    // 4b. Vantagem da tag (cupom escolhido) ou presente de recuperação: vale só a melhor; só com o código do WhatsApp.
    const { benefit, couponRefused } = await resolveBenefit(tx, {
      tenantId,
      contactId: contact.id,
      verified: contact.verified,
      couponId: input.couponId,
      settings: store.settings,
      now,
      subtotalCents,
      deliveryFeeCents: quote.feeCents,
    });
    if (input.couponId && couponRefused) fail("COUPON_INVALID", couponRefused);
    const applied = applyBenefit(benefit, subtotalCents, quote.feeCents);
    const feeCents = applied.deliveryFeeCents;
    const totalCents = subtotalCents - applied.discountCents + feeCents;

    // 5. Pagamento (D9): só na entrega ou na retirada por enquanto; o troco precisa passar do total.
    const { method } = input.payment;
    if (method === "pix" && !paid) {
      if (!pixAvailable(menuStore) || !this.pix.configured || !effectivePaymentMethods(menuStore).includes("pix")) {
        fail("PIX_UNAVAILABLE", "O Pix não está disponível nesta loja. Escolha pagar na entrega.");
      }
      const cpf = (input.payment.cpf ?? "").replace(/\D/g, "");
      if (!isValidCpf(cpf)) fail("CPF_REQUIRED", "Para pagar com Pix, informe um CPF válido.");
      // Nada é gravado agora: o pedido nasce só com o pagamento confirmado (E43). Quem chama gera a cobrança.
      return {
        kind: "pix" as const,
        tenantId,
        recipientId: menuStore.pixRecipientId!,
        expiresMinutes: pixExpiresMinutesOf(menuStore),
        totalCents,
        contact: { id: contact.id, name: contact.name ?? "Cliente", phone: contact.phone ?? "", cpf },
        description: `Pedido no cardápio de ${store.name}`,
      };
    }
    if (method !== "pix" && !effectivePaymentMethods(menuStore).includes(method)) fail("PAYMENT_METHOD_UNAVAILABLE", "A loja não aceita essa forma de pagamento.");
    const changeForCents = method === "cash" ? (input.payment.changeForCents ?? null) : null;
    if (changeForCents != null && changeForCents <= totalCents) {
      fail("CHANGE_TOO_LOW", `O troco precisa ser para um valor maior que ${formatCents(totalCents)}.`, { totalCents });
    }

    // 6. O pedido, com a linha do tempo do jeito das integrações (recebido e confirmado), para os cards e a previsão.
    if (fulfillment.mode === "DELIVERY" && fulfillment.saveAs && contact.verified && address && !fulfillment.savedAddressId) {
      await rememberAddress(tx, { id: contact.id, tenantId }, fulfillment.saveAs, {
        street: address.street,
        number: address.number || null,
        complement: address.complement,
        district: address.neighborhood,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
      });
    }
    const takeout = fulfillment.mode === "PICKUP";
    const promised = scheduled ? scheduled.end : new Date(now.getTime() + quote.eta.maxMinutes * 60_000);
    const notes = input.notes?.trim() || null;
    const code = String(1001 + (await tx.order.count({ where: { tenantId, source: "MENU" } })));
    const order = await tx.order.create({
      data: {
        tenantId,
        contactId: contact.id,
        channelId: null,
        externalOrderId: input.idempotencyKey,
        displayCode: code,
        source: "MENU",
        status: "CONFIRMED",
        scheduledFor: scheduled?.start ?? null,
        paymentMethod: PAYMENT_METHOD[method],
        subtotal: reais(subtotalCents),
        deliveryFee: reais(feeCents),
        total: reais(totalCents),
        deliveryAddress: (address ?? undefined) as Prisma.InputJsonObject | undefined,
        placedAt: now,
        // Nos campos que o painel já lê dos pedidos das plataformas (forecast.ts): tipo, observação e horário prometido.
        raw: {
          source: "menu",
          // De onde veio (P8): a conversa com a IA, um anúncio da Meta (fbclid na 1ª visita) ou, sem a marca, o site.
          ...(input.cartId ? { origin: "whatsapp_ai" } : input.attribution?.fbclid || input.attribution?.fbc ? { origin: "ad" } : {}),
          orderType: takeout ? "TAKEOUT" : "DELIVERY",
          extraInfo: notes,
          ...(takeout ? { takeout: { takeoutDateTime: promised.toISOString() } } : { delivery: { deliveryDateTime: promised.toISOString() } }),
          eta: quote.eta,
          payment: { method, changeForCents },
          ...(benefit ? { benefit: { ...benefit, discountCents: applied.discountCents } } : {}),
          // As escolhas de cada linha, para o "Pedir de novo" (W15/W16).
          lines: input.lines.map((l) => ({ itemId: l.itemId, sizeId: l.sizeId ?? null, optionIds: l.optionIds ?? [], halves: l.halves ?? [], quantity: l.quantity, note: l.note?.trim() || null })),
          customerName: contact.name,
          // Origem da 1ª visita (F7-02), para o funil por origem e a Meta.
          ...(input.attribution && Object.keys(input.attribution).length ? { attribution: input.attribution } : {}),
          accessTokenHash: createHash("sha256").update(this.tokenOf(tenantId, input.idempotencyKey)).digest("hex"),
        } satisfies Prisma.InputJsonObject,
        items: {
          create: priced.map(({ line, note }) => ({
            tenantId,
            name: nameOf(line),
            quantity: line.quantity,
            unitPrice: reais(line.unitCents),
            notes: note,
            options: optionsText(line),
            menuItemId: line.itemId,
          })),
        },
        events: {
          create: [
            { tenantId, externalEventId: "PLACED", code: "PLACED", occurredAt: now },
            { tenantId, externalEventId: "CONFIRMED", code: "CONFIRMED", occurredAt: now },
          ],
        },
      },
      select: { id: true },
    });

    // PURCHASE só com o pagamento confirmado (F6/F7-04): na entrega, o servidor registra só o início do checkout.
    if (paid) await tx.payment.update({ where: { id: paid.paymentId }, data: { orderId: order.id } });
    const closeCart = input.cartId ?? (input.contextToken ? this.contextCart(tenantId, input.contextToken, now) : null);
    if (closeCart) {
      await tx.cart.updateMany({ where: { id: closeCart, tenantId, status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] } }, data: { status: "CHECKED_OUT", orderId: order.id } });
    }
    await this.funnel.record(tx, tenantId, {
      eventId: paid ? paid.paymentId : randomUUID(),
      stage: paid ? "PURCHASE" : "INITIATE_CHECKOUT",
      channel: input.cartId ? "WHATSAPP" : "WEB",
      contactId: contact.id,
      orderId: order.id,
      valueCents: totalCents,
      sessionId: input.sessionId ?? null,
      attribution: attributionOf(input),
    });

    // 7. Confirmação no WhatsApp, só para o telefone provado pelo código (o do visitante pode ser de outra pessoa).
    const notice = contact.verified && !pausedOf(store.settings) ? await this.confirmation(tx, store, contact, order.id, code, { scheduled, takeout, eta: quote.eta, method, changeForCents, now }) : null;
    return { id: order.id, code, tenantId, fresh: true as const, notice };
  }

  /** Cadastro do pedido. Visitante: acha ou cria pelo telefone digitado, sem nunca usar um cadastro de telefone provado (regra 9). */
  private async contactOf(tx: TenantTx, tenantId: string, input: PlaceOrderInput, session: { tenantId: string; contactId: string } | null) {
    const name = input.customer?.name.trim() || null;
    let contact: { id: string; name: string | null; phone: string | null; verified: boolean } | null = null;
    if (session?.tenantId === tenantId) {
      const found = await tx.contact.findFirst({ where: { id: session.contactId, tenantId, deletedAt: null }, select: { id: true, name: true, phone: true } });
      if (found) {
        if (!found.name && name) await tx.contact.update({ where: { id: found.id }, data: { name } });
        contact = { ...found, name: found.name ?? name, verified: true };
      }
    }
    if (!contact) {
      if (!input.customer || !name) throw new BadRequestException("Informe seu nome e seu celular.");
      const phone = toE164(input.customer.phone);
      if (!phone?.startsWith("+55")) throw new BadRequestException("Informe um celular válido com DDD.");
      // O telefone digitado não prova quem é: o pedido fica num cadastro de visitante, separado do cliente que entrou pelo código.
      const found = await tx.contact.findFirst({
        where: { tenantId, phone, phoneSource: "informed_by_customer", deletedAt: null, identities: { none: {} } },
        orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
        select: { id: true, name: true, phone: true },
      });
      const id =
        found?.id ??
        (await tx.contact.create({ data: { tenantId, name, phone, phoneSource: "informed_by_customer" }, select: { id: true } })).id;
      if (found && found.name !== name) await tx.contact.update({ where: { id }, data: { name } });
      contact = { id, name, phone, verified: false };
    }
    await tx.contact.update({ where: { id: contact.id }, data: { lastSeenAt: new Date() } });
    if (input.marketingOptIn === true) {
      await tx.consent.create({ data: { tenantId, contactId: contact.id, purpose: "marketing_whatsapp", granted: true, source: "menu_checkout" } });
    }
    return contact;
  }

  /** Mensagem de pedido recebido na conversa do WhatsApp do cliente (a última, ou uma nova), no tom do restaurante (regra 10). */
  private async confirmation(
    tx: TenantTx,
    store: { tenantId: string; settings: unknown },
    contact: { id: string; name: string | null; phone: string | null },
    orderId: string,
    code: string,
    info: { scheduled: { start: Date } | null; takeout: boolean; eta: { minMinutes: number; maxMinutes: number }; method: PayOnDelivery | "pix"; changeForCents: number | null; now: Date },
  ): Promise<{ conversationId: string; messageId: string } | null> {
    if (!contact.phone) return null;
    const whatsapp = await connectedWhatsApp(tx, store.tenantId);
    if (!whatsapp || whatsapp.tenantId !== store.tenantId) return null;
    try {
      const conversationId = await openWhatsAppConversation(tx, whatsapp, { ...contact, tenantId: store.tenantId });
      const conversation = { id: conversationId, tenantId: store.tenantId, channelId: whatsapp.id };
      await tx.order.update({ where: { id: orderId }, data: { conversationId } });
      await systemEvent(tx, conversation, { event: "order", orderId });
      const quando = info.scheduled
        ? `Agendado para ${dayWord(info.scheduled.start, info.now)} às ${hhmm(info.scheduled.start)}.`
        : info.takeout
          ? `Fica pronto por volta das ${hhmm(new Date(info.now.getTime() + info.eta.maxMinutes * 60_000))}.`
          : `Previsão de entrega entre ${hhmm(new Date(info.now.getTime() + info.eta.minMinutes * 60_000))} e ${hhmm(new Date(info.now.getTime() + info.eta.maxMinutes * 60_000))}.`;
      const troco = info.changeForCents != null ? ` (troco para ${formatCents(info.changeForCents)})` : "";
      const pagamento = info.method === "pix" ? "já pago com Pix" : `${info.takeout ? "na retirada" : "na entrega"}, ${PAYMENT_TEXT[info.method]}${troco}`;
      const text = fillMessage(automationMessagesOf(store.settings).menuOrderConfirmed, {
        nome: contact.name?.trim().split(/\s+/)[0] ?? "",
        pedido: code,
        quando,
        pagamento,
      });
      const messageId = await automationMessage(tx, conversation, "menu_order_confirmed", text);
      return { conversationId, messageId };
    } catch (error) {
      // A confirmação não pode derrubar o pedido: ele já está na tela do cliente e no painel.
      this.logger.warn(`Confirmação do pedido ${orderId} não preparada: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Pedido para a tela de confirmação (W15): pela sessão do código do mesmo cliente ou pelo token devolvido na criação. */
  get(slug: string, orderId: string, auth: { sessionToken?: string; orderToken?: string }): Promise<PublicOrderDto> {
    return this.customers.session(auth.sessionToken).then((session) =>
      this.menu.withStore(slug, async (tx, store) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, tenantId: store.tenantId, source: "MENU" },
          include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { occurredAt: "asc" }, select: { code: true, occurredAt: true } } },
        });
        if (!order) throw new NotFoundException("Pedido não encontrado.");
        const raw = (order.raw ?? {}) as { accessTokenHash?: string | null; orderType?: string; eta?: PublicOrderDto["eta"]; payment?: { method: PayOnDelivery; changeForCents: number | null } };
        const bySession = session?.tenantId === store.tenantId && session.contactId === order.contactId;
        const byToken = Boolean(auth.orderToken && raw.accessTokenHash && sameHash(raw.accessTokenHash, auth.orderToken));
        if (!bySession && !byToken) throw new UnauthorizedException("Abra o pedido pelo link recebido ou entre com o código.");
        const address = order.deliveryAddress as DeliveryAddressJson | null;
        return {
          id: order.id,
          code: order.displayCode ?? order.id.slice(0, 6),
          status: order.status,
          placedAt: order.placedAt.toISOString(),
          scheduledFor: order.scheduledFor?.toISOString() ?? null,
          mode: raw.orderType === "TAKEOUT" ? "PICKUP" : "DELIVERY",
          eta: raw.eta ?? null,
          address: address ? addressLine(address) : null,
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            totalCents: cents(item.unitPrice) * item.quantity,
            options: item.options,
            notes: item.notes,
          })),
          subtotalCents: cents(order.subtotal),
          deliveryFeeCents: cents(order.deliveryFee),
          totalCents: cents(order.total),
          payment: { method: raw.payment?.method ?? "cash", changeForCents: raw.payment?.changeForCents ?? null },
          notes: (order.raw as { extraInfo?: string | null }).extraInfo ?? null,
          storePhone: menuStoreOf(store.settings).phone || null,
          timeline: order.events.map((e) => ({ code: e.code, at: e.occurredAt.toISOString() })),
          benefit: (() => {
            const b = (order.raw as { benefit?: { label: string; discountCents: number; freeDelivery: boolean } }).benefit;
            return b ? { label: b.label, discountCents: b.discountCents, freeDelivery: b.freeDelivery } : null;
          })(),
          rating: (order.raw as { rating?: { score?: number } }).rating?.score ?? null,
          reorder: (order.raw as { lines?: PublicOrderDto["reorder"] }).lines ?? [],
        };
      }),
    );
  }

  rate(slug: string, orderId: string, auth: { sessionToken?: string; orderToken?: string }, score: number): Promise<{ rating: number }> {
    return this.customers.session(auth.sessionToken).then((session) =>
      this.menu.withStore(slug, async (tx, store) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, tenantId: store.tenantId, source: "MENU" },
          select: { id: true, status: true, raw: true, contactId: true, conversationId: true },
        });
        if (!order) throw new NotFoundException("Pedido não encontrado.");
        const raw = (order.raw ?? {}) as { accessTokenHash?: string | null; rating?: unknown };
        const bySession = session?.tenantId === store.tenantId && session.contactId === order.contactId;
        const byToken = Boolean(auth.orderToken && raw.accessTokenHash && sameHash(raw.accessTokenHash, auth.orderToken));
        if (!bySession && !byToken) throw new UnauthorizedException("Abra o pedido pelo link recebido ou entre com o código.");
        if (order.status !== "DELIVERED") fail("NOT_DELIVERED", "Você avalia depois que o pedido for entregue.", {}, HttpStatus.CONFLICT);
        if (raw.rating) fail("ALREADY_RATED", "Este pedido já foi avaliado. Obrigado!", {}, HttpStatus.CONFLICT);
        await tx.order.update({ where: { id: order.id }, data: { raw: { ...(order.raw as Prisma.JsonObject), rating: { score, at: new Date().toISOString() } } } });
        // Nos relatórios de avaliação, só quando há conversa (a nota da tabela pede uma).
        if (order.conversationId) {
          await tx.rating.create({ data: { tenantId: store.tenantId, conversationId: order.conversationId, orderId: order.id, score, channelType: "WHATSAPP" } });
        }
        return { rating: score };
      }),
    );
  }
}


type DeliveryAddressJson = {
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string | null;
  reference: string | null;
  lat?: number;
  lng?: number;
};

function sameHash(storedHex: string, token: string): boolean {
  const given = createHash("sha256").update(token).digest();
  const stored = Buffer.from(storedHex, "hex");
  return stored.length === given.length && timingSafeEqual(stored, given);
}

/** "Calabresa (Grande)" ou "½ Calabresa + ½ Portuguesa (Grande)", como a equipe lê no card. */
function lineName(line: PricedLine, items: Map<string, { name: string; sizes: { id: string; name: string }[] }>): string {
  const item = items.get(line.itemId);
  const size = item?.sizes.find((s) => s.id === line.sizeId)?.name;
  const base = line.halves.length ? [line.itemId, ...line.halves].map((id) => `½ ${items.get(id)?.name ?? "?"}`).join(" + ") : (item?.name ?? "Item");
  return size ? `${base} (${size})` : base;
}

/** Complementos como a equipe lê: "2× Bacon". */
function optionsText(line: PricedLine): string[] {
  const counts = new Map<string, number>();
  for (const option of line.options) counts.set(option.name, (counts.get(option.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${count}× ${name}`);
}

function addressLine(address: DeliveryAddressJson): string {
  const street = [address.street, address.number || "s/n", address.complement].filter(Boolean).join(", ");
  return [street, address.neighborhood, address.city].filter(Boolean).join(" · ");
}

/** "hoje" ou "amanhã" (horário de Brasília). */
function dayWord(at: Date, now: Date): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
  return day(at) === day(now) ? "hoje" : "amanhã";
}
