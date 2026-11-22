import { describe, expect, it } from "vitest";
import {
  badgesOf,
  deliveryStrip,
  fold,
  highlightParts,
  highlightsOf,
  moneyShort,
  type PublicMenuCategory,
  type PublicMenuItem,
  type PublicMenuStore,
  priceLabel,
  searchMenu,
  visibleCategories,
} from "./public-menu";

function item(over: Partial<PublicMenuItem>): PublicMenuItem {
  return {
    id: "i",
    categoryId: "c",
    name: "Item",
    description: null,
    priceCents: 1000,
    photoUrl: null,
    soldOut: false,
    availableNow: true,
    allowsHalf: false,
    sizes: [],
    optionGroups: [],
    tags: [],
    ingredients: [],
    allergens: [],
    servesPeople: null,
    ...over,
  };
}

const category = (name: string, items: PublicMenuItem[]): PublicMenuCategory => ({
  id: name,
  name,
  description: null,
  allowsHalf: false,
  halfPricing: "HIGHER",
  availableNow: true,
  items,
});

const menu = [
  category("Pizzas", [
    item({ id: "1", name: "Calabresa", ingredients: ["Muçarela", "Cebola"], tags: ["Mais pedido"] }),
    item({ id: "2", name: "Quatro queijos", ingredients: ["Gorgonzola", "Muçarela"] }),
    item({ id: "3", name: "Atum", soldOut: true, tags: ["novidade"] }),
  ]),
  category("Bebidas", [item({ id: "4", name: "Coca-Cola 2 L" })]),
  category("Sobremesas", []),
];

describe("busca", () => {
  it("ignora acento e caixa", () => {
    expect(fold("  MUÇARELA ")).toBe("mucarela");
    expect(searchMenu(menu, "mucarela").map((h) => h.item.id)).toEqual(["1", "2"]);
  });
  it("nome vem antes de ingrediente", () => {
    const hits = searchMenu(menu, "calab");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ matchedIn: "name", categoryName: "Pizzas" });
    expect(searchMenu(menu, "cebola")[0]?.matchedIn).toBe("ingredient");
  });
  it("todas as palavras precisam casar", () => {
    expect(searchMenu(menu, "quatro gorgonzola").map((h) => h.item.id)).toEqual(["2"]);
    expect(searchMenu(menu, "quatro cebola")).toEqual([]);
  });
  it("busca vazia ou sem resultado devolve lista vazia", () => {
    expect(searchMenu(menu, "   ")).toEqual([]);
    expect(searchMenu(menu, "lasanha")).toEqual([]);
  });
  it("mantém o esgotado na lista", () => {
    expect(searchMenu(menu, "atum")[0]?.item.soldOut).toBe(true);
  });
});

describe("highlightParts", () => {
  it("destaca o termo sem perder o texto original", () => {
    const parts = highlightParts("Calabresa", "calab");
    expect(parts).toEqual([
      { text: "Calab", hit: true },
      { text: "resa", hit: false },
    ]);
  });
  it("casa sem acento", () => {
    expect(highlightParts("Muçarela", "mucar")[0]).toEqual({ text: "Muçar", hit: true });
  });
  it("sem busca, um trecho só", () => {
    expect(highlightParts("Atum", "")).toEqual([{ text: "Atum", hit: false }]);
  });
});

describe("cardápio", () => {
  it("esconde categoria vazia", () => {
    expect(visibleCategories(menu).map((c) => c.name)).toEqual(["Pizzas", "Bebidas"]);
  });
  it("destaques: só à venda, marcados, na ordem", () => {
    expect(highlightsOf(menu).map((i) => i.id)).toEqual(["1"]);
  });
  it("selos: esgotado sozinho; tags conhecidas", () => {
    expect(badgesOf(menu[0]!.items[2]!)).toEqual([{ label: "Esgotado", tone: "muted" }]);
    expect(badgesOf(menu[0]!.items[0]!)).toEqual([{ label: "Mais pedido", tone: "hot" }]);
    expect(badgesOf(item({ availableNow: false }))[0]?.label).toBe("Indisponível agora");
  });
  it("preço: com tamanho, 'a partir de'", () => {
    const sizes = [
      { id: "a", name: "Grande", priceCents: 5490 },
      { id: "b", name: "Broto", priceCents: 3490 },
    ];
    expect(priceLabel({ priceCents: null, sizes })?.replace(/\s/g, " ")).toBe("a partir de R$ 34,90 (broto)");
    expect(priceLabel({ priceCents: 4990, sizes: [] })?.replace(/\s/g, " ")).toBe("R$ 49,90");
    expect(priceLabel({ priceCents: null, sizes: [] })).toBeNull();
  });
});

describe("faixa da entrega", () => {
  const store = {
    feeRange: { minCents: 500, maxCents: 1200 },
    freeDeliveryFromCents: 15000,
    deliveryEta: { minMinutes: 40, maxMinutes: 50 },
  } as PublicMenuStore;
  const texts = (s: PublicMenuStore) => deliveryStrip(s).map((p) => p.text.replace(/\s/g, " "));
  it("faixa, frete grátis e tempo", () => {
    expect(texts(store)).toEqual(["Entrega R$ 5 a R$ 12", "grátis acima de R$ 150", "40–50 min"]);
  });
  it("taxa única, sem frete grátis e sem tempo", () => {
    expect(texts({ ...store, feeRange: { minCents: 790, maxCents: 790 }, freeDeliveryFromCents: null, deliveryEta: { minMinutes: 0, maxMinutes: 0 } })).toEqual(["Entrega R$ 7,90"]);
    expect(moneyShort(500).replace(/\s/g, " ")).toBe("R$ 5");
  });
});
