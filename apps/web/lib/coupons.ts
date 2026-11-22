// Cupons das tags do cliente no cardápio público. Só quem entrou com o código do WhatsApp vê; o cliente escolhe um
// (vale só um por pedido) e o servidor confere de novo ao fazer o pedido. O presente de recuperação não aparece aqui.

import type { CustomerCouponDto } from "@dishdesk/shared";
import { useEffect, useState } from "react";

export type CouponsResponse = { name: string | null; coupons: CustomerCouponDto[] };

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

/** Prévia do pedido com o cupom escolhido (só se ainda vale): desconto, taxa e total. O servidor decide no pedido. */
export function useCouponPreview(slug: string, subtotalCents: number, deliveryFeeCents: number) {
  const id = useSelectedCoupon(slug);
  const data = useCoupons(slug, subtotalCents);
  const coupon = data?.coupons.find((c) => c.id === id && c.available) ?? null;
  const effect = couponEffect(coupon, subtotalCents);
  const feeCents = effect.freeDelivery ? 0 : deliveryFeeCents;
  return { coupon, couponId: coupon?.id ?? null, discountCents: effect.discountCents, feeCents, totalCents: subtotalCents - effect.discountCents + feeCents };
}
