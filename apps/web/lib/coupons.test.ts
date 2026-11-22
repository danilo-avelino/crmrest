import { DEFAULT_TAG_BENEFITS } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { benefitsPayload } from "@/components/settings/tag-benefits-tab";
import { couponEffect, couponSummary } from "./coupons";

const money = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

describe("cupons do cliente", () => {
  it("o desconto não passa do subtotal e o frete grátis zera a entrega", () => {
    expect(couponEffect({ discountCents: 1000, freeDelivery: true }, 600)).toEqual({ discountCents: 600, freeDelivery: true });
    expect(couponEffect(null, 5000)).toEqual({ discountCents: 0, freeDelivery: false });
    expect(couponSummary({ discountCents: 1000, freeDelivery: true }, money)).toBe("Frete grátis · R$ 10,00 de desconto");
  });

  it("configuração: R$ em texto vira centavos; valor inválido volta a mensagem", () => {
    const ok = benefitsPayload(DEFAULT_TAG_BENEFITS, { "VIP.discount": "12,50", "VIP.min": "", "recovery.discount": "15" });
    expect(ok.ok && ok.body.tags.VIP).toMatchObject({ discountCents: 1250, minOrderCents: 0 });
    expect(ok.ok && ok.body.recovery.discountCents).toBe(1500);
    const bad = benefitsPayload(DEFAULT_TAG_BENEFITS, { "VIP.discount": "dez" });
    expect(bad).toEqual({ ok: false, error: "Cliente VIP · cupom: informe um valor em R$, como 10,00." });
  });
});
