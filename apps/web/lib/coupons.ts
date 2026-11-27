// Cupons das tags do cliente no cardápio público. Só quem entrou com o código do WhatsApp vê; o cliente escolhe um
// (vale só um por pedido) e o servidor confere de novo ao fazer o pedido. O presente de recuperação não aparece aqui.

import type { CustomerCouponDto, VipGiftDto } from "@dishdesk/shared";
import { useEffect, useState } from "react";

export type CouponsResponse = { name: string | null; coupons: CustomerCouponDto[]; vipGift?: VipGiftDto | null; vip?: boolean };

/** null: sem a sessão do código. */
export async function fetchCoupons(slug: string, subtotalCents?: number): Promise<CouponsResponse | null> {
  const query = subtotalCents != null ? `?subtotal=${subtotalCents}` : "";
  const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/me/coupons${query}`, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Cupons indisponíveis (${response.status})`);
  return (await response.json()) as CouponsResponse;
}

/** Cupons do cliente; `undefined` enquanto carrega, `null` sem login. */
export function useCoupons(slug: string, subtotalCents?: number): CouponsResponse | null | undefined {
  const [data, setData] = useState<CouponsResponse | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchCoupons(slug, subtotalCents)
      .then((found) => alive && setData(found))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [slug, subtotalCents]);
  return data;
}

const key = (slug: string) => `dd-coupon:${slug}`;
export const COUPON_EVENT = "dd:coupon";

export function selectedCoupon(slug: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key(slug));
  } catch {
    return null;
  }
}

export function selectCoupon(slug: string, id: string | null): void {
  try {
    if (id) window.localStorage.setItem(key(slug), id);
    else window.localStorage.removeItem(key(slug));
  } catch {
    // sem armazenamento: vale só nesta página
  }
  window.dispatchEvent(new Event(COUPON_EVENT));
}

/** Cupom escolhido, acompanhando a troca em outra parte da página. */
export function useSelectedCoupon(slug: string): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setId(selectedCoupon(slug));
    sync();
    window.addEventListener(COUPON_EVENT, sync);
    return () => window.removeEventListener(COUPON_EVENT, sync);
  }, [slug]);
  return id;
}

/** Desconto que o cupom dá (até o subtotal) e se zera a entrega. Só prévia: o servidor decide no pedido. */
export function couponEffect(coupon: Pick<CustomerCouponDto, "discountCents" | "freeDelivery"> | null | undefined, subtotalCents: number) {
  if (!coupon) return { discountCents: 0, freeDelivery: false };
  return { discountCents: Math.min(coupon.discountCents, subtotalCents), freeDelivery: coupon.freeDelivery };
}

/** "Frete grátis · R$ 10 de desconto". */
export function couponSummary(coupon: Pick<CustomerCouponDto, "discountCents" | "freeDelivery">, money: (cents: number) => string): string {
  return [coupon.freeDelivery ? "Frete grátis" : null, coupon.discountCents > 0 ? `${money(coupon.discountCents)} de desconto` : null].filter(Boolean).join(" · ");
}

// ---------- Cupons da aba Cupons (N4): código digitado na sacola e os automáticos ----------

export type MenuCouponView = { id: string; label: string; code: string | null; discountCents: number; freeDelivery: boolean };
export type CodePreview = { typed: { ok: true; coupon: MenuCouponView } | { ok: false; message: string } | null; automatic: MenuCouponView | null };
type PreviewLine = { itemId: string; totalCents: number };

const codeKey = (slug: string) => `dd-coupon-code:${slug}`;

export function couponCode(slug: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(codeKey(slug));
  } catch {
    return null;
  }
}

export function setCouponCode(slug: string, code: string | null): void {
  try {
    if (code) window.localStorage.setItem(codeKey(slug), code);
    else window.localStorage.removeItem(codeKey(slug));
  } catch {
    // sem armazenamento: vale só nesta página
  }
  window.dispatchEvent(new Event(COUPON_EVENT));
}

/** Código digitado na sacola, acompanhando a troca em outra parte da página. */
export function useCouponCode(slug: string): string | null {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setCode(couponCode(slug));
    sync();
    window.addEventListener(COUPON_EVENT, sync);
    return () => window.removeEventListener(COUPON_EVENT, sync);
  }, [slug]);
  return code;
}

export async function fetchCodePreview(slug: string, body: { code: string | null; lines: PreviewLine[]; mode: "DELIVERY" | "PICKUP" | null }): Promise<CodePreview | null> {
  const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/coupon-preview`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  return (await response.json()) as CodePreview;
}

/** Prévia do cupom digitado e do melhor automático para estas linhas; `undefined` enquanto carrega. */
export function useCodePreview(slug: string, lines: PreviewLine[], mode: "DELIVERY" | "PICKUP" | null): CodePreview | null | undefined {
  const code = useCouponCode(slug);
  const [data, setData] = useState<CodePreview | null | undefined>(undefined);
  const key = `${code ?? ""}|${mode ?? ""}|${lines.map((l) => `${l.itemId}:${l.totalCents}`).join(",")}`;
  useEffect(() => {
    let alive = true;
    if (!lines.length) return;
    fetchCodePreview(slug, { code, lines, mode })
      .then((found) => alive && setData(found))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
    // `key` resume code, mode e linhas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, key]);
  return lines.length ? data : null;
}

/**
 * Prévia do pedido com a melhor vantagem (vale uma só, como no servidor): o cupom da tag escolhido, o código
 * digitado ou o automático. Desconto, taxa, total e o que vai no pedido (`couponId` da tag ou `couponCode`).
 */
export function useCouponPreview(slug: string, subtotalCents: number, deliveryFeeCents: number, lines: PreviewLine[] = [], mode: "DELIVERY" | "PICKUP" | null = null) {
  const id = useSelectedCoupon(slug);
  const data = useCoupons(slug, subtotalCents);
  const codes = useCodePreview(slug, lines, mode);
  const tag = data?.coupons.find((c) => c.id === id && c.available) ?? null;
  const tagEffect = couponEffect(tag, subtotalCents);
  const menuCoupon = codes?.typed?.ok ? codes.typed.coupon : (codes?.automatic ?? null);
  const savings = (e: { discountCents: number; freeDelivery: boolean }) => Math.min(e.discountCents, subtotalCents) + (e.freeDelivery ? deliveryFeeCents : 0);
  const useMenu = menuCoupon != null && (!tag || savings(menuCoupon) > savings(tagEffect));
  const effect = useMenu ? { discountCents: Math.min(menuCoupon.discountCents, subtotalCents), freeDelivery: menuCoupon.freeDelivery } : tagEffect;
  const feeCents = effect.freeDelivery ? 0 : deliveryFeeCents;
  const label = useMenu ? menuCoupon.label : (tag?.title ?? null);
  return {
    coupon: useMenu ? null : tag,
    label,
    couponId: useMenu ? null : (tag?.id ?? null),
    couponCode: useMenu && menuCoupon.code ? menuCoupon.code : null,
    discountCents: effect.discountCents,
    freeDelivery: effect.freeDelivery,
    /** Brinde do VIP que entra neste pedido (soma com o cupom); o servidor confere de novo e põe o item a R$ 0. */
    vipGift: data?.vipGift?.available && subtotalCents >= data.vipGift.minOrderCents ? data.vipGift.name : null,
    feeCents,
    totalCents: subtotalCents - effect.discountCents + feeCents,
  };
}
