import type { TenantTx } from "@dishdesk/database";
import {
  BENEFIT_TAGS,
  BENEFIT_TITLE,
  type BenefitTag,
  benefitSavings,
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
    if (!rule.enabled || !input.tags.includes(tag) || (!rule.freeDelivery && rule.discountCents === 0)) continue;
    let reason: string | null = null;
    if (rule.frequency === "ONCE" && (await usedSince(tx, input.tenantId, input.contactId, "tag", tag, null))) reason = "Você já usou este cupom.";
    else if (rule.frequency === "MONTHLY" && (await usedSince(tx, input.tenantId, input.contactId, "tag", tag, monthStartBrt(input.now)))) reason = "Já usado este mês. Volta no mês que vem.";
    else if (input.subtotalCents != null && input.subtotalCents < rule.minOrderCents) reason = `Vale a partir de ${formatCents(rule.minOrderCents)}.`;
    coupons.push({
      id: tag,
      title: BENEFIT_TITLE[tag],
      freeDelivery: rule.freeDelivery,
      discountCents: rule.discountCents,
      minOrderCents: rule.minOrderCents,
      frequency: rule.frequency,
      available: reason === null,
      reason,
    });
  }
  return coupons;
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

export type { BenefitTag };
