import type { TenantTx } from "@dishdesk/database";
import {
  BENEFIT_TAGS,
  BENEFIT_TITLE,
  type BenefitTag,
  benefitSavings,
  type CouponPartDto,
  type CustomerCouponDto,
  RECOVERY_TAGS,
  tagBenefitsOf,
} from "@dishdesk/shared";
import { formatCents } from "../menu/pricing.js";
import { type CouponLine, candidateCoupons } from "./menu-coupons.js";

/**
 * O que o pedido grava em `raw.benefit` (e a tela do pedido mostra). `menu_coupon`: cupom da aba Cupons (N4), com o
 * id do cupom em `tag` e o código em `code` (null no automático).
 */
export type AppliedBenefit = {
  kind: "coupon" | "recovery" | "menu_coupon";
  tag: string;
  label: string;
  discountCents: number;
  freeDelivery: boolean;
  code?: string | null;
};

/** Forma de pagamento do checkout como o cupom guarda: pix, card ou cash. */
export function couponPaymentOf(method: string | null | undefined): string | null {
  if (!method) return null;
  if (method === "pix" || method === "pix_on_delivery") return "pix";
  if (method === "credit" || method === "debit") return "card";
  return method === "cash" ? "cash" : null;
}

const RECOVERY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Início do mês corrente em Brasília (UTC−3, sem horário de verão). */
function monthStartBrt(now: Date): Date {
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1, 3));
}

async function usedSince(tx: TenantTx, tenantId: string, contactId: string, path: "tag" | "kind", value: string, since: Date | null): Promise<boolean> {
  const found = await tx.order.findFirst({
    where: {
      tenantId,
      contactId,
      source: "MENU",
      status: { not: "CANCELED" },
      raw: { path: ["benefit", path], equals: value },
      ...(since ? { placedAt: { gte: since } } : {}),
    },
    select: { id: true },
  });
  return Boolean(found);
}

/**
 * Cupons que o cliente identificado pelo código vê (só tags positivas ligadas). Tags negativas nunca entram aqui.
 * `subtotalCents` (opcional) marca os que ainda não alcançam o pedido mínimo.
 */
export async function customerCoupons(
  tx: TenantTx,
  input: { tenantId: string; contactId: string; tags: string[]; settings: unknown; now: Date; subtotalCents?: number },
): Promise<CustomerCouponDto[]> {
  const config = tagBenefitsOf(input.settings);
  const coupons: CustomerCouponDto[] = [];
  for (const tag of BENEFIT_TAGS) {
    const rule = config.tags[tag];
    if (!rule.enabled || !input.tags.includes(tag)) continue;
    const parts: CouponPartDto[] = [];
    // Cada parte com o seu mínimo e a sua frequência (26/11/2026).
    const perks = [
      rule.freeDelivery.enabled ? { kind: "freeDelivery" as const, cents: 0, minOrderCents: rule.freeDelivery.minOrderCents, frequency: rule.freeDelivery.frequency, perMonth: rule.freeDelivery.perMonth } : null,
      rule.discount.enabled && rule.discount.cents > 0
        ? { kind: "discount" as const, cents: rule.discount.cents, minOrderCents: rule.discount.minOrderCents, frequency: rule.discount.frequency, perMonth: rule.discount.perMonth }
        : null,
    ];
    for (const perk of perks) {
      if (!perk) continue;
      const { perMonth, ...part } = perk;
      // Em X pedidos por mês: X usos no mês de Brasília; uma vez por mês e uma vez só: 1.
      const allowed = perk.frequency === "EVERY_ORDER" ? null : perk.frequency === "MONTHLY_TIMES" ? perMonth : 1;
      const since = perk.frequency === "ONCE" ? null : monthStartBrt(input.now);
      const used = allowed == null ? 0 : await partUsesSince(tx, input, tag, perk.kind, since);
      let reason: string | null = null;
      if (allowed != null && used >= allowed)
        reason = perk.frequency === "ONCE" ? "Você já usou este cupom." : perk.frequency === "MONTHLY_TIMES" ? `Já usado ${allowed} vezes este mês. Volta no mês que vem.` : "Já usado este mês. Volta no mês que vem.";
      else if (input.subtotalCents != null && input.subtotalCents < perk.minOrderCents) reason = `Vale a partir de ${formatCents(perk.minOrderCents)}.`;
      parts.push({ ...part, allowed, used, available: reason === null, reason });
    }
    if (parts.length === 0) continue;
    const valid = parts.filter((p) => p.available);
    coupons.push({
      id: tag,
      title: BENEFIT_TITLE[tag],
      freeDelivery: valid.some((p) => p.kind === "freeDelivery"),
      discountCents: valid.find((p) => p.kind === "discount")?.cents ?? 0,
      parts,
      available: valid.length > 0,
      reason: valid.length > 0 ? null : parts[0]!.reason,
    });
  }
  return coupons;
}

/** Quantas vezes a parte do cupom da tag foi usada desde `since` (null = sempre). O pedido grava em `raw.benefit` o que valeu. */
async function partUsesSince(tx: TenantTx, input: { tenantId: string; contactId: string }, tag: string, kind: CouponPartDto["kind"], since: Date | null): Promise<number> {
  return tx.order.count({
    where: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      source: "MENU",
      status: { not: "CANCELED" },
      AND: [
        { raw: { path: ["benefit", "kind"], equals: "coupon" } },
        { raw: { path: ["benefit", "tag"], equals: tag } },
        kind === "freeDelivery" ? { raw: { path: ["benefit", "freeDelivery"], equals: true } } : { NOT: { raw: { path: ["benefit", "discountCents"], equals: 0 } } },
      ],
      ...(since ? { placedAt: { gte: since } } : {}),
    },
  });
}

/**
 * Vantagem do pedido: o cupom escolhido (se valer) e o presente de recuperação (tag negativa, silencioso); vale só a
 * de maior economia, nunca as duas. Só para o cliente que entrou com o código: o telefone digitado não prova quem é.
 */
export async function resolveBenefit(
  tx: TenantTx,
  input: {
    tenantId: string;
    contactId: string;
    verified: boolean;
    couponId: string | null | undefined;
    settings: unknown;
    now: Date;
    subtotalCents: number;
    deliveryFeeCents: number;
    /** Cupom da aba Cupons digitado na sacola; os automáticos entram sozinhos. */
    couponCode?: string | null;
    lines?: CouponLine[];
    mode?: "DELIVERY" | "PICKUP";
    paymentMethod?: string | null;
  },
): Promise<{ benefit: AppliedBenefit | null; couponRefused: string | null; codeRefused: string | null }> {
  const options: AppliedBenefit[] = [];
  let couponRefused: string | null = null;
  let codeRefused: string | null = null;

  // Cupons da aba Cupons: o digitado e os automáticos. Valem também sem o código do WhatsApp, menos os que dependem
  // de saber quem é o cliente (só novos, um uso por cliente).
  const menuCoupons = await candidateCoupons(tx, {
    tenantId: input.tenantId,
    contactId: input.verified ? input.contactId : null,
    code: input.couponCode ?? null,
    ctx: {
      now: input.now,
      lines: input.lines ?? [],
      subtotalCents: input.subtotalCents,
      mode: input.mode ?? null,
      paymentMethod: couponPaymentOf(input.paymentMethod),
      verified: input.verified,
    },
  });
  if (input.couponCode?.trim()) {
    if (menuCoupons.typedMissing) codeRefused = "Cupom não encontrado. Confira o código.";
    else if (menuCoupons.typed?.refusal) codeRefused = menuCoupons.typed.refusal;
  }
  for (const c of [...(menuCoupons.typed ? [menuCoupons.typed] : []), ...menuCoupons.automatic]) {
    if (c.refusal || (c.discountCents === 0 && !c.freeDelivery)) continue;
    options.push({ kind: "menu_coupon", tag: c.id, label: c.code ?? c.name, code: c.code, discountCents: c.discountCents, freeDelivery: c.freeDelivery });
  }

  if (!input.verified) {
    const best = bestOf(options, input.subtotalCents, input.deliveryFeeCents);
    return { benefit: best, couponRefused: input.couponId ? "Entre com o código do WhatsApp para usar cupons." : null, codeRefused: best?.kind === "menu_coupon" && best.code ? null : codeRefused };
  }
  const contact = await tx.contact.findFirst({ where: { id: input.contactId, tenantId: input.tenantId }, select: { tags: true } });
  const tags = contact?.tags ?? [];
  const config = tagBenefitsOf(input.settings);

  if (input.couponId) {
    const coupons = await customerCoupons(tx, { tenantId: input.tenantId, contactId: input.contactId, tags, settings: input.settings, now: input.now, subtotalCents: input.subtotalCents });
    const coupon = coupons.find((c) => c.id === input.couponId);
    if (!coupon) couponRefused = "Este cupom não está disponível para você.";
    else if (!coupon.available) couponRefused = coupon.reason;
    else options.push({ kind: "coupon", tag: coupon.id, label: coupon.title, discountCents: coupon.discountCents, freeDelivery: coupon.freeDelivery });
  }

  const recovery = config.recovery;
  const hurt = RECOVERY_TAGS.some((tag) => tags.includes(tag));
  if (recovery.enabled && hurt && input.subtotalCents >= recovery.minOrderCents && (recovery.discountCents > 0 || recovery.freeDelivery)) {
    const recent = await usedSince(tx, input.tenantId, input.contactId, "kind", "recovery", new Date(input.now.getTime() - RECOVERY_COOLDOWN_MS));
    if (!recent) options.push({ kind: "recovery", tag: "recovery", label: "Presente da casa", discountCents: recovery.discountCents, freeDelivery: recovery.freeDelivery });
  }

  const best = bestOf(options, input.subtotalCents, input.deliveryFeeCents);
  return {
    benefit: best,
    couponRefused: best?.kind === "coupon" ? null : couponRefused,
    // O código digitado perdeu para uma vantagem maior: não é erro, só não entra.
    codeRefused: best?.kind === "menu_coupon" && best.code ? null : codeRefused,
  };
}

/** Vale só a de maior economia, nunca duas. */
function bestOf(options: AppliedBenefit[], subtotalCents: number, deliveryFeeCents: number): AppliedBenefit | null {
  return [...options].sort((a, b) => benefitSavings(b, subtotalCents, deliveryFeeCents) - benefitSavings(a, subtotalCents, deliveryFeeCents))[0] ?? null;
}

/** Desconto efetivo (o desconto não passa do subtotal) e a taxa depois da vantagem. */
export function applyBenefit(benefit: AppliedBenefit | null, subtotalCents: number, deliveryFeeCents: number) {
  if (!benefit) return { discountCents: 0, deliveryFeeCents };
  return { discountCents: Math.min(benefit.discountCents, subtotalCents), deliveryFeeCents: benefit.freeDelivery ? 0 : deliveryFeeCents };
}

/**
 * Brinde gravado no pedido (`raw.gift`, com a tag, para contar o limite do mês; até 26/11/2026 era `raw.vipGift`, só do
 * VIP); o item vai na lista do pedido a R$ 0.
 */
export type AppliedVipGift = { itemId: string; name: string; tag: BenefitTag };

/**
 * Brinde deste cliente (um só por pedido: o da primeira tag de BENEFIT_TAGS que valer), sem olhar o subtotal: null
 * quando está desligado, o cliente não tem a tag, o item saiu do cardápio (ou esgotou) ou não entrou com o código do
 * WhatsApp. `available: false` quando já usou o limite do mês.
 */
export async function vipGiftFor(
  tx: TenantTx,
  input: { tenantId: string; contactId: string; tags: string[]; settings: unknown; now: Date },
): Promise<{ item: AppliedVipGift; minOrderCents: number; perMonth: number | null; usedThisMonth: number; available: boolean; reason: string | null } | null> {
  const config = tagBenefitsOf(input.settings);
  for (const tag of BENEFIT_TAGS) {
    const found = await giftOf(tx, input, config, tag);
    if (found) return found;
  }
  return null;
}

async function giftOf(tx: TenantTx, input: { tenantId: string; contactId: string; tags: string[]; now: Date }, config: ReturnType<typeof tagBenefitsOf>, tag: BenefitTag) {
  const gift = config.tags[tag].gift;
  if (!config.tags[tag].enabled || !gift.enabled || !gift.itemId || !input.tags.includes(tag)) return null;
  const item = await tx.menuItem.findFirst({
    where: { id: gift.itemId, tenantId: input.tenantId, active: true, soldOut: false, category: { active: true } },
    select: { id: true, name: true },
  });
  if (!item) return null;
  let reason: string | null = null;
  let used = 0;
  if (gift.perMonth != null) {
    used = await tx.order.count({
      where: {
        tenantId: input.tenantId,
        contactId: input.contactId,
        source: "MENU",
        status: { not: "CANCELED" },
        OR: [
          { raw: { path: ["gift", "tag"], equals: tag } },
          ...(tag === "VIP" ? [{ raw: { path: ["vipGift", "given"], equals: true } }] : []),
        ],
        placedAt: { gte: monthStartBrt(input.now) },
      },
    });
    if (used >= gift.perMonth) reason = gift.perMonth === 1 ? "Você já ganhou o brinde este mês." : `Você já ganhou o brinde ${gift.perMonth} vezes este mês.`;
  }
  return { item: { itemId: item.id, name: item.name, tag }, minOrderCents: gift.minOrderCents, perMonth: gift.perMonth, usedThisMonth: used, available: reason === null, reason };
}

export type { BenefitTag };
