import { describe, expect, it } from "vitest";
import { addButtonOf, halfPrice, priceCart, type PricingCatalog, type PricingItem, priceLine } from "../src/menu/pricing.js";

const size = (id: string, name: string, priceCents: number) => ({ id, name, priceCents, active: true });
const option = (id: string, priceCents: number, extra = {}) => ({ id, name: id, priceCents, active: true, soldOut: false, ...extra });
const borda = { id: "g-borda", name: "Borda", minSelect: 0, maxSelect: 1, options: [option("catupiry", 800), option("cheddar", 900, { soldOut: true })] };
const molho = { id: "g-molho", name: "Molho", minSelect: 1, maxSelect: 2, options: [option("alho", 0), option("pimenta", 150)] };

const pizza = (id: string, grande: number, extra: Partial<PricingItem> = {}): PricingItem => ({
  id,
  name: id,
  categoryId: "pizzas",
  priceCents: null,
  active: true,
  soldOut: false,
  allowsHalf: true,
  sizes: [size(`${id}-m`, "Média", grande - 1000), size(`${id}-g`, "Grande", grande)],
  optionGroups: [borda, molho],
  ...extra,
});

const catalog = (rule: "MAX" | "AVERAGE" | "SUM" = "MAX", items: PricingItem[] = []): PricingCatalog => ({
  items: new Map(
    [
      pizza("calabresa", 5000),
      pizza("frango", 5999),
      pizza("esgotada", 5000, { soldOut: true }),
      pizza("inteira", 5000, { allowsHalf: false }),
      { ...pizza("coca", 0), categoryId: "bebidas", priceCents: 700, sizes: [], optionGroups: [] },
      ...items,
    ].map((i) => [i.id, i]),
  ),
  categories: { pizzas: { id: "pizzas", allowsHalf: true, halfPricing: rule }, bebidas: { id: "bebidas", allowsHalf: false, halfPricing: "MAX" } },
});

const codes = (r: ReturnType<typeof priceLine>) => (r.ok ? [] : r.errors.map((e) => e.code));

describe("PricingService (F2-04)", () => {
  it("R6: sem tamanho dá SIZE_REQUIRED, nunca preço 0", () => {
    const line = priceLine(catalog(), { itemId: "calabresa", optionIds: ["alho"], quantity: 1 });
    expect(codes(line)).toEqual(["SIZE_REQUIRED"]);
    expect(addButtonOf(catalog(), { itemId: "calabresa", optionIds: ["alho"], quantity: 1 })).toEqual({
      disabled: true,
      label: "Escolha o tamanho",
      code: "SIZE_REQUIRED",
    });
  });

  it("item sem preço e sem tamanho também exige tamanho", () => {
    expect(codes(priceLine(catalog("MAX", [{ ...pizza("x", 1), sizes: [], optionGroups: [] }]), { itemId: "x", quantity: 1 }))).toEqual([
      "SIZE_REQUIRED",
    ]);
  });

  it("tamanho + complementos vezes a quantidade", () => {
    const line = priceLine(catalog(), { itemId: "calabresa", sizeId: "calabresa-g", optionIds: ["catupiry", "pimenta"], quantity: 2 });
    expect(line.ok && line.value).toMatchObject({ baseCents: 5000, optionsCents: 950, unitCents: 5950, totalCents: 11900 });
    expect(addButtonOf(catalog(), { itemId: "calabresa", sizeId: "calabresa-g", optionIds: ["alho"], quantity: 1 })).toEqual({
      disabled: false,
      label: "Adicionar R$ 50,00",
      totalCents: 5000,
    });
  });

  it("item com preço próprio, sem tamanhos", () => {
    const line = priceLine(catalog(), { itemId: "coca", quantity: 3 });
    expect(line.ok && line.value.totalCents).toBe(2100);
  });

  it("mínimo e máximo de cada grupo", () => {
    expect(codes(priceLine(catalog(), { itemId: "calabresa", sizeId: "calabresa-g", quantity: 1 }))).toEqual(["GROUP_MIN"]);
    expect(
      codes(priceLine(catalog(), { itemId: "calabresa", sizeId: "calabresa-g", optionIds: ["alho", "pimenta", "alho"], quantity: 1 })),
    ).toEqual(["GROUP_MAX"]);
  });

  it("complemento de outro item, esgotado ou inativo é recusado", () => {
    expect(codes(priceLine(catalog(), { itemId: "coca", optionIds: ["catupiry"], quantity: 1 }))).toEqual(["OPTION_NOT_FOUND"]);
    expect(codes(priceLine(catalog(), { itemId: "calabresa", sizeId: "calabresa-g", optionIds: ["alho", "cheddar"], quantity: 1 }))).toEqual([
      "OPTION_UNAVAILABLE",
    ]);
  });

  it("item esgotado, tamanho errado e quantidade inválida", () => {
    expect(codes(priceLine(catalog(), { itemId: "esgotada", sizeId: "esgotada-g", quantity: 1 }))).toEqual(["ITEM_UNAVAILABLE"]);
    expect(codes(priceLine(catalog(), { itemId: "calabresa", sizeId: "frango-g", quantity: 1 }))).toEqual(["SIZE_NOT_FOUND"]);
    expect(codes(priceLine(catalog(), { itemId: "coca", quantity: 0 }))).toEqual(["INVALID_QUANTITY"]);
    expect(codes(priceLine(catalog(), { itemId: "nada", quantity: 1 }))).toEqual(["ITEM_NOT_FOUND"]);
  });

  it("R7: meio a meio pela regra da categoria, no mesmo tamanho", () => {
    const sel = { itemId: "calabresa", sizeId: "calabresa-g", halves: ["frango"], optionIds: ["alho"], quantity: 1 };
    const base = (rule: "MAX" | "AVERAGE" | "SUM") => {
      const line = priceLine(catalog(rule), sel);
      return line.ok ? [line.value.baseCents, line.value.halfRule] : codes(line);
    };
    expect(base("MAX")).toEqual([5999, "MAX"]);
    expect(base("AVERAGE")).toEqual([5500, "AVERAGE"]); // (5000 + 5999) / 2 = 5499,5 → 5500
    expect(base("SUM")).toEqual([10999, "SUM"]); // 5000 + 5999, preços cheios
    const media = priceLine(catalog("MAX"), { ...sel, sizeId: "calabresa-m" });
    expect(media.ok && media.value.baseCents).toBe(4999);
  });

  it("regras de arredondamento do meio a meio", () => {
    expect(halfPrice("AVERAGE", [1001, 1000])).toBe(1001);
    expect(halfPrice("AVERAGE", [1003, 1000])).toBe(1002);
    expect(halfPrice("SUM", [1001, 1001])).toBe(2002);
  });

  it("meio a meio inválido", () => {
    const sel = (halves: string[], itemId = "calabresa") => ({ itemId, sizeId: `${itemId}-g`, halves, optionIds: ["alho"], quantity: 1 });
    expect(codes(priceLine(catalog(), sel(["inteira"])))).toEqual(["HALF_NOT_ALLOWED"]);
    expect(codes(priceLine(catalog(), sel(["frango"], "inteira")))).toEqual(["HALF_NOT_ALLOWED"]);
    expect(codes(priceLine(catalog(), sel(["coca"])))).toEqual(["HALF_OTHER_CATEGORY"]);
    expect(codes(priceLine(catalog(), sel(["frango", "calabresa"])))).toEqual(["HALF_TOO_MANY"]);
    expect(codes(priceLine(catalog(), sel(["esgotada"])))).toEqual(["ITEM_UNAVAILABLE"]);
    const semGrande = pizza("broto", 3000, { sizes: [size("broto-m", "Média", 2000)] });
    expect(codes(priceLine(catalog("MAX", [semGrande]), sel(["broto"])))).toEqual(["HALF_SIZE_MISSING"]);
    const categoriaSemMeio = { ...catalog(), categories: { pizzas: { id: "pizzas", allowsHalf: false, halfPricing: "MAX" as const } } };
    expect(codes(priceLine(categoriaSemMeio, sel(["frango"])))).toEqual(["HALF_NOT_ALLOWED"]);
  });

  it("sacola: subtotal, taxa e total; taxa pode depender do subtotal", () => {
    const sels = [
      { itemId: "calabresa", sizeId: "calabresa-g", optionIds: ["alho"], quantity: 1 },
      { itemId: "coca", quantity: 2 },
    ];
    const cart = priceCart(catalog(), sels, 800);
    expect(cart.ok && cart.value).toMatchObject({ subtotalCents: 6400, deliveryFeeCents: 800, totalCents: 7200 });
    const free = priceCart(catalog(), sels, (subtotal) => (subtotal >= 6000 ? 0 : 800));
    expect(free.ok && free.value.totalCents).toBe(6400);
    const bad = priceCart(catalog(), [...sels, { itemId: "calabresa", quantity: 1 }]);
    expect(bad.ok ? [] : bad.errors.map((e) => e.code)).toEqual(["SIZE_REQUIRED"]);
  });
});
