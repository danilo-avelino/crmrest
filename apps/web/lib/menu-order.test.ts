import type { MenuOrderInfo } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { menuBadges, menuPaymentLabel, menuScheduledLabel, parseMenuItemName } from "./menu-order";

const menu = (extra: Partial<MenuOrderInfo> = {}): MenuOrderInfo => ({ takeout: false, scheduledFor: null, payment: null, origin: "site", ...extra });

describe("selo de pagamento do pedido do cardápio", () => {
  it("dinheiro na entrega, com troco", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "cash", changeForCents: 10_000 } }))).toBe("Pagar na entrega: dinheiro, troco p/ R$ 100");
  });
  it("dinheiro sem troco e troco com centavos", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "cash", changeForCents: null } }))).toBe("Pagar na entrega: dinheiro, sem troco");
    expect(menuPaymentLabel(menu({ payment: { method: "cash", changeForCents: 5050 } }))).toBe("Pagar na entrega: dinheiro, troco p/ R$ 50,50");
  });
  it("cartão na entrega e na retirada", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "credit", changeForCents: null } }))).toBe("cartão de crédito na entrega");
    expect(menuPaymentLabel(menu({ payment: { method: "debit", changeForCents: null }, takeout: true }))).toBe("cartão de débito na retirada");
  });
  it("dinheiro na retirada", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "cash", changeForCents: 2000 }, takeout: true }))).toBe("Pagar na retirada: dinheiro, troco p/ R$ 20");
  });
  it("Pix na maquininha: pagar na entrega ou na retirada, nunca \"Pago via Pix\"", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "pix_on_delivery", changeForCents: null }, takeout: false }))).toBe("Pagar na entrega: Pix na maquininha");
    expect(menuPaymentLabel(menu({ payment: { method: "pix_on_delivery", changeForCents: null }, takeout: true }))).toBe("Pagar na retirada: Pix na maquininha");
    expect(menuBadges(menu({ payment: { method: "pix_on_delivery", changeForCents: null } }))[0]).toMatchObject({ tone: "pending", label: "Pagar na entrega: Pix na maquininha" });
  });

  it("Pix: pago, sem importar a retirada", () => {
    expect(menuPaymentLabel(menu({ payment: { method: "pix", changeForCents: null }, takeout: true }))).toBe("Pago via Pix");
  });
  it("sem forma de pagamento: sem selo", () => {
    expect(menuPaymentLabel(menu())).toBeNull();
  });
});

describe("selo de agendamento", () => {
  const now = new Date("2026-11-22T15:00:00Z"); // 12:00 em Brasília
  it("no mesmo dia: só a hora, em Brasília", () => {
    expect(menuScheduledLabel("2026-11-22T22:30:00Z", now)).toBe("Agendado 19:30");
  });
  it("em outro dia: com a data de Brasília", () => {
    expect(menuScheduledLabel("2026-11-24T22:30:00Z", now)).toBe("Agendado 24/11 19:30");
  });
  it("23:00 em Brasília já é o dia seguinte em UTC, mas segue sendo hoje", () => {
    expect(menuScheduledLabel("2026-11-23T02:00:00Z", now)).toBe("Agendado 23:00");
  });
});

describe("selos do pedido", () => {
  it("pedido de outra origem: nenhum selo", () => {
    expect(menuBadges(menu({ origin: "whatsapp_ai" })).at(-1)).toEqual({ key: "origin", tone: "info", label: "WhatsApp pela IA" });
    expect(menuBadges(menu({ origin: "site" })).some((b) => b.key === "origin")).toBe(false);
    expect(menuBadges(null)).toEqual([]);
    expect(menuBadges(undefined)).toEqual([]);
  });
  it("pagamento e agendamento, com o tom de cada um", () => {
    const now = new Date("2026-11-22T15:00:00Z");
    expect(menuBadges(menu({ payment: { method: "pix", changeForCents: null }, scheduledFor: "2026-11-22T22:30:00Z" }), now)).toEqual([
      { key: "payment", tone: "resolved", label: "Pago via Pix" },
      { key: "scheduled", tone: "info", label: "Agendado 19:30" },
    ]);
    expect(menuBadges(menu({ payment: { method: "debit", changeForCents: null } }), now)[0]).toMatchObject({ tone: "pending" });
  });
});

describe("nome do item para a cozinha", () => {
  it("meio a meio com tamanho", () => {
    expect(parseMenuItemName("½ Calabresa + ½ Frango (Grande)")).toEqual({ size: "Grande", halves: ["Calabresa", "Frango"], title: "½ Calabresa + ½ Frango" });
  });
  it("três sabores", () => {
    expect(parseMenuItemName("½ A + ½ B + ½ C").halves).toEqual(["A", "B", "C"]);
  });
  it("item inteiro com tamanho", () => {
    expect(parseMenuItemName("Calabresa (Grande)")).toEqual({ size: "Grande", halves: [], title: "Calabresa" });
  });
  it("item sem tamanho", () => {
    expect(parseMenuItemName("Refri 2 L")).toEqual({ size: null, halves: [], title: "Refri 2 L" });
  });
});

describe("selo da vantagem no pedido do cardápio", () => {
  it("mostra o cupom ou o presente com o desconto e o frete grátis", () => {
    const badges = menuBadges({ takeout: false, scheduledFor: null, payment: null, origin: "site", benefit: { label: "Cliente VIP", discountCents: 1000, freeDelivery: true } });
    expect(badges).toContainEqual({ key: "benefit", tone: "resolved", label: "Cliente VIP: − R$ 10,00 e frete grátis" });
  });
});
