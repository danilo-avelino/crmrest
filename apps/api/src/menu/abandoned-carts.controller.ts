import type { TenantTx } from "@dishdesk/database";
import { automationMessagesOf, fillMessage } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { Queue } from "bullmq";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { automationMessage, dispatch } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { adminScope } from "../settings/tenant-admin.js";
import { loadMenuCategories, loadMenuItems, pricingCatalogOf } from "./menu-catalog.js";
import { requireModule } from "./menu.service.js";
import { type LineSelection, priceLine } from "./pricing.js";

/** Carrinho parado há pelo menos isto entra na lista; mais velho que 7 dias sai. */
const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Janela de atendimento do WhatsApp: fora dela, só template (que o WhatsApp por QR Code não tem). */
const WINDOW_MS = 24 * 60 * 60_000;

export type AbandonedCartDto = {
  id: string;
  conversationId: string;
  customerName: string | null;
  phone: string | null;
  stage: "building" | "awaiting_confirmation" | "pix_expired";
  items: string[];
  subtotalCents: number;
  updatedAt: string;
  windowOpen: boolean;
  recoverySentAt: string | null;
};

type StoredOption = { id: string };

/**
 * Carrinhos e Pix abandonados (P7, F7-07): os carrinhos que a IA montou no WhatsApp e não viraram pedido. A sacola do
 * site fica só no navegador do visitante, então não entra. A equipe manda a mensagem de recuperação (no tom da loja,
 * regra 10) só com a janela de 24 h aberta, uma vez por carrinho.
 */
@Controller("menu/:tenantId/abandoned-carts")
export class AbandonedCartsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
  ) {}

  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<AbandonedCartDto[]> {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return abandonedCarts(tx, tenantId, new Date());
    });
  }

  @Post(":cartId/recover")
  @HttpCode(200)
  async recover(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("cartId", ParseUUIDPipe) cartId: string, @CurrentAuth() auth: RequestAuth) {
    const sent = await this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const now = new Date();
      const cart = (await abandonedCarts(tx, tenantId, now)).find((c) => c.id === cartId);
      if (!cart) throw new NotFoundException("Carrinho não encontrado ou já virou pedido.");
      if (cart.recoverySentAt) throw new ConflictException("A mensagem de recuperação já foi mandada para este carrinho.");
      if (!cart.windowOpen) throw new ConflictException("Passou a janela de 24 h do WhatsApp: o cliente precisa mandar uma mensagem antes.");
      const conversation = await tx.conversation.findFirstOrThrow({ where: { id: cart.conversationId, tenantId }, select: { id: true, tenantId: true, channelId: true } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const text = fillMessage(automationMessagesOf(tenant.settings).menuCartRecovery, { nome: cart.customerName?.trim().split(/\s+/)[0] ?? "" });
      const messageId = await automationMessage(tx, conversation, "menu_cart_recovery", text);
      // Mantém o "parado desde": o carrinho continua na lista, agora com a mensagem marcada como enviada.
      await tx.cart.update({ where: { id: cart.id }, data: { recoverySentAt: now, updatedAt: new Date(cart.updatedAt) } });
      return { conversationId: conversation.id, messageId };
    });
    await dispatch(this.outbound, this.realtime, tenantId, sent.conversationId, [sent.messageId]);
    return { ok: true };
  }
}

export async function abandonedCarts(tx: TenantTx, tenantId: string, now: Date): Promise<AbandonedCartDto[]> {
  const carts = await tx.cart.findMany({
    where: {
      tenantId,
      orderId: null,
      conversationId: { not: null },
      status: { in: ["DRAFT", "AWAITING_CONFIRMATION"] },
      updatedAt: { lt: new Date(now.getTime() - IDLE_MS), gt: new Date(now.getTime() - MAX_AGE_MS) },
      items: { some: {} },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: {
      items: { orderBy: { createdAt: "asc" }, include: { item: { select: { name: true } }, size: { select: { name: true } } } },
      contact: { select: { name: true, phone: true } },
      payments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, expiresAt: true } },
    },
  });
  if (!carts.length) return [];
  const menu = await tx.menu.findUnique({ where: { tenantId }, select: { id: true } });
  const [categories, menuItems] = menu ? await Promise.all([loadMenuCategories(tx, tenantId, menu.id), loadMenuItems(tx, tenantId, menu.id)]) : [[], []];
  const catalog = pricingCatalogOf(categories, menuItems, now);
  const lastInbound = await tx.message.groupBy({
    by: ["conversationId"],
    where: { tenantId, conversationId: { in: carts.map((c) => c.conversationId!) }, direction: "INBOUND" },
    _max: { createdAt: true },
  });
  const inboundAt = new Map(lastInbound.map((row) => [row.conversationId, row._max.createdAt]));

  return carts.map((cart) => {
    let subtotalCents = 0;
    for (const row of cart.items) {
      const options = Array.isArray(row.options) ? (row.options as StoredOption[]) : [];
      const selection: LineSelection = { itemId: row.itemId, sizeId: row.sizeId, optionIds: options.map((o) => o.id), halves: row.halves, quantity: row.quantity };
      const priced = priceLine(catalog, selection);
      if (priced.ok) subtotalCents += priced.value.totalCents;
    }
    const payment = cart.payments[0];
    const pixExpired = payment && (payment.status === "EXPIRED" || (payment.status === "PENDING" && payment.expiresAt && payment.expiresAt < now));
    const last = inboundAt.get(cart.conversationId!);
    return {
      id: cart.id,
      conversationId: cart.conversationId!,
      customerName: cart.contact?.name ?? null,
      phone: cart.contact?.phone ?? null,
      stage: pixExpired ? "pix_expired" : cart.status === "AWAITING_CONFIRMATION" ? "awaiting_confirmation" : "building",
      items: cart.items.map((row) => `${row.quantity}× ${row.item.name}${row.size ? ` ${row.size.name}` : ""}`),
      subtotalCents,
      updatedAt: cart.updatedAt.toISOString(),
      windowOpen: Boolean(last && now.getTime() - last.getTime() < WINDOW_MS),
      recoverySentAt: cart.recoverySentAt?.toISOString() ?? null,
    };
  });
}
