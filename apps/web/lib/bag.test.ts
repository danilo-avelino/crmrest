import { describe, expect, it } from "vitest";
import {
  type BagStore,
  bagButton,
  deliveryLine,
  freeDeliveryProgress,
  freeDeliveryRemaining,
  itemsLabel,
  minOrderMissing,
  reconcileLine,
  subtotalOf,
  suggestionsOf,
} from "./bag";
import type { PriceResponse } from "./item-sheet";
import type { CartLine } from "./public-cart";
import type { PublicMenuCategory, PublicMenuItem } from "./public-menu";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  id: "l1", itemId: "i1", name: "Pizza", sizeId: null, sizeName: null, half: null, options: {}, optionLines: [], quantity: 2, note: null,
  unitCents: 3000, totalCents: 6000, pricedAt: 0, ...over,
});
const store = (over: Partial<BagStore> = {}): BagStore => ({
  status: "open", nextOpening: null, schedulingEnabled: true, feeRange: { minCents: 500, maxCents: 1200 }, freeDeliveryFromCents: 10000, minOrderCents: 3000, ...over,
});
const ok = (totalCents: number): PriceResponse => ({
  ok: true,
  line: { itemId: "i1", sizeId: null, halves: [], halfRule: null, baseCents: 0, options: [], optionsCents: 0, unitCents: totalCents / 2, quantity: 2, totalCents },
  button: { disabled: false, label: "x", totalCents },
});

describe("sacola: contas", () => {
  it("subtotal e rótulo de itens", () => {
    expect(subtotalOf([line(), line({ totalCents: 1000, quantity: 1 })])).toBe(7000);
    expect(itemsLabel([line({ quantity: 1 })])).toBe("1 item");
    expect(itemsLabel([line(), line({ quantity: 1 })])).toBe("3 itens");
  });
  it("falta para entrega grátis (R11)", () => {
    expect(freeDeliveryRemaining(7680, 10000)).toBe(2320);
    expect(freeDeliveryRemaining(12000, 10000)).toBe(0);
    expect(freeDeliveryRemaining(5000, null)).toBeNull();
    expect(freeDeliveryProgress(5000, 10000)).toBe(0.5);
    expect(freeDeliveryProgress(20000, 10000)).toBe(1);
  });
  it("pedido mínimo e linha de entrega", () => {
    expect(minOrderMissing(2000, 3000)).toBe(1000);
    expect(minOrderMissing(4000, 3000)).toBe(0);
    expect(deliveryLine(store(), 5000).replaceAll(" ", " ")).toBe("R$ 5 a R$ 12");
    expect(deliveryLine(store(), 10000)).toBe("Grátis");
    expect(deliveryLine(store({ feeRange: null, freeDeliveryFromCents: null }), 5000)).toBe("a calcular");
  });
});

describe("sacola: botão principal", () => {
  const input = { subtotalCents: 6000, count: 1, unavailable: 0 };
  it("aberta: Continuar", () => expect(bagButton(store(), input)).toMatchObject({ action: "continue", label: "Continuar", disabled: false }));
  it("fechada: agenda no horário de abertura, nunca botão morto (R2)", () => {
    expect(bagButton(store({ status: "closed", nextOpening: "hoje às 18:00" }), input)).toMatchObject({ action: "schedule", label: "Agendar para as 18:00", disabled: false });
  });
  it("fechada sem agendamento e pausada: só aviso", () => {
    expect(bagButton(store({ status: "closed", schedulingEnabled: false, nextOpening: "amanhã às 11:00" }), input)).toMatchObject({ action: null });
    expect(bagButton(store({ status: "paused" }), input).message).toMatch(/pausou/);
  });
  it("abaixo do mínimo: trava com explicação", () => {
    const b = bagButton(store(), { ...input, subtotalCents: 2000 });
    expect(b.disabled).toBe(true);
    expect(b.message?.replace(/ /g, " ")).toBe("Faltam R$ 10 para o pedido mínimo de R$ 30.");
  });
  it("item indisponível trava", () => expect(bagButton(store(), { ...input, unavailable: 1 }).disabled).toBe(true));
  it("sacola vazia: sem botão", () => expect(bagButton(store(), { ...input, count: 0 }).action).toBeNull());
});

describe("sacola: conferência de preço", () => {
  it("mesmo preço", () => expect(reconcileLine(line(), ok(6000)).check.kind).toBe("ok"));
  it("preço mudou: usa o novo", () => {
    expect(reconcileLine(line(), ok(7000))).toEqual({ check: { kind: "changed", fromCents: 6000, toCents: 7000 }, unitCents: 3500, totalCents: 7000 });
  });
  it("esgotou depois de entrar", () => {
    const r = reconcileLine(line(), { ok: false, errors: [{ code: "ITEM_UNAVAILABLE", message: "x" }], button: { disabled: true, label: "x", code: "ITEM_UNAVAILABLE" } });
    expect(r.check).toEqual({ kind: "unavailable", message: "Esgotou ou saiu do cardápio" });
  });
});

describe("sacola: cupom (R8) e sugestões", () => {
  const item = (id: string, priceCents: number, over: Partial<PublicMenuItem> = {}): PublicMenuItem => ({
    id, categoryId: "c", name: id, description: null, priceCents, photoUrl: null, soldOut: false, availableNow: true, allowsHalf: false,
    sizes: [], optionGroups: [], tags: [], ingredients: [], allergens: [], servesPeople: null, ...over,
  });
  const cat = (name: string, items: PublicMenuItem[]): PublicMenuCategory => ({ id: name, name, description: null, allowsHalf: false, halfPricing: "SUM", availableNow: true, items });
  it("bebidas e sobremesas; quem completa a entrega grátis vem primeiro; sem esgotado nem o que já está na sacola", () => {
    const cats = [cat("Pizzas", [item("p", 5000)]), cat("Bebidas", [item("coca", 800), item("vinho", 3000), item("agua", 500, { soldOut: true }), item("suco", 900)])];
    const out = suggestionsOf(cats, [], [{ itemId: "suco" }], 2000);
    expect(out.map((s) => s.item.id)).toEqual(["vinho", "coca"]);
    expect(out[0]!.completes).toBe(true);
  });
  it("sem categoria de bebida usa os destaques", () => {
    expect(suggestionsOf([cat("Pizzas", [item("p", 5000)])], [item("d", 1000)], [], null).map((s) => s.item.id)).toEqual(["d"]);
  });
});
