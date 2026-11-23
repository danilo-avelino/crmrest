import type { TenantTx } from "@dishdesk/database";
import { menuStoreOf } from "@dishdesk/shared";
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { type AutomationState, setAutomationState } from "../automations/automation.js";
import { quoteDelivery } from "../menu/delivery.js";
import { loadMenuCategories, loadMenuItems, pricingCatalogOf } from "../menu/menu-catalog.js";
import { type LineSelection, priceLine } from "../menu/pricing.js";
import { DemoLocked } from "../demo/demo.guard.js";

export type CartStage = "building" | "awaiting_confirmation" | "awaiting_pix" | "paid";

export type ConversationCartDto = {
  /** Estado da IA na conversa; `null` quando nunca houve automação. */
  ai: "on" | "off" | null;
  cart: {
    id: string;
    stage: CartStage;
    items: { id: string; name: string; size: string | null; half: string | null; options: string[]; quantity: number; notes: string | null; totalCents: number }[];
    subtotalCents: number;
    deliveryFeeCents: number;
    totalCents: number;
    /** Validade do Pix pendente (ISO); `null` quando não há cobrança pendente. */
    pixExpiresAt: string | null;
  } | null;
};

const EMPTY: ConversationCartDto = { ai: null, cart: null };
const SetAi = z.object({ on: z.boolean() });

type StoredOption = { id: string; name: string };
type StoredDelivery = { mode?: string; district?: string; lat?: number; lng?: number };

/**
 * Carrinho montado pela IA na conversa (F4-10), para o painel do cliente da Inbox, e o botão que liga ou desliga a IA
 * ("Assumir conversa" / "Devolver à IA"). Sem o módulo MENU, ou sem carrinho aberto, responde vazio.
 */
@Controller("conversations/:id/cart")
export class ConversationCartController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentAuth() auth: RequestAuth): Promise<ConversationCartDto> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await requireConversation(tx, id);
      const state = conversation.automationState as AutomationState;
      const ai = state.ai ?? null;
      const module = await tx.tenantModule.findUnique({
        where: { tenantId_module: { tenantId: conversation.tenantId, module: "MENU" } },
        select: { id: true },
      });
      if (!module) return EMPTY;
      const cart = await tx.cart.findFirst({
        where: { tenantId: conversation.tenantId, conversationId: id, status: { not: "ABANDONED" } },
        orderBy: { createdAt: "desc" },
        include: {
          items: { orderBy: { createdAt: "asc" }, include: { item: { select: { name: true } }, size: { select: { name: true } } } },
          payments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, expiresAt: true } },
        },
      });
      if (!cart) return { ai, cart: null };
      const payment = cart.payments[0];
      const stage: CartStage | null =
        payment?.status === "PENDING"
          ? "awaiting_pix"
          : payment?.status === "PAID"
            ? "paid"
            : cart.status === "DRAFT"
              ? "building"
              : cart.status === "AWAITING_CONFIRMATION"
                ? "awaiting_confirmation"
                : null;
      if (!stage) return { ai, cart: null };

      const menu = await tx.menu.findUnique({ where: { tenantId: conversation.tenantId }, select: { id: true } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: conversation.tenantId }, select: { settings: true } });
      const [categories, menuItems] = menu
        ? await Promise.all([loadMenuCategories(tx, conversation.tenantId, menu.id), loadMenuItems(tx, conversation.tenantId, menu.id)])
        : [[], []];
      const catalog = pricingCatalogOf(categories, menuItems, new Date());
      const items: NonNullable<ConversationCartDto["cart"]>["items"] = [];
      let subtotalCents = 0;
      for (const row of cart.items) {
        const options = Array.isArray(row.options) ? (row.options as StoredOption[]) : [];
        const selection: LineSelection = { itemId: row.itemId, sizeId: row.sizeId, optionIds: options.map((o) => o.id), halves: row.halves, quantity: row.quantity };
        const priced = priceLine(catalog, selection);
        const totalCents = priced.ok ? priced.value.totalCents : 0;
        subtotalCents += totalCents;
        items.push({
          id: row.id,
          name: row.item.name,
          size: row.size?.name ?? null,
          half: row.halves[0] ? (menuItems.find((i) => i.id === row.halves[0])?.name ?? null) : null,
          options: options.map((o) => o.name),
          quantity: row.quantity,
          notes: row.notes,
          totalCents,
        });
      }
      const delivery = cart.deliveryAddress as StoredDelivery | null;
      const quote =
        delivery && (delivery.mode === "DELIVERY" || delivery.mode === "PICKUP")
          ? quoteDelivery(menuStoreOf(tenant.settings), {
              mode: delivery.mode,
              subtotalCents,
              address: { district: delivery.district ?? null, lat: delivery.lat ?? null, lng: delivery.lng ?? null },
            })
          : null;
      const deliveryFeeCents = quote?.ok ? quote.feeCents : 0;
      return {
        ai,
        cart: {
          id: cart.id,
          stage,
          items,
          subtotalCents,
          deliveryFeeCents,
          totalCents: subtotalCents + deliveryFeeCents,
          pixExpiresAt: stage === "awaiting_pix" ? (payment?.expiresAt?.toISOString() ?? null) : null,
        },
      };
    });
  }

  /** "Assumir conversa" (`on: false`: a IA para) e "Devolver à IA" (`on: true`). */
  @DemoLocked()
  @Post("ai")
  setAi(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(SetAi)) body: { on: boolean }, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await requireConversation(tx, id);
      const state = conversation.automationState as AutomationState;
      await setAutomationState(tx, id, {
        ...state,
        ai: body.on ? "on" : "off",
        ...(body.on ? { aiWaiting: undefined, aiWaitingReason: undefined } : { triage: "done" as const }),
      });
      return { ai: body.on ? ("on" as const) : ("off" as const) };
    });
  }
}

async function requireConversation(tx: TenantTx, id: string) {
  const conversation = await tx.conversation.findUnique({ where: { id }, select: { tenantId: true, automationState: true } });
  if (!conversation) throw new NotFoundException("Conversa não encontrada.");
  return conversation;
}
